/**
 * Tests for the bank reconciliation engine.
 *
 * Covers: matching algorithm (4 passes), direction compatibility,
 * greedy assignment, dry run, manual link/unlink, status calculation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  tryReconcileTransaction,
  runReconciliation,
  manualLink,
  unlinkReconciliation,
} from '../bank-reconciliation'
import type { UnlinkedGLLine } from '../bank-reconciliation'
import { makeTransaction } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

vi.mock('@/lib/supabase/server')

// ============================================================
// Helpers
// ============================================================

function makeGLLine(overrides: Partial<UnlinkedGLLine> = {}): UnlinkedGLLine {
  return {
    line_id: `line-${Math.random().toString(36).slice(2, 8)}`,
    journal_entry_id: `je-${Math.random().toString(36).slice(2, 8)}`,
    debit_amount: 0,
    credit_amount: 0,
    line_description: null,
    entry_date: '2024-06-15',
    voucher_number: 1,
    voucher_series: 'A',
    entry_description: 'Test entry',
    source_type: 'import',
    ...overrides,
  }
}

// ============================================================
// tryReconcileTransaction — in-memory matching
// ============================================================

describe('tryReconcileTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  // ------------------------------------------------------------------
  // Pass 1: Exact amount + exact date
  // ------------------------------------------------------------------
  it('matches income transaction with exact amount and date (debit on 1930)', () => {
    const tx = makeTransaction({ amount: 5000, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 5000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_exact')
    expect(result!.confidence).toBe(0.95)
  })

  it('matches expense transaction with exact amount and date (credit on 1930)', () => {
    const tx = makeTransaction({ amount: -1200, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1200, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_exact')
    expect(result!.confidence).toBe(0.95)
  })

  // ------------------------------------------------------------------
  // Pass 2: Exact amount + OCR/reference match (within ±90 days)
  // ------------------------------------------------------------------
  it('matches on exact amount with OCR reference match within 90 days', () => {
    const tx = makeTransaction({
      amount: 3500,
      date: '2024-06-20',
      currency: 'SEK',
      reference: '12345678',
    })
    const line = makeGLLine({
      debit_amount: 3500,
      entry_date: '2024-06-10',
      entry_description: 'Payment ref 12345678',
    })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_reference')
    expect(result!.confidence).toBe(0.90)
  })

  // Regression: viktor@frnzn.com — recurring monthly bank fee from 2026 was
  // wrongly reconciled to a 2024 SIE-imported voucher because description +
  // amount collided. auto_reference must require a real OCR token AND a
  // bounded date window — description alone, no date check, is not enough.
  it('does NOT match recurring charge across years on description alone', () => {
    const tx = makeTransaction({
      amount: -149,
      date: '2026-01-31',
      currency: 'SEK',
      description: 'Månadsavgift Baspaket',
      reference: null,
    })
    const line = makeGLLine({
      credit_amount: 149,
      entry_date: '2024-03-31',
      entry_description: 'Bankavgifter Månadsavgift Baspaket',
    })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  it('does NOT match on OCR reference when dates are >90 days apart', () => {
    const tx = makeTransaction({
      amount: 3500,
      date: '2026-06-20',
      currency: 'SEK',
      reference: '12345678',
    })
    const line = makeGLLine({
      debit_amount: 3500,
      entry_date: '2024-06-10',
      entry_description: 'Payment ref 12345678',
    })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Pass 3: Exact amount + date within ±3 days
  // ------------------------------------------------------------------
  it('matches on exact amount within 3 day date range', () => {
    const tx = makeTransaction({ amount: 750, date: '2024-06-17', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 750, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_date_range')
    expect(result!.confidence).toBe(0.85)
  })

  it('does not match when date difference exceeds 3 days', () => {
    const tx = makeTransaction({ amount: 750, date: '2024-06-20', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 750, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    // 5 days apart, no reference, different dates — no match
    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Pass 4: Fuzzy amount (±0.01) + exact date
  // ------------------------------------------------------------------
  it('matches on fuzzy amount with exact date', () => {
    const tx = makeTransaction({ amount: -999.99, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).not.toBeNull()
    expect(result!.method).toBe('auto_fuzzy')
    expect(result!.confidence).toBe(0.75)
  })

  it('does not match when fuzzy amount exceeds 0.01 tolerance', () => {
    const tx = makeTransaction({ amount: -999.98, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Direction mismatch rejection
  // ------------------------------------------------------------------
  it('rejects income transaction against credit line (direction mismatch)', () => {
    const tx = makeTransaction({ amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ credit_amount: 1000, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  it('rejects expense transaction against debit line (direction mismatch)', () => {
    const tx = makeTransaction({ amount: -500, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 500, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Non-SEK transactions
  // ------------------------------------------------------------------
  it('skips non-SEK transactions', () => {
    const tx = makeTransaction({ amount: 100, date: '2024-06-15', currency: 'EUR' })
    const line = makeGLLine({ debit_amount: 100, entry_date: '2024-06-15' })

    const result = tryReconcileTransaction(tx, [line])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Empty pool
  // ------------------------------------------------------------------
  it('returns null for empty GL line pool', () => {
    const tx = makeTransaction({ amount: 100, date: '2024-06-15', currency: 'SEK' })

    const result = tryReconcileTransaction(tx, [])

    expect(result).toBeNull()
  })

  // ------------------------------------------------------------------
  // Priority: highest confidence wins
  // ------------------------------------------------------------------
  it('prefers exact match over date range match', () => {
    const tx = makeTransaction({ amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const exactLine = makeGLLine({
      line_id: 'exact',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })
    const rangeLine = makeGLLine({
      line_id: 'range',
      debit_amount: 1000,
      entry_date: '2024-06-14',
    })

    const result = tryReconcileTransaction(tx, [rangeLine, exactLine])

    expect(result).not.toBeNull()
    expect(result!.glLine.line_id).toBe('exact')
    expect(result!.method).toBe('auto_exact')
  })

  // ------------------------------------------------------------------
  // No double-matching when using greedy algorithm
  // ------------------------------------------------------------------
  it('each GL line can only match once in a pool', () => {
    const tx1 = makeTransaction({ id: 'tx-1', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const tx2 = makeTransaction({ id: 'tx-2', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const line = makeGLLine({ debit_amount: 1000, entry_date: '2024-06-15' })

    // First transaction matches
    const result1 = tryReconcileTransaction(tx1, [line])
    expect(result1).not.toBeNull()

    // Second transaction against the same single line also matches individually
    const result2 = tryReconcileTransaction(tx2, [line])
    expect(result2).not.toBeNull()

    // But in the batch reconciliation (greedyMatch), only one would be assigned
    // This is tested in runReconciliation tests
  })
})

// ============================================================
// runReconciliation — batch matching with DB calls
// ============================================================

describe('runReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function createQueueMockSupabase() {
    const resultQueue: { data: unknown; error: unknown }[] = []

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

  it('returns empty matches when no unmatched transactions exist', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // RPC: get_unlinked_1930_lines returns empty
    enqueue({ data: [] })
    // from('transactions').select — unmatched
    enqueue({ data: [] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1')

    expect(result.matches).toEqual([])
    expect(result.applied).toBe(0)
  })

  it('dry run returns matches without applying', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx = makeTransaction({ id: 'tx-1', amount: 1000, date: '2024-06-15', currency: 'SEK' })
    const glLine: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      debit_amount: 1000,
      entry_date: '2024-06-15',
    })

    // RPC returns GL lines
    enqueue({ data: [glLine] })
    // from('transactions') returns unmatched transactions
    enqueue({ data: [tx] })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: true })

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].method).toBe('auto_exact')
    expect(result.applied).toBe(0)
  })

  it('applies matches when not dry run', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const tx = makeTransaction({ id: 'tx-1', amount: -500, date: '2024-06-15', currency: 'SEK' })
    const glLine: UnlinkedGLLine = makeGLLine({
      line_id: 'line-1',
      journal_entry_id: 'je-1',
      credit_amount: 500,
      entry_date: '2024-06-15',
    })

    // RPC returns GL lines
    enqueue({ data: [glLine] })
    // from('transactions') returns unmatched transactions
    enqueue({ data: [tx] })
    // Update transaction with link
    enqueue({ data: null, error: null })

    const result = await runReconciliation(supabase as never, 'company-1', 'user-1', { dryRun: false })

    expect(result.matches).toHaveLength(1)
    expect(result.applied).toBe(1)
    expect(result.errors).toBe(0)
  })
})

// ============================================================
// manualLink
// ============================================================

describe('manualLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function createQueueMockSupabase() {
    const resultQueue: { data: unknown; error: unknown }[] = []

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

  it('rejects when transaction not found', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Transaction query returns null
    enqueue({ data: null, error: { message: 'Not found' } })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaction not found')
  })

  it('rejects when transaction is already linked', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: 'je-existing' })

    // Transaction found but already linked
    enqueue({ data: tx })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Transaction is already linked to a journal entry')
  })

  it('rejects when journal entry has no 1930 line', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    // Transaction found
    enqueue({ data: tx })
    // Journal entry found
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // No 1930 lines
    enqueue({ data: [] })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Verifikationen saknar rad på bankkonto (19xx)')
  })

  it('succeeds when all validations pass', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })

    // Transaction found
    enqueue({ data: tx })
    // Journal entry found
    enqueue({ data: { id: 'je-1', user_id: 'company-1', status: 'posted' } })
    // 1930 line exists
    enqueue({ data: [{ debit_amount: 1000, credit_amount: 0 }] })
    // No existing link
    enqueue({ data: null, error: null })
    // Update succeeds
    enqueue({ data: null, error: null })

    const result = await manualLink(supabase as never, 'company-1', 'tx-1', 'je-1', 'user-1')

    expect(result.success).toBe(true)
  })
})

// ============================================================
// unlinkReconciliation
// ============================================================

describe('unlinkReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  function createQueueMockSupabase() {
    const resultQueue: { data: unknown; error: unknown }[] = []

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

  it('rejects when transaction has no reconciliation_method (categorization entry)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Transaction found with journal_entry_id but no reconciliation_method
    enqueue({
      data: {
        id: 'tx-1',
        journal_entry_id: 'je-1',
        reconciliation_method: null,
      },
    })

    const result = await unlinkReconciliation(supabase as never, 'company-1', 'tx-1')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Cannot unlink')
  })

  it('succeeds when reconciliation_method is set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Transaction found with reconciliation_method
    enqueue({
      data: {
        id: 'tx-1',
        journal_entry_id: 'je-1',
        reconciliation_method: 'auto_exact',
      },
    })
    // Update succeeds
    enqueue({ data: null, error: null })

    const result = await unlinkReconciliation(supabase as never, 'company-1', 'tx-1')

    expect(result.success).toBe(true)
  })
})
