/**
 * Tests for the generic transaction ingestion pipeline.
 *
 * Covers deduplication, insert, invoice matching, auto-categorization,
 * and result aggregation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ingestTransactions, type RawTransaction } from '../ingest'
import { makeJournalEntry, makeTransaction } from '@/tests/helpers'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockEvaluateMappingRules = vi.fn()
vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  evaluateMappingRules: (...args: unknown[]) => mockEvaluateMappingRules(...args),
}))

const mockCreateTransactionJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) =>
    mockCreateTransactionJournalEntry(...args),
}))

const mockGetBestInvoiceMatch = vi.fn()
vi.mock('@/lib/invoices/invoice-matching', () => ({
  getBestInvoiceMatch: (...args: unknown[]) => mockGetBestInvoiceMatch(...args),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
}))

// ---------------------------------------------------------------------------
// Queue-based Supabase mock
// ---------------------------------------------------------------------------

function createQueueMockSupabase() {
  const resultQueue: { data: unknown; error: unknown }[] = []

  /**
   * Push one or more results onto the queue.
   * Each awaited Supabase chain pops the next result in FIFO order.
   */
  const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
    for (const r of results) {
      resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
    }
  }

  const buildChain = (): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const next = resultQueue.shift() ?? { data: null, error: null }
          return (resolve: (v: unknown) => void) => resolve(next)
        }
        return (..._args: unknown[]) => buildChain()
      },
    }
    return new Proxy({}, handler)
  }

  const supabase = {
    from: vi.fn().mockImplementation(() => buildChain()),
    rpc: vi.fn().mockImplementation(() => buildChain()),
  }

  return { supabase, enqueue }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-1'
const COMPANY_ID = 'company-1'

function makeRaw(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    date: '2024-06-15',
    description: 'Test transaction',
    amount: -250.0,
    currency: 'SEK',
    external_id: `ext-${Math.random().toString(36).slice(2, 8)}`,
    mcc_code: null,
    merchant_name: null,
    reference: null,
    bank_connection_id: null,
    import_source: 'test',
    ...overrides,
  }
}

function makeMappingResult(overrides: Record<string, unknown> = {}) {
  return {
    rule: null,
    debit_account: '5410',
    credit_account: '1930',
    risk_level: 'low',
    confidence: 0.9,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Office supplies',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
//
// Queue order after batch dedup refactor:
// 1. Booked transaction map query
// 1b. Unbooked bank-synced transaction map query
// 2. Supplier invoices fetch
// 3. Batch external_id dedup query (returns matching external_ids)
// 4. Per-transaction: insert, updates, etc.
// ---------------------------------------------------------------------------

describe('ingestTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // 1. Successfully imports new transactions
  // -----------------------------------------------------------------------
  it('imports new transactions when no duplicate exists', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -100 })
    const inserted = makeTransaction({ id: 'tx-1', external_id: raw.external_id })

    // Booked transaction map query (no booked transactions)
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch (no unpaid invoices)
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert returns the new transaction
    enqueue({ data: inserted, error: null })
    // evaluateMappingRules will be called but we want low confidence
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.transaction_ids).toEqual(['tx-1'])
  })

  // -----------------------------------------------------------------------
  // 2. Detects duplicates
  // -----------------------------------------------------------------------
  it('detects duplicates via external_id', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw()

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — returns matching external_id
    enqueue({ data: [{ external_id: raw.external_id }], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.transaction_ids).toEqual([])
  })

  // -----------------------------------------------------------------------
  // 2b. CSV row dedupes against uncategorized enable_banking row when
  //     date+amount+description prefix match (Lunar CSV vs Lunar PSD2 case).
  // -----------------------------------------------------------------------
  it('dedupes CSV row against unbooked enable_banking row with matching description', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2024-06-15',
      amount: -250.0,
      description: 'ICA Maxi Solna',
      external_id: 'lunar_csvhash123',
      import_source: 'csv_lunar',
    })

    // Booked transaction map query — none
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query — one PSD2 row with matching content
    enqueue({
      data: [{ date: '2024-06-15', amount: -250.0, description: 'ICA Maxi Solna' }],
      error: null,
    })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — external_id differs, so no match
    enqueue({ data: [], error: null })
    // No insert expected — row should be deduplicated at content layer

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.transaction_ids).toEqual([])
  })

  // -----------------------------------------------------------------------
  // 2c. No false positive: same date+amount but different description does
  //     NOT trigger content dedup — guards against the historical concern
  //     about unrelated transfers colliding on (date, amount) alone.
  // -----------------------------------------------------------------------
  it('does not dedupe when date+amount match but description differs', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2024-06-15',
      amount: -250.0,
      description: 'Coop Stockholm',
      external_id: 'lunar_csvhash456',
      import_source: 'csv_lunar',
    })
    const inserted = makeTransaction({
      id: 'tx-no-collision',
      external_id: raw.external_id,
      amount: -250.0,
    })

    // Booked transaction map query — none
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query — a PSD2 row with same date/amount but DIFFERENT description
    enqueue({
      data: [{ date: '2024-06-15', amount: -250.0, description: 'ICA Maxi Solna' }],
      error: null,
    })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — no match
    enqueue({ data: [], error: null })
    // Insert succeeds — the new row is not a duplicate
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.transaction_ids).toEqual(['tx-no-collision'])
  })

  // -----------------------------------------------------------------------
  // 3. Counts errors when insert fails
  // -----------------------------------------------------------------------
  it('counts errors when insert fails', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw()

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert fails
    enqueue({ data: null, error: { message: 'DB constraint violation' } })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.errors).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.transaction_ids).toEqual([])
  })

  // -----------------------------------------------------------------------
  // 4. Auto-matches invoices for income transactions (amount > 0)
  // -----------------------------------------------------------------------
  it('auto-matches invoices for income transactions', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: 5000, description: 'Payment received' })
    const inserted = makeTransaction({
      id: 'tx-income',
      amount: 5000,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert returns the new transaction
    enqueue({ data: inserted, error: null })
    // Invoice match update (supabase.from('transactions').update(...))
    enqueue({ data: null, error: null })
    // Mapping rules auto-categorization update (if triggered)
    enqueue({ data: null, error: null })

    mockGetBestInvoiceMatch.mockResolvedValue({
      invoice: { id: 'inv-1' },
      confidence: 0.95,
      matchReason: 'OCR reference match',
    })
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_matched_invoices).toBe(1)
    expect(mockGetBestInvoiceMatch).toHaveBeenCalledWith(
      expect.anything(), // supabase client
      COMPANY_ID,
      expect.objectContaining({ id: 'tx-income' }),
      0.50
    )
  })

  // -----------------------------------------------------------------------
  // 5. Does not attempt invoice matching for expenses (amount < 0)
  // -----------------------------------------------------------------------
  it('does not attempt invoice matching for expenses', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -350 })
    const inserted = makeTransaction({
      id: 'tx-expense',
      amount: -350,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.auto_matched_invoices).toBe(0)
    expect(mockGetBestInvoiceMatch).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 6. Auto-categorizes when mapping confidence >= 0.8
  // -----------------------------------------------------------------------
  it('auto-categorizes when mapping confidence is at least 0.8', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -500, mcc_code: 5411, merchant_name: 'ICA' })
    const inserted = makeTransaction({
      id: 'tx-cat',
      amount: -500,
      external_id: raw.external_id,
    })
    const journalEntry = makeJournalEntry({ id: 'je-1' })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })
    // Update after journal entry creation
    enqueue({ data: null, error: null })

    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.85, requires_review: false })
    )
    mockCreateTransactionJournalEntry.mockResolvedValue(journalEntry)

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_categorized).toBe(1)
    expect(mockCreateTransactionJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({ id: 'tx-cat' }),
      expect.objectContaining({ confidence: 0.85 })
    )
  })

  // -----------------------------------------------------------------------
  // 7. Skips auto-categorization when confidence < 0.8
  // -----------------------------------------------------------------------
  it('skips auto-categorization when confidence is below 0.8', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -200 })
    const inserted = makeTransaction({
      id: 'tx-lowconf',
      amount: -200,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.6 })
    )

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_categorized).toBe(0)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 7b. Skips auto-categorization when requires_review is true
  // -----------------------------------------------------------------------
  it('skips auto-categorization when requires_review is true even if confidence is high', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -800 })
    const inserted = makeTransaction({
      id: 'tx-review',
      amount: -800,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.95, requires_review: true })
    )

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_categorized).toBe(0)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 8. Returns correct IngestResult totals
  // -----------------------------------------------------------------------
  it('returns correct IngestResult totals', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw1 = makeRaw({ external_id: 'ext-a', amount: -100 })
    const raw2 = makeRaw({ external_id: 'ext-b', amount: -200 })

    const inserted1 = makeTransaction({ id: 'tx-a', amount: -100 })
    const inserted2 = makeTransaction({ id: 'tx-b', amount: -200 })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Transaction 1: insert OK
    enqueue({ data: inserted1, error: null })
    // Transaction 2: insert OK
    enqueue({ data: inserted2, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw1, raw2])

    expect(result.imported).toBe(2)
    expect(result.duplicates).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.auto_categorized).toBe(0)
    expect(result.auto_matched_invoices).toBe(0)
    expect(result.transaction_ids).toEqual(['tx-a', 'tx-b'])
  })

  // -----------------------------------------------------------------------
  // 9. Handles mixed batch (new, duplicates, errors)
  // -----------------------------------------------------------------------
  it('handles a mixed batch of new transactions, duplicates, and errors', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const rawNew = makeRaw({ external_id: 'ext-new', amount: 3000 })
    const rawDup = makeRaw({ external_id: 'ext-dup', amount: -150 })
    const rawErr = makeRaw({ external_id: 'ext-err', amount: -75 })

    const insertedNew = makeTransaction({
      id: 'tx-new',
      amount: 3000,
      external_id: 'ext-new',
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — ext-dup already exists
    enqueue({ data: [{ external_id: 'ext-dup' }], error: null })
    // Transaction rawNew: insert OK
    enqueue({ data: insertedNew, error: null })
    // Invoice match update for income transaction
    enqueue({ data: null, error: null })
    // logMatchEvent insert (fire-and-forget)
    enqueue({ data: null, error: null })
    // rawDup: skipped (in Set) — no queue entry needed
    // NOTE: auto-categorization is skipped because invoice match triggers `continue`
    // Transaction rawErr: insert fails
    enqueue({ data: null, error: { message: 'Insert failed' } })

    // Income transaction gets an invoice match
    mockGetBestInvoiceMatch.mockResolvedValue({
      invoice: { id: 'inv-match' },
      confidence: 0.95,
      matchReason: 'Exact amount match',
    })

    // Auto-categorization with high confidence
    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.85 })
    )
    const journalEntry = makeJournalEntry({ id: 'je-mixed' })
    mockCreateTransactionJournalEntry.mockResolvedValue(journalEntry)

    const result = await ingestTransactions(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      [rawNew, rawDup, rawErr]
    )

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.auto_matched_invoices).toBe(1)
    expect(result.auto_categorized).toBe(0) // Skipped: invoice match triggers continue
    expect(result.transaction_ids).toEqual(['tx-new'])
  })

  // -----------------------------------------------------------------------
  // Edge: empty input array
  // -----------------------------------------------------------------------
  it('returns zero totals for an empty input array', async () => {
    const { supabase } = createQueueMockSupabase()

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [])

    expect(result).toEqual({
      imported: 0,
      duplicates: 0,
      reconciled: 0,
      auto_categorized: 0,
      auto_matched_invoices: 0,
      errors: 0,
      transaction_ids: [],
    })
  })

  // -----------------------------------------------------------------------
  // Edge: invoice matching error is non-critical
  // -----------------------------------------------------------------------
  it('continues processing when invoice matching throws', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: 1000 })
    const inserted = makeTransaction({ id: 'tx-inv-err', amount: 1000 })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    enqueue({ data: inserted, error: null })

    mockGetBestInvoiceMatch.mockRejectedValue(new Error('Network error'))
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    // Should still count as imported even though invoice matching failed
    expect(result.imported).toBe(1)
    expect(result.auto_matched_invoices).toBe(0)
    expect(result.errors).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Edge: auto-categorization error is non-critical
  // -----------------------------------------------------------------------
  it('continues processing when auto-categorization throws', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -400 })
    const inserted = makeTransaction({ id: 'tx-cat-err', amount: -400 })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockRejectedValue(new Error('Mapping error'))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.auto_categorized).toBe(0)
    expect(result.errors).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Imports never auto-link to existing journal entries.
  // Reconciliation must be an explicit user action (manualLink / runReconciliation).
  // Regression: viktor@frnzn.com — bank txns from 2026 were silently linked
  // to SIE-imported vouchers, surfacing them as "bokförda" without action.
  // -----------------------------------------------------------------------
  it('never auto-reconciles imported transactions to existing GL lines', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -500, external_id: 'ext-recon' })
    const inserted = makeTransaction({
      id: 'tx-recon',
      amount: -500,
      external_id: 'ext-recon',
      currency: 'SEK',
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.reconciled).toBe(0)
  })

  // -----------------------------------------------------------------------
  // rawInsertOnly: skips reconciliation, matching, and auto-categorization
  // -----------------------------------------------------------------------
  it('skips reconciliation, matching, and categorization when rawInsertOnly is set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: 5000, description: 'Payment received' })
    const inserted = makeTransaction({
      id: 'tx-raw',
      amount: 5000,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // No supplier invoices fetch (skipped by rawInsertOnly)
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert returns the new transaction
    enqueue({ data: inserted, error: null })

    const result = await ingestTransactions(
      supabase as never, COMPANY_ID, USER_ID, [raw],
      { rawInsertOnly: true }
    )

    expect(result.imported).toBe(1)
    expect(result.reconciled).toBe(0)
    expect(result.auto_categorized).toBe(0)
    expect(result.auto_matched_invoices).toBe(0)
    // Should NOT have attempted any post-insert operations
    expect(mockGetBestInvoiceMatch).not.toHaveBeenCalled()
    expect(mockEvaluateMappingRules).not.toHaveBeenCalled()
  })

  it('still deduplicates when rawInsertOnly is set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ external_id: 'ext-dup-raw' })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — already exists
    enqueue({ data: [{ external_id: 'ext-dup-raw' }], error: null })

    const result = await ingestTransactions(
      supabase as never, COMPANY_ID, USER_ID, [raw],
      { rawInsertOnly: true }
    )

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Content-based dedup: cross-source duplicate detection
  // -----------------------------------------------------------------------
  it('skips transactions that match already-booked ones by date+amount+description', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      external_id: 'psd2_conn123_tx456',
      date: '2024-06-15',
      amount: -250,
    })

    // Booked transaction map returns a booked tx with same date+amount+description
    enqueue({
      data: [{ date: '2024-06-15', amount: -250, description: raw.description }],
      error: null,
    })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no match by external_id)
    enqueue({ data: [], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  it('imports transactions when booked ones have different amounts', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      external_id: 'psd2_conn123_tx789',
      date: '2024-06-15',
      amount: -300,
    })
    const inserted = makeTransaction({ id: 'tx-new', amount: -300 })

    // Booked transaction map: same date but different amount
    enqueue({
      data: [{ date: '2024-06-15', amount: -250, description: raw.description }],
      error: null,
    })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no match)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
  })

  it('handles multiple booked transactions with same date+amount correctly', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Three incoming transactions with the same date+amount
    const raw1 = makeRaw({ external_id: 'psd2_a', date: '2024-06-15', amount: -100 })
    const raw2 = makeRaw({ external_id: 'psd2_b', date: '2024-06-15', amount: -100 })
    const raw3 = makeRaw({ external_id: 'psd2_c', date: '2024-06-15', amount: -100 })

    const inserted = makeTransaction({ id: 'tx-new', amount: -100 })

    // Booked map: 2 existing booked transactions with same date+amount+description
    // So 2 of the 3 incoming should be skipped, 1 should be imported
    enqueue({
      data: [
        { date: '2024-06-15', amount: -100, description: raw1.description },
        { date: '2024-06-15', amount: -100, description: raw1.description },
      ],
      error: null,
    })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches for any)
    enqueue({ data: [], error: null })

    // raw1: not in external_id set → content dedup matches (bookedCount=2 -> 1)
    // raw2: not in external_id set → content dedup matches (bookedCount=1 -> 0)
    // raw3: not in external_id set → content dedup exhausted → insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw1, raw2, raw3])

    expect(result.duplicates).toBe(2)
    expect(result.imported).toBe(1)
  })

  // -----------------------------------------------------------------------
  // FX rate fetching (issue #442)
  // Each non-SEK transaction must be priced at the rate of its OWN date,
  // not the import date and not a single batch-level rate.
  // -----------------------------------------------------------------------
  it('fetches an exchange rate per unique (currency, date) pair', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw1 = makeRaw({ amount: -100, currency: 'USD', date: '2026-05-07', external_id: 'usd-a' })
    const raw2 = makeRaw({ amount: -50, currency: 'USD', date: '2026-05-08', external_id: 'usd-b' })
    const raw3 = makeRaw({ amount: -200, currency: 'EUR', date: '2026-05-07', external_id: 'eur-a' })
    const raw4 = makeRaw({ amount: -300, currency: 'USD', date: '2026-05-07', external_id: 'usd-c' })

    enqueue({ data: [], error: null }) // booked map
    enqueue({ data: [], error: null }) // unbooked enable_banking map
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // batch external_id dedup
    enqueue({ data: makeTransaction({ id: 'tx-1' }), error: null })
    enqueue({ data: makeTransaction({ id: 'tx-2' }), error: null })
    enqueue({ data: makeTransaction({ id: 'tx-3' }), error: null })
    enqueue({ data: makeTransaction({ id: 'tx-4' }), error: null })

    mockFetchExchangeRate.mockResolvedValue({ currency: 'USD', rate: 9.2, date: '2026-05-07' })
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw1, raw2, raw3, raw4])

    // 3 unique pairs: USD/2026-05-07, USD/2026-05-08, EUR/2026-05-07.
    // raw4 reuses USD/2026-05-07 and must NOT trigger an extra fetch.
    expect(mockFetchExchangeRate).toHaveBeenCalledTimes(3)
    const pairs = mockFetchExchangeRate.mock.calls.map(([currency, date]) => ({
      currency,
      date: (date as Date).toISOString().split('T')[0],
    }))
    expect(pairs).toContainEqual({ currency: 'USD', date: '2026-05-07' })
    expect(pairs).toContainEqual({ currency: 'USD', date: '2026-05-08' })
    expect(pairs).toContainEqual({ currency: 'EUR', date: '2026-05-07' })
  })

  it('does not fetch a rate for SEK transactions', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -100, currency: 'SEK', date: '2026-05-07' })

    enqueue({ data: [], error: null }) // booked
    enqueue({ data: [], error: null }) // unbooked
    enqueue({ data: [], error: null }) // suppliers
    enqueue({ data: [], error: null }) // dedup
    enqueue({ data: makeTransaction({ id: 'tx-sek' }), error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('continues normally when booked transaction map query fails', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -200 })
    const inserted = makeTransaction({ id: 'tx-mapfail', amount: -200 })

    // Booked map query throws (caught by try/catch in buildExistingTransactionMap)
    enqueue({ error: { message: 'Query failed' } })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
  })
})
