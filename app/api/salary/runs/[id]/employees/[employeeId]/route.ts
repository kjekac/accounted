import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'
import { SalaryEmployeeOverrideSchema } from '@/lib/api/schemas'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'

ensureInitialized()

/** Fetch one employee's pay spec within a salary run, with employee + line items. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> },
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(*), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
  }

  // Strip the encrypted personnummer ciphertext before sending to the browser
  // — replace it with the YYYYMMDD-XXXX masked form so the page can render
  // identity without exposing the suffix or the raw cipher blob.
  const masked = {
    ...data,
    employee: data.employee
      ? {
          ...data.employee,
          personnummer: maskPersonnummer(decryptPersonnummer(data.employee.personnummer)),
        }
      : data.employee,
  }

  return NextResponse.json({ data: masked })
}

/**
 * Apply per-employee override on tax/avgifter (advanced mode).
 *
 * Only allowed in `review` status — the calculation engine has run, but the
 * run hasn't been approved or booked yet. After approval, vouchers and AGI
 * lock in the effective values; further changes require correction flows.
 *
 * Pass `null` for any field to clear a previously-set override.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> },
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const parsed = await validateBody(request, SalaryEmployeeOverrideSchema)
  if (!parsed.success) return parsed.response

  // Gate on run status. Override is only valid mid-review.
  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  if (run.status !== 'review') {
    return NextResponse.json(
      { error: 'Justering av skatt/avgifter är bara tillåten i granskningsläge (review).' },
      { status: 400 },
    )
  }

  // Build patch — only include fields that were explicitly provided so
  // unrelated overrides are not nulled.
  const patch: Record<string, number | string | null> = {}
  if ('tax_withheld_override' in parsed.data) {
    patch.tax_withheld_override = parsed.data.tax_withheld_override ?? null
  }
  if ('avgifter_amount_override' in parsed.data) {
    patch.avgifter_amount_override = parsed.data.avgifter_amount_override ?? null
  }
  if ('avgifter_basis_override' in parsed.data) {
    patch.avgifter_basis_override = parsed.data.avgifter_basis_override ?? null
  }
  if ('reason' in parsed.data) {
    patch.override_reason = parsed.data.reason ?? null
  }

  const { data, error } = await supabase
    .from('salary_run_employees')
    .update(patch)
    .eq('salary_run_id', id)
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)
    .select('id, tax_withheld, tax_withheld_override, avgifter_amount, avgifter_amount_override, avgifter_basis, avgifter_basis_override, override_reason')
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Anställd hittades inte i lönekörningen' }, { status: 404 })
  }

  return NextResponse.json({ data })
}

/** Remove employee from a draft salary run. Cascades to delete their line items. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  const { id, employeeId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Verify run is draft
  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  if (run.status !== 'draft') return NextResponse.json({ error: 'Kan bara redigera utkast' }, { status: 400 })

  // Delete the salary_run_employee (cascades to salary_line_items via ON DELETE CASCADE)
  const { error } = await supabase
    .from('salary_run_employees')
    .delete()
    .eq('salary_run_id', id)
    .eq('employee_id', employeeId)
    .eq('company_id', companyId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: { deleted: true } })
}
