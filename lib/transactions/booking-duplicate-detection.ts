/**
 * Booking-time duplicate guard for bank transactions.
 *
 * Why this exists
 * ---------------
 * A bank account's transactions can land in the `transactions` table twice — a
 * CSV import on top of a PSD2 sync, or a re-sync whose external_id drifted (see
 * the import dedup in lib/transactions/ingest.ts). Import-time dedup is
 * best-effort and can miss. The cosmetic cost of a missed duplicate is a second
 * row in the "Att bokföra" list. The REAL cost is booking BOTH copies: that
 * creates two verifikationer for one affärshändelse, double-counts the
 * cost/income, and is felaktig bokföring under BFL (the second verifikat has no
 * underlying event). Rättelse would then require storno, not deletion.
 *
 * This guard runs at booking time. Before a transaction becomes a verifikat it
 * looks for ANOTHER transaction in the same company that is already booked and
 * shares this one's (date, amount, cash account). If found, the caller surfaces
 * it as a WARNING — never a hard block, because genuinely repeated
 * same-(date,amount) payments do occur (e.g. several identical Swish transfers
 * in one day). The user confirms with force=true after reviewing the candidate.
 *
 * Mirrors the invoice-side `detectDuplicatePaymentVoucher`
 * (lib/invoices/duplicate-payment-detection.ts), but keyed on an already-booked
 * sibling TRANSACTION rather than a manually-posted journal entry.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Integer öre — representation-agnostic amount key (mirrors the ingest dedup). */
function toOre(amount: number | string): number {
  return Math.round(Number(amount) * 100)
}

/** An already-booked transaction that looks like the same real movement. */
export interface BookedDuplicateCandidate {
  /** The sibling transaction that is already booked. */
  transaction_id: string
  /** Its verifikat. */
  journal_entry_id: string
  /** Human label, e.g. "A142" (voucher_series + voucher_number). */
  voucher_label: string
  entry_date: string
  description: string | null
  amount: number
}

/** Minimal shape of the transaction about to be booked. */
export interface BookingTarget {
  id: string
  date: string
  amount: number | string
  cash_account_id?: string | null
}

/**
 * Find an already-booked sibling transaction sharing (date, amount, account).
 * Returns the single best candidate, or null.
 *
 * Account guard mirrors the import dedup bridge: when BOTH sides know their
 * cash_account_id they must match; a null on either side is treated as
 * compatible (single-account companies and un-backfilled rows behave as before).
 *
 * Fail-open: a query error returns null rather than throwing — a detection
 * failure must never block a legitimate booking. The pick is deterministic
 * (lowest id) so a re-detection under force=true returns the same candidate the
 * user reviewed.
 */
export async function detectBookedDuplicateTransaction(
  supabase: SupabaseClient,
  companyId: string,
  target: BookingTarget,
): Promise<BookedDuplicateCandidate | null> {
  const targetOre = toOre(target.amount)
  if (targetOre === 0 || Number.isNaN(targetOre)) return null

  // Same company, same date, already booked, not the target row itself. The
  // amount and account match is applied in JS so a numeric-string amount from
  // PostgREST ("-1616.00") collapses to the same öre as the number (-1616).
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount, description, cash_account_id, journal_entry_id')
    .eq('company_id', companyId)
    .eq('date', target.date)
    .not('journal_entry_id', 'is', null)
    .neq('id', target.id)
    .limit(100)

  if (error || !data || data.length === 0) return null

  type Row = {
    id: string
    date: string
    amount: number | string
    description: string | null
    cash_account_id: string | null
    journal_entry_id: string
  }
  const targetAccount = target.cash_account_id ?? null
  const matches = (data as unknown as Row[]).filter((r) => {
    if (toOre(r.amount) !== targetOre) return false
    // Account guard: both-known must match; a null on either side is compatible.
    if (targetAccount !== null && r.cash_account_id !== null && r.cash_account_id !== targetAccount) {
      return false
    }
    return r.journal_entry_id != null
  })
  if (matches.length === 0) return null

  matches.sort((a, b) => a.id.localeCompare(b.id))
  const best = matches[0]

  // Resolve the voucher label for the warning (best-effort — a missing label
  // still yields a usable candidate the UI can render by date/amount).
  let voucherLabel = ''
  let entryDate = best.date
  const { data: je } = await supabase
    .from('journal_entries')
    .select('voucher_series, voucher_number, entry_date')
    .eq('id', best.journal_entry_id)
    .maybeSingle()
  if (je) {
    const j = je as { voucher_series: string | null; voucher_number: number | null; entry_date: string | null }
    voucherLabel = `${j.voucher_series ?? 'A'}${j.voucher_number ?? ''}`
    entryDate = j.entry_date ?? best.date
  }

  return {
    transaction_id: best.id,
    journal_entry_id: best.journal_entry_id,
    voucher_label: voucherLabel,
    entry_date: entryDate,
    description: best.description,
    amount: Math.round(Number(best.amount) * 100) / 100,
  }
}
