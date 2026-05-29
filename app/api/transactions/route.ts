import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

const MAX_ROWS = 500

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const unmatched = searchParams.get('unmatched') === 'true'
  const reconciled = searchParams.get('reconciled') === 'true'
  const currency = searchParams.get('currency') || undefined
  const dateFrom = searchParams.get('date_from') || undefined
  const dateTo = searchParams.get('date_to') || undefined
  // When set, return only ignored rows — used by the reconciliation view to
  // surface a "Visa ignorerade" undo list. The default (no param) behaviour
  // continues to exclude ignored rows from unmatched results.
  const onlyIgnored = searchParams.get('only_ignored') === 'true'
  // account_number is accepted for API symmetry with the reconciliation status
  // endpoint; transactions don't carry a cash_account FK today (PSD2 account
  // identity is embedded in external_id), so we use it to derive a default
  // currency when the caller didn't supply one. Anything more precise needs
  // the cash_account_id backfill tracked as Tier 4.
  const accountNumberParam = searchParams.get('account_number') || undefined

  let derivedCurrency = currency
  if (!derivedCurrency && accountNumberParam) {
    const { data: cashAccount } = await supabase
      .from('cash_accounts')
      .select('currency')
      .eq('company_id', companyId)
      .eq('ledger_account', accountNumberParam)
      .maybeSingle()
    if (cashAccount?.currency) derivedCurrency = cashAccount.currency as string
  }

  let query = supabase
    .from('transactions')
    .select('id, date, description, amount, currency, amount_sek, exchange_rate, reference, journal_entry_id, reconciliation_method, is_ignored')
    .eq('company_id', companyId)

  // unmatched and reconciled are mutually exclusive — unmatched wins if both set
  if (unmatched) {
    query = query.is('journal_entry_id', null)
    // Hide rows the user has explicitly suppressed from the reconciliation
    // view. Other callers (e.g. BookDirectlyDialog) also benefit — once
    // ignored, the row stops surfacing in the "to book" funnel everywhere.
    if (!onlyIgnored) query = query.eq('is_ignored', false)
  } else if (reconciled) {
    query = query.not('journal_entry_id', 'is', null)
  }

  if (onlyIgnored) query = query.eq('is_ignored', true)

  if (derivedCurrency) query = query.eq('currency', derivedCurrency)
  if (dateFrom) query = query.gte('date', dateFrom)
  if (dateTo) query = query.lte('date', dateTo)

  // Fetch one extra row so we can tell the caller whether the result was truncated.
  query = query.order('date', { ascending: false }).limit(MAX_ROWS + 1)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data || []
  const hasMore = rows.length > MAX_ROWS
  const truncated = hasMore ? rows.slice(0, MAX_ROWS) : rows

  return NextResponse.json({ data: truncated, has_more: hasMore, limit: MAX_ROWS })
}
