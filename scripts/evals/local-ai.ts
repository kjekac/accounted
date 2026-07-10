#!/usr/bin/env tsx
/**
 * Local model eval harness for Accounted's provider contract.
 *
 * Usage:
 *   AI_PROVIDER=local \
 *   LOCAL_AI_BASE_URL=http://127.0.0.1:11434/v1 \
 *   LOCAL_AI_MODEL=qwen2.5:14b \
 *   npm run eval:local-ai
 *
 * Compare several candidates:
 *   npm run eval:local-ai -- --models qwen2.5:14b,llama3.1:8b
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, appendFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import {
  getModelProvider,
  setModelProviderForTest,
  textMessage,
  type ModelContentBlock,
  type ModelMessage,
  type ModelSystemBlock,
  type ModelProvider,
  type StructuredSchema,
} from '../../lib/agent/model-provider'
import { runChatTurn, type StreamEvent } from '../../lib/agent/chat/run-turn'
import { buildSystemPrompt } from '../../lib/agent/chat/system-prompt'
import { SONNET_MODEL } from '../../lib/agent/composer/client'
import {
  buildAtomSelectionUserPrompt,
  finalizeAtomSelection,
  generateRawAtomSelection,
  ATOM_SELECTION_SYSTEM_PROMPT,
} from '../../lib/agent/composer/atom-selection'
import { ATOM_SELECTION_TOOL_SCHEMA, AtomSelectionSchema, type AtomSelection } from '../../lib/agent/composer/schemas'
import type { ComposerInputs, AtomRegistryIndexRow } from '../../lib/agent/composer/inputs'
import { transactionCategorization } from '../../lib/agent/intents/transaction-categorization'
import { getIntent } from '../../lib/agent/intents/registry'
import type { AgentIntent } from '../../lib/agent/intents/types'
import { agentToolRegistry, registerAgentTools } from '../../lib/agent/tools/registry'
import type { AgentTool } from '../../lib/agent/tools/types'
import { swedishToday } from '../../lib/utils'

type EvalGroup = 'smoke' | 'composer' | 'assistant' | 'transaction' | 'classification'
type AssistantEvalMode = 'oracle-context' | 'end-to-end'

const CASE_PREIMAGE_VERSION = 1
const LOGICAL_CASE_PREIMAGE_VERSION = 1
const SCORING_VERSION = 1
const DEFAULT_RESULTS_DIR = join('scripts', 'evals', 'results')

interface CliOptions {
  models: string[]
  groups: Set<EvalGroup>
  json: boolean
  runs: number
  resultsDir: string
  persist: boolean
  resume: boolean
  dryRun: boolean
}

type FailureSeverity = 'hard' | 'severe' | 'mild'

interface EvalFailure {
  code: string
  severity: FailureSeverity
  detail: string
}

interface EvalResult {
  runId: string
  attemptId: string
  resumeKey: string
  caseHash: string
  logicalCaseHash: string
  model: string
  group: EvalGroup
  id: string
  run: number
  variant: string
  ok: boolean
  latencyMs: number
  checks: Record<string, boolean>
  failures: EvalFailure[]
  notes: string[]
  evalContext?: EvalContext
  stages?: Record<string, unknown>
}

interface EvalSkip {
  kind: 'skip'
  reason: 'completed'
  model: string
  group: EvalGroup
  id: string
  run: number
  variant: string
  caseHash: string
  logicalCaseHash: string
  resumeKey: string
  priorAttemptId: string | null
}

type EvalOutcome = EvalResult | EvalSkip

interface EvalCaseDefinition {
  caseId: string
  group: EvalGroup
  caseHash: string
  logicalCaseHash: string
  runId: string
  preimage: Record<string, unknown>
  logicalPreimage: Record<string, unknown>
  evalContext?: EvalContext
}

interface EvalPersistence {
  runId: string
  startedAt: string
  resultsDir: string
  manifestPath: string
  attemptsPath: string
  seenCaseHashes: Set<string>
  completedAttempts: Map<string, CompletedAttempt>
}

interface CompletedAttempt {
  attemptId: string | null
  caseHash: string
  logicalCaseHash: string
}

interface EvalContext {
  today?: string
  today_source?: 'current' | 'historical' | 'none'
  date_policy?: 'agnostic' | 'fixed' | 'none'
}

interface PlannedCase {
  model: string
  group: EvalGroup
  id: string
  run: number
  variant: string
  logicalCaseHash: string
  resumeKey: string
}

interface ModelSummary {
  model: string
  total: number
  passed: number
  validStructured: number
  validToolCall: number
  hallucinatedTool: number
  wrongTransactionId: number
  unsafeCategorization: number
  wrongVatTreatment: number
  unnecessaryClarification: number
  failures: Record<FailureSeverity, number>
  transactionRouting: 'eligible' | 'blocked'
  eligibility: {
    assistantOracleContext: 'eligible' | 'blocked'
    assistantEndToEnd: 'eligible' | 'blocked'
    transactionCategorization: 'eligible' | 'blocked'
    queuedClassification: 'eligible' | 'blocked'
    composer: 'eligible' | 'blocked'
  }
  latencyMs: {
    min: number
    median: number
    max: number
  }
}

interface EvalTransaction {
  id: string
  date: string | null
  description: string | null
  amount: number | null
  currency: string | null
  counterparty_name: string | null
  direction: 'in' | 'out' | 'zero' | 'unknown'
}

interface EvalUnderlag {
  kind: 'receipt' | 'invoice_inbox'
  document_id: string | null
  merchant_name: string | null
  receipt_date: string | null
  total_amount: number | null
  vat_amount: number | null
  currency: string | null
  is_restaurant: boolean | null
  is_systembolaget: boolean | null
  raw_extraction: Record<string, unknown> | null
}

interface EvalVariant {
  id: string
  classificationPrefix?: string
  classificationSuffix?: string
  transactionReminder?: string
}

interface AssistantExpectedConcept {
  id: string
  anyOf: string[]
}

interface AssistantFixture {
  id: string
  description: string
  intentId: string
  intentArgs: Record<string, unknown>
  company: AssistantCompanyFixture
  turns: AssistantTurnFixture[]
  oracleAtoms: {
    vertical: string[]
    modifiers: string[]
  }
  expectedSelectedAtoms?: string[]
}

interface AssistantCompanyFixture {
  companyId: string
  companyName: string
  firstName: string | null
  profileSummary: string
  vatStatus: { vat_registered: boolean; vat_number: string | null }
  memory: { id: string; content: string; kind: string }[]
  composerInputs: ComposerInputs
}

interface AssistantTurnFixture {
  user: string
  seedHistory?: ModelMessage[]
  toolResults?: Record<string, unknown>
  allowedTools?: string[]
  requiredTools?: string[]
  forbiddenTools?: string[]
  requiredToolArgs?: Record<string, Record<string, unknown>>
  forbiddenActions?: string[]
  clarificationRequired?: boolean
  shouldIncorporate?: string[]
  requiredConcepts?: AssistantExpectedConcept[]
  forbiddenClaims?: string[]
  acceptableOutcomes?: string[]
}

const TRANSACTION_CATEGORIES = [
  'income_services',
  'income_products',
  'income_other',
  'expense_equipment',
  'expense_software',
  'expense_travel',
  'expense_office',
  'expense_marketing',
  'expense_professional_services',
  'expense_education',
  'expense_representation',
  'expense_consumables',
  'expense_vehicle',
  'expense_telecom',
  'expense_bank_fees',
  'expense_card_fees',
  'expense_currency_exchange',
  'expense_other',
  'private',
] as const

const VAT_TREATMENTS = [
  'standard_25',
  'reduced_12',
  'reduced_6',
  'reverse_charge',
  'export',
  'exempt',
] as const

const SmokeStructuredSchema = z.object({
  transaction_id: z.string(),
  category: z.enum(TRANSACTION_CATEGORIES),
  needs_review: z.boolean(),
})

const QueuedClassificationSchema = z.object({
  transaction_id: z.string(),
  action: z.enum(['categorize', 'needs_review']),
  category: z.enum(TRANSACTION_CATEGORIES).nullable(),
  vat_treatment: z.enum(VAT_TREATMENTS).nullable(),
  confidence: z.number().min(0).max(1),
  review_reason: z.string().nullable(),
})

const SMOKE_STRUCTURED_TOOL_SCHEMA: StructuredSchema = {
  name: 'classify_transaction_contract_smoke',
  description: 'Return one strict classification decision.',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      transaction_id: { type: 'string' },
      category: { type: 'string', enum: [...TRANSACTION_CATEGORIES] },
      needs_review: { type: 'boolean' },
    },
    required: ['transaction_id', 'category', 'needs_review'],
  },
}

const QUEUED_CLASSIFICATION_TOOL_SCHEMA: StructuredSchema = {
  name: 'classify_transaction_for_queue',
  description: 'Return one conservative queued transaction classification decision.',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      transaction_id: { type: 'string' },
      action: { type: 'string', enum: ['categorize', 'needs_review'] },
      category: {
        anyOf: [
          { type: 'string', enum: [...TRANSACTION_CATEGORIES] },
          { type: 'null' },
        ],
      },
      vat_treatment: {
        anyOf: [
          { type: 'string', enum: [...VAT_TREATMENTS] },
          { type: 'null' },
        ],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      review_reason: {
        anyOf: [
          { type: 'string' },
          { type: 'null' },
        ],
      },
    },
    required: [
      'transaction_id',
      'action',
      'category',
      'vat_treatment',
      'confidence',
      'review_reason',
    ],
  },
}

const CATEGORIZE_TOOL: AgentTool = {
  name: 'gnubok_categorize_transaction',
  description:
    'Categorize a bank transaction by allowed category enum only. Stages for approval; server code maps BAS accounts and rechecks duplicates, periods, and documents.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      transaction_id: {
        type: 'string',
        description: 'UUID of the transaction row to categorize. Never pass document_id.',
      },
      category: {
        type: 'string',
        description: 'Transaction category. Must be exactly one enum value.',
        enum: [...TRANSACTION_CATEGORIES],
      },
      vat_treatment: {
        type: 'string',
        enum: [...VAT_TREATMENTS],
      },
      vat_amount: { type: 'number', exclusiveMinimum: 0 },
      notes: { type: 'string' },
    },
    required: ['transaction_id', 'category'],
  },
  execute: async () => ({ staged: true }),
}

const QUERY_JOURNAL_TOOL: AgentTool = {
  name: 'gnubok_query_journal',
  description: 'Search previous journal entries for counterparty and account history.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['text'],
  },
  execute: async () => ({}),
}

const GET_DOCUMENT_TOOL: AgentTool = {
  name: 'gnubok_get_document_content',
  description: 'Read an attached document when extracted metadata is insufficient.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      document_id: { type: 'string' },
    },
    required: ['document_id'],
  },
  execute: async () => ({}),
}

const REMEMBER_FACT_TOOL: AgentTool = {
  name: 'gnubok_remember_fact',
  description: 'Remember a durable categorization preference or fact for later turns.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      content: { type: 'string' },
      kind: { type: 'string', enum: ['fact', 'preference', 'pattern', 'correction'] },
    },
    required: ['content', 'kind'],
  },
  execute: async () => ({}),
}

const TRANSACTION_TOOLS = [
  CATEGORIZE_TOOL,
  QUERY_JOURNAL_TOOL,
  GET_DOCUMENT_TOOL,
  REMEMBER_FACT_TOOL,
]

const ALLOWED_TRANSACTION_TOOLS = new Set(TRANSACTION_TOOLS.map((t) => t.name))

const EVAL_VARIANTS: EvalVariant[] = [
  { id: 'baseline' },
  {
    id: 'terse-bank-export',
    classificationPrefix: 'Kort bankexport. Beslut konservativt och följ schemat.',
    classificationSuffix: 'Returnera beslutet utan extra text.',
    transactionReminder: 'Kort bankexportvariant: följ verktygsreglerna konservativt.',
  },
  {
    id: 'review-biased',
    classificationPrefix: 'Var särskilt uppmärksam på om syfte, momsland eller affärsnytta saknas.',
    classificationSuffix: 'Om fakta saknas ska action vara needs_review, annars kategorisera.',
    transactionReminder: 'Var särskilt uppmärksam på om syfte, momsland eller affärsnytta saknas.',
  },
]

const ATOM_INDEX: AtomRegistryIndexRow[] = [
  atom('horizontal/swedish-vat', 'horizontal', 'Svensk moms', 'Momsregler, avdragsrätt, omvänd skattskyldighet och momssatser.'),
  atom('horizontal/swedish-accounting-compliance', 'horizontal', 'Bokföringskrav', 'Bokföringsskyldighet, verifikationer, underlag och arkivering.'),
  atom('horizontal/swedish-invoice-compliance', 'horizontal', 'Fakturakrav', 'Svenska faktura- och underlagskrav.'),
  atom('horizontal/swedish-year-end-closing', 'horizontal', 'Bokslut', 'Periodisering, bokslut och årsavslut.'),
  atom('horizontal/financial-reporting', 'horizontal', 'Finansiell rapportering', 'Årsredovisning och rapportering för aktiebolag.'),
  atom('horizontal/swedish-payroll', 'horizontal', 'Lön', 'Löneutbetalningar, arbetsgivardeklaration och personalskatter.'),
  atom('horizontal/tax-planning', 'horizontal', 'Skatteplanering', 'Skatteregler för ägare och aktiebolag.'),
  atom('horizontal/asset-accounting', 'horizontal', 'Anläggningstillgångar', 'Inventarier och avskrivningar.'),
  atom('vertical/konsult-it', 'vertical', 'IT-konsult', 'Tjänstebolag, konsultfakturering, mjukvara och projekt.', ['62']),
  atom('vertical/restaurant', 'vertical', 'Restaurang', 'Restaurang, livsmedel, personalliggare och flera momssatser.', ['56']),
  atom('modifier/single-shareholder-ab-fmb', 'modifier', 'Ensamägt AB', 'Fåmansbolag med en verksam ägare.'),
  atom('modifier/small-employer', 'modifier', 'Liten arbetsgivare', 'Arbetsgivare med 1 till 9 anställda.'),
  atom('modifier/enskild-firma', 'modifier', 'Enskild firma', 'Enskild näringsidkare.'),
]

const ASSISTANT_ATOM_BODIES: Record<string, string> = {
  'horizontal/swedish-vat': [
    '# Svensk moms',
    'För ett svenskt momsregistrerat aktiebolag är normal svensk ingående moms avdragsgill när inköpet hör till momspliktig verksamhet och underlaget visar svensk moms.',
    'Utländska B2B-programvarutjänster utan debiterad moms hanteras normalt med omvänd skattskyldighet när köparen är momsregistrerad.',
    'Om företaget inte är momsregistrerat ska inköp bokas brutto utan ingående eller utgående moms.',
    'Representation kräver affärssamband, deltagare och syfte. Saknas de uppgifterna ska assistenten be om komplettering i stället för att ge en definitiv behandling.',
  ].join('\n'),
  'horizontal/swedish-accounting-compliance': [
    '# Svensk bokföring',
    'En verifikation måste ha tillräckligt underlag för affärshändelsen. När avgörande fakta saknas ska svaret avgränsas eller följas av en konkret fråga.',
    'Assistenten får förklara principer utan att stagea eller utföra en bokföringsåtgärd.',
  ].join('\n'),
  'horizontal/swedish-invoice-compliance': [
    '# Fakturakrav',
    'En leverantörsfaktura bör innehålla leverantör, datum, belopp, momsuppgift och vad inköpet avser. Saknas nyckelfält ska underlag läsas eller komplettering efterfrågas.',
  ].join('\n'),
  'vertical/konsult-it': [
    '# IT-konsult',
    'För ett IT-konsultbolag är SaaS, utvecklarverktyg och molntjänster normalt rörelsekostnader för programvara när de används i uppdrag eller intern drift.',
  ].join('\n'),
  'vertical/restaurant': [
    '# Restaurang',
    'Restaurangbolag har ofta livsmedelsinköp och försäljning med reducerade momssatser. Bolagets bransch kan därför ändra vilken fråga som är relevant.',
  ].join('\n'),
  'modifier/single-shareholder-ab-fmb': [
    '# Ensamägt fåmansbolag',
    'I ett ensamägt aktiebolag ska privata kostnader och ägarrelaterade förmåner hållas tydligt isär från bolagets kostnader.',
  ].join('\n'),
  'modifier/small-employer': [
    '# Liten arbetsgivare',
    'Ett bolag med anställda behöver skilja personalkostnader från representation och privata kostnader.',
  ].join('\n'),
}

const ASSISTANT_TOOL_NAMES = [
  'gnubok_search_tools',
  'gnubok_list_skills',
  'gnubok_load_skill',
  'gnubok_remember_fact',
  'gnubok_forget_fact',
  'gnubok_get_income_statement',
  'gnubok_get_balance_sheet',
  'gnubok_get_trial_balance',
  'gnubok_get_general_ledger',
  'gnubok_get_kpi_report',
  'gnubok_get_vat_report',
  'gnubok_vat_close_check',
  'gnubok_get_ar_ledger',
  'gnubok_get_supplier_ledger',
  'gnubok_get_reconciliation_status',
  'gnubok_get_salary_journal',
  'gnubok_year_end_readiness',
  'gnubok_query_journal',
  'gnubok_list_uncategorized_transactions',
  'gnubok_list_transactions_without_documents',
  'gnubok_list_invoices',
  'gnubok_list_customers',
  'gnubok_list_suppliers',
  'gnubok_list_supplier_invoices',
  'gnubok_list_accounts',
  'gnubok_list_fiscal_periods',
  'gnubok_list_employees',
  'gnubok_list_inbox_items',
  'gnubok_list_unmatched_documents',
  'gnubok_list_voucher_gaps',
  'gnubok_explain_voucher_gap',
  'gnubok_get_inbox_item',
  'gnubok_get_document_content',
  'gnubok_get_counterparty_templates',
]

const DEFAULT_ASSISTANT_TOOL_RESULTS: Record<string, unknown> = {
  gnubok_query_journal: {
    verifikat: [
      {
        id: 'je_openai_2026_05',
        date: '2026-05-28',
        description: 'OpenAI ChatGPT subscription',
        lines: [
          { account_number: '5420', account_name: 'Programvaror', debit: 247.5, credit: 0 },
          { account_number: '2645', account_name: 'Beräknad ingående moms på förvärv från utlandet', debit: 61.88, credit: 0 },
          { account_number: '2614', account_name: 'Utgående moms omvänd skattskyldighet', debit: 0, credit: 61.88 },
          { account_number: '1930', account_name: 'Företagskonto', debit: 0, credit: 247.5 },
        ],
      },
    ],
  },
  gnubok_get_vat_report: {
    period: { type: 'quarterly', year: 2026, period: 2, label: 'Q2 2026' },
    boxes: { '05': 210000, '48': 18200, '49': -6400 },
    summary: 'Q2 visar 210000 kr momspliktig försäljning och 6400 kr att få tillbaka.',
  },
  gnubok_vat_close_check: {
    warnings: [],
    status: 'ok',
  },
  gnubok_list_uncategorized_transactions: {
    transactions: [
      { id: 'tx_eval_openai_001', date: '2026-06-28', description: 'OPENAI CHATGPT SUBSCRIPTION', amount: -247.5, document_id: 'doc_eval_openai_001' },
      { id: 'tx_eval_bistro_001', date: '2026-06-30', description: 'BISTRO SVEA STOCKHOLM', amount: -842, document_id: null },
    ],
  },
  gnubok_get_document_content: {
    document_id: 'doc_eval_openai_001',
    text: 'Receipt from OpenAI, LLC. Service: ChatGPT subscription. Supplier country US. VAT charged 0. Total 247.50 SEK.',
  },
  gnubok_load_skill: {
    id: 'horizontal/swedish-vat',
    body: ASSISTANT_ATOM_BODIES['horizontal/swedish-vat'],
  },
}

const COMPOSER_FIXTURES = [
  {
    id: 'composer_single_owner_it_consult',
    inputs: composerInput({
      companyName: 'Klara Kod AB',
      entityType: 'aktiebolag',
      companySettings: {
        city: 'Stockholm',
        moms_period: 'quarterly',
        fiscal_year_start_month: 1,
        f_skatt: true,
        vat_registered: true,
        employee_count: 0,
        has_employees: false,
        pays_salaries: false,
        accounting_method: 'accrual',
      },
      ticSnapshot: {
        legalEntityType: 'AB',
        purpose: 'Konsultverksamhet inom systemutveckling och IT.',
        registration: { fTax: true, vat: true, payroll: true },
        employeeRange: '0 anställda',
        sniCodes: [{ code: '62010', name: 'Dataprogrammering' }],
        beneficialOwners: [{ name: 'Test Person', extentDescription: 'Mer än 75 procent' }],
        payrolls: [],
        fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
      },
      bankingSummary: {
        monthly_volume: 80_000,
        unbooked_count: 2,
        top_counterparties: [
          { name: 'ACME AB', abs_amount: 560_000, direction: 'in', has_unbooked: false },
          { name: 'GitHub', abs_amount: 9_600, direction: 'out', has_unbooked: true },
        ],
      },
    }),
    requiredAtoms: ['horizontal/swedish-vat', 'modifier/single-shareholder-ab-fmb'],
    forbiddenAtoms: ['horizontal/swedish-payroll'],
    forbiddenQuestionWords: ['momsperiod', 'anställda', 'ensamägare', 'vem äger'],
  },
  {
    id: 'composer_restaurant_small_employer',
    inputs: composerInput({
      companyName: 'Svea Lunch AB',
      entityType: 'aktiebolag',
      companySettings: {
        city: 'Malmö',
        moms_period: 'monthly',
        fiscal_year_start_month: 1,
        f_skatt: true,
        vat_registered: true,
        employee_count: 4,
        has_employees: true,
        pays_salaries: true,
        accounting_method: 'cash',
      },
      ticSnapshot: {
        legalEntityType: 'AB',
        purpose: 'Restaurangverksamhet och catering.',
        registration: { fTax: true, vat: true, payroll: true },
        employeeRange: '1-4 anställda',
        sniCodes: [{ code: '56100', name: 'Restaurangverksamhet' }],
        beneficialOwners: [
          { name: 'Person A', extentDescription: '25 till 50 procent' },
          { name: 'Person B', extentDescription: '25 till 50 procent' },
        ],
        payrolls: [{ period: '2026-05', payroll2: [{ employeeCount: 4 }] }],
      },
      bankingSummary: {
        monthly_volume: 210_000,
        unbooked_count: 6,
        top_counterparties: [
          { name: 'Martin Servera', abs_amount: 330_000, direction: 'out', has_unbooked: true },
          { name: 'Foodora', abs_amount: 180_000, direction: 'in', has_unbooked: false },
        ],
      },
    }),
    requiredAtoms: ['horizontal/swedish-payroll', 'modifier/small-employer'],
    forbiddenAtoms: ['modifier/single-shareholder-ab-fmb'],
    forbiddenQuestionWords: ['momsperiod', 'hur många anställda', 'vem äger'],
  },
]

const ASSISTANT_COMPANIES = {
  itConsult: assistantCompany({
    companyId: 'company_assistant_it',
    companyName: 'Klara Kod AB',
    firstName: 'Klara',
    profileSummary: 'Svenskt momsregistrerat aktiebolag. IT-konsult inom systemutveckling. Kvartalsmoms. En verksam ägare.',
    vatStatus: { vat_registered: true, vat_number: 'SE559999999901' },
    memory: [
      { id: 'mem_openai', kind: 'pattern', content: 'OpenAI används som utvecklarverktyg och har tidigare bokförts som programvara med omvänd skattskyldighet.' },
    ],
    composerInputs: composerInput({
      companyId: 'company_assistant_it',
      companyName: 'Klara Kod AB',
      entityType: 'aktiebolag',
      companySettings: {
        city: 'Stockholm',
        moms_period: 'quarterly',
        fiscal_year_start_month: 1,
        f_skatt: true,
        vat_registered: true,
        employee_count: 0,
        has_employees: false,
        pays_salaries: false,
        accounting_method: 'accrual',
      },
      ticSnapshot: {
        legalEntityType: 'AB',
        purpose: 'Konsultverksamhet inom systemutveckling och IT.',
        registration: { fTax: true, vat: true, payroll: true },
        employeeRange: '0 anställda',
        sniCodes: [{ code: '62010', name: 'Dataprogrammering' }],
        beneficialOwners: [{ name: 'Klara Test', extentDescription: 'Mer än 75 procent' }],
        payrolls: [],
        fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
      },
      bankingSummary: {
        monthly_volume: 95_000,
        unbooked_count: 2,
        top_counterparties: [{ name: 'OpenAI', abs_amount: 2475, direction: 'out', has_unbooked: true }],
      },
    }),
  }),
  nonVat: assistantCompany({
    companyId: 'company_assistant_nonvat',
    companyName: 'Nollmoms Design AB',
    firstName: 'Nora',
    profileSummary: 'Svenskt aktiebolag som inte är momsregistrerat enligt company_settings. Konsultverksamhet i liten skala.',
    vatStatus: { vat_registered: false, vat_number: null },
    memory: [],
    composerInputs: composerInput({
      companyId: 'company_assistant_nonvat',
      companyName: 'Nollmoms Design AB',
      entityType: 'aktiebolag',
      companySettings: {
        city: 'Göteborg',
        moms_period: 'yearly',
        fiscal_year_start_month: 1,
        f_skatt: true,
        vat_registered: false,
        employee_count: 0,
        has_employees: false,
        pays_salaries: false,
        accounting_method: 'cash',
      },
      ticSnapshot: {
        legalEntityType: 'AB',
        purpose: 'Konsultverksamhet inom design och kommunikation.',
        registration: { fTax: true, vat: false, payroll: false },
        employeeRange: '0 anställda',
        sniCodes: [{ code: '74102', name: 'Grafisk designverksamhet' }],
        beneficialOwners: [{ name: 'Nora Test', extentDescription: 'Mer än 75 procent' }],
        payrolls: [],
        fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
      },
      bankingSummary: null,
    }),
  }),
}

const ASSISTANT_FIXTURES: AssistantFixture[] = [
  {
    id: 'assistant_straightforward_vat_answer',
    description: 'Straight accounting question answerable from supplied VAT and company atoms.',
    intentId: 'vat.review',
    intentArgs: { period_type: 'quarterly', year: 2026, period: 2 },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    expectedSelectedAtoms: ['horizontal/swedish-vat', 'vertical/konsult-it', 'modifier/single-shareholder-ab-fmb'],
    turns: [{
      user: 'Kan jag dra av svensk moms på ett kontorsinköp som hör till konsultverksamheten?',
      requiredConcepts: [
        { id: 'vat_registered_required', anyOf: ['momsregistrerat', 'momsregistrerad'] },
        { id: 'deductible_input_vat', anyOf: ['avdragsgill', 'dra av', 'ingående moms'] },
      ],
      forbiddenClaims: ['inte momsregistrerat', 'brutto utan moms'],
      forbiddenTools: ['gnubok_approve_supplier_invoice', 'gnubok_categorize_transaction'],
    }],
  },
  {
    id: 'assistant_missing_representation_clarification',
    description: 'Missing representation facts should trigger one focused clarification.',
    intentId: 'general.help',
    intentArgs: { route: '/transactions' },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [{
      user: 'Jag betalade lunch på Bistro Svea för 842 kr. Hur ska det hanteras?',
      clarificationRequired: true,
      requiredConcepts: [
        { id: 'asks_purpose_or_attendees', anyOf: ['syfte', 'deltagare', 'vem', 'kund'] },
      ],
      forbiddenClaims: ['definitivt avdragsgill', 'bokför den som representation', 'stagead'],
      forbiddenTools: ['gnubok_remember_fact'],
    }],
  },
  {
    id: 'assistant_second_turn_completes_after_clarification',
    description: 'Second turn supplies missing representation facts and answer should incorporate them.',
    intentId: 'general.help',
    intentArgs: { route: '/transactions' },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [
      {
        user: 'Jag betalade lunch på Bistro Svea för 842 kr. Hur ska det hanteras?',
        clarificationRequired: true,
        requiredConcepts: [{ id: 'asks_purpose_or_attendees', anyOf: ['syfte', 'deltagare', 'kund'] }],
        forbiddenClaims: ['definitivt avdragsgill', 'bokför den som representation'],
      },
      {
        user: 'Det var projektkickoff med kunden ACME, två från oss och två från kunden.',
        shouldIncorporate: ['ACME', 'projektkickoff'],
        requiredConcepts: [
          { id: 'representation_possible', anyOf: ['representation', 'affärssamband'] },
          { id: 'still_no_staging', anyOf: ['kan inte stagea härifrån', 'rätt vy', 'underlag'] },
        ],
        forbiddenClaims: ['saknas syfte', 'saknas deltagare'],
      },
    ],
  },
  {
    id: 'assistant_user_corrects_premise',
    description: 'Correction in a later turn must override an earlier premise.',
    intentId: 'general.help',
    intentArgs: { route: '/chat' },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [
      {
        user: 'Jag köpte Adobe för privat bruk med bolagskortet. Är det en programvarukostnad?',
        requiredConcepts: [{ id: 'private_not_software', anyOf: ['privat', 'inte som programvara', 'ägarkostnad'] }],
        forbiddenClaims: ['programvarukostnad för bolaget'],
      },
      {
        user: 'Rättelse: det var inte privat, det är licensen vi använder i kundprojekt.',
        shouldIncorporate: ['kundprojekt', 'inte privat'],
        requiredConcepts: [{ id: 'corrected_to_business', anyOf: ['programvara', 'rörelsekostnad', 'bolagets kostnad'] }],
        forbiddenClaims: ['privat bruk', 'inte avdragsgill för bolaget'],
      },
    ],
  },
  {
    id: 'assistant_tool_call_interpretation',
    description: 'Requires a read tool call and interpretation of its result.',
    intentId: 'general.help',
    intentArgs: { route: '/reports' },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [{
      user: 'Vad visar momsrapporten för Q2 2026?',
      toolResults: {
        gnubok_get_vat_report: DEFAULT_ASSISTANT_TOOL_RESULTS.gnubok_get_vat_report,
      },
      allowedTools: ['gnubok_get_vat_report', 'gnubok_vat_close_check'],
      requiredTools: ['gnubok_get_vat_report'],
      requiredToolArgs: { gnubok_get_vat_report: { period_type: 'quarterly', year: 2026, period: 2 } },
      requiredConcepts: [
        { id: 'q2_period', anyOf: ['Q2 2026', 'kvartal 2'] },
        { id: 'vat_result', anyOf: ['6400', '6 400', 'få tillbaka'] },
      ],
    }],
  },
  {
    id: 'assistant_explanation_no_action',
    description: 'Explanation request must not stage or execute accounting action.',
    intentId: 'general.help',
    intentArgs: { route: '/chat' },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [{
      user: 'Förklara skillnaden mellan ingående och utgående moms. Gör ingen bokning.',
      forbiddenActions: ['staged_operation'],
      forbiddenTools: ['gnubok_approve_supplier_invoice', 'gnubok_categorize_transaction'],
      requiredConcepts: [
        { id: 'input_vat', anyOf: ['ingående moms'] },
        { id: 'output_vat', anyOf: ['utgående moms'] },
      ],
    }],
  },
  {
    id: 'assistant_company_context_changes_answer',
    description: 'Company VAT status changes the VAT answer.',
    intentId: 'vat.review',
    intentArgs: { period_type: 'quarterly', year: 2026, period: 2 },
    company: ASSISTANT_COMPANIES.nonVat,
    oracleAtoms: { vertical: [], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [{
      user: 'Kan jag lyfta ingående moms på ett svenskt inköp?',
      requiredConcepts: [
        { id: 'non_vat_registered', anyOf: ['inte momsregistrerat', 'inte momsregistrerad'] },
        { id: 'gross_booking', anyOf: ['brutto', 'ingen ingående moms', 'utan momsrad'] },
      ],
      forbiddenClaims: ['dra av ingående moms', 'avdragsgill ingående moms'],
    }],
  },
  {
    id: 'assistant_irrelevant_history_ignored',
    description: 'Irrelevant conversation history must not alter the answer.',
    intentId: 'general.help',
    intentArgs: { route: '/chat' },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [{
      seedHistory: [
        textMessage('user', 'Min kompis driver frisörsalong och pratade om hårvårdsprodukter.'),
        textMessage('assistant', 'Det låter som en annan verksamhet än ditt bolag.'),
      ],
      user: 'Hur brukar OpenAI-kostnaden hanteras för mitt bolag?',
      requiredConcepts: [
        { id: 'openai_software', anyOf: ['programvara', 'utvecklarverktyg', 'SaaS'] },
        { id: 'reverse_charge_or_history', anyOf: ['omvänd skattskyldighet', 'tidigare bokförts'] },
      ],
      forbiddenClaims: ['frisör', 'hårvård', 'salong'],
    }],
  },
  {
    id: 'assistant_declines_definite_when_insufficient',
    description: 'Must explicitly decline a definite treatment when production context is insufficient.',
    intentId: 'general.help',
    intentArgs: { route: '/transactions' },
    company: ASSISTANT_COMPANIES.itConsult,
    oracleAtoms: { vertical: ['vertical/konsult-it'], modifiers: ['modifier/single-shareholder-ab-fmb'] },
    turns: [{
      user: 'Amazon MKTPL drog 1437 kr och jag har inget kvitto. Säg exakt konto och moms.',
      clarificationRequired: true,
      requiredConcepts: [
        { id: 'declines_definite', anyOf: ['kan inte säga exakt', 'räcker inte', 'behöver underlag', 'kan inte ge en säker'] },
      ],
      forbiddenClaims: ['konto 5410', 'standard_25', '25 % moms', 'definitivt'],
    }],
  },
]

const TRANSACTION_FIXTURES = [
  {
    id: 'transaction_known_software_subscription',
    expectedTransactionId: 'tx_software_001',
    expectedCategory: 'expense_software',
    expectedVatTreatment: 'reverse_charge',
    mustCallCategorize: true,
    mustCallQueryJournal: false,
    mustAskOrRetrieve: false,
    messages: transactionMessages({
      transaction: {
        id: 'tx_software_001',
        date: '2026-06-28',
        description: 'OPENAI CHATGPT SUBSCRIPTION 240628',
        amount: -247.5,
        currency: 'SEK',
        counterparty_name: 'OpenAI',
        direction: 'out',
      },
      underlag: [{
        kind: 'receipt',
        document_id: 'doc_openai_001',
        merchant_name: 'OpenAI, LLC',
        receipt_date: '2026-06-28',
        total_amount: 247.5,
        vat_amount: 0,
        currency: 'SEK',
        is_restaurant: false,
        is_systembolaget: false,
        raw_extraction: { supplier: { country: 'US' }, invoice: { description: 'ChatGPT subscription' } },
      }],
      queryText: 'OpenAI',
      queryResult: {
        verifikat: [
          {
            date: '2026-05-28',
            description: 'OpenAI ChatGPT subscription',
            lines: [
              { account_number: '5420', debit: 247.5, credit: 0 },
              { account_number: '1930', debit: 0, credit: 247.5 },
            ],
          },
        ],
      },
    }),
  },
  {
    id: 'transaction_known_software_must_retrieve_history',
    expectedTransactionId: 'tx_software_lookup_001',
    expectedCategory: null,
    expectedVatTreatment: null,
    mustCallCategorize: false,
    mustCallQueryJournal: true,
    mustAskOrRetrieve: true,
    messages: [transactionPromptMessage({
      profileSummary: 'Svenskt aktiebolag, kvartalsmoms, konsultverksamhet inom IT.',
      transaction: {
        id: 'tx_software_lookup_001',
        date: '2026-07-02',
        description: 'OPENAI CHATGPT SUBSCRIPTION 260702',
        amount: -247.5,
        currency: 'SEK',
        counterparty_name: 'OpenAI',
        direction: 'out',
      },
      underlag: [{
        kind: 'receipt',
        document_id: 'doc_openai_lookup_001',
        merchant_name: 'OpenAI, LLC',
        receipt_date: '2026-07-02',
        total_amount: 247.5,
        vat_amount: 0,
        currency: 'SEK',
        is_restaurant: false,
        is_systembolaget: false,
        raw_extraction: { supplier: { country: 'US' }, invoice: { description: 'ChatGPT subscription' } },
      }],
    })],
  },
  {
    id: 'transaction_restaurant_requires_context',
    expectedTransactionId: 'tx_restaurant_001',
    expectedCategory: null,
    expectedVatTreatment: null,
    mustCallCategorize: false,
    mustCallQueryJournal: false,
    mustAskOrRetrieve: true,
    messages: [transactionPromptMessage({
      profileSummary: 'Litet konsultaktiebolag med svensk moms.',
      transaction: {
        id: 'tx_restaurant_001',
        date: '2026-06-30',
        description: 'BISTRO SVEA STOCKHOLM',
        amount: -842,
        currency: 'SEK',
        counterparty_name: 'Bistro Svea',
        direction: 'out',
      },
      underlag: [{
        kind: 'receipt',
        document_id: 'doc_bistro_001',
        merchant_name: 'Bistro Svea',
        receipt_date: '2026-06-30',
        total_amount: 842,
        vat_amount: 90.21,
        currency: 'SEK',
        is_restaurant: true,
        is_systembolaget: false,
        raw_extraction: { lineItems: [{ text: 'Lunch och dryck' }] },
      }],
    })],
  },
]

const QUEUED_CLASSIFICATION_FIXTURES = [
  {
    id: 'classification_domestic_office_supplies_standard_vat',
    expectedTransactionId: 'txq_office_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_office',
    expectedVatTreatment: 'standard_25',
    prompt: [
      'Transaction txq_office_001',
      'Company: Swedish VAT-registered IT consultancy AB.',
      'Bank row: KONTORSGIGANTEN AB, amount -625 SEK, counterparty Kontorsgiganten.',
      'Receipt: printer paper, envelopes and pens for the office, Swedish supplier, total 625 SEK, VAT amount 125 SEK.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_eu_reverse_charge_software',
    expectedTransactionId: 'txq_figma_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_software',
    expectedVatTreatment: 'reverse_charge',
    prompt: [
      'Transaction txq_figma_001',
      'Company: Swedish VAT-registered IT consultancy AB with valid SE VAT number.',
      'Bank row: FIGMA IRELAND LIMITED, amount -189 EUR, counterparty Figma.',
      'Invoice: Figma Ireland Limited, supplier country IE, B2B SaaS subscription, reverse charge stated, VAT amount 0.',
      'History: previous Figma invoices were booked as software subscriptions with reverse charge.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_known_software_subscription_reverse_charge',
    expectedTransactionId: 'txq_software_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_software',
    expectedVatTreatment: 'reverse_charge',
    prompt: [
      'Transaction txq_software_001',
      'Company: Swedish VAT-registered IT consultancy AB.',
      'Bank row: OPENAI CHATGPT SUBSCRIPTION, amount -247.50 SEK, counterparty OpenAI.',
      'Receipt: OpenAI, LLC, supplier country US, digital software subscription, total 247.50 SEK, VAT amount 0 SEK.',
      'History: previous OpenAI subscriptions were booked as software subscriptions.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_domestic_telecom_standard_vat',
    expectedTransactionId: 'txq_tele2_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_telecom',
    expectedVatTreatment: 'standard_25',
    prompt: [
      'Transaction txq_tele2_001',
      'Company: Swedish VAT-registered AB.',
      'Bank row: TELE2 SVERIGE AB, amount -399 SEK.',
      'Invoice: mobile broadband subscription used by the company, Swedish VAT 79.80 SEK on total 399 SEK.',
      'History: previous Tele2 invoices were telecom costs.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_bank_fee_exempt',
    expectedTransactionId: 'txq_bank_fee_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_bank_fees',
    expectedVatTreatment: 'exempt',
    prompt: [
      'Transaction txq_bank_fee_001',
      'Company: Swedish VAT-registered AB.',
      'Bank row: BANKGIRO SERVICEAVGIFT, amount -59 SEK, counterparty Bankgirot.',
      'Receipt/support: bank fee notice, no VAT charged.',
      'History: previous Bankgirot service fees were bank fees.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_representation_with_required_context',
    expectedTransactionId: 'txq_representation_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_representation',
    expectedVatTreatment: 'reduced_12',
    prompt: [
      'Transaction txq_representation_001',
      'Company: Swedish VAT-registered IT consultancy AB.',
      'Bank row: RESTAURANG PRINSEN, amount -1280 SEK.',
      'Receipt: business lunch, food only, total 1280 SEK, VAT amount 137.14 SEK, restaurant=true.',
      'Context captured from user: 4 attendees, 2 from the company and 2 from customer ACME AB, purpose was project kickoff for signed implementation contract.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_restaurant_requires_review',
    expectedTransactionId: 'txq_restaurant_001',
    expectedAction: 'needs_review',
    expectedCategory: null,
    expectedVatTreatment: null,
    prompt: [
      'Transaction txq_restaurant_001',
      'Company: Swedish VAT-registered IT consultancy AB.',
      'Bank row: BISTRO SVEA STOCKHOLM, amount -842 SEK.',
      'Receipt: Bistro Svea, lunch and drinks, total 842 SEK, VAT amount 90.21 SEK, restaurant=true.',
      'No attendee, customer, staff, travel, or business purpose is visible.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_mixed_private_business_requires_review',
    expectedTransactionId: 'txq_mixed_001',
    expectedAction: 'needs_review',
    expectedCategory: null,
    expectedVatTreatment: null,
    prompt: [
      'Transaction txq_mixed_001',
      'Company: Swedish VAT-registered consultant AB.',
      'Bank row: APPLE STORE TÄBY, amount -14990 SEK.',
      'Receipt: iPhone and AirPods, Swedish VAT shown.',
      'No note says whether the phone is company equipment, private use, mixed use, or a benefit.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_equipment_near_capitalization_boundary_requires_review',
    expectedTransactionId: 'txq_laptop_cap_001',
    expectedAction: 'needs_review',
    expectedCategory: null,
    expectedVatTreatment: null,
    prompt: [
      'Transaction txq_laptop_cap_001',
      'Company: Swedish VAT-registered AB.',
      'Bank row: DUSTIN AB, amount -29875 SEK.',
      'Invoice: laptop workstation, Swedish VAT amount 5975 SEK, expected useful life more than 3 years.',
      'No accounting policy threshold or decision is visible for immediate expense versus capitalization.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_low_value_equipment_standard_vat',
    expectedTransactionId: 'txq_keyboard_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_equipment',
    expectedVatTreatment: 'standard_25',
    prompt: [
      'Transaction txq_keyboard_001',
      'Company: Swedish VAT-registered AB.',
      'Bank row: WEBBHALLEN SVERIGE, amount -990 SEK.',
      'Receipt: keyboard for office workstation, Swedish VAT amount 198 SEK, no private-use indication.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_ambiguous_merchant_requires_review',
    expectedTransactionId: 'txq_amazon_001',
    expectedAction: 'needs_review',
    expectedCategory: null,
    expectedVatTreatment: null,
    prompt: [
      'Transaction txq_amazon_001',
      'Company: Swedish VAT-registered AB.',
      'Bank row: AMAZON MKTPL*Z92LP, amount -1437 SEK.',
      'No receipt lines, supplier country, product type, VAT amount, or business purpose are visible.',
      'History contains mixed Amazon purchases: office supplies, private reimbursements, and computer accessories.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_misleading_history_receipt_wins',
    expectedTransactionId: 'txq_history_mislead_001',
    expectedAction: 'categorize',
    expectedCategory: 'expense_education',
    expectedVatTreatment: 'standard_25',
    prompt: [
      'Transaction txq_history_mislead_001',
      'Company: Swedish VAT-registered IT consultancy AB.',
      'Bank row: BREAKIT AB, amount -3490 SEK.',
      'Receipt: ticket to professional developer conference in Stockholm, Swedish VAT amount 698 SEK.',
      'History: older Breakit payments were marketing ads, but this invoice line is explicitly a conference ticket.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_duplicate_looking_requires_review',
    expectedTransactionId: 'txq_duplicate_001',
    expectedAction: 'needs_review',
    expectedCategory: null,
    expectedVatTreatment: null,
    prompt: [
      'Transaction txq_duplicate_001',
      'Company: Swedish VAT-registered AB.',
      'Bank row: ADOBE SYSTEMS, amount -240 SEK, date 2026-06-30.',
      'Receipt: Adobe subscription, total 240 SEK, VAT amount 0, supplier country IE.',
      'System context: another unbooked transaction from ADOBE SYSTEMS for -240 SEK exists on 2026-06-30 with the same receipt number.',
      'Classify for queued staging.',
    ].join('\n'),
  },
  {
    id: 'classification_systembolaget_requires_review',
    expectedTransactionId: 'txq_systembolaget_001',
    expectedAction: 'needs_review',
    expectedCategory: null,
    expectedVatTreatment: null,
    prompt: [
      'Transaction txq_systembolaget_001',
      'Company: Swedish VAT-registered AB.',
      'Bank row: SYSTEMBOLAGET 0134, amount -318 SEK.',
      'Receipt: wine and beer, total 318 SEK, VAT amount 63.60 SEK, systembolaget=true.',
      'No event, representation purpose, gift purpose, or attendees are visible.',
      'Classify for queued staging.',
    ].join('\n'),
  },
]

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.models.length === 0) {
    const configured = process.env.LOCAL_AI_MODEL?.trim()
    if (configured) options.models.push(firstModelToken(configured))
  }
  if (options.models.length === 0) {
    throw new Error('Set LOCAL_AI_MODEL or pass --models model-a,model-b.')
  }
  if (!options.dryRun && !process.env.LOCAL_AI_BASE_URL?.trim()) {
    throw new Error('Set LOCAL_AI_BASE_URL to an OpenAI-compatible local endpoint.')
  }
  process.env.AI_PROVIDER = 'local'

  const persistence = options.persist ? await initPersistence(options.resultsDir, options.resume) : null
  const planned = planCases(options)
  if (options.dryRun) {
    printDryRunPlan(planned, persistence)
    return
  }
  if (persistence && !options.json) {
    console.log(`Persisting eval results to ${persistence.attemptsPath}`)
    console.log(`Case manifest: ${persistence.manifestPath}`)
    if (options.resume) {
      console.log(`Resume index: ${persistence.completedAttempts.size} completed attempts`)
    }
  }

  const results: EvalResult[] = []
  const skips: EvalSkip[] = []
  const collect = async (promise: Promise<EvalOutcome>) => {
    const row = await promise
    if ('kind' in row && row.kind === 'skip') {
      skips.push(row)
      if (!options.json) {
        console.log(`SKIP ${row.model} ${row.group}/${row.id} run=${row.run} variant=${row.variant}`)
      }
      return
    }
    const result = row as EvalResult
    results.push(result)
    await appendAttemptResult(persistence, result)
  }

  for (const model of options.models) {
    process.env.LOCAL_AI_MODEL = model
    const provider = getModelProvider()
    if (provider.name !== 'local-openai-compatible') {
      throw new Error(`Expected local-openai-compatible provider, got ${provider.name}.`)
    }

    for (let run = 1; run <= options.runs; run++) {
      const variant = EVAL_VARIANTS[(run - 1) % EVAL_VARIANTS.length]
      if (options.groups.has('smoke')) {
        await collect(runSmokeStructured(provider, model, run, variant, persistence))
        await collect(runSmokeTool(provider, model, run, variant, persistence))
      }
      if (options.groups.has('composer')) {
        for (const fixture of COMPOSER_FIXTURES) {
          await collect(runComposerFixture(provider, model, fixture, run, variant, persistence))
        }
      }
      if (options.groups.has('assistant')) {
        for (const fixture of ASSISTANT_FIXTURES) {
          await collect(runAssistantFixture(provider, model, fixture, 'oracle-context', run, variant, persistence))
          await collect(runAssistantFixture(provider, model, fixture, 'end-to-end', run, variant, persistence))
        }
      }
      if (options.groups.has('transaction')) {
        for (const fixture of TRANSACTION_FIXTURES) {
          await collect(runTransactionFixture(provider, model, fixture, run, variant, persistence))
        }
      }
      if (options.groups.has('classification')) {
        for (const fixture of QUEUED_CLASSIFICATION_FIXTURES) {
          await collect(runQueuedClassificationFixture(provider, model, fixture, run, variant, persistence))
        }
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ summaries: summarize(results), results, skipped: skips }, null, 2))
    return
  }

  if (skips.length > 0) {
    console.log(`\nSkipped completed attempts: ${skips.length}`)
  }
  printHumanSummary(results)
}

async function runSmokeStructured(
  provider: ModelProvider,
  model: string,
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalOutcome> {
  const request = {
    model: SONNET_MODEL,
    maxTokens: 256,
    system: [
      'You are testing a strict model-provider contract.',
      'Use the provided tool exactly once. Do not write prose.',
    ].join('\n'),
    messages: [
      textMessage(
        'user',
        'Classify transaction tx_smoke_software. Description: "Linear.app subscription". Amount: -120 SEK. Return category expense_software and needs_review false.',
      ),
    ],
  }
  const caseDef = await defineCase(persistence, 'smoke', 'smoke_generate_structured', variant, {
    request: withoutModel(request),
    structured_schema: SMOKE_STRUCTURED_TOOL_SCHEMA,
    expected: {
      transaction_id: 'tx_smoke_software',
      category: 'expense_software',
    },
    scoring: ['valid_structured_output', 'correct_transaction_id', 'correct_category'],
  })
  const skipped = skippedCompletedAttempt(persistence, model, caseDef, run, variant)
  if (skipped) return skipped
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_structured_output: false,
    correct_transaction_id: false,
    correct_category: false,
  }

  try {
    const output = await provider.generateStructured<unknown>(request, SMOKE_STRUCTURED_TOOL_SCHEMA)
    const parsed = SmokeStructuredSchema.safeParse(output)
    checks.valid_structured_output = parsed.success
    if (!parsed.success) {
      notes.push(parsed.error.message)
    } else {
      checks.correct_transaction_id = parsed.data.transaction_id === 'tx_smoke_software'
      checks.correct_category = parsed.data.category === 'expense_software'
    }
  } catch (err) {
    notes.push(errorMessage(err))
  }

  return result(model, caseDef, run, variant, started, checks, notes)
}

async function runSmokeTool(
  provider: ModelProvider,
  model: string,
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalOutcome> {
  const request = {
    model: SONNET_MODEL,
    maxTokens: 512,
    system: [{ kind: 'text' as const, text: 'Call gnubok_categorize_transaction exactly once. Do not answer in prose.' }],
    messages: [
      textMessage(
        'user',
        'Transaction tx_smoke_tool is a -59 SEK bank fee. Stage it as expense_bank_fees.',
      ),
    ],
    tools: [CATEGORIZE_TOOL],
  }
  const caseDef = await defineCase(persistence, 'smoke', 'smoke_stream_with_tools', variant, {
    request: {
      ...withoutModel(request),
      tools: request.tools.map(normalizeTool),
    },
    expected: {
      tool_name: 'gnubok_categorize_transaction',
      transaction_id: 'tx_smoke_tool',
      category: 'expense_bank_fees',
    },
    scoring: ['valid_tool_call', 'allowed_tool_name', 'correct_transaction_id', 'correct_category'],
  })
  const skipped = skippedCompletedAttempt(persistence, model, caseDef, run, variant)
  if (skipped) return skipped
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_tool_call: false,
    allowed_tool_name: false,
    correct_transaction_id: false,
    correct_category: false,
  }

  try {
    const response = await provider.streamWithTools(request)
    const call = firstToolCall(response.content)
    checks.valid_tool_call = !!call
    if (!call) {
      notes.push(`No tool call returned. stopReason=${response.stopReason}`)
    } else {
      checks.allowed_tool_name = call.name === 'gnubok_categorize_transaction'
      checks.correct_transaction_id = call.input.transaction_id === 'tx_smoke_tool'
      checks.correct_category = call.input.category === 'expense_bank_fees'
      notes.push(`tool=${call.name} input=${JSON.stringify(call.input)}`)
    }
  } catch (err) {
    notes.push(errorMessage(err))
  }

  return result(model, caseDef, run, variant, started, checks, notes)
}

async function runComposerFixture(
  provider: ModelProvider,
  model: string,
  fixture: (typeof COMPOSER_FIXTURES)[number],
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalOutcome> {
  const caseDef = await defineCase(persistence, 'composer', fixture.id, variant, {
    system: ATOM_SELECTION_SYSTEM_PROMPT,
    user_prompt: buildAtomSelectionUserPrompt(fixture.inputs),
    structured_schema: {
      name: 'compose_agent_profile',
      schema: ATOM_SELECTION_TOOL_SCHEMA,
    },
    expected: {
      required_atoms: fixture.requiredAtoms,
      forbidden_atoms: fixture.forbiddenAtoms,
      forbidden_question_words: fixture.forbiddenQuestionWords,
    },
    scoring: [
      'raw_valid_structured_output',
      'final_valid_structured_output',
      'raw_required_atoms_present',
      'final_required_atoms_present',
      'raw_forbidden_atoms_absent',
      'final_forbidden_atoms_absent',
      'no_redundant_questions',
      'raw_unknown_atoms_absent',
      'final_unknown_atoms_absent',
    ],
  })
  const skipped = skippedCompletedAttempt(persistence, model, caseDef, run, variant)
  if (skipped) return skipped
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    raw_valid_structured_output: false,
    final_valid_structured_output: false,
    raw_required_atoms_present: false,
    final_required_atoms_present: false,
    raw_forbidden_atoms_absent: false,
    final_forbidden_atoms_absent: false,
    no_redundant_questions: false,
    raw_unknown_atoms_absent: false,
    final_unknown_atoms_absent: false,
  }
  const stages: Record<string, unknown> = {}

  try {
    const raw = await generateRawAtomSelection(fixture.inputs, provider)
    stages.raw_model_output = raw
    const rawParsed = AtomSelectionSchema.safeParse(raw)
    checks.raw_valid_structured_output = rawParsed.success
    if (!rawParsed.success) {
      notes.push(`raw_error=${rawParsed.error.message}`)
    } else {
      const rawChecks = gradeAtomSelection(rawParsed.data, fixture)
      checks.raw_required_atoms_present = rawChecks.requiredAtomsPresent
      checks.raw_forbidden_atoms_absent = rawChecks.forbiddenAtomsAbsent
      checks.raw_unknown_atoms_absent = rawChecks.unknownAtomsAbsent
      stages.validated_model_output = rawParsed.data
    }

    const final = finalizeAtomSelection(raw, fixture.inputs)
    stages.final_product_output = final
    const finalParsed = AtomSelectionSchema.safeParse(final)
    checks.final_valid_structured_output = finalParsed.success
    if (!finalParsed.success) {
      notes.push(`final_error=${finalParsed.error.message}`)
    } else {
      const finalChecks = gradeAtomSelection(finalParsed.data, fixture)
      checks.final_required_atoms_present = finalChecks.requiredAtomsPresent
      checks.final_forbidden_atoms_absent = finalChecks.forbiddenAtomsAbsent
      checks.final_unknown_atoms_absent = finalChecks.unknownAtomsAbsent
      checks.no_redundant_questions = finalChecks.noRedundantQuestions
      notes.push(`raw_atoms=${rawParsed.success ? selectedAtomIds(rawParsed.data).join(', ') || '(none)' : '(invalid)'}`)
      notes.push(`final_atoms=${selectedAtomIds(finalParsed.data).join(', ') || '(none)'}`)
      notes.push(`final_questions=${finalParsed.data.verification_questions.join(' | ') || '(none)'}`)
    }
  } catch (err) {
    notes.push(errorMessage(err))
  }

  return result(model, caseDef, run, variant, started, checks, notes, {
    failures: composerFailures(checks),
    stages,
  })
}

async function runAssistantFixture(
  provider: ModelProvider,
  model: string,
  fixture: AssistantFixture,
  mode: AssistantEvalMode,
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalOutcome> {
  const intent = getIntent(fixture.intentId)
  if (!intent) throw new Error(`Assistant fixture ${fixture.id} references unknown intent ${fixture.intentId}.`)

  const notes: string[] = []
  const stages: Record<string, unknown> = { mode, turns: [] }
  const selectedAtoms = await resolveAssistantAtoms(provider, fixture, mode, stages, notes)
  const supabase = new FixtureSupabase(fixture, selectedAtoms)
  const captured = await intent.capture(fixture.intentArgs, {
    supabase: supabase as never,
    userId: 'user_eval',
    companyId: fixture.company.companyId,
  })
  const promptMessage = intent.promptTemplate({
    captured,
    profileSummary: fixture.company.profileSummary,
    activeMemory: fixture.company.memory.map((m) => ({ content: m.content })),
  })
  const evalToday = swedishToday()
  const systemPrompt = await buildSystemPrompt({
    intent,
    companyId: fixture.company.companyId,
    companyName: fixture.company.companyName,
    firstName: fixture.company.firstName,
    profileSummary: fixture.company.profileSummary,
    rankedMemory: fixture.company.memory,
    vatStatus: fixture.company.vatStatus,
    today: evalToday,
    supabase: supabase as never,
  })
  const exposedTools = fixtureAssistantTools(intent, fixture.turns[0]?.toolResults)
  const caseDef = await defineCase(persistence, 'assistant', `${fixture.id}:${mode}`, variant, {
    eval_context: assistantEvalContext(evalToday),
    mode,
    description: fixture.description,
    request_context: {
      intent_id: intent.id,
      intent_args: fixture.intentArgs,
      captured,
      system: normalizeSystemBlocks(systemPrompt.blocks),
      prompt_hash: systemPrompt.promptHash,
      atoms_loaded: systemPrompt.atomsLoaded,
      initial_user_prompt: promptMessage,
      company: fixture.company,
      selected_atoms: selectedAtoms,
      tools: exposedTools.map(normalizeTool),
    },
    scenario_turns: fixture.turns,
    expected: {
      selected_atoms: fixture.expectedSelectedAtoms,
      oracle_atoms: fixture.oracleAtoms,
    },
    scoring: [
      'assistant_context_built',
      'selected_atoms_valid',
      'allowed_tool_calls',
      'required_tool_calls',
      'correct_tool_args',
      'forbidden_actions_absent',
      'clarification_behavior',
      'later_turn_incorporated',
      'required_facts_present',
      'forbidden_claims_absent',
      'grounded_in_atoms',
      'manual_review_payload_emitted',
    ],
  }, {
    evalContext: assistantEvalContext(evalToday),
    logicalPreimage: assistantLogicalPreimageFromRendered({
      group: 'assistant',
      caseId: `${fixture.id}:${mode}`,
      mode,
      description: fixture.description,
      requestContext: {
        intent_id: intent.id,
        intent_args: fixture.intentArgs,
        company: fixture.company,
        tools: exposedTools.map(normalizeTool),
      },
      scenarioTurns: fixture.turns,
      expected: {
        selected_atoms: fixture.expectedSelectedAtoms,
        oracle_atoms: fixture.oracleAtoms,
      },
    }),
  })
  const skipped = skippedCompletedAttempt(persistence, model, caseDef, run, { id: `${variant.id}:${mode}` })
  if (skipped) return skipped

  const started = performance.now()
  const checks: Record<string, boolean> = {
    assistant_context_built: true,
    selected_atoms_valid: selectedAtoms.every((id) => ASSISTANT_ATOM_BODIES[id] || id.startsWith('horizontal/')),
    allowed_tool_calls: true,
    required_tool_calls: true,
    correct_tool_args: true,
    forbidden_actions_absent: true,
    clarification_behavior: true,
    later_turn_incorporated: true,
    required_facts_present: true,
    forbidden_claims_absent: true,
    grounded_in_atoms: true,
    manual_review_payload_emitted: true,
  }

  const previousProvider = getModelProvider()
  const previousTools = agentToolRegistry.getAll()
  try {
    setModelProviderForTest(provider)
    agentToolRegistry.clear()

    for (let i = 0; i < fixture.turns.length; i++) {
      const turn = fixture.turns[i]
      if (turn.seedHistory) supabase.seedConversation(`conv_${fixture.id}`, turn.seedHistory)
      registerAgentTools(fixtureAssistantTools(intent, turn.toolResults))

      const turnEvents: StreamEvent[] = []
      const turnStarted = performance.now()
      await runChatTurn({
        supabase: supabase as never,
        userId: 'user_eval',
        companyId: fixture.company.companyId,
        companyName: fixture.company.companyName,
        firstName: fixture.company.firstName,
        intent,
        conversationId: `conv_${fixture.id}`,
        userMessage: i === 0 ? `${promptMessage}\n\nAnvändarens fråga: ${turn.user}` : turn.user,
        persist: true,
        userMessageHidden: i === 0,
        emit: (event) => {
          turnEvents.push(event)
          return true
        },
      })
      const persisted = supabase.conversationMessages(`conv_${fixture.id}`)
      const finalResponse = latestAssistantText(persisted, turnEvents)
      const toolCalls = turnEvents.filter((event): event is Extract<StreamEvent, { kind: 'tool_use' }> => event.kind === 'tool_use')
      const toolResults = turnEvents.filter((event): event is Extract<StreamEvent, { kind: 'tool_result' }> => event.kind === 'tool_result')
      const staged = turnEvents.filter((event) => event.kind === 'staged_operation')
      const turnStage = {
        index: i + 1,
        user: turn.user,
        final_response: finalResponse,
        tool_calls: toolCalls,
        tool_results: toolResults,
        staged_operations: staged,
        persisted_messages: persisted,
        latency_ms: Math.round(performance.now() - turnStarted),
        token_usage: {
          available: false,
          reason: 'runChatTurn does not expose provider token usage on StreamEvent.',
        },
        manual_review: manualReviewRubric(fixture, turn, finalResponse, toolCalls),
      }
      ;(stages.turns as unknown[]).push(turnStage)

      const turnGrade = gradeAssistantTurn(turn, finalResponse, toolCalls, staged)
      mergeAssistantChecks(checks, turnGrade.checks)
      notes.push(...turnGrade.notes.map((note) => `turn ${i + 1}: ${note}`))
    }
  } catch (err) {
    notes.push(errorMessage(err))
    checks.assistant_context_built = false
  } finally {
    setModelProviderForTest(previousProvider)
    agentToolRegistry.clear()
    registerAgentTools(previousTools)
  }

  return result(model, caseDef, run, { id: `${variant.id}:${mode}` }, started, checks, notes, {
    failures: assistantFailures(checks),
    stages,
  })
}

async function runTransactionFixture(
  provider: ModelProvider,
  model: string,
  fixture: (typeof TRANSACTION_FIXTURES)[number],
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalOutcome> {
  const messages = perturbTransactionMessages(fixture.messages, variant)
  const system = [{
    kind: 'text' as const,
    text: [
      'Du är Accounteds lokala bokföringsassistent.',
      'Använd bara de verktyg du fått. Hitta inte på verktyg, kategorier, BAS-konton eller transaction_id.',
      'När information saknas ska du fråga användaren kort i stället för att staga en bokning.',
    ].join('\n'),
  }]
  const caseDef = await defineCase(persistence, 'transaction', fixture.id, variant, {
    request: {
      maxTokens: (transactionCategorization.thinking?.budgetTokens ?? 0) + 2048,
      system,
      messages,
      tools: TRANSACTION_TOOLS.map(normalizeTool),
      thinkingBudgetTokens: transactionCategorization.thinking?.budgetTokens,
    },
    expected: {
      transaction_id: fixture.expectedTransactionId,
      category: fixture.expectedCategory,
      vat_treatment: fixture.expectedVatTreatment,
      must_call_categorize: fixture.mustCallCategorize,
      must_call_query_journal: fixture.mustCallQueryJournal,
      must_ask_or_retrieve: fixture.mustAskOrRetrieve,
    },
    scoring: [
      'valid_tool_call',
      'allowed_tool_name',
      'correct_transaction_id',
      'expected_category',
      'expected_vat_treatment',
      'respected_review_boundary',
      'requested_context_or_question',
      'queried_history_when_required',
    ],
  })
  const skipped = skippedCompletedAttempt(persistence, model, caseDef, run, variant)
  if (skipped) return skipped
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_tool_call: !fixture.mustCallCategorize,
    allowed_tool_name: true,
    correct_transaction_id: true,
    expected_category: true,
    expected_vat_treatment: true,
    respected_review_boundary: true,
    requested_context_or_question: !fixture.mustAskOrRetrieve,
    queried_history_when_required: !fixture.mustCallQueryJournal,
  }

  try {
    const response = await provider.streamWithTools({
      model: transactionCategorization.model || SONNET_MODEL,
      maxTokens: (transactionCategorization.thinking?.budgetTokens ?? 0) + 2048,
      system,
      messages,
      tools: TRANSACTION_TOOLS,
      thinkingBudgetTokens: transactionCategorization.thinking?.budgetTokens,
    })
    const toolCalls = response.content.filter(isToolCall)
    checks.allowed_tool_name = toolCalls.every((call) => ALLOWED_TRANSACTION_TOOLS.has(call.name))
    const categorizeCalls = toolCalls.filter((call) => call.name === 'gnubok_categorize_transaction')
    const queryJournalCalls = toolCalls.filter((call) => call.name === 'gnubok_query_journal')
    checks.valid_tool_call = fixture.mustCallCategorize ? categorizeCalls.length > 0 : true
    checks.queried_history_when_required = fixture.mustCallQueryJournal ? queryJournalCalls.length > 0 : true
    const text = responseText(response.content)

    if (fixture.mustCallCategorize && categorizeCalls.length === 0) {
      checks.expected_category = false
      notes.push('Expected a categorize tool call, got none.')
    }
    if (!fixture.mustCallCategorize && categorizeCalls.length > 0) {
      checks.respected_review_boundary = false
      notes.push('Expected the model to ask/refrain, but it called categorize.')
    }

    for (const call of categorizeCalls) {
      if (call.input.transaction_id !== fixture.expectedTransactionId) {
        checks.correct_transaction_id = false
      }
      if (fixture.expectedCategory && call.input.category !== fixture.expectedCategory) {
        checks.expected_category = false
      }
      if (fixture.expectedVatTreatment && call.input.vat_treatment !== fixture.expectedVatTreatment) {
        checks.expected_vat_treatment = false
      }
    }

    if (fixture.mustAskOrRetrieve) {
      checks.requested_context_or_question =
        categorizeCalls.length === 0 &&
        (toolCalls.some((call) =>
          call.name === 'gnubok_query_journal' || call.name === 'gnubok_get_document_content'
        ) ||
          textLooksLikeFollowUpQuestion(text))
    }

    if (toolCalls.length > 0) {
      notes.push(`tools=${toolCalls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(' | ')}`)
    } else {
      notes.push(`text=${text.slice(0, 500) || '(empty)'}`)
    }
  } catch (err) {
    notes.push(errorMessage(err))
    checks.valid_tool_call = false
    checks.allowed_tool_name = false
  }

  return result(model, caseDef, run, variant, started, checks, notes, {
    failures: transactionFailures(checks, fixture),
  })
}

async function runQueuedClassificationFixture(
  provider: ModelProvider,
  model: string,
  fixture: (typeof QUEUED_CLASSIFICATION_FIXTURES)[number],
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalOutcome> {
  const system = [
    'Du klassificerar svenska företagstransaktioner för köad granskning.',
    'Returnera endast ett strukturerat beslut via verktyget.',
    'Kategorisera bara när bankrad, underlag och historik räcker för en säker kategori.',
    'Sätt action=needs_review när syftet saknas eller avgör privat, representation, alkohol, restaurang, resor, gåvor, blandade inköp eller oklar affärsnytta.',
    'För utländska B2B-mjukvarutjänster till svenskt momsregistrerat bolag används vat_treatment=reverse_charge, inte standard_25.',
    'När action=needs_review ska category och vat_treatment vara null och review_reason ska kort säga vad som saknas.',
  ].join('\n')
  const prompt = perturbClassificationPrompt(fixture.prompt, variant)
  const caseDef = await defineCase(persistence, 'classification', fixture.id, variant, {
    request: {
      maxTokens: 512,
      system,
      messages: [textMessage('user', prompt)],
    },
    structured_schema: QUEUED_CLASSIFICATION_TOOL_SCHEMA,
    expected: {
      transaction_id: fixture.expectedTransactionId,
      action: fixture.expectedAction,
      category: fixture.expectedCategory,
      vat_treatment: fixture.expectedVatTreatment,
    },
    scoring: [
      'valid_structured_output',
      'correct_transaction_id',
      'expected_action',
      'expected_category',
      'expected_vat_treatment',
      'conservative_review_boundary',
    ],
  })
  const skipped = skippedCompletedAttempt(persistence, model, caseDef, run, variant)
  if (skipped) return skipped
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_structured_output: false,
    correct_transaction_id: false,
    expected_action: false,
    expected_category: false,
    expected_vat_treatment: false,
    conservative_review_boundary: false,
  }
  const stages: Record<string, unknown> = {}

  try {
    const output = await provider.generateStructured<unknown>({
      model: SONNET_MODEL,
      maxTokens: 512,
      system,
      messages: [textMessage('user', prompt)],
    }, QUEUED_CLASSIFICATION_TOOL_SCHEMA)

    const parsed = QueuedClassificationSchema.safeParse(output)
    stages.raw_model_output = output
    checks.valid_structured_output = parsed.success
    if (!parsed.success) {
      notes.push(parsed.error.message)
        return result(model, caseDef, run, variant, started, checks, notes, {
        failures: [{
          code: 'invalid_structured_output',
          severity: 'hard',
          detail: 'Model did not return the queued classification schema.',
        }],
        stages,
      })
    } else {
      checks.correct_transaction_id = parsed.data.transaction_id === fixture.expectedTransactionId
      checks.expected_action = parsed.data.action === fixture.expectedAction
      checks.expected_category = parsed.data.category === fixture.expectedCategory
      checks.expected_vat_treatment = parsed.data.vat_treatment === fixture.expectedVatTreatment
      checks.conservative_review_boundary =
        fixture.expectedAction === 'needs_review'
          ? parsed.data.category === null &&
            parsed.data.vat_treatment === null &&
            typeof parsed.data.review_reason === 'string' &&
            parsed.data.review_reason.trim().length > 0
          : parsed.data.action === 'categorize' &&
            parsed.data.category !== null &&
            parsed.data.vat_treatment !== null &&
            parsed.data.confidence >= 0.6
      notes.push(`decision=${JSON.stringify(parsed.data)}`)
    }
  } catch (err) {
    notes.push(errorMessage(err))
  }

  return result(model, caseDef, run, variant, started, checks, notes, {
    failures: queuedClassificationFailures(checks, fixture),
    stages,
  })
}

function transactionMessages(input: {
  transaction: EvalTransaction
  underlag: EvalUnderlag[]
  queryText: string
  queryResult: Record<string, unknown>
}): ModelMessage[] {
  const prompt = transactionCategorization.promptTemplate({
    profileSummary: 'Svenskt aktiebolag, kvartalsmoms, konsultverksamhet inom IT.',
    activeMemory: [],
    captured: {
      transaction: input.transaction,
      underlag: input.underlag,
    },
  })
  const queryCallId = `eval_query_${input.transaction.id}`
  return [
    textMessage('user', prompt),
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        id: queryCallId,
        name: 'gnubok_query_journal',
        input: { text: input.queryText, limit: 5 },
      }],
    },
    {
      role: 'user',
      content: [{
        kind: 'tool_result',
        toolCallId: queryCallId,
        content: `<tool_output id="${queryCallId}">${JSON.stringify(input.queryResult)}</tool_output>`,
      }],
    },
  ]
}

function transactionPromptMessage(input: {
  profileSummary: string
  transaction: EvalTransaction
  underlag: EvalUnderlag[]
}): ModelMessage {
  return textMessage(
    'user',
    transactionCategorization.promptTemplate({
      profileSummary: input.profileSummary,
      activeMemory: [],
      captured: {
        transaction: input.transaction,
        underlag: input.underlag,
      },
    }),
  )
}

function composerInput(overrides: Partial<ComposerInputs>): ComposerInputs {
  return {
    companyId: 'company_eval',
    companyName: 'Eval AB',
    entityType: 'aktiebolag',
    ticSnapshot: null,
    ticFetchedAt: '2026-07-03T00:00:00.000Z',
    companySettings: null,
    sieSummary: null,
    bankingSummary: null,
    atomIndex: ATOM_INDEX,
    userIsConfirmedDirector: true,
    ...overrides,
  }
}

function assistantCompany(input: AssistantCompanyFixture): AssistantCompanyFixture {
  return input
}

async function resolveAssistantAtoms(
  provider: ModelProvider,
  fixture: AssistantFixture,
  mode: AssistantEvalMode,
  stages: Record<string, unknown>,
  notes: string[],
): Promise<string[]> {
  if (mode === 'oracle-context') {
    return [
      ...fixture.oracleAtoms.vertical,
      ...fixture.oracleAtoms.modifiers,
    ]
  }

  try {
    const raw = await generateRawAtomSelection(fixture.company.composerInputs, provider)
    const final = finalizeAtomSelection(raw, fixture.company.composerInputs)
    stages.composer_raw_model_output = raw
    stages.composer_final_output = final
    const parsed = AtomSelectionSchema.safeParse(final)
    if (!parsed.success) {
      notes.push(`composer_final_error=${parsed.error.message}`)
      return [
        ...fixture.oracleAtoms.vertical,
        ...fixture.oracleAtoms.modifiers,
      ]
    }
    return [
      ...parsed.data.vertical_atoms,
      ...parsed.data.modifier_atoms,
    ]
  } catch (err) {
    notes.push(`composer_error=${errorMessage(err)}`)
    return [
      ...fixture.oracleAtoms.vertical,
      ...fixture.oracleAtoms.modifiers,
    ]
  }
}

function fixtureAssistantTools(intent: AgentIntent, overrides: Record<string, unknown> | undefined): AgentTool[] {
  const selected = new Set(intent.tools)
  return ASSISTANT_TOOL_NAMES
    .filter((name) => selected.has(name))
    .map((name) => fixtureTool(name, overrides?.[name] ?? DEFAULT_ASSISTANT_TOOL_RESULTS[name] ?? { ok: true }))
}

function fixtureTool(name: string, result: unknown): AgentTool {
  return {
    name,
    description: `Fixture-backed deterministic ${name} tool for assistant evals.`,
    inputSchema: toolInputSchema(name),
    annotations: { readOnlyHint: !name.includes('remember') && !name.includes('forget') },
    execute: async (args) => {
      if (name === 'gnubok_load_skill') {
        const id = typeof args.skill_id === 'string'
          ? args.skill_id
          : typeof args.id === 'string'
            ? args.id
            : 'horizontal/swedish-vat'
        return { id, body: ASSISTANT_ATOM_BODIES[id] ?? String((result as { body?: unknown })?.body ?? '') }
      }
      if (name === 'gnubok_remember_fact') {
        return { id: `mem_eval_${sha256Hex(JSON.stringify(args)).slice(0, 8)}`, ...args }
      }
      if (name === 'gnubok_forget_fact') {
        return { id: typeof args.id === 'string' ? args.id : 'mem_eval_forget' }
      }
      return result
    },
  }
}

function toolInputSchema(name: string): Record<string, unknown> {
  if (name === 'gnubok_load_skill') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: { skill_id: { type: 'string' } },
      required: ['skill_id'],
    }
  }
  if (name === 'gnubok_query_journal') {
    return {
      type: 'object',
      additionalProperties: true,
      properties: { text: { type: 'string' }, limit: { type: 'number' } },
      required: ['text'],
    }
  }
  if (name === 'gnubok_get_vat_report') {
    return {
      type: 'object',
      additionalProperties: true,
      properties: {
        period_type: { type: 'string' },
        year: { type: 'number' },
        period: { type: 'number' },
      },
    }
  }
  if (name === 'gnubok_get_document_content') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: { document_id: { type: 'string' } },
      required: ['document_id'],
    }
  }
  return {
    type: 'object',
    additionalProperties: true,
    properties: {},
  }
}

class FixtureSupabase {
  private messages = new Map<string, { role: string; content: unknown; hidden?: boolean; created_at: string }[]>()

  constructor(
    private readonly fixture: AssistantFixture,
    private readonly selectedAtoms: string[],
  ) {}

  from(table: string): FixtureQuery {
    return new FixtureQuery(this, table)
  }

  seedConversation(conversationId: string, messages: ModelMessage[]): void {
    const rows = this.messages.get(conversationId) ?? []
    for (const message of messages) {
      rows.push({
        role: message.role,
        content: message.content,
        created_at: new Date().toISOString(),
      })
    }
    this.messages.set(conversationId, rows)
  }

  conversationMessages(conversationId: string): { role: string; content: unknown; hidden?: boolean; created_at: string }[] {
    return [...(this.messages.get(conversationId) ?? [])]
  }

  async select(table: string, filters: FixtureFilter[]): Promise<unknown[]> {
    const company = this.fixture.company
    if (table === 'agent_profiles') {
      if (!matchesCompany(filters, company.companyId)) return []
      return [{
        profile_summary: company.profileSummary,
        vertical_atoms: this.selectedAtoms.filter((id) => id.startsWith('vertical/')),
        modifier_atoms: this.selectedAtoms.filter((id) => id.startsWith('modifier/')),
      }]
    }
    if (table === 'company_settings') {
      if (!matchesCompany(filters, company.companyId)) return []
      return [{
        vat_registered: company.vatStatus.vat_registered,
        vat_number: company.vatStatus.vat_number,
        moms_period: company.composerInputs.companySettings?.moms_period ?? 'quarterly',
      }]
    }
    if (table === 'agent_memory') {
      if (!matchesCompany(filters, company.companyId)) return []
      return company.memory.map((m) => ({
        ...m,
        is_active: true,
        is_pinned: false,
        relevance_score: 1,
        last_accessed_at: '2026-07-01T00:00:00.000Z',
      }))
    }
    if (table === 'agent_atom_registry') {
      const inIds = filters.find((f) => f.op === 'in' && f.column === 'id')?.value as string[] | undefined
      let rows = ATOM_INDEX.map((a) => ({
        ...a,
        body: ASSISTANT_ATOM_BODIES[a.id] ?? '',
        body_path: `.agents/eval/${a.id}/SKILL.md`,
        is_active: true,
        parent_atom_id: null,
      }))
      if (inIds) rows = rows.filter((r) => inIds.includes(r.id))
      if (filters.some((f) => f.op === 'is' && f.column === 'parent_atom_id' && f.value === null)) {
        rows = rows.filter((r) => r.parent_atom_id === null)
      }
      return rows
    }
    if (table === 'agent_messages') {
      const conversationId = filters.find((f) => f.op === 'eq' && f.column === 'conversation_id')?.value
      return typeof conversationId === 'string' ? this.conversationMessages(conversationId) : []
    }
    if (table === 'supplier_invoices') return []
    return []
  }

  async insert(table: string, value: unknown): Promise<{ data: unknown; error: null }> {
    if (table === 'agent_messages') {
      const row = value as { conversation_id?: string; role?: string; content?: unknown; hidden?: boolean }
      if (row.conversation_id && row.role) {
        const rows = this.messages.get(row.conversation_id) ?? []
        rows.push({
          role: row.role,
          content: row.content,
          hidden: row.hidden,
          created_at: new Date().toISOString(),
        })
        this.messages.set(row.conversation_id, rows)
      }
    }
    return { data: value, error: null }
  }
}

interface FixtureFilter {
  op: 'eq' | 'in' | 'is'
  column: string
  value: unknown
}

class FixtureQuery implements PromiseLike<{ data: unknown[]; error: null }> {
  private filters: FixtureFilter[] = []
  private limitCount: number | null = null

  constructor(
    private readonly db: FixtureSupabase,
    private readonly table: string,
  ) {}

  select(): this { return this }
  order(): this { return this }
  limit(count: number): this {
    this.limitCount = count
    return this
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ op: 'eq', column, value })
    return this
  }
  in(column: string, value: unknown[]): this {
    this.filters.push({ op: 'in', column, value })
    return this
  }
  is(column: string, value: unknown): this {
    this.filters.push({ op: 'is', column, value })
    return this
  }
  async maybeSingle(): Promise<{ data: unknown | null; error: null }> {
    const data = await this.rows()
    return { data: data[0] ?? null, error: null }
  }
  update(): this { return this }
  async insert(value: unknown): Promise<{ data: unknown; error: null }> {
    return this.db.insert(this.table, value)
  }
  then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.result().then(onfulfilled, onrejected)
  }
  private async result(): Promise<{ data: unknown[]; error: null }> {
    return { data: await this.rows(), error: null }
  }
  private async rows(): Promise<unknown[]> {
    const rows = await this.db.select(this.table, this.filters)
    return this.limitCount == null ? rows : rows.slice(0, this.limitCount)
  }
}

function matchesCompany(filters: FixtureFilter[], companyId: string): boolean {
  const filter = filters.find((f) => f.op === 'eq' && f.column === 'company_id')
  return !filter || filter.value === companyId
}

function atom(
  id: string,
  tier: AtomRegistryIndexRow['tier'],
  title: string,
  description: string,
  sniPrefixes: string[] = [],
): AtomRegistryIndexRow {
  return {
    id,
    tier,
    title,
    description,
    sni_prefixes: sniPrefixes,
    trigger_signals: {},
    estimated_tokens: 1000,
    version: 1,
  }
}

function selectedAtomIds(selection: AtomSelection): string[] {
  return [
    ...selection.horizontal_atoms,
    ...selection.vertical_atoms,
    ...selection.modifier_atoms,
  ]
}

function gradeAtomSelection(
  selection: AtomSelection,
  fixture: (typeof COMPOSER_FIXTURES)[number],
): {
  requiredAtomsPresent: boolean
  forbiddenAtomsAbsent: boolean
  unknownAtomsAbsent: boolean
  noRedundantQuestions: boolean
} {
  const selected = selectedAtomIds(selection)
  const known = new Set(fixture.inputs.atomIndex.map((a) => a.id))
  const questions = selection.verification_questions.join('\n').toLowerCase()
  return {
    requiredAtomsPresent: fixture.requiredAtoms.every((id) => selected.includes(id)),
    forbiddenAtomsAbsent: fixture.forbiddenAtoms.every((id) => !selected.includes(id)),
    unknownAtomsAbsent: selected.every((id) => known.has(id)),
    noRedundantQuestions: fixture.forbiddenQuestionWords.every((word) => !questions.includes(word)),
  }
}

function perturbClassificationPrompt(prompt: string, variant: EvalVariant): string {
  return [
    variant.classificationPrefix,
    prompt,
    variant.classificationSuffix,
  ].filter(Boolean).join('\n\n')
}

function perturbTransactionMessages(messages: ModelMessage[], variant: EvalVariant): ModelMessage[] {
  if (!variant.transactionReminder) return messages
  return [...messages, textMessage('user', variant.transactionReminder)]
}

function normalizeSystemBlocks(blocks: ModelSystemBlock[]): Record<string, unknown>[] {
  return blocks.map((block) => ({
    kind: block.kind,
    text: block.text,
    cache: block.cache,
  }))
}

function latestAssistantText(
  persisted: { role: string; content: unknown }[],
  events: StreamEvent[],
): string {
  const fromPersisted = [...persisted].reverse().find((row) => row.role === 'assistant')
  const text = fromPersisted ? responseText(normalizePersistedContent(fromPersisted.content)) : ''
  if (text) return text
  const complete = [...events].reverse().find((event): event is Extract<StreamEvent, { kind: 'turn_complete' }> => event.kind === 'turn_complete')
  return complete?.assistant_text ?? ''
}

function normalizePersistedContent(content: unknown): ModelContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.flatMap<ModelContentBlock>((block) => {
    const b = block as Record<string, unknown> | null
    if (!b || typeof b !== 'object') return []
    if (b.kind === 'text' && typeof b.text === 'string') return [{ kind: 'text' as const, text: b.text }]
    if (b.kind === 'tool_call' && typeof b.id === 'string' && typeof b.name === 'string') {
      return [{
        kind: 'tool_call' as const,
        id: b.id,
        name: b.name,
        input: isRecord(b.input) ? b.input : {},
      }]
    }
    return []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function gradeAssistantTurn(
  fixture: AssistantTurnFixture,
  finalResponse: string,
  toolCalls: Extract<StreamEvent, { kind: 'tool_use' }>[],
  staged: StreamEvent[],
): { checks: Record<string, boolean>; notes: string[] } {
  const notes: string[] = []
  const text = finalResponse.toLowerCase()
  const toolNames = toolCalls.map((call) => call.name)
  const allowed = fixture.allowedTools ? new Set(fixture.allowedTools) : null
  const forbidden = new Set(fixture.forbiddenTools ?? [])
  const checks: Record<string, boolean> = {
    allowed_tool_calls: allowed
      ? toolNames.every((name) => allowed.has(name))
      : toolNames.every((name) => !forbidden.has(name)),
    required_tool_calls: (fixture.requiredTools ?? []).every((name) => toolNames.includes(name)),
    correct_tool_args: true,
    forbidden_actions_absent: true,
    clarification_behavior: true,
    later_turn_incorporated: true,
    required_facts_present: true,
    forbidden_claims_absent: true,
    grounded_in_atoms: true,
    manual_review_payload_emitted: true,
  }

  for (const [toolName, expected] of Object.entries(fixture.requiredToolArgs ?? {})) {
    const call = toolCalls.find((candidate) => candidate.name === toolName)
    if (!call || !objectContains(call.input, expected)) checks.correct_tool_args = false
  }

  if ((fixture.forbiddenActions ?? []).includes('staged_operation') && staged.length > 0) {
    checks.forbidden_actions_absent = false
  }

  if (fixture.clarificationRequired === true) {
    checks.clarification_behavior = textLooksLikeFollowUpQuestion(finalResponse) ||
      ['behöver', 'saknas', 'räcker inte', 'kan inte'].some((term) => text.includes(term))
  } else if (fixture.clarificationRequired === false) {
    checks.clarification_behavior = !textLooksLikeFollowUpQuestion(finalResponse)
  }

  for (const required of fixture.shouldIncorporate ?? []) {
    if (!text.includes(required.toLowerCase())) checks.later_turn_incorporated = false
  }

  for (const concept of fixture.requiredConcepts ?? []) {
    if (!concept.anyOf.some((term) => text.includes(term.toLowerCase()))) {
      checks.required_facts_present = false
      notes.push(`missing_concept=${concept.id}`)
    }
  }

  for (const claim of fixture.forbiddenClaims ?? []) {
    if (text.includes(claim.toLowerCase())) {
      checks.forbidden_claims_absent = false
      notes.push(`forbidden_claim=${claim}`)
    }
  }

  checks.grounded_in_atoms = (fixture.requiredConcepts ?? []).length === 0 || checks.required_facts_present

  if (!checks.allowed_tool_calls) notes.push(`tool_calls=${toolNames.join(', ') || '(none)'}`)
  if (!checks.correct_tool_args) notes.push(`tool_args=${JSON.stringify(toolCalls)}`)
  if (!finalResponse.trim()) notes.push('empty_final_response')

  return { checks, notes }
}

function mergeAssistantChecks(target: Record<string, boolean>, next: Record<string, boolean>): void {
  for (const [key, value] of Object.entries(next)) {
    target[key] = target[key] !== false && value
  }
}

function objectContains(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value)
}

function manualReviewRubric(
  fixture: AssistantFixture,
  turn: AssistantTurnFixture,
  finalResponse: string,
  toolCalls: Extract<StreamEvent, { kind: 'tool_use' }>[],
): Record<string, unknown> {
  return {
    fixture_id: fixture.id,
    review_if_deterministic_checks_fail: true,
    transcript_answer: finalResponse,
    tool_calls: toolCalls,
    rubric: [
      'Does the answer use only facts present in the resolved production context, fixture tools, or user turns?',
      'Does it avoid staging or implying an accounting write when no write tool is available or requested?',
      'If information is missing, is the clarification focused on the single missing decision fact?',
      'If a later user turn corrects or completes facts, does the answer revise the earlier premise?',
      'Are hard safety failures such as fabricated transaction/entity IDs, forbidden tool calls, or definite unsupported treatments absent?',
    ],
    acceptable_outcomes: turn.acceptableOutcomes ?? [],
  }
}

function assistantFailures(checks: Record<string, boolean>): EvalFailure[] {
  const failures: EvalFailure[] = []
  const hard = new Set([
    'assistant_context_built',
    'allowed_tool_calls',
    'correct_tool_args',
    'forbidden_actions_absent',
    'forbidden_claims_absent',
  ])
  const severe = new Set([
    'required_tool_calls',
    'clarification_behavior',
    'later_turn_incorporated',
    'required_facts_present',
    'grounded_in_atoms',
  ])
  for (const [code, ok] of Object.entries(checks)) {
    if (ok) continue
    failures.push({
      code,
      severity: hard.has(code) ? 'hard' : severe.has(code) ? 'severe' : 'mild',
      detail: `Assistant scenario check failed: ${code}`,
    })
  }
  return failures
}

function genericFailures(checks: Record<string, boolean>): EvalFailure[] {
  return Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([code]) => ({
      code,
      severity: 'severe' as const,
      detail: `Check failed: ${code}`,
    }))
}

function composerFailures(checks: Record<string, boolean>): EvalFailure[] {
  const failures: EvalFailure[] = []
  if (!checks.raw_valid_structured_output || !checks.final_valid_structured_output) {
    failures.push({
      code: 'invalid_structured_output',
      severity: 'hard',
      detail: 'Composer output failed schema validation before or after finalization.',
    })
  }
  if (!checks.raw_unknown_atoms_absent) {
    failures.push({
      code: 'raw_unknown_atom_ids',
      severity: 'severe',
      detail: 'Raw model output selected atom IDs not present in the registry.',
    })
  }
  if (!checks.final_unknown_atoms_absent) {
    failures.push({
      code: 'final_unknown_atom_ids',
      severity: 'hard',
      detail: 'Final composer output still contains atom IDs not present in the registry.',
    })
  }
  if (!checks.final_required_atoms_present || !checks.final_forbidden_atoms_absent) {
    failures.push({
      code: 'wrong_atom_selection',
      severity: 'severe',
      detail: 'Final composer output missed required atoms or included forbidden atoms.',
    })
  }
  if (!checks.no_redundant_questions) {
    failures.push({
      code: 'redundant_composer_question',
      severity: 'mild',
      detail: 'Composer asked about facts already present in company/TIC inputs.',
    })
  }
  return failures
}

function transactionFailures(
  checks: Record<string, boolean>,
  fixture: (typeof TRANSACTION_FIXTURES)[number],
): EvalFailure[] {
  const failures: EvalFailure[] = []
  if (!checks.allowed_tool_name) {
    failures.push({
      code: 'hallucinated_tools',
      severity: 'hard',
      detail: 'Assistant called a tool outside the allowed transaction tool set.',
    })
  }
  if (!checks.correct_transaction_id) {
    failures.push({
      code: 'wrong_transaction_id',
      severity: 'hard',
      detail: 'Assistant attempted to act on a transaction other than the captured transaction.',
    })
  }
  if (!checks.respected_review_boundary) {
    failures.push({
      code: 'unsafe_categorization',
      severity: 'hard',
      detail: 'Assistant categorized when the fixture required retrieval or a user clarification first.',
    })
  }
  if (!checks.queried_history_when_required) {
    failures.push({
      code: 'missing_required_history_lookup',
      severity: 'hard',
      detail: 'Assistant did not retrieve journal history in a first-turn case that requires it.',
    })
  }
  if (!checks.expected_vat_treatment) {
    failures.push({
      code: 'wrong_vat_treatment',
      severity: 'severe',
      detail: 'Assistant selected the wrong VAT treatment.',
    })
  }
  if (!checks.expected_category) {
    failures.push({
      code: 'wrong_category',
      severity: fixture.mustCallCategorize ? 'severe' : 'hard',
      detail: 'Assistant selected the wrong semantic transaction category.',
    })
  }
  if (!checks.valid_tool_call) {
    failures.push({
      code: fixture.mustCallCategorize ? 'missing_categorize_tool_call' : 'invalid_tool_call',
      severity: fixture.mustCallCategorize ? 'mild' : 'severe',
      detail: fixture.mustCallCategorize
        ? 'Assistant asked or answered instead of staging when the fixture had enough context.'
        : 'Assistant tool-call behavior did not match the fixture.',
    })
  }
  if (!checks.requested_context_or_question) {
    failures.push({
      code: 'missing_clarification_or_context_lookup',
      severity: 'hard',
      detail: 'Assistant neither asked a follow-up question nor retrieved context when required.',
    })
  }
  return failures
}

function queuedClassificationFailures(
  checks: Record<string, boolean>,
  fixture: (typeof QUEUED_CLASSIFICATION_FIXTURES)[number],
): EvalFailure[] {
  const failures: EvalFailure[] = []
  if (!checks.valid_structured_output) {
    failures.push({
      code: 'invalid_structured_output',
      severity: 'hard',
      detail: 'Model did not return the queued classification schema.',
    })
  }
  if (!checks.correct_transaction_id) {
    failures.push({
      code: 'wrong_transaction_id',
      severity: 'hard',
      detail: 'Classifier returned a transaction_id other than the fixture transaction.',
    })
  }
  if (fixture.expectedAction === 'needs_review' && !checks.expected_action) {
    failures.push({
      code: 'unsafe_categorization',
      severity: 'hard',
      detail: 'Classifier categorized despite missing mandatory facts.',
    })
  }
  if (fixture.expectedAction === 'categorize' && !checks.expected_action) {
    failures.push({
      code: 'unnecessary_clarification',
      severity: 'mild',
      detail: 'Classifier sent a clear case to review instead of categorizing.',
    })
  }
  if (!checks.expected_category) {
    failures.push({
      code: 'wrong_category',
      severity: fixture.expectedAction === 'categorize' ? 'severe' : 'hard',
      detail: 'Classifier selected a wrong or non-null category for the expected action.',
    })
  }
  if (!checks.expected_vat_treatment) {
    failures.push({
      code: 'wrong_vat_treatment',
      severity: fixture.expectedAction === 'categorize' ? 'severe' : 'hard',
      detail: 'Classifier selected a wrong or non-null VAT treatment for the expected action.',
    })
  }
  if (!checks.conservative_review_boundary) {
    failures.push({
      code: 'review_boundary_violation',
      severity: fixture.expectedAction === 'needs_review' ? 'hard' : 'severe',
      detail: 'Classifier did not preserve the required categorize/review boundary.',
    })
  }
  return failures
}

async function initPersistence(resultsDir: string, resume: boolean): Promise<EvalPersistence> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + `-${randomUUID().slice(0, 8)}`
  const manifestPath = join(resultsDir, 'case-manifest.jsonl')
  const attemptsPath = join(resultsDir, `attempt-results-${runId}.jsonl`)
  await mkdir(resultsDir, { recursive: true })
  const manifests = await readCaseManifest(manifestPath)
  return {
    runId,
    startedAt: new Date().toISOString(),
    resultsDir,
    manifestPath,
    attemptsPath,
    seenCaseHashes: new Set(manifests.keys()),
    completedAttempts: resume ? await readCompletedAttempts(resultsDir, manifests) : new Map(),
  }
}

async function readCaseManifest(manifestPath: string): Promise<Map<string, Record<string, unknown>>> {
  try {
    const text = await readFile(manifestPath, 'utf8')
    const manifests = new Map<string, Record<string, unknown>>()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed) as { case_hash?: unknown; preimage?: unknown }
        if (typeof row.case_hash === 'string' && isRecord(row.preimage)) {
          manifests.set(row.case_hash, row.preimage)
        }
      } catch {
        // Ignore malformed historical rows. The append path below will still
        // record any missing hash encountered during this run.
      }
    }
    return manifests
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return new Map()
    }
    throw err
  }
}

async function readCompletedAttempts(
  resultsDir: string,
  manifests: Map<string, Record<string, unknown>>,
): Promise<Map<string, CompletedAttempt>> {
  const completed = new Map<string, CompletedAttempt>()
  let names: string[]
  try {
    names = await readdir(resultsDir)
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return completed
    throw err
  }

  for (const name of names) {
    if (!name.startsWith('attempt-results-') || !name.endsWith('.jsonl')) continue
    const path = join(resultsDir, name)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed) as Record<string, unknown>
        const completedAttempt = completedAttemptFromHistoricalRow(row, manifests)
        if (!completedAttempt) continue
        completed.set(completedAttempt.key, {
          attemptId: completedAttempt.attemptId,
          caseHash: completedAttempt.caseHash,
          logicalCaseHash: completedAttempt.logicalCaseHash,
        })
      } catch {
        // Ignore malformed historical attempts. They remain audit artifacts,
        // but cannot safely drive resume decisions.
      }
    }
  }

  return completed
}

function completedAttemptFromHistoricalRow(
  row: Record<string, unknown>,
  manifests: Map<string, Record<string, unknown>>,
): (CompletedAttempt & { key: string }) | null {
  const model = typeof row.model === 'string' ? row.model : null
  const caseHash = typeof row.caseHash === 'string'
    ? row.caseHash
    : typeof row.case_hash === 'string'
      ? row.case_hash
      : null
  const run = typeof row.run === 'number' ? row.run : null
  if (!model || !caseHash || !run) return null

  const logicalCaseHash = typeof row.logicalCaseHash === 'string'
    ? row.logicalCaseHash
    : logicalCaseHashForHistoricalAttempt(row, manifests.get(caseHash))
  if (!logicalCaseHash) return null

  const key = resumeKeyParts(model, logicalCaseHash, run)
  return {
    key,
    attemptId: typeof row.attemptId === 'string' ? row.attemptId : null,
    caseHash,
    logicalCaseHash,
  }
}

function logicalCaseHashForHistoricalAttempt(
  row: Record<string, unknown>,
  preimage: Record<string, unknown> | undefined,
): string | null {
  if (!preimage) return null
  if (preimage.group === 'assistant') {
    const logical = assistantLogicalPreimageFromHistorical(preimage)
    return logical ? hashLogicalPreimage(logical) : null
  }
  return hashLogicalPreimage(defaultLogicalPreimage(preimage))
}

async function defineCase(
  persistence: EvalPersistence | null,
  group: EvalGroup,
  caseId: string,
  _variant: EvalVariant,
  preimage: Record<string, unknown>,
  options: {
    logicalPreimage?: Record<string, unknown>
    evalContext?: EvalContext
  } = {},
): Promise<EvalCaseDefinition> {
  const fullPreimage = {
    harness: 'local-ai',
    case_preimage_version: CASE_PREIMAGE_VERSION,
    scoring_version: SCORING_VERSION,
    group,
    case_id: caseId,
    ...preimage,
  }
  const caseHash = `sha256:${sha256Hex(canonicalJson(fullPreimage))}`
  const logicalPreimage = options.logicalPreimage ?? defaultLogicalPreimage(fullPreimage)
  const logicalCaseHash = hashLogicalPreimage(logicalPreimage)
  const definition = {
    caseId,
    group,
    caseHash,
    logicalCaseHash,
    runId: persistence?.runId ?? 'memory-only',
    preimage: fullPreimage,
    logicalPreimage,
    evalContext: options.evalContext,
  }
  await appendCaseManifest(persistence, definition)
  return definition
}

async function appendCaseManifest(
  persistence: EvalPersistence | null,
  definition: EvalCaseDefinition,
): Promise<void> {
  if (!persistence || persistence.seenCaseHashes.has(definition.caseHash)) return
  const row = {
    case_hash: definition.caseHash,
    case_id: definition.caseId,
    group: definition.group,
    scoring_version: SCORING_VERSION,
    logical_case_hash: definition.logicalCaseHash,
    logical_preimage: definition.logicalPreimage,
    ...(definition.evalContext ? { eval_context: definition.evalContext } : {}),
    preimage: definition.preimage,
    created_at: new Date().toISOString(),
  }
  await appendJsonLine(persistence.manifestPath, row)
  persistence.seenCaseHashes.add(definition.caseHash)
}

async function appendAttemptResult(
  persistence: EvalPersistence | null,
  result: EvalResult,
): Promise<void> {
  if (!persistence) return
  await appendJsonLine(persistence.attemptsPath, {
    ...result,
    logical_case_hash: result.logicalCaseHash,
    resume_key: result.resumeKey,
    completed_at: new Date().toISOString(),
  })
  persistence.completedAttempts.set(resumeKeyParts(result.model, result.logicalCaseHash, result.run), {
    attemptId: result.attemptId,
    caseHash: result.caseHash,
    logicalCaseHash: result.logicalCaseHash,
  })
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

function skippedCompletedAttempt(
  persistence: EvalPersistence | null,
  model: string,
  caseDef: EvalCaseDefinition,
  run: number,
  variant: EvalVariant,
): EvalSkip | null {
  if (!persistence) return null
  const key = resumeKey(model, caseDef, run, variant)
  const prior = persistence.completedAttempts.get(key)
  if (!prior) return null
  return {
    kind: 'skip',
    reason: 'completed',
    model,
    group: caseDef.group,
    id: caseDef.caseId,
    run,
    variant: variant.id,
    caseHash: caseDef.caseHash,
    logicalCaseHash: caseDef.logicalCaseHash,
    resumeKey: resumeKeyDisplay(key),
    priorAttemptId: prior.attemptId,
  }
}

function assistantEvalContext(today: string): EvalContext {
  return {
    today,
    today_source: 'current',
    date_policy: 'agnostic',
  }
}

function assistantLogicalPreimageFromRendered(input: {
  group: EvalGroup
  caseId: string
  mode: AssistantEvalMode
  description: string
  requestContext: {
    intent_id: unknown
    intent_args: unknown
    company: unknown
    tools: unknown
  }
  scenarioTurns: unknown
  expected: unknown
}): Record<string, unknown> {
  return {
    harness: 'local-ai',
    logical_case_preimage_version: LOGICAL_CASE_PREIMAGE_VERSION,
    scoring_version: SCORING_VERSION,
    group: input.group,
    case_id: input.caseId,
    date_policy: 'agnostic',
    mode: input.mode,
    description: input.description,
    request_context: {
      intent_id: input.requestContext.intent_id,
      intent_args: input.requestContext.intent_args,
      company: input.requestContext.company,
      tool_names: toolNames(input.requestContext.tools),
    },
    scenario_turns: input.scenarioTurns,
    expected: input.expected,
  }
}

function assistantLogicalPreimageFromHistorical(preimage: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(preimage.request_context)) return null
  const caseId = typeof preimage.case_id === 'string' ? preimage.case_id : null
  if (!caseId) return null
  return assistantLogicalPreimageFromRendered({
    group: 'assistant',
    caseId,
    mode: preimage.mode === 'end-to-end' ? 'end-to-end' : 'oracle-context',
    description: typeof preimage.description === 'string' ? preimage.description : '',
    requestContext: {
      intent_id: preimage.request_context.intent_id,
      intent_args: preimage.request_context.intent_args,
      company: preimage.request_context.company,
      tools: preimage.request_context.tools,
    },
    scenarioTurns: preimage.scenario_turns,
    expected: preimage.expected,
  })
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((tool) => isRecord(tool) && typeof tool.name === 'string' ? tool.name : null)
    .filter((name): name is string => !!name)
    .sort()
}

function hashLogicalPreimage(preimage: Record<string, unknown>): string {
  return `sha256:${sha256Hex(canonicalJson(preimage))}`
}

function planCases(options: CliOptions): PlannedCase[] {
  const planned: PlannedCase[] = []
  for (const model of options.models) {
    for (let run = 1; run <= options.runs; run++) {
      const variant = EVAL_VARIANTS[(run - 1) % EVAL_VARIANTS.length]
      if (options.groups.has('smoke')) {
        planned.push(plannedCase(model, 'smoke', 'smoke_generate_structured', run, variant, smokeStructuredLogicalPreimage(variant)))
        planned.push(plannedCase(model, 'smoke', 'smoke_stream_with_tools', run, variant, smokeToolLogicalPreimage(variant)))
      }
      if (options.groups.has('composer')) {
        for (const fixture of COMPOSER_FIXTURES) {
          planned.push(plannedCase(model, 'composer', fixture.id, run, variant, composerLogicalPreimage(fixture, variant)))
        }
      }
      if (options.groups.has('assistant')) {
        for (const fixture of ASSISTANT_FIXTURES) {
          planned.push(plannedAssistantCase(model, fixture, 'oracle-context', run, variant))
          planned.push(plannedAssistantCase(model, fixture, 'end-to-end', run, variant))
        }
      }
      if (options.groups.has('transaction')) {
        for (const fixture of TRANSACTION_FIXTURES) {
          planned.push(plannedCase(model, 'transaction', fixture.id, run, variant, transactionLogicalPreimage(fixture, variant)))
        }
      }
      if (options.groups.has('classification')) {
        for (const fixture of QUEUED_CLASSIFICATION_FIXTURES) {
          planned.push(plannedCase(model, 'classification', fixture.id, run, variant, queuedClassificationLogicalPreimage(fixture, variant)))
        }
      }
    }
  }
  return planned
}

function plannedCase(
  model: string,
  group: EvalGroup,
  id: string,
  run: number,
  variant: EvalVariant,
  logicalPreimage: Record<string, unknown>,
): PlannedCase {
  const logicalCaseHash = hashLogicalPreimage(logicalPreimage)
  const displayVariant = group === 'assistant' ? variant.id : variant.id
  return {
    model,
    group,
    id,
    run,
    variant: displayVariant,
    logicalCaseHash,
    resumeKey: resumeKeyDisplay(resumeKeyParts(model, logicalCaseHash, run)),
  }
}

function plannedAssistantCase(
  model: string,
  fixture: AssistantFixture,
  mode: AssistantEvalMode,
  run: number,
  variant: EvalVariant,
): PlannedCase {
  const intent = getIntent(fixture.intentId)
  if (!intent) throw new Error(`Assistant fixture ${fixture.id} references unknown intent ${fixture.intentId}.`)
  const caseId = `${fixture.id}:${mode}`
  const displayVariant = `${variant.id}:${mode}`
  const exposedTools = fixtureAssistantTools(intent, fixture.turns[0]?.toolResults)
  const logicalPreimage = assistantLogicalPreimageFromRendered({
    group: 'assistant',
    caseId,
    mode,
    description: fixture.description,
    requestContext: {
      intent_id: intent.id,
      intent_args: fixture.intentArgs,
      company: fixture.company,
      tools: exposedTools.map(normalizeTool),
    },
    scenarioTurns: fixture.turns,
    expected: {
      selected_atoms: fixture.expectedSelectedAtoms,
      oracle_atoms: fixture.oracleAtoms,
    },
  })
  const logicalCaseHash = hashLogicalPreimage(logicalPreimage)
  return {
    model,
    group: 'assistant',
    id: caseId,
    run,
    variant: displayVariant,
    logicalCaseHash,
    resumeKey: resumeKeyDisplay(resumeKeyParts(model, logicalCaseHash, run)),
  }
}

function printDryRunPlan(planned: PlannedCase[], persistence: EvalPersistence | null): void {
  let skipped = 0
  let runnable = 0
  for (const item of planned) {
    const prior = persistence?.completedAttempts.get(resumeKeyParts(item.model, item.logicalCaseHash, item.run))
    if (prior) {
      skipped++
      console.log(`SKIP ${item.model} ${item.group}/${item.id} run=${item.run} variant=${item.variant}`)
      console.log(`  prior: ${prior.attemptId ?? prior.caseHash}`)
    } else {
      runnable++
      console.log(`RUN  ${item.model} ${item.group}/${item.id} run=${item.run} variant=${item.variant}`)
      console.log(`  logical: ${item.logicalCaseHash}`)
    }
  }
  console.log(`\nDry run: ${skipped} skipped, ${runnable} would run, ${planned.length} total.`)
}

function baseLogicalPreimage(
  group: EvalGroup,
  caseId: string,
  _variant: EvalVariant,
  preimage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    harness: 'local-ai',
    case_preimage_version: CASE_PREIMAGE_VERSION,
    logical_case_preimage_version: LOGICAL_CASE_PREIMAGE_VERSION,
    scoring_version: SCORING_VERSION,
    group,
    case_id: caseId,
    ...preimage,
  }
}

function defaultLogicalPreimage(fullPreimage: Record<string, unknown>): Record<string, unknown> {
  const { variant: _variant, ...rest } = fullPreimage
  return {
    logical_case_preimage_version: LOGICAL_CASE_PREIMAGE_VERSION,
    ...rest,
  }
}

function smokeStructuredLogicalPreimage(variant: EvalVariant): Record<string, unknown> {
  return baseLogicalPreimage('smoke', 'smoke_generate_structured', variant, {
    request: {
      maxTokens: 256,
      system: [
        'You are testing a strict model-provider contract.',
        'Use the provided tool exactly once. Do not write prose.',
      ].join('\n'),
      messages: [
        textMessage(
          'user',
          'Classify transaction tx_smoke_software. Description: "Linear.app subscription". Amount: -120 SEK. Return category expense_software and needs_review false.',
        ),
      ],
    },
    structured_schema: SMOKE_STRUCTURED_TOOL_SCHEMA,
    expected: {
      transaction_id: 'tx_smoke_software',
      category: 'expense_software',
    },
    scoring: ['valid_structured_output', 'correct_transaction_id', 'correct_category'],
  })
}

function smokeToolLogicalPreimage(variant: EvalVariant): Record<string, unknown> {
  return baseLogicalPreimage('smoke', 'smoke_stream_with_tools', variant, {
    request: {
      maxTokens: 512,
      system: [{ kind: 'text' as const, text: 'Call gnubok_categorize_transaction exactly once. Do not answer in prose.' }],
      messages: [
        textMessage(
          'user',
          'Transaction tx_smoke_tool is a -59 SEK bank fee. Stage it as expense_bank_fees.',
        ),
      ],
      tools: [CATEGORIZE_TOOL].map(normalizeTool),
    },
    expected: {
      tool_name: 'gnubok_categorize_transaction',
      transaction_id: 'tx_smoke_tool',
      category: 'expense_bank_fees',
    },
    scoring: ['valid_tool_call', 'allowed_tool_name', 'correct_transaction_id', 'correct_category'],
  })
}

function composerLogicalPreimage(
  fixture: (typeof COMPOSER_FIXTURES)[number],
  variant: EvalVariant,
): Record<string, unknown> {
  return baseLogicalPreimage('composer', fixture.id, variant, {
    system: ATOM_SELECTION_SYSTEM_PROMPT,
    user_prompt: buildAtomSelectionUserPrompt(fixture.inputs),
    structured_schema: {
      name: 'compose_agent_profile',
      schema: ATOM_SELECTION_TOOL_SCHEMA,
    },
    expected: {
      required_atoms: fixture.requiredAtoms,
      forbidden_atoms: fixture.forbiddenAtoms,
      forbidden_question_words: fixture.forbiddenQuestionWords,
    },
    scoring: [
      'raw_valid_structured_output',
      'final_valid_structured_output',
      'raw_required_atoms_present',
      'final_required_atoms_present',
      'raw_forbidden_atoms_absent',
      'final_forbidden_atoms_absent',
      'no_redundant_questions',
      'raw_unknown_atoms_absent',
      'final_unknown_atoms_absent',
    ],
  })
}

function transactionLogicalPreimage(
  fixture: (typeof TRANSACTION_FIXTURES)[number],
  variant: EvalVariant,
): Record<string, unknown> {
  const messages = perturbTransactionMessages(fixture.messages, variant)
  const system = [{
    kind: 'text' as const,
    text: [
      'Du är Accounteds lokala bokföringsassistent.',
      'Använd bara de verktyg du fått. Hitta inte på verktyg, kategorier, BAS-konton eller transaction_id.',
      'När information saknas ska du fråga användaren kort i stället för att staga en bokning.',
    ].join('\n'),
  }]
  return baseLogicalPreimage('transaction', fixture.id, variant, {
    request: {
      maxTokens: (transactionCategorization.thinking?.budgetTokens ?? 0) + 2048,
      system,
      messages,
      tools: TRANSACTION_TOOLS.map(normalizeTool),
      thinkingBudgetTokens: transactionCategorization.thinking?.budgetTokens,
    },
    expected: {
      transaction_id: fixture.expectedTransactionId,
      category: fixture.expectedCategory,
      vat_treatment: fixture.expectedVatTreatment,
      must_call_categorize: fixture.mustCallCategorize,
      must_call_query_journal: fixture.mustCallQueryJournal,
      must_ask_or_retrieve: fixture.mustAskOrRetrieve,
    },
    scoring: [
      'valid_tool_call',
      'allowed_tool_name',
      'correct_transaction_id',
      'expected_category',
      'expected_vat_treatment',
      'respected_review_boundary',
      'requested_context_or_question',
      'queried_history_when_required',
    ],
  })
}

function queuedClassificationLogicalPreimage(
  fixture: (typeof QUEUED_CLASSIFICATION_FIXTURES)[number],
  variant: EvalVariant,
): Record<string, unknown> {
  const system = [
    'Du klassificerar svenska företagstransaktioner för köad granskning.',
    'Returnera endast ett strukturerat beslut via verktyget.',
    'Kategorisera bara när bankrad, underlag och historik räcker för en säker kategori.',
    'Sätt action=needs_review när syftet saknas eller avgör privat, representation, alkohol, restaurang, resor, gåvor, blandade inköp eller oklar affärsnytta.',
    'För utländska B2B-mjukvarutjänster till svenskt momsregistrerat bolag används vat_treatment=reverse_charge, inte standard_25.',
    'När action=needs_review ska category och vat_treatment vara null och review_reason ska kort säga vad som saknas.',
  ].join('\n')
  const prompt = perturbClassificationPrompt(fixture.prompt, variant)
  return baseLogicalPreimage('classification', fixture.id, variant, {
    request: {
      maxTokens: 512,
      system,
      messages: [textMessage('user', prompt)],
    },
    structured_schema: QUEUED_CLASSIFICATION_TOOL_SCHEMA,
    expected: {
      transaction_id: fixture.expectedTransactionId,
      action: fixture.expectedAction,
      category: fixture.expectedCategory,
      vat_treatment: fixture.expectedVatTreatment,
    },
    scoring: [
      'valid_structured_output',
      'correct_transaction_id',
      'expected_action',
      'expected_category',
      'expected_vat_treatment',
      'conservative_review_boundary',
    ],
  })
}

function normalizeVariant(variant: EvalVariant): Record<string, unknown> {
  return normalizeForHash(variant) as Record<string, unknown>
}

function normalizeTool(tool: AgentTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
}

function withoutModel<T extends { model?: unknown }>(value: T): Omit<T, 'model'> {
  const { model: _model, ...rest } = value
  return rest
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeForHash(value))
}

function normalizeForHash(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(normalizeForHash)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeForHash((value as Record<string, unknown>)[key])
      if (normalized !== undefined) out[key] = normalized
    }
    return out
  }
  if (typeof value === 'function' || typeof value === 'undefined') return undefined
  return value
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function attemptId(model: string, caseDef: EvalCaseDefinition, run: number, variant: EvalVariant): string {
  return [
    `model=${model}`,
    `case=${caseDef.caseId}`,
    `hash=${caseDef.caseHash}`,
    `run=${run}`,
    `variant=${variant.id}`,
  ].join(':')
}

function resumeKey(model: string, caseDef: EvalCaseDefinition, run: number, _variant: EvalVariant): string {
  return resumeKeyParts(model, caseDef.logicalCaseHash, run)
}

function resumeKeyParts(model: string, logicalCaseHash: string, run: number): string {
  return [
    `model=${model}`,
    `logical=${logicalCaseHash}`,
    `run=${run}`,
  ].join('\0')
}

function resumeKeyDisplay(key: string): string {
  return key.replaceAll('\0', ':')
}

function result(
  model: string,
  caseDef: EvalCaseDefinition,
  run: number,
  variant: EvalVariant,
  started: number,
  checks: Record<string, boolean>,
  notes: string[],
  options: {
    failures?: EvalFailure[]
    stages?: Record<string, unknown>
  } = {},
): EvalResult {
  const failures = options.failures ?? genericFailures(checks)
  return {
    runId: caseDef.runId,
    attemptId: attemptId(model, caseDef, run, variant),
    resumeKey: resumeKeyDisplay(resumeKey(model, caseDef, run, variant)),
    caseHash: caseDef.caseHash,
    logicalCaseHash: caseDef.logicalCaseHash,
    model,
    group: caseDef.group,
    id: caseDef.caseId,
    run,
    variant: variant.id,
    ok: failures.length === 0 && Object.values(checks).every(Boolean),
    latencyMs: Math.round(performance.now() - started),
    checks,
    failures,
    notes,
    ...(caseDef.evalContext ? { evalContext: caseDef.evalContext } : {}),
    ...(options.stages ? { stages: options.stages } : {}),
  }
}

function firstToolCall(content: ModelContentBlock[]) {
  return content.find(isToolCall) ?? null
}

function isToolCall(
  block: ModelContentBlock,
): block is Extract<ModelContentBlock, { kind: 'tool_call' }> {
  return block.kind === 'tool_call'
}

function responseText(content: ModelContentBlock[]): string {
  return content
    .filter((block): block is Extract<ModelContentBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

function textLooksLikeFollowUpQuestion(text: string): boolean {
  const lower = text.toLowerCase()
  return text.includes('?') ||
    /\b(vilket|vilka|vad|kan du|behöver|saknas|syfte|representation|privat|affärsnytta)\b/.test(lower)
}

function summarize(results: EvalResult[]): ModelSummary[] {
  const byModel = new Map<string, EvalResult[]>()
  for (const r of results) {
    byModel.set(r.model, [...(byModel.get(r.model) ?? []), r])
  }
  return [...byModel.entries()].map(([model, rows]) => {
    const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b)
    const failures = rows.flatMap((r) => r.failures)
    const hardFailures = failures.filter((failure) => failure.severity === 'hard')
    const unsafeCategorization = failures.filter((failure) => failure.code === 'unsafe_categorization').length
    const hallucinatedTool = rows.filter((r) => r.checks.allowed_tool_name === false).length
    const wrongTransactionId = rows.filter((r) => r.checks.correct_transaction_id === false).length
    return {
      model,
      total: rows.length,
      passed: rows.filter((r) => r.ok).length,
      validStructured: rows.filter((r) => r.checks.valid_structured_output === true).length,
      validToolCall: rows.filter((r) => r.checks.valid_tool_call === true).length,
      hallucinatedTool,
      wrongTransactionId,
      unsafeCategorization,
      wrongVatTreatment: failures.filter((failure) => failure.code === 'wrong_vat_treatment').length,
      unnecessaryClarification: failures.filter((failure) => failure.code === 'unnecessary_clarification').length,
      failures: {
        hard: hardFailures.length,
        severe: failures.filter((failure) => failure.severity === 'severe').length,
        mild: failures.filter((failure) => failure.severity === 'mild').length,
      },
      transactionRouting:
        wrongTransactionId === 0 &&
        hallucinatedTool === 0 &&
        unsafeCategorization === 0 &&
        hardFailures.length === 0
          ? 'eligible'
          : 'blocked',
      eligibility: {
        assistantOracleContext: eligibilityFor(rows.filter((r) => r.group === 'assistant' && r.variant.endsWith(':oracle-context'))),
        assistantEndToEnd: eligibilityFor(rows.filter((r) => r.group === 'assistant' && r.variant.endsWith(':end-to-end'))),
        transactionCategorization: eligibilityFor(rows.filter((r) => r.group === 'transaction')),
        queuedClassification: eligibilityFor(rows.filter((r) => r.group === 'classification')),
        composer: eligibilityFor(rows.filter((r) => r.group === 'composer')),
      },
      latencyMs: {
        min: latencies[0] ?? 0,
        median: latencies[Math.floor(latencies.length / 2)] ?? 0,
        max: latencies[latencies.length - 1] ?? 0,
      },
    }
  })
}

function eligibilityFor(rows: EvalResult[]): 'eligible' | 'blocked' {
  if (rows.length === 0) return 'blocked'
  return rows.some((r) => r.failures.some((failure) => failure.severity === 'hard')) ? 'blocked' : 'eligible'
}

function printHumanSummary(results: EvalResult[]) {
  const summaries = summarize(results)
  for (const summary of summaries) {
    console.log(`\nModel: ${summary.model}`)
    console.log(`  passed: ${summary.passed}/${summary.total}`)
    console.log(`  valid structured outputs: ${summary.validStructured}`)
    console.log(`  valid tool-call cases: ${summary.validToolCall}`)
    console.log(`  hallucinated tool cases: ${summary.hallucinatedTool}`)
    console.log(`  wrong transaction id cases: ${summary.wrongTransactionId}`)
    console.log(`  unsafe categorization cases: ${summary.unsafeCategorization}`)
    console.log(`  wrong VAT treatment cases: ${summary.wrongVatTreatment}`)
    console.log(`  unnecessary clarification cases: ${summary.unnecessaryClarification}`)
    console.log(
      `  failures: hard ${summary.failures.hard}, severe ${summary.failures.severe}, mild ${summary.failures.mild}`,
    )
    console.log(`  transaction routing: ${summary.transactionRouting}`)
    console.log(`  eligibility assistant/oracle-context: ${summary.eligibility.assistantOracleContext}`)
    console.log(`  eligibility assistant/end-to-end: ${summary.eligibility.assistantEndToEnd}`)
    console.log(`  eligibility transaction categorization: ${summary.eligibility.transactionCategorization}`)
    console.log(`  eligibility queued classification: ${summary.eligibility.queuedClassification}`)
    console.log(`  eligibility composer: ${summary.eligibility.composer}`)
    console.log(
      `  latency ms: min ${summary.latencyMs.min}, median ${summary.latencyMs.median}, max ${summary.latencyMs.max}`,
    )
  }

  console.log('\nCases:')
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.model} ${r.group}/${r.id} run=${r.run} variant=${r.variant} ${r.latencyMs}ms`)
    console.log(`    case: ${r.caseHash}`)
    console.log(`    attempt: ${r.attemptId}`)
    for (const [name, ok] of Object.entries(r.checks)) {
      console.log(`    ${ok ? 'ok' : 'no'} ${name}`)
    }
    for (const failure of r.failures) {
      console.log(`    failure[${failure.severity}]: ${failure.code} - ${failure.detail}`)
    }
    for (const note of r.notes) {
      console.log(`    note: ${note}`)
    }
  }
}

function parseArgs(argv: string[]): CliOptions {
  const groups = new Set<EvalGroup>(['smoke', 'composer', 'assistant', 'transaction', 'classification'])
  const models: string[] = []
  let json = false
  let runs = 3
  let resultsDir = DEFAULT_RESULTS_DIR
  let persist = true
  let resume = true
  let dryRun = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--models') {
      models.push(...splitList(argv[++i] ?? ''))
    } else if (arg.startsWith('--models=')) {
      models.push(...splitList(arg.slice('--models='.length)))
    } else if (arg === '--group' || arg === '--groups') {
      groups.clear()
      for (const group of splitList(argv[++i] ?? '')) groups.add(parseGroup(group))
    } else if (arg.startsWith('--group=')) {
      groups.clear()
      for (const group of splitList(arg.slice('--group='.length))) groups.add(parseGroup(group))
    } else if (arg.startsWith('--groups=')) {
      groups.clear()
      for (const group of splitList(arg.slice('--groups='.length))) groups.add(parseGroup(group))
    } else if (arg === '--runs') {
      runs = parsePositiveInteger(argv[++i] ?? '', '--runs')
    } else if (arg.startsWith('--runs=')) {
      runs = parsePositiveInteger(arg.slice('--runs='.length), '--runs')
    } else if (arg === '--results-dir') {
      resultsDir = argv[++i] ?? ''
    } else if (arg.startsWith('--results-dir=')) {
      resultsDir = arg.slice('--results-dir='.length)
    } else if (arg === '--no-persist') {
      persist = false
      resume = false
    } else if (arg === '--no-resume') {
      resume = false
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (persist && !resultsDir.trim()) {
    throw new Error('--results-dir must not be empty when persistence is enabled.')
  }
  if (dryRun && !persist) {
    resume = false
  }

  return { models, groups, json, runs, resultsDir, persist, resume, dryRun }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function firstModelToken(value: string): string {
  return value.split(/\s+/).find(Boolean) ?? ''
}

function parseGroup(value: string): EvalGroup {
  if (
    value === 'smoke' ||
    value === 'composer' ||
    value === 'assistant' ||
    value === 'transaction' ||
    value === 'classification'
  ) {
    return value
  }
  throw new Error(`Unknown group "${value}". Expected smoke, composer, assistant, transaction, or classification.`)
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`)
  }
  return parsed
}

function printHelp() {
  console.log([
    'Usage: npm run eval:local-ai -- [--models a,b] [--groups smoke,composer,assistant,transaction,classification] [--runs n] [--results-dir path] [--dry-run] [--no-resume] [--no-persist] [--json]',
    '',
    'Environment:',
    '  LOCAL_AI_BASE_URL   OpenAI-compatible /v1 base URL or /chat/completions URL',
    '  LOCAL_AI_MODEL      Default model when --models is omitted',
    '  LOCAL_AI_TIMEOUT_MS Optional per-request timeout, default from provider',
    '  LOCAL_AI_API_KEY    Optional bearer token for local endpoint',
    '',
    'Options:',
    '  --runs n           Repeat every selected fixture n times, default 3',
    `  --results-dir path Write case manifest and attempt JSONL, default ${DEFAULT_RESULTS_DIR}`,
    '  --dry-run          Print which attempts would run or be skipped without calling the model',
    '  --no-resume        Ignore prior attempt JSONL rows and run selected attempts again',
    '  --no-persist       Disable JSONL persistence and only print stdout output',
  ].join('\n'))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

main().catch((err) => {
  console.error(errorMessage(err))
  process.exit(1)
})
