import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { UpdateEmployeeBenefitSchema } from '@/lib/api/schemas'
import { calculateBikeBenefit } from '@/lib/salary/benefits'

ensureInitialized()

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; benefitId: string }> }
) {
  const { id, benefitId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, UpdateEmployeeBenefitSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  const { data: existing, error: fetchError } = await supabase
    .from('employee_benefits')
    .select('benefit_type, metadata')
    .eq('id', benefitId)
    .eq('employee_id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
  }

  const updates: Record<string, unknown> = { ...body }

  if (body.annual_market_value !== undefined) {
    if (existing.benefit_type !== 'bike') {
      return NextResponse.json(
        { error: 'annual_market_value gäller endast cykelförmån' },
        { status: 400 },
      )
    }
    const calc = calculateBikeBenefit(body.annual_market_value)
    updates.monthly_value = calc.monthlyValue
    updates.metadata = {
      ...(existing.metadata as Record<string, unknown> ?? {}),
      ...(body.metadata ?? {}),
      annual_market_value: body.annual_market_value,
      annual_taxable: calc.annualTaxable,
      tax_free_portion: calc.taxFreePortion,
    }
    delete (updates as Record<string, unknown>).annual_market_value
  }

  const { data, error } = await supabase
    .from('employee_benefits')
    .update(updates)
    .eq('id', benefitId)
    .eq('employee_id', id)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
  }

  return NextResponse.json({ data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; benefitId: string }> }
) {
  const { id, benefitId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { error } = await supabase
    .from('employee_benefits')
    .delete()
    .eq('id', benefitId)
    .eq('employee_id', id)
    .eq('company_id', companyId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data: { id: benefitId, deleted: true } })
}
