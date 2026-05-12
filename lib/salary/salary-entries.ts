import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { createLogger } from '@/lib/logger'
import { SALARY_ACCOUNTS, getLineItemAccount } from './account-mapping'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'

const log = createLogger('salary-entries')

interface SalaryRunEmployee {
  employee_id: string
  employment_type: string
  gross_salary: number
  tax_withheld: number
  net_salary: number
  avgifter_amount: number
  avgifter_rate: number
  vacation_accrual: number
  vacation_accrual_avgifter: number
  cost_center?: string
  project?: string
  line_items: Array<{
    item_type: string
    amount: number
    account_number: string | null
    is_net_deduction: boolean
    is_gross_deduction: boolean
  }>
  // Löneväxling pension (if applicable)
  pension_contribution?: number
  pension_slp?: number
}

interface SalaryRunData {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  voucher_series: string
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_vacation_accrual: number
  employees: SalaryRunEmployee[]
}

/**
 * Create all journal entries for a salary run.
 * Creates 3 entries:
 *   1. Salary entry: gross salary expenses, tax withholding, net payment
 *   2. Avgifter entry: employer contributions expense + liability
 *   3. Vacation entry: vacation accrual expense + liability + avgifter on accrual
 *
 * All entries use source_type: 'salary_payment' and source_id: salaryRun.id
 */
export async function createSalaryRunEntries(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData
): Promise<{
  salaryEntry: JournalEntry
  avgifterEntry: JournalEntry
  vacationEntry: JournalEntry | null
  pensionEntry: JournalEntry | null
}> {
  const entryDate = run.payment_date
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (!fiscalPeriodId) {
    throw new Error(`Ingen öppen räkenskapsperiod för datum ${entryDate}`)
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const desc = `Lön ${periodLabel}`

  await ensureSalaryAccountsExist(supabase, companyId, userId, run)

  // ─── Entry 1: Salary (brutto, skatt, netto) ───
  const salaryEntry = await createSalaryEntry(
    supabase, companyId, userId, run, fiscalPeriodId, desc
  )

  // ─── Entry 2: Arbetsgivaravgifter ───
  const avgifterEntry = await createAvgifterEntry(
    supabase, companyId, userId, run, fiscalPeriodId, desc
  )

  // ─── Entry 3: Vacation accrual (if any) ───
  let vacationEntry: JournalEntry | null = null
  const totalVacation = run.employees.reduce((sum, e) => sum + e.vacation_accrual, 0)
  const totalVacationAvgifter = run.employees.reduce((sum, e) => sum + e.vacation_accrual_avgifter, 0)
  if (totalVacation > 0 || totalVacationAvgifter > 0) {
    vacationEntry = await createVacationEntry(
      supabase, companyId, userId, run, fiscalPeriodId, desc, totalVacation, totalVacationAvgifter
    )
  }

  // ─── Entry 4: Pension provisions + SLP (if löneväxling) ───
  // Per deductions-lonevaxling.md: pension = löneväxling × 1.058, SLP = pension × 24.26%
  // Debit 7410 Pensionsförsäkringspremier / Credit 2740 Skuld pensionsförsäkringar
  // Debit 7533 Särskild löneskatt / Credit 2514 Beräknad särskild löneskatt
  let pensionEntry: JournalEntry | null = null
  const totalPension = run.employees.reduce((sum, e) => sum + (e.pension_contribution || 0), 0)
  const totalSlp = run.employees.reduce((sum, e) => sum + (e.pension_slp || 0), 0)
  if (totalPension > 0) {
    pensionEntry = await createPensionEntry(
      supabase, companyId, userId, run, fiscalPeriodId, desc, totalPension, totalSlp
    )
  }

  return { salaryEntry, avgifterEntry, vacationEntry, pensionEntry }
}

/**
 * Entry 1: Salary booking.
 *
 * Debit:  7210/7220/7240 Löner (per employee by type)
 * Credit: 2710 Personalskatt (total tax withheld)
 * Credit: 1930 Företagskonto (total net salary)
 */
async function createSalaryEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string
): Promise<JournalEntry> {
  const lines: CreateJournalEntryLineInput[] = []

  // Aggregate salary expenses by account
  const expenseByAccount = new Map<string, number>()
  for (const emp of run.employees) {
    // Base salary and additions go to the employee-type account
    const salaryAccount = getEmployeeSalaryAccount(emp.employment_type)

    // Add salary line items that are cash expenses
    // Förmånsvärden (benefits) are excluded — they affect the tax base but
    // have no cash flow and should not appear as expense lines in the journal.
    const BENEFIT_TYPES = ['benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness', 'benefit_bike', 'benefit_other']
    let lineItemTotal = 0
    for (const li of emp.line_items) {
      if (li.is_net_deduction || li.is_gross_deduction) continue
      if (BENEFIT_TYPES.includes(li.item_type)) continue // No cash flow for förmånsvärden
      const account = li.account_number || getLineItemAccount(li.item_type as never, emp.employment_type)
      const current = expenseByAccount.get(account) || 0
      expenseByAccount.set(account, current + li.amount)
      lineItemTotal += li.amount
    }

    // Ensure the debit side always equals gross_salary (minus gross deductions,
    // which the credit side doesn't book either). If line items don't cover the
    // full gross amount, book the remainder to the default salary account so the
    // entry balances. Without this, an employee with overtime line items but no
    // base-salary line item would fail the check_journal_entry_balance() trigger.
    const baseRemainder = Math.round((emp.gross_salary - lineItemTotal) * 100) / 100
    if (baseRemainder !== 0) {
      const current = expenseByAccount.get(salaryAccount) || 0
      expenseByAccount.set(salaryAccount, current + baseRemainder)
    }
  }

  // Debit: Salary expense accounts
  for (const [account, amount] of expenseByAccount) {
    if (amount === 0) continue
    if (amount > 0) {
      lines.push({
        account_number: account,
        debit_amount: Math.round(amount * 100) / 100,
        credit_amount: 0,
        line_description: `${desc} — ${accountLabel(account)}`,
      })
    } else {
      // Negative amounts (deductions) become credits
      lines.push({
        account_number: account,
        debit_amount: 0,
        credit_amount: Math.round(Math.abs(amount) * 100) / 100,
        line_description: `${desc} — ${accountLabel(account)}`,
      })
    }
  }

  // Credit: Tax withholding
  const totalTax = run.employees.reduce((sum, e) => sum + e.tax_withheld, 0)
  if (totalTax > 0) {
    lines.push({
      account_number: SALARY_ACCOUNTS.TAX_WITHHELD,
      debit_amount: 0,
      credit_amount: Math.round(totalTax * 100) / 100,
      line_description: `${desc} — Personalskatt`,
    })
  }

  // Credit: Net salary to bank
  const totalNet = run.employees.reduce((sum, e) => sum + e.net_salary, 0)
  if (totalNet > 0) {
    lines.push({
      account_number: SALARY_ACCOUNTS.BANK,
      debit_amount: 0,
      credit_amount: Math.round(totalNet * 100) / 100,
      line_description: `${desc} — Nettolön`,
    })
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: desc,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating salary entry for ${desc}: ${lines.length} lines`)
  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Entry 2: Arbetsgivaravgifter.
 *
 * Debit:  7510 Lagstadgade sociala avgifter
 * Credit: 2731 Avräkning sociala avgifter
 */
async function createAvgifterEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string
): Promise<JournalEntry> {
  const totalAvgifter = run.employees.reduce((sum, e) => sum + e.avgifter_amount, 0)
  const roundedAvgifter = Math.round(totalAvgifter * 100) / 100

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
      debit_amount: roundedAvgifter,
      credit_amount: 0,
      line_description: `${desc} — Arbetsgivaravgifter`,
    },
    {
      account_number: SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
      debit_amount: 0,
      credit_amount: roundedAvgifter,
      line_description: `${desc} — Arbetsgivaravgifter`,
    },
  ]

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc} — Arbetsgivaravgifter`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating avgifter entry for ${desc}: ${roundedAvgifter} SEK`)
  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Entry 3: Vacation accrual.
 *
 * Debit:  7290 Förändring semesterlöneskuld
 * Credit: 2920 Upplupna semesterlöner
 * Debit:  7519 Sociala avgifter semester
 * Credit: 2940 Upplupna sociala avgifter
 */
async function createVacationEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string,
  totalVacation: number,
  totalVacationAvgifter: number
): Promise<JournalEntry> {
  const roundedVacation = Math.round(totalVacation * 100) / 100
  const roundedAvgifter = Math.round(totalVacationAvgifter * 100) / 100

  const lines: CreateJournalEntryLineInput[] = []

  if (roundedVacation > 0) {
    lines.push(
      {
        account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_EXPENSE,
        debit_amount: roundedVacation,
        credit_amount: 0,
        line_description: `${desc} — Semesteravsättning`,
      },
      {
        account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY,
        debit_amount: 0,
        credit_amount: roundedVacation,
        line_description: `${desc} — Semesteravsättning`,
      }
    )
  }

  if (roundedAvgifter > 0) {
    lines.push(
      {
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
        debit_amount: roundedAvgifter,
        credit_amount: 0,
        line_description: `${desc} — Sociala avgifter på semester`,
      },
      {
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY,
        debit_amount: 0,
        credit_amount: roundedAvgifter,
        line_description: `${desc} — Sociala avgifter på semester`,
      }
    )
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc} — Semesteravsättning`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating vacation entry for ${desc}: ${roundedVacation} SEK + ${roundedAvgifter} SEK avgifter`)
  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Entry 4: Pension provisions + SLP (löneväxling).
 *
 * Debit:  7410 Pensionsförsäkringspremier
 * Credit: 2740 Skuld pensionsförsäkringar
 * Debit:  7533 Särskild löneskatt på pensionskostnader (24.26%)
 * Credit: 2514 Beräknad särskild löneskatt
 *
 * Per deductions-lonevaxling.md: pension = löneväxling × 1.058
 */
async function createPensionEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string,
  totalPension: number,
  totalSlp: number
): Promise<JournalEntry> {
  const roundedPension = Math.round(totalPension * 100) / 100
  const roundedSlp = Math.round(totalSlp * 100) / 100

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: SALARY_ACCOUNTS.PENSION_EXPENSE,
      debit_amount: roundedPension,
      credit_amount: 0,
      line_description: `${desc} — Pensionsförsäkringspremier`,
    },
    {
      account_number: SALARY_ACCOUNTS.PENSION_LIABILITY,
      debit_amount: 0,
      credit_amount: roundedPension,
      line_description: `${desc} — Pensionsförsäkringspremier`,
    },
  ]

  if (roundedSlp > 0) {
    lines.push(
      {
        account_number: SALARY_ACCOUNTS.SLP_EXPENSE,
        debit_amount: roundedSlp,
        credit_amount: 0,
        line_description: `${desc} — Särskild löneskatt 24,26%`,
      },
      {
        account_number: SALARY_ACCOUNTS.SLP_LIABILITY,
        debit_amount: 0,
        credit_amount: roundedSlp,
        line_description: `${desc} — Särskild löneskatt 24,26%`,
      }
    )
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc} — Pensionsavsättning`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  log.info(`Creating pension entry for ${desc}: ${roundedPension} SEK pension + ${roundedSlp} SEK SLP`)
  return createJournalEntry(supabase, companyId, userId, input)
}

// ============================================================
// Helpers
// ============================================================

function getEmployeeSalaryAccount(employmentType: string): string {
  switch (employmentType) {
    case 'company_owner': return SALARY_ACCOUNTS.SALARY_OWNER
    case 'board_member': return SALARY_ACCOUNTS.SALARY_BOARD
    default: return SALARY_ACCOUNTS.SALARY_EMPLOYEE
  }
}

/**
 * Ensure every BAS account referenced by the salary run exists in
 * chart_of_accounts. Users who seeded the minimal chart via
 * seed_chart_of_accounts will be missing many 7xxx/29xx accounts — we
 * auto-create them from BAS reference data on first salary booking.
 */
async function ensureSalaryAccountsExist(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData
): Promise<void> {
  const needed = new Set<string>()

  for (const account of Object.values(SALARY_ACCOUNTS)) needed.add(account)

  for (const emp of run.employees) {
    needed.add(getEmployeeSalaryAccount(emp.employment_type))
    for (const li of emp.line_items) {
      const account = li.account_number || getLineItemAccount(li.item_type as never, emp.employment_type)
      if (account) needed.add(account)
    }
  }

  if (needed.size === 0) return

  const { data: existing, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .in('account_number', [...needed])

  if (error) {
    throw new Error(`Kunde inte läsa kontoplanen: ${error.message}`)
  }

  const existingSet = new Set((existing || []).map(a => a.account_number))
  const missing = [...needed].filter(num => !existingSet.has(num))
  if (missing.length === 0) return

  const inserts = missing.map(accountNumber => {
    const basRef = getBASReference(accountNumber)
    if (basRef) {
      return {
        user_id: userId,
        company_id: companyId,
        account_number: accountNumber,
        account_name: basRef.account_name,
        account_class: basRef.account_class,
        account_group: basRef.account_group,
        account_type: basRef.account_type,
        normal_balance: basRef.normal_balance,
        sru_code: basRef.sru_code,
        k2_excluded: basRef.k2_excluded,
        plan_type: 'full_bas',
        is_active: true,
        is_system_account: false,
      }
    }
    // Fallback — shouldn't happen for salary accounts, but keeps us safe.
    const classNum = parseInt(accountNumber.charAt(0), 10)
    const group = accountNumber.substring(0, 2)
    return {
      user_id: userId,
      company_id: companyId,
      account_number: accountNumber,
      account_name: `Konto ${accountNumber}`,
      account_class: classNum,
      account_group: group,
      account_type: classNum >= 4 ? 'expense' : classNum === 2 ? 'liability' : 'asset',
      normal_balance: classNum <= 1 || classNum >= 4 ? 'debit' : 'credit',
      plan_type: 'full_bas',
      is_active: true,
      is_system_account: false,
    }
  })

  const { error: insertError } = await supabase.from('chart_of_accounts').insert(inserts)
  if (insertError && !insertError.message.includes('duplicate')) {
    throw new Error(`Kunde inte skapa saknade konton: ${insertError.message}`)
  }

  log.info(`Auto-created ${missing.length} missing salary accounts: ${missing.join(', ')}`)
}

function accountLabel(account: string): string {
  const labels: Record<string, string> = {
    '7210': 'Löner tjänstemän',
    '7220': 'Löner företagsledare',
    '7240': 'Styrelsearvoden',
    '7281': 'Sjuklöner',
    '7285': 'Semesterlöner',
    '7321': 'Traktamenten skattefria',
    '7322': 'Traktamenten skattepliktiga',
    '7331': 'Bilersättningar skattefria',
    '7332': 'Bilersättningar skattepliktiga',
  }
  return labels[account] || `Konto ${account}`
}
