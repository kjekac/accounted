import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { runReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import { validateBody } from '@/lib/api/validate'
import { RunReconciliationSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, RunReconciliationSchema)
  if (!validation.success) return validation.response
  const { date_from, date_to, dry_run } = validation.data

  const result = await runReconciliation(supabase, companyId, user.id, {
    dateFrom: date_from,
    dateTo: date_to,
    dryRun: dry_run ?? false,
  })

  return NextResponse.json({
    data: {
      matches: result.matches.map((m) => ({
        transaction_id: m.transaction.id,
        transaction_date: m.transaction.date,
        transaction_description: m.transaction.description,
        transaction_amount: m.transaction.amount,
        journal_entry_id: m.glLine.journal_entry_id,
        voucher_number: m.glLine.voucher_number,
        voucher_series: m.glLine.voucher_series,
        entry_date: m.glLine.entry_date,
        entry_description: m.glLine.entry_description,
        method: m.method,
        confidence: m.confidence,
      })),
      applied: result.applied,
      errors: result.errors,
      dry_run: dry_run ?? false,
    },
  })
}
