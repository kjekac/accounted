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
import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import {
  getModelProvider,
  textMessage,
  type ModelContentBlock,
  type ModelMessage,
  type ModelProvider,
  type StructuredSchema,
} from '../../lib/agent/model-provider'
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
import type { AgentTool } from '../../lib/agent/tools/types'

type EvalGroup = 'smoke' | 'composer' | 'transaction' | 'classification'

const CASE_PREIMAGE_VERSION = 1
const SCORING_VERSION = 1
const DEFAULT_RESULTS_DIR = join('scripts', 'evals', 'results')

interface CliOptions {
  models: string[]
  groups: Set<EvalGroup>
  json: boolean
  runs: number
  resultsDir: string
  persist: boolean
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
  caseHash: string
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
  stages?: Record<string, unknown>
}

interface EvalCaseDefinition {
  caseId: string
  group: EvalGroup
  caseHash: string
  runId: string
  preimage: Record<string, unknown>
}

interface EvalPersistence {
  runId: string
  startedAt: string
  resultsDir: string
  manifestPath: string
  attemptsPath: string
  seenCaseHashes: Set<string>
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
    if (configured) options.models.push(configured)
  }
  if (options.models.length === 0) {
    throw new Error('Set LOCAL_AI_MODEL or pass --models model-a,model-b.')
  }
  if (!process.env.LOCAL_AI_BASE_URL?.trim()) {
    throw new Error('Set LOCAL_AI_BASE_URL to an OpenAI-compatible local endpoint.')
  }
  process.env.AI_PROVIDER = 'local'

  const persistence = options.persist ? await initPersistence(options.resultsDir) : null
  if (persistence && !options.json) {
    console.log(`Persisting eval results to ${persistence.attemptsPath}`)
    console.log(`Case manifest: ${persistence.manifestPath}`)
  }

  const results: EvalResult[] = []
  const collect = async (promise: Promise<EvalResult>) => {
    const row = await promise
    results.push(row)
    await appendAttemptResult(persistence, row)
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
    console.log(JSON.stringify({ summaries: summarize(results), results }, null, 2))
    return
  }

  printHumanSummary(results)
}

async function runSmokeStructured(
  provider: ModelProvider,
  model: string,
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalResult> {
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
): Promise<EvalResult> {
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
): Promise<EvalResult> {
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

async function runTransactionFixture(
  provider: ModelProvider,
  model: string,
  fixture: (typeof TRANSACTION_FIXTURES)[number],
  run: number,
  variant: EvalVariant,
  persistence: EvalPersistence | null,
): Promise<EvalResult> {
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
): Promise<EvalResult> {
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

async function initPersistence(resultsDir: string): Promise<EvalPersistence> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + `-${randomUUID().slice(0, 8)}`
  const manifestPath = join(resultsDir, 'case-manifest.jsonl')
  const attemptsPath = join(resultsDir, `attempt-results-${runId}.jsonl`)
  await mkdir(resultsDir, { recursive: true })
  return {
    runId,
    startedAt: new Date().toISOString(),
    resultsDir,
    manifestPath,
    attemptsPath,
    seenCaseHashes: await readManifestHashes(manifestPath),
  }
}

async function readManifestHashes(manifestPath: string): Promise<Set<string>> {
  try {
    const text = await readFile(manifestPath, 'utf8')
    const hashes = new Set<string>()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed) as { case_hash?: unknown }
        if (typeof row.case_hash === 'string') hashes.add(row.case_hash)
      } catch {
        // Ignore malformed historical rows. The append path below will still
        // record any missing hash encountered during this run.
      }
    }
    return hashes
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return new Set()
    }
    throw err
  }
}

async function defineCase(
  persistence: EvalPersistence | null,
  group: EvalGroup,
  caseId: string,
  variant: EvalVariant,
  preimage: Record<string, unknown>,
): Promise<EvalCaseDefinition> {
  const fullPreimage = {
    harness: 'local-ai',
    case_preimage_version: CASE_PREIMAGE_VERSION,
    scoring_version: SCORING_VERSION,
    group,
    case_id: caseId,
    variant: normalizeVariant(variant),
    ...preimage,
  }
  const caseHash = `sha256:${sha256Hex(canonicalJson(fullPreimage))}`
  const definition = { caseId, group, caseHash, runId: persistence?.runId ?? 'memory-only', preimage: fullPreimage }
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
    completed_at: new Date().toISOString(),
  })
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
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
    caseHash: caseDef.caseHash,
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
      latencyMs: {
        min: latencies[0] ?? 0,
        median: latencies[Math.floor(latencies.length / 2)] ?? 0,
        max: latencies[latencies.length - 1] ?? 0,
      },
    }
  })
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
  const groups = new Set<EvalGroup>(['smoke', 'composer', 'transaction', 'classification'])
  const models: string[] = []
  let json = false
  let runs = 3
  let resultsDir = DEFAULT_RESULTS_DIR
  let persist = true

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

  return { models, groups, json, runs, resultsDir, persist }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseGroup(value: string): EvalGroup {
  if (
    value === 'smoke' ||
    value === 'composer' ||
    value === 'transaction' ||
    value === 'classification'
  ) {
    return value
  }
  throw new Error(`Unknown group "${value}". Expected smoke, composer, transaction, or classification.`)
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
    'Usage: npm run eval:local-ai -- [--models a,b] [--groups smoke,composer,transaction,classification] [--runs n] [--results-dir path] [--no-persist] [--json]',
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
