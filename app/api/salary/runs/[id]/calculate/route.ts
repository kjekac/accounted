import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { calculateSalary } from '@/lib/salary/calculation-engine'
import { loadPayrollConfig, serializePayrollConfig } from '@/lib/salary/payroll-config'
import { fetchAllTaxTableRatesForRun, TaxTableUnavailableError } from '@/lib/salary/tax-tables'
import { loadAndDeriveAbsence } from '@/lib/salary/derive-absence-line-items'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { SalaryLineItemType } from '@/types'

const DERIVED_ABSENCE_TYPES: SalaryLineItemType[] = [
  'sick_karens',
  'sick_day2_14',
  'sick_day15_plus',
  'vab',
  'parental_leave',
]

const BENEFIT_TYPE_TO_LINE_ITEM: Record<string, SalaryLineItemType> = {
  bike: 'benefit_bike',
  car: 'benefit_car',
  meals: 'benefit_meals',
  housing: 'benefit_housing',
  wellness: 'benefit_wellness',
  other: 'benefit_other',
}

ensureInitialized()

export const POST = withRouteContext(
  'salary_run.calculate',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  const { user, supabase, companyId, log, requestId } = ctx
  const opLog = log.child({ salaryRunId: id })

  // Verify run is draft
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    return errorResponseFromCode('SALARY_RUN_NOT_FOUND', opLog, { requestId })
  }
  if (run.status !== 'draft') {
    return errorResponseFromCode('SALARY_RUN_CALCULATE_FAILED', opLog, {
      requestId,
      details: { currentStatus: run.status, reason: 'not_draft' },
    })
  }

  const paymentYear = parseInt(run.payment_date.split('-')[0])

  // Load config
  const config = await loadPayrollConfig(supabase, paymentYear)

  // Load all employees in this run
  const { data: runEmployees, error: empError } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(*), line_items:salary_line_items(*)')
    .eq('salary_run_id', id)

  if (empError || !runEmployees || runEmployees.length === 0) {
    return errorResponseFromCode('SALARY_RUN_NO_EMPLOYEES', opLog, { requestId })
  }

  // Pre-calculation validation — ensure employees have required data
  const validationErrors: string[] = []
  for (const sre of runEmployees) {
    const emp = sre.employee
    if (!emp) continue
    const name = `${emp.first_name} ${emp.last_name}`

    if (emp.salary_type === 'monthly' && (!emp.monthly_salary || emp.monthly_salary <= 0)) {
      validationErrors.push(`${name}: Månadslön saknas eller är 0`)
    }
    if (emp.salary_type === 'hourly' && (!emp.hourly_rate || emp.hourly_rate <= 0)) {
      validationErrors.push(`${name}: Timlön saknas eller är 0`)
    }
    if (emp.f_skatt_status === 'a_skatt' && !emp.is_sidoinkomst && !emp.tax_table_number) {
      validationErrors.push(`${name}: Skattetabell saknas (krävs för A-skatt)`)
    }
  }
  if (validationErrors.length > 0) {
    return errorResponseFromCode('VALIDATION_ERROR', opLog, {
      requestId,
      details: { issues: validationErrors, reason: 'employee_data_incomplete' },
    })
  }

  // Fetch tax table rates from Skatteverket API for all needed tables/columns
  const tableNumbers = [...new Set(runEmployees.filter(e => e.employee?.tax_table_number).map(e => e.employee.tax_table_number as number))]
  const columns = [...new Set(runEmployees.filter(e => e.employee?.tax_column).map(e => e.employee.tax_column as number))]
  let taxRates: Awaited<ReturnType<typeof fetchAllTaxTableRatesForRun>>['rates'] = []
  let taxTableSource: Awaited<ReturnType<typeof fetchAllTaxTableRatesForRun>>['source'] = 'api'
  if (tableNumbers.length > 0) {
    try {
      const result = await fetchAllTaxTableRatesForRun(
        paymentYear,
        tableNumbers,
        columns.length > 0 ? columns : [1]
      )
      taxRates = result.rates
      taxTableSource = result.source
    } catch (err) {
      if (err instanceof TaxTableUnavailableError) {
        return errorResponseFromCode('SALARY_RUN_TAX_TABLE_MISSING', opLog, {
          requestId,
          details: { reason: err.message, paymentYear, tableNumbers },
          status: 503,
        })
      }
      throw err
    }
  }

  let totalGross = 0
  let totalTax = 0
  let totalNet = 0
  let totalAvgifter = 0
  let totalVacationAccrual = 0
  let totalEmployerCost = 0

  // Load YTD data from prior booked salary runs this year (filters pushed to DB)
  const { data: priorRuns } = await supabase
    .from('salary_run_employees')
    .select('employee_id, gross_salary, tax_withheld, net_salary, salary_run:salary_runs!inner(period_year, period_month, status)')
    .eq('company_id', companyId)
    .eq('salary_run.period_year', run.period_year)
    .eq('salary_run.status', 'booked')
    .lt('salary_run.period_month', run.period_month)

  const ytdByEmployee = new Map<string, { gross: number; tax: number; net: number }>()
  for (const prior of (priorRuns || [])) {
    const current = ytdByEmployee.get(prior.employee_id) || { gross: 0, tax: 0, net: 0 }
    current.gross += prior.gross_salary
    current.tax += prior.tax_withheld
    current.net += prior.net_salary
    ytdByEmployee.set(prior.employee_id, current)
  }

  // Pay period bounds — used to load per-day absence records.
  const periodYear = run.period_year as number
  const periodMonth = run.period_month as number
  const periodStart = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`
  const periodEndDate = new Date(Date.UTC(periodYear, periodMonth, 0)) // last day of month
  const periodEnd = periodEndDate.toISOString().slice(0, 10)

  // Track employees who hit Försäkringskassan day-15 transition or läkarintyg
  // dag 8 — surfaced as warnings in the response so the UI can flag them.
  const lakarintygEmployees: string[] = []
  const fkReportingEmployees: string[] = []

  for (const sre of runEmployees) {
    const emp = sre.employee
    if (!emp) continue

    // ── Derive absence line items from per-day records ─────────────────
    // Sjuklöneperiod boundaries, återinsjuknande, högriskskydd, day-15
    // FK transition all require dates — we can't compute them from
    // aggregated quantities. Replace any existing derived absence rows on
    // this sre with the freshly-computed ones, then merge into the
    // in-memory lineItems array passed to calculateSalary.
    const absenceResult = await loadAndDeriveAbsence({
      supabase,
      companyId: companyId!,
      employeeId: emp.id,
      monthlySalary: emp.monthly_salary || 0,
      payrollConfig: config,
      periodStart,
      periodEnd,
    })

    // ── Derive worked hours from per-day records (hourly employees) ────
    // For timanställda the calendar entries in salary_worked_days are the
    // authoritative source. Sum the period and pass to the calculator. If
    // no rows exist (legacy run, or hourly employee added without using the
    // calendar), fall back to the snapshot column on salary_run_employees.
    let derivedHoursWorked: number | null = null
    if (emp.salary_type === 'hourly') {
      const { data: workedDays, error: workedError } = await supabase
        .from('salary_worked_days')
        .select('hours')
        .eq('company_id', companyId)
        .eq('employee_id', emp.id)
        .gte('work_date', periodStart)
        .lte('work_date', periodEnd)
      if (workedError) {
        return errorResponse(workedError, opLog, { requestId })
      }
      derivedHoursWorked = (workedDays ?? []).reduce(
        (sum, d) => Math.round((sum + Number(d.hours)) * 100) / 100,
        0,
      )
      opLog.info('Derived hours_worked from calendar', {
        employeeId: emp.id,
        periodStart,
        periodEnd,
        rowCount: workedDays?.length ?? 0,
        derivedHoursWorked,
      })

      // Refresh the hourly_salary line item so the displayed Lönerader table
      // matches what the engine actually calculated. Without this, the
      // placeholder created at employee-add time keeps showing 0 kr even
      // after the user fills the calendar.
      if (derivedHoursWorked > 0 && (emp.hourly_rate || 0) > 0) {
        const baseAmount = Math.round((emp.hourly_rate as number) * derivedHoursWorked * 100) / 100
        // Delete any existing hourly_salary rows for this sre, then insert a
        // single fresh one. Avoids the "did the row already exist?" branch.
        await supabase
          .from('salary_line_items')
          .delete()
          .eq('salary_run_employee_id', sre.id)
          .eq('item_type', 'hourly_salary')
        await supabase.from('salary_line_items').insert({
          salary_run_employee_id: sre.id,
          company_id: companyId,
          item_type: 'hourly_salary',
          description: 'Timlön',
          quantity: derivedHoursWorked,
          amount: baseAmount,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: true,
          is_gross_deduction: false,
          is_net_deduction: false,
          account_number: getLineItemAccount('hourly_salary'),
          sort_order: 0,
        })
      }
    }

    const employeeName = `${emp.first_name} ${emp.last_name}`
    if (absenceResult.flagLakarintyg) lakarintygEmployees.push(employeeName)
    if (absenceResult.flagFkReporting) fkReportingEmployees.push(employeeName)

    const { error: delAbsErr } = await supabase
      .from('salary_line_items')
      .delete()
      .eq('salary_run_employee_id', sre.id)
      .in('item_type', DERIVED_ABSENCE_TYPES)
    if (delAbsErr) {
      return errorResponse(delAbsErr, opLog, { requestId })
    }

    // ── Derive benefit line items from employee_benefits ──
    // Active benefits = is_active AND payment_date ∈ [valid_from, valid_to]
    const { data: activeBenefits, error: benefitsErr } = await supabase
      .from('employee_benefits')
      .select('id, benefit_type, description, monthly_value')
      .eq('employee_id', emp.id)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .lte('valid_from', run.payment_date)
      .or(`valid_to.is.null,valid_to.gte.${run.payment_date}`)
    if (benefitsErr) {
      return errorResponse(benefitsErr, opLog, { requestId })
    }

    // Replace prior auto-generated benefit rows for this sre.
    const { error: delBenefitErr } = await supabase
      .from('salary_line_items')
      .delete()
      .eq('salary_run_employee_id', sre.id)
      .not('source_benefit_id', 'is', null)
    if (delBenefitErr) {
      return errorResponse(delBenefitErr, opLog, { requestId })
    }

    const derivedBenefitRows = (activeBenefits ?? [])
      .filter(b => b.monthly_value > 0)
      .map((b, idx) => {
        const itemType = BENEFIT_TYPE_TO_LINE_ITEM[b.benefit_type] ?? 'benefit_other'
        return {
          salary_run_employee_id: sre.id,
          company_id: companyId,
          item_type: itemType,
          description: b.description,
          quantity: 1,
          amount: Math.round(b.monthly_value * 100) / 100,
          is_taxable: true,
          is_avgift_basis: true,
          is_vacation_basis: false,
          is_gross_deduction: false,
          is_net_deduction: false,
          account_number: getLineItemAccount(itemType, emp.employment_type),
          sort_order: 200 + idx,
          source_benefit_id: b.id,
        }
      })

    if (derivedBenefitRows.length > 0) {
      const { error: insBenefitErr } = await supabase
        .from('salary_line_items')
        .insert(derivedBenefitRows)
      if (insBenefitErr) {
        return errorResponse(insBenefitErr, opLog, { requestId })
      }
    }

    if (absenceResult.lineItems.length > 0) {
      const rows = absenceResult.lineItems.map((li, idx) => ({
        salary_run_employee_id: sre.id,
        company_id: companyId,
        item_type: li.item_type,
        description: li.description,
        quantity: li.quantity,
        amount: Math.round(li.amount * 100) / 100,
        is_taxable: li.is_taxable,
        is_avgift_basis: li.is_avgift_basis,
        is_vacation_basis: li.is_vacation_basis,
        is_gross_deduction: li.is_gross_deduction,
        is_net_deduction: false,
        account_number: getLineItemAccount(li.item_type),
        sort_order: 100 + idx, // sort derived items after manual ones
      }))
      const { error: insAbsErr } = await supabase
        .from('salary_line_items')
        .insert(rows)
      if (insAbsErr) {
        return errorResponse(insAbsErr, opLog, { requestId })
      }
    }

    // Build the merged in-memory line items: keep non-derived items from
    // the originally-loaded sre.line_items, then append the freshly-derived
    // absence and benefit items.
    const manualLineItems = (sre.line_items || [])
      .filter((li: Record<string, unknown>) => {
        if (DERIVED_ABSENCE_TYPES.includes(li.item_type as SalaryLineItemType)) return false
        if (li.source_benefit_id) return false
        return true
      })
      .map((li: Record<string, unknown>) => ({
        itemType: li.item_type as SalaryLineItemType,
        amount: li.amount as number,
        isTaxable: li.is_taxable as boolean,
        isAvgiftBasis: li.is_avgift_basis as boolean,
        isVacationBasis: li.is_vacation_basis as boolean,
        isGrossDeduction: li.is_gross_deduction as boolean,
        isNetDeduction: li.is_net_deduction as boolean,
      }))
    const derivedLineItems = absenceResult.lineItems.map(li => ({
      itemType: li.item_type as SalaryLineItemType,
      amount: li.amount,
      isTaxable: li.is_taxable,
      isAvgiftBasis: li.is_avgift_basis,
      isVacationBasis: li.is_vacation_basis,
      isGrossDeduction: li.is_gross_deduction,
      isNetDeduction: false,
    }))
    const derivedBenefitLineItems = derivedBenefitRows.map(row => ({
      itemType: row.item_type as SalaryLineItemType,
      amount: row.amount,
      isTaxable: true,
      isAvgiftBasis: true,
      isVacationBasis: false,
      isGrossDeduction: false,
      isNetDeduction: false,
    }))
    const lineItems = [...manualLineItems, ...derivedLineItems, ...derivedBenefitLineItems]

    const result = calculateSalary(
      {
        employmentType: emp.employment_type,
        salaryType: emp.salary_type,
        monthlySalary: emp.monthly_salary || 0,
        hourlyRate: emp.hourly_rate || undefined,
        // Calendar-derived hours win when at least one row exists in the
        // period. The legacy snapshot column (sre.hours_worked) only kicks
        // in for runs predating the calendar feature.
        hoursWorked: derivedHoursWorked !== null && derivedHoursWorked > 0
          ? derivedHoursWorked
          : sre.hours_worked || undefined,
        employmentDegree: emp.employment_degree,
        taxTableNumber: emp.tax_table_number,
        taxColumn: emp.tax_column || 1,
        isSidoinkomst: emp.is_sidoinkomst,
        jamkningPercentage: emp.jamkning_percentage,
        jamkningValidFrom: emp.jamkning_valid_from,
        jamkningValidTo: emp.jamkning_valid_to,
        fSkattStatus: emp.f_skatt_status,
        personnummer: emp.personnummer,
        paymentDate: run.payment_date,
        vacationRule: emp.vacation_rule,
        vacationDaysPerYear: emp.vacation_days_per_year,
        semestertillaggRate: emp.semestertillagg_rate,
        vaxaStodEligible: emp.vaxa_stod_eligible,
        vaxaStodStart: emp.vaxa_stod_start,
        vaxaStodEnd: emp.vaxa_stod_end,
        lineItems,
      },
      config,
      taxRates.map(r => ({
        tableYear: r.tableYear,
        tableNumber: r.tableNumber,
        columnNumber: r.columnNumber,
        incomeFrom: r.incomeFrom,
        incomeTo: r.incomeTo,
        taxAmount: r.taxAmount,
      }))
    )

    // Aggregated absence counts derived from per-day records (above).
    // Vacation still comes from line items because it's user-entered, not
    // calendar-tracked yet.
    const sickDays = absenceResult.aggregated.sickDays
    const vabDays = absenceResult.aggregated.vabDays
    const parentalDays = absenceResult.aggregated.parentalDays
    const vacationDays = (sre.line_items || [])
      .filter((li: Record<string, unknown>) => li.item_type === 'vacation')
      .reduce((sum: number, li: Record<string, unknown>) => sum + ((li.quantity as number) || 0), 0)

    // Update salary_run_employee with calculated results. If any individual
    // update fails we abort so run totals aren't written from partial data.
    // For hourly employees with calendar rows, also mirror the derived total
    // into hours_worked so downstream code (reports, storno via correct/route)
    // sees a consistent snapshot.
    const snapshotHoursWorked =
      derivedHoursWorked !== null && derivedHoursWorked > 0
        ? derivedHoursWorked
        : sre.hours_worked
    const { error: empUpdateError } = await supabase
      .from('salary_run_employees')
      .update({
        hours_worked: snapshotHoursWorked,
        gross_salary: result.grossSalary,
        gross_deductions: result.grossDeductions,
        benefit_values: result.benefitValues,
        taxable_income: result.taxableIncome,
        tax_withheld: result.taxWithheld,
        net_deductions: result.netDeductions,
        net_salary: result.netSalary,
        avgifter_rate: result.avgifterRate,
        avgifter_amount: result.avgifterAmount,
        avgifter_basis: result.avgifterBasis,
        avgifter_category: result.avgifterCategory,
        vacation_accrual: result.vacationAccrual,
        vacation_accrual_avgifter: result.vacationAccrualAvgifter,
        tax_table_number: emp.tax_table_number,
        tax_column: emp.tax_column,
        tax_table_year: paymentYear,
        sick_days: sickDays,
        vab_days: vabDays,
        parental_days: parentalDays,
        vacation_days_taken: vacationDays,
        calculation_breakdown: { steps: result.steps },
        ytd_gross: Math.round(((ytdByEmployee.get(sre.employee_id)?.gross || 0) + result.grossSalary) * 100) / 100,
        ytd_tax: Math.round(((ytdByEmployee.get(sre.employee_id)?.tax || 0) + result.taxWithheld) * 100) / 100,
        ytd_net: Math.round(((ytdByEmployee.get(sre.employee_id)?.net || 0) + result.netSalary) * 100) / 100,
      })
      .eq('id', sre.id)

    if (empUpdateError) {
      return errorResponse(empUpdateError, opLog, { requestId })
    }

    totalGross += result.grossSalary
    totalTax += result.taxWithheld
    totalNet += result.netSalary
    totalAvgifter += result.avgifterAmount
    totalVacationAccrual += result.vacationAccrual
    totalEmployerCost += result.totalEmployerCost
  }

  // Update run totals
  const { data: updatedRun, error: updateError } = await supabase
    .from('salary_runs')
    .update({
      total_gross: Math.round(totalGross * 100) / 100,
      total_tax: Math.round(totalTax * 100) / 100,
      total_net: Math.round(totalNet * 100) / 100,
      total_avgifter: Math.round(totalAvgifter * 100) / 100,
      total_vacation_accrual: Math.round(totalVacationAccrual * 100) / 100,
      total_employer_cost: Math.round(totalEmployerCost * 100) / 100,
      calculation_params: serializePayrollConfig(config),
    })
    .eq('id', id)
    .select()
    .single()

  if (updateError) {
    return errorResponse(updateError, opLog, { requestId })
  }

  const warnings: string[] = []
  if (taxTableSource === 'fallback') {
    warnings.push(
      `Skatteverkets skattetabell-API är inte nåbart — beräkningen använder lokal reservdata för ${paymentYear}. Kontrollera att Skatteverket inte publicerat ändringar innan lönekörningen bokförs.`
    )
  } else if (taxTableSource === 'mixed') {
    warnings.push(
      `Skatteverkets skattetabell-API svarade bara delvis — vissa skattetabeller kommer från lokal reservdata för ${paymentYear}. Kontrollera att Skatteverket inte publicerat ändringar innan lönekörningen bokförs.`
    )
  }

  if (lakarintygEmployees.length > 0) {
    // Per Sjuklönelagen 8§: from day 8 of a sjuklöneperiod the employer can
    // require a läkarintyg. Day 1–7 use sjukförsäkran (employee declaration).
    warnings.push(
      `Läkarintyg krävs från och med dag 8: ${lakarintygEmployees.join(', ')}. ` +
      `Kontrollera att läkarintyg finns innan lönekörningen godkänns.`
    )
  }

  if (fkReportingEmployees.length > 0) {
    // Day 15+ falls on Försäkringskassan; the employer reports via FK.
    warnings.push(
      `Försäkringskassan tar över sjuklön från dag 15: ${fkReportingEmployees.join(', ')}. ` +
      `Säkerställ att anmälan till FK är gjord.`
    )
  }

  return NextResponse.json({ data: updatedRun, warnings })
  },
  { requireWrite: true },
)
