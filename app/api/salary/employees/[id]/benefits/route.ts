import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { CreateEmployeeBenefitSchema } from '@/lib/api/schemas'
import { calculateBikeBenefit } from '@/lib/salary/benefits'

ensureInitialized()

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('employee_benefits')
    .select('*')
    .eq('employee_id', id)
    .eq('company_id', companyId)
    .order('valid_from', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, CreateEmployeeBenefitSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Confirm employee belongs to the company
  const { data: emp } = await supabase
    .from('employees')
    .select('id')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()
  if (!emp) return NextResponse.json({ error: 'Anställd hittades inte' }, { status: 404 })

  // Bike benefit: derive monthly_value + metadata from the annual market value
  let monthlyValue = body.monthly_value ?? 0
  let metadata: Record<string, unknown> = body.metadata ?? {}

  if (body.benefit_type === 'bike' && body.annual_market_value !== undefined) {
    const calc = calculateBikeBenefit(body.annual_market_value)
    monthlyValue = calc.monthlyValue
    metadata = {
      ...metadata,
      annual_market_value: body.annual_market_value,
      annual_taxable: calc.annualTaxable,
      tax_free_portion: calc.taxFreePortion,
    }
  }

  const { data, error } = await supabase
    .from('employee_benefits')
    .insert({
      employee_id: id,
      company_id: companyId,
      user_id: user.id,
      benefit_type: body.benefit_type,
      description: body.description,
      monthly_value: monthlyValue,
      valid_from: body.valid_from,
      valid_to: body.valid_to ?? null,
      metadata,
      is_active: body.is_active ?? true,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data }, { status: 201 })
}
