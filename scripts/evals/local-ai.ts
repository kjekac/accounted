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
import { selectAtoms } from '../../lib/agent/composer/atom-selection'
import { AtomSelectionSchema } from '../../lib/agent/composer/schemas'
import type { ComposerInputs, AtomRegistryIndexRow } from '../../lib/agent/composer/inputs'
import { transactionCategorization } from '../../lib/agent/intents/transaction-categorization'
import type { AgentTool } from '../../lib/agent/tools/types'

type EvalGroup = 'smoke' | 'composer' | 'transaction'

interface CliOptions {
  models: string[]
  groups: Set<EvalGroup>
  json: boolean
}

interface EvalResult {
  model: string
  group: EvalGroup
  id: string
  ok: boolean
  latencyMs: number
  checks: Record<string, boolean>
  notes: string[]
}

interface ModelSummary {
  model: string
  total: number
  passed: number
  validStructured: number
  validToolCall: number
  hallucinatedTool: number
  wrongTransactionId: number
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
    mustCallCategorize: true,
    messages: transactionMessages({
      transaction: {
        id: 'tx_software_001',
        date: '2026-06-28',
        description: 'OPENAI CHATGPT SUBSCRIPTION 240628',
        amount: -247.5,
        currency: 'SEK',
        counterparty_name: 'OpenAI',
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
    id: 'transaction_restaurant_requires_context',
    expectedTransactionId: 'tx_restaurant_001',
    expectedCategory: null,
    mustCallCategorize: false,
    messages: [
      textMessage(
        'user',
        transactionCategorization.promptTemplate({
          profileSummary: 'Litet konsultaktiebolag med svensk moms.',
          activeMemory: [],
          captured: {
            transaction: {
              id: 'tx_restaurant_001',
              date: '2026-06-30',
              description: 'BISTRO SVEA STOCKHOLM',
              amount: -842,
              currency: 'SEK',
              counterparty_name: 'Bistro Svea',
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
          },
        }),
      ),
    ],
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

  const results: EvalResult[] = []
  for (const model of options.models) {
    process.env.LOCAL_AI_MODEL = model
    const provider = getModelProvider()
    if (provider.name !== 'local-openai-compatible') {
      throw new Error(`Expected local-openai-compatible provider, got ${provider.name}.`)
    }

    if (options.groups.has('smoke')) {
      results.push(await runSmokeStructured(provider, model))
      results.push(await runSmokeTool(provider, model))
    }
    if (options.groups.has('composer')) {
      for (const fixture of COMPOSER_FIXTURES) {
        results.push(await runComposerFixture(model, fixture))
      }
    }
    if (options.groups.has('transaction')) {
      for (const fixture of TRANSACTION_FIXTURES) {
        results.push(await runTransactionFixture(provider, model, fixture))
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ summaries: summarize(results), results }, null, 2))
    return
  }

  printHumanSummary(results)
}

async function runSmokeStructured(provider: ModelProvider, model: string): Promise<EvalResult> {
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_structured_output: false,
    correct_transaction_id: false,
    correct_category: false,
  }

  try {
    const output = await provider.generateStructured<unknown>({
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
    }, SMOKE_STRUCTURED_TOOL_SCHEMA)
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

  return result(model, 'smoke', 'smoke_generate_structured', started, checks, notes)
}

async function runSmokeTool(provider: ModelProvider, model: string): Promise<EvalResult> {
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_tool_call: false,
    allowed_tool_name: false,
    correct_transaction_id: false,
    correct_category: false,
  }

  try {
    const response = await provider.streamWithTools({
      model: SONNET_MODEL,
      maxTokens: 512,
      system: [{ kind: 'text', text: 'Call gnubok_categorize_transaction exactly once. Do not answer in prose.' }],
      messages: [
        textMessage(
          'user',
          'Transaction tx_smoke_tool is a -59 SEK bank fee. Stage it as expense_bank_fees.',
        ),
      ],
      tools: [CATEGORIZE_TOOL],
    })
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

  return result(model, 'smoke', 'smoke_stream_with_tools', started, checks, notes)
}

async function runComposerFixture(
  model: string,
  fixture: (typeof COMPOSER_FIXTURES)[number],
): Promise<EvalResult> {
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_structured_output: false,
    required_atoms_present: false,
    forbidden_atoms_absent: false,
    no_redundant_questions: false,
    no_unknown_atoms_after_filter: false,
  }

  try {
    const selection = await selectAtoms(fixture.inputs)
    const parsed = AtomSelectionSchema.safeParse(selection)
    checks.valid_structured_output = parsed.success
    if (!parsed.success) {
      notes.push(parsed.error.message)
    } else {
      const selected = [
        ...parsed.data.horizontal_atoms,
        ...parsed.data.vertical_atoms,
        ...parsed.data.modifier_atoms,
      ]
      const known = new Set(fixture.inputs.atomIndex.map((a) => a.id))
      checks.required_atoms_present = fixture.requiredAtoms.every((id) => selected.includes(id))
      checks.forbidden_atoms_absent = fixture.forbiddenAtoms.every((id) => !selected.includes(id))
      checks.no_unknown_atoms_after_filter = selected.every((id) => known.has(id))
      const questions = parsed.data.verification_questions.join('\n').toLowerCase()
      checks.no_redundant_questions = fixture.forbiddenQuestionWords.every((word) => !questions.includes(word))
      notes.push(`atoms=${selected.join(', ') || '(none)'}`)
      notes.push(`questions=${parsed.data.verification_questions.join(' | ') || '(none)'}`)
    }
  } catch (err) {
    notes.push(errorMessage(err))
  }

  return result(model, 'composer', fixture.id, started, checks, notes)
}

async function runTransactionFixture(
  provider: ModelProvider,
  model: string,
  fixture: (typeof TRANSACTION_FIXTURES)[number],
): Promise<EvalResult> {
  const started = performance.now()
  const notes: string[] = []
  const checks: Record<string, boolean> = {
    valid_tool_call: false,
    allowed_tool_name: true,
    correct_transaction_id: true,
    expected_category: true,
    respected_review_boundary: true,
  }

  try {
    const response = await provider.streamWithTools({
      model: transactionCategorization.model || SONNET_MODEL,
      maxTokens: (transactionCategorization.thinking?.budgetTokens ?? 0) + 2048,
      system: [{
        kind: 'text',
        text: [
          'Du är Accounteds lokala bokföringsassistent.',
          'Använd bara de verktyg du fått. Hitta inte på verktyg, kategorier, BAS-konton eller transaction_id.',
          'När information saknas ska du fråga användaren kort i stället för att staga en bokning.',
        ].join('\n'),
      }],
      messages: fixture.messages,
      tools: TRANSACTION_TOOLS,
      thinkingBudgetTokens: transactionCategorization.thinking?.budgetTokens,
    })
    const toolCalls = response.content.filter(isToolCall)
    checks.valid_tool_call = toolCalls.length > 0
    checks.allowed_tool_name = toolCalls.every((call) => ALLOWED_TRANSACTION_TOOLS.has(call.name))
    const categorizeCalls = toolCalls.filter((call) => call.name === 'gnubok_categorize_transaction')

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
    }

    if (toolCalls.length > 0) {
      notes.push(`tools=${toolCalls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(' | ')}`)
    } else {
      const text = response.content
        .filter((block): block is Extract<ModelContentBlock, { kind: 'text' }> => block.kind === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
      notes.push(`text=${text.slice(0, 500) || '(empty)'}`)
    }
  } catch (err) {
    notes.push(errorMessage(err))
    checks.valid_tool_call = false
    checks.allowed_tool_name = false
  }

  return result(model, 'transaction', fixture.id, started, checks, notes)
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

function result(
  model: string,
  group: EvalGroup,
  id: string,
  started: number,
  checks: Record<string, boolean>,
  notes: string[],
): EvalResult {
  return {
    model,
    group,
    id,
    ok: Object.values(checks).every(Boolean),
    latencyMs: Math.round(performance.now() - started),
    checks,
    notes,
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

function summarize(results: EvalResult[]): ModelSummary[] {
  const byModel = new Map<string, EvalResult[]>()
  for (const r of results) {
    byModel.set(r.model, [...(byModel.get(r.model) ?? []), r])
  }
  return [...byModel.entries()].map(([model, rows]) => {
    const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b)
    return {
      model,
      total: rows.length,
      passed: rows.filter((r) => r.ok).length,
      validStructured: rows.filter((r) => r.checks.valid_structured_output === true).length,
      validToolCall: rows.filter((r) => r.checks.valid_tool_call === true).length,
      hallucinatedTool: rows.filter((r) => r.checks.allowed_tool_name === false).length,
      wrongTransactionId: rows.filter((r) => r.checks.correct_transaction_id === false).length,
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
    console.log(
      `  latency ms: min ${summary.latencyMs.min}, median ${summary.latencyMs.median}, max ${summary.latencyMs.max}`,
    )
  }

  console.log('\nCases:')
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.model} ${r.group}/${r.id} ${r.latencyMs}ms`)
    for (const [name, ok] of Object.entries(r.checks)) {
      console.log(`    ${ok ? 'ok' : 'no'} ${name}`)
    }
    for (const note of r.notes) {
      console.log(`    note: ${note}`)
    }
  }
}

function parseArgs(argv: string[]): CliOptions {
  const groups = new Set<EvalGroup>(['smoke', 'composer', 'transaction'])
  const models: string[] = []
  let json = false

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
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { models, groups, json }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseGroup(value: string): EvalGroup {
  if (value === 'smoke' || value === 'composer' || value === 'transaction') return value
  throw new Error(`Unknown group "${value}". Expected smoke, composer, or transaction.`)
}

function printHelp() {
  console.log([
    'Usage: npm run eval:local-ai -- [--models a,b] [--groups smoke,composer,transaction] [--json]',
    '',
    'Environment:',
    '  LOCAL_AI_BASE_URL   OpenAI-compatible /v1 base URL or /chat/completions URL',
    '  LOCAL_AI_MODEL      Default model when --models is omitted',
    '  LOCAL_AI_TIMEOUT_MS Optional per-request timeout, default from provider',
    '  LOCAL_AI_API_KEY    Optional bearer token for local endpoint',
  ].join('\n'))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

main().catch((err) => {
  console.error(errorMessage(err))
  process.exit(1)
})
