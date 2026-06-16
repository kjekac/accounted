/**
 * Tests for the booking-time duplicate guard.
 *
 * Detection queries `transactions` for same-date already-booked siblings, then
 * filters by öre + cash-account compatibility in JS, then resolves the voucher
 * label from `journal_entries`. The mock returns the rows each query yields.
 */
import { describe, it, expect } from 'vitest'
import { detectBookedDuplicateTransaction } from '../booking-duplicate-detection'

type TxRow = {
  id: string
  date: string
  amount: number | string
  description: string | null
  cash_account_id: string | null
  journal_entry_id: string
}
type JeRow = { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }

function txChain(data: TxRow[]) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.not = () => c
  c.neq = () => c
  c.limit = () => Promise.resolve({ data, error: null })
  return c
}
function jeChain(data: JeRow | null) {
  const c: Record<string, unknown> = {}
  c.select = () => c
  c.eq = () => c
  c.maybeSingle = () => Promise.resolve({ data, error: null })
  return c
}
function makeSupabase(txData: TxRow[], jeData: JeRow | null = { voucher_series: 'A', voucher_number: 142, entry_date: '2025-12-19' }) {
  return {
    from: (table: string) => (table === 'transactions' ? txChain(txData) : jeChain(jeData)),
  } as never
}

const COMPANY = 'co-1'
const sibling = (over: Partial<TxRow> = {}): TxRow => ({
  id: 'sib-1',
  date: '2025-12-19',
  amount: -1616,
  description: 'TELENOR SVERIGE AB',
  cash_account_id: null,
  journal_entry_id: 'je-1',
  ...over,
})

describe('detectBookedDuplicateTransaction', () => {
  it('returns null when no same-date booked sibling exists', async () => {
    const supabase = makeSupabase([])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('flags a same date+amount+account booked sibling with its voucher label', async () => {
    const supabase = makeSupabase([sibling()])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result).toEqual({
      transaction_id: 'sib-1',
      journal_entry_id: 'je-1',
      voucher_label: 'A142',
      entry_date: '2025-12-19',
      description: 'TELENOR SVERIGE AB',
      amount: -1616,
    })
  })

  it('does NOT flag a sibling on a different known cash account', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: 'acct-B',
    })
    expect(result).toBeNull()
  })

  it('flags when accounts are compatible via a null on either side', async () => {
    const supabase = makeSupabase([sibling({ cash_account_id: 'acct-A' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('does NOT flag a sibling with a different amount', async () => {
    const supabase = makeSupabase([sibling({ amount: -1000 })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('matches a numeric-string amount from PostgREST against a JS number (öre)', async () => {
    const supabase = makeSupabase([sibling({ amount: '-1616.00' })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-1')
  })

  it('returns null for a zero-amount target without querying', async () => {
    const supabase = makeSupabase([sibling({ amount: 0 })])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: 0, cash_account_id: null,
    })
    expect(result).toBeNull()
  })

  it('picks the lowest-id sibling deterministically (stable under force re-detect)', async () => {
    const supabase = makeSupabase([
      sibling({ id: 'sib-9' }),
      sibling({ id: 'sib-2' }),
    ])
    const result = await detectBookedDuplicateTransaction(supabase, COMPANY, {
      id: 'self', date: '2025-12-19', amount: -1616, cash_account_id: null,
    })
    expect(result?.transaction_id).toBe('sib-2')
  })
})
