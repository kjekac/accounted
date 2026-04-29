import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { generatePain001 } from '@/lib/salary/payment/pain001-generator'
import { getBranding } from '@/lib/branding/service'
import type { Pain001CompanyData, Pain001Employee } from '@/lib/salary/payment/pain001-generator'

ensureInitialized()

/**
 * Generate pain.001 (ISO 20022) payment file for a salary run.
 *
 * Per BFL: The payment file is räkenskapsinformation/underlag linked to
 * the salary journal entry. Subject to 7-year retention.
 *
 * The file is uploaded to the bank's corporate portal for batch payment.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  // Load salary run
  const { data: run } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (!run) {
    return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
  }

  if (!['approved', 'paid', 'booked'].includes(run.status)) {
    return NextResponse.json({ error: 'Betalfil kan bara genereras efter godkännande' }, { status: 400 })
  }

  // Load company + settings
  const { data: company } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .single()

  const { data: settings } = await supabase
    .from('company_settings')
    .select('bank_iban, bank_bic')
    .eq('company_id', companyId)
    .single()

  if (!company) {
    return NextResponse.json({ error: 'Företag hittades inte' }, { status: 404 })
  }

  if (!settings?.bank_iban || !settings?.bank_bic) {
    return NextResponse.json({ error: 'IBAN och BIC krävs i företagsinställningar för betalfil' }, { status: 400 })
  }

  // Load employees
  const { data: runEmployees } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(first_name, last_name, clearing_number, bank_account_number)')
    .eq('salary_run_id', id)

  if (!runEmployees || runEmployees.length === 0) {
    return NextResponse.json({ error: 'Inga anställda i lönekörningen' }, { status: 400 })
  }

  // Validate all employees have bank accounts
  const missingBank = runEmployees.filter(sre => {
    const emp = sre.employee as { clearing_number: string | null; bank_account_number: string | null } | null
    return !emp?.clearing_number || !emp?.bank_account_number
  })

  if (missingBank.length > 0) {
    return NextResponse.json({
      error: `${missingBank.length} anställd(a) saknar bankkontouppgifter`,
    }, { status: 400 })
  }

  const companyData: Pain001CompanyData = {
    name: company.name,
    orgNumber: company.org_number || '',
    iban: settings.bank_iban,
    bic: settings.bank_bic,
  }

  const employees: Pain001Employee[] = runEmployees
    .filter(sre => sre.net_salary > 0)
    .map(sre => {
      const emp = sre.employee as { first_name: string; last_name: string; clearing_number: string; bank_account_number: string }
      return {
        name: `${emp.first_name} ${emp.last_name}`,
        clearingNumber: emp.clearing_number,
        bankAccountNumber: emp.bank_account_number,
        netSalary: sre.net_salary,
      }
    })

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const messageId = `${getBranding().appName.toUpperCase()}-${company.org_number?.replace('-', '')}-${periodLabel}`

  const xml = generatePain001(companyData, employees, {
    messageId,
    paymentDate: run.payment_date,
    periodLabel,
  })

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="pain001_lon_${periodLabel}.xml"`,
    },
  })
}
