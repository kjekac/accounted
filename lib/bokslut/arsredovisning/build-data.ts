import type { SupabaseClient } from '@supabase/supabase-js'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getNarrative } from './narrative-service'
import type {
  ArsredovisningData,
  EgenKapitalRow,
  FlerarsoversiktRow,
  IncomeStatementLine,
  BalanceSheetLine,
  NoteEntry,
} from './types'
import type { BalanceSheetSection, IncomeStatementSection } from '@/types'

/**
 * Pre-populate the K2 årsredovisning data for a fiscal period. Loads:
 *   - Income statement + balance sheet for the current period
 *   - Up to 3 prior periods for the flerårsöversikt
 *   - Asset register so noter can list avskrivningstider per category
 *   - Active employees count for medelantal anställda
 *   - Equity-account movements for förändring av eget kapital
 *
 * Manually-authored fields (description, important_events,
 * resultatdisposition, ställda säkerheter, eventualförpliktelser) are
 * pre-filled with sensible boilerplate the user can replace. The narrative
 * editor in the UI persists overrides via /api/.../arsredovisning POST.
 */
export async function buildArsredovisningData(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  overrides: Partial<ArsredovisningData['forvaltningsberattelse']> = {},
): Promise<ArsredovisningData> {
  const [periodResult, settingsResult, periodList, incomeStatement, balanceSheet, narrative] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, previous_period_id, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, address, entity_type')
      .eq('company_id', companyId)
      .maybeSingle(),
    fetchAllRows(({ from, to }) =>
      supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })
        .range(from, to),
    ),
    generateIncomeStatement(supabase, companyId, fiscalPeriodId),
    generateBalanceSheet(supabase, companyId, fiscalPeriodId),
    // Load persisted narrative overrides — replaces the URL-query-param
    // carry from earlier phases. Caller-supplied overrides (passed in via
    // the second arg) still win, so the API can layer per-request edits on
    // top of the saved baseline if needed.
    getNarrative(supabase, companyId, fiscalPeriodId).catch(() => null),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }
  const period = periodResult.data
  const settings = settingsResult.data
  const companyName = settings?.company_name ?? 'Bolaget'
  const orgNumber = settings?.org_number ?? ''
  // Default to 'unknown' (not 'aktiebolag') when entity_type isn't set —
  // otherwise the K2 guard in buildK2Noter would claim K2 for every
  // unconfigured company, which is exactly the false-assertion the guard
  // was added to prevent.
  const entityType = (settings as { entity_type?: string } | null)?.entity_type ?? 'unknown'

  type AddressShape = { city?: string | null; postal_city?: string | null } | null
  const addressUnknown = (settings as { address?: AddressShape } | null)?.address ?? null
  const city =
    (addressUnknown && (addressUnknown.city ?? addressUnknown.postal_city)) || null

  // Merge precedence: caller overrides → persisted narrative → boilerplate
  const persistedDescription = narrative?.description ?? undefined
  const persistedEvents = narrative?.important_events ?? undefined
  const persistedRd = narrative?.resultatdisposition ?? undefined
  const persistedAgmDate = narrative?.agm_date ?? null

  const flerarsoversikt = await buildFlerarsoversikt(
    supabase,
    companyId,
    fiscalPeriodId,
    (periodList ?? []) as Array<{ id: string; name: string; period_start: string; period_end: string }>,
  )

  const egen_kapital_changes = buildEquityChanges(balanceSheet.equity_liability_sections)

  const { notes: noter, warnings: noterWarnings } = await buildK2Noter(
    supabase,
    companyId,
    entityType,
  )

  const resultatrakning = flattenIncomeStatement(incomeStatement)
  const balansrakning = flattenBalanceSheet(balanceSheet)

  const warnings: string[] = [...noterWarnings]
  if (entityType !== 'aktiebolag' && entityType !== 'unknown') {
    warnings.push(
      'Den här årsredovisningen genereras med K2-mallen (BFNAR 2016:10) som standard. För K3- eller annan företagsform kan strukturen behöva justeras manuellt innan inlämning.',
    )
  }
  if (entityType === 'unknown') {
    warnings.push(
      'Företagsform saknas i inställningarna — fyll i Inställningar → Företag för att få rätt redovisningsprinciper i not 1.',
    )
  }
  if (!persistedAgmDate) {
    warnings.push(
      'Datum för årsstämma saknas. Fastställelseintyget i PDF:en lämnas tomt på datumraden tills det fylls i nedan.',
    )
  } else {
    // ÅRL 8 kap 3 § + ÅRL 7 kap 10 §: AGM must be held after the räkenskapsår
    // ends and within 6 months of period end (för privat AB). A date before
    // period_end is logically impossible; after the deadline is a legally
    // defective fastställelseintyg.
    if (persistedAgmDate <= period.period_end) {
      warnings.push(
        `Datum för årsstämma (${persistedAgmDate}) ligger på eller före räkenskapsårets slut (${period.period_end}) — fastställelseintyget blir juridiskt felaktigt. Kontrollera datumet.`,
      )
    } else {
      const periodEndDate = new Date(`${period.period_end}T00:00:00Z`)
      const deadline = new Date(periodEndDate)
      deadline.setUTCMonth(deadline.getUTCMonth() + 6)
      const deadlineIso = deadline.toISOString().slice(0, 10)
      if (persistedAgmDate > deadlineIso) {
        warnings.push(
          `Datum för årsstämma (${persistedAgmDate}) är efter 6-månadersgränsen (${deadlineIso}). För privat AB ska årsstämman hållas inom 6 månader från räkenskapsårets slut (ÅRL 7 kap 10 §).`,
        )
      }
    }
  }

  return {
    company: {
      name: companyName,
      org_number: orgNumber,
      city,
    },
    fiscal_period: {
      id: period.id,
      name: period.name,
      period_start: period.period_start,
      period_end: period.period_end,
    },
    forvaltningsberattelse: {
      description:
        overrides.description ??
        persistedDescription ??
        `${companyName} bedriver verksamhet enligt verksamhetsbeskrivningen i bolagsordningen.`,
      important_events:
        overrides.important_events ??
        persistedEvents ??
        'Inga väsentliga händelser utöver löpande verksamhet har inträffat under räkenskapsåret.',
      kontrollbalans_required: overrides.kontrollbalans_required ?? false,
      flerarsoversikt,
      egen_kapital_changes,
      resultatdisposition:
        overrides.resultatdisposition ??
        persistedRd ??
        'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      agm_date: persistedAgmDate,
    },
    resultatrakning,
    warnings,
    balansrakning,
    noter,
    signatures: [], // populated by signature-flow service in a later phase step
  }
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

async function buildFlerarsoversikt(
  supabase: SupabaseClient,
  companyId: string,
  currentPeriodId: string,
  allPeriods: PeriodRow[],
): Promise<FlerarsoversiktRow[]> {
  // Take the current period + 3 prior (oldest first).
  const sorted = [...allPeriods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const currentIdx = sorted.findIndex((p) => p.id === currentPeriodId)
  if (currentIdx === -1) return []
  const slice = sorted.slice(Math.max(0, currentIdx - 3), currentIdx + 1)

  const rows: FlerarsoversiktRow[] = []
  for (const p of slice) {
    try {
      const [is, tb] = await Promise.all([
        generateIncomeStatement(supabase, companyId, p.id),
        generateTrialBalance(supabase, companyId, p.id),
      ])
      // Nettoomsättning = sum of revenue sections (revenue is normally credit).
      const netRevenue = is.total_revenue
      const resultAfterFinancial = is.total_revenue - is.total_expenses + is.total_financial
      const totalAssets = tb.rows
        .filter((r) => r.account_class === 1)
        .reduce((s, r) => s + (r.closing_debit - r.closing_credit), 0)
      const eqLiab = tb.rows
        .filter((r) => r.account_class === 2)
        .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)
      // Soliditet: eget kapital uses 20xx ONLY. 21xx (periodiseringsfonder,
      // överavskrivningar) are obeskattade reserver — partially deferred tax,
      // not equity. K2 / ÅRL splits them out. Including 21xx here would
      // inflate soliditet for any AB that posts dispositions.
      //
      // K3 NOTE: K3 (BFNAR 2012:1) requires the 79,4% equity portion of
      // obeskattade reserver to be folded into eget kapital and the 20,6%
      // latent skatteskuld to be split out separately. When K3 support
      // lands this filter must branch on the company's framework — for now
      // we treat every entity as K2 / consistent-with-K2.
      const equity = tb.rows
        .filter((r) => r.account_number.startsWith('20'))
        .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)
      const soliditet =
        totalAssets > 0 ? Math.round((equity / totalAssets) * 1000) / 10 : null
      // Avoid the unused-variable warning while leaving eqLiab computed for
      // future "Skulder" column expansion.
      void eqLiab
      rows.push({
        year: p.name,
        net_revenue: Math.round(netRevenue),
        result_after_financial: Math.round(resultAfterFinancial),
        soliditet_pct: soliditet,
      })
    } catch {
      // Prior periods may lack continuity if SIE import was partial. Skip
      // rather than blocking the whole årsredovisning.
      rows.push({
        year: p.name,
        net_revenue: 0,
        result_after_financial: 0,
        soliditet_pct: null,
      })
    }
  }
  return rows
}

function buildEquityChanges(sections: BalanceSheetSection[]): EgenKapitalRow[] {
  const equity: EgenKapitalRow[] = []
  for (const section of sections) {
    for (const row of section.rows) {
      if (
        row.account_number.startsWith('20') ||
        row.account_number.startsWith('21')
      ) {
        equity.push({
          label: `${row.account_number} ${row.account_name}`,
          amount: row.amount,
        })
      }
    }
  }
  return equity
}

async function buildK2Noter(
  supabase: SupabaseClient,
  companyId: string,
  entityType: string,
): Promise<{ notes: NoteEntry[]; warnings: string[] }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []
  // Note 1: framework. Only claim K2 explicitly when we know the company is
  // an AB and using K2 — otherwise emit a generic principles note so the
  // ÅR doesn't falsely assert a framework the company isn't on.
  // K3 election isn't yet tracked separately; we treat any non-AB as not-K2.
  const isAbK2 = entityType === 'aktiebolag'
  notes.push({
    number: 1,
    title: 'Redovisnings- och värderingsprinciper',
    body: isAbK2
      ? 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd BFNAR 2016:10 Årsredovisning i mindre företag (K2).'
      : 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd.',
  })

  // Note: aktiekapital. K2 punkt 18.x requires AB to disclose share-capital
  // structure. Read from company_settings when present; surface a warning
  // when missing so the user knows to fill it in. We also surface the
  // warning when entityType is 'unknown' since the company may in fact be
  // an AB the user just hasn't configured yet — staying silent would let
  // them download an incomplete K2 ÅR without realising.
  const maybeAb = isAbK2 || entityType === 'unknown'
  if (maybeAb) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('aktiekapital, antal_aktier, kvotvarde')
      .eq('company_id', companyId)
      .maybeSingle()
    type AktiekapitalShape = { aktiekapital?: number | null; antal_aktier?: number | null; kvotvarde?: number | null }
    const ak = settings as AktiekapitalShape | null
    const aktiekapital = ak?.aktiekapital ?? null
    const antalAktier = ak?.antal_aktier ?? null
    const kvotvarde = ak?.kvotvarde ?? null
    if (aktiekapital || antalAktier) {
      const parts: string[] = []
      if (aktiekapital) parts.push(`Aktiekapital: ${aktiekapital.toLocaleString('sv-SE')} kr.`)
      if (antalAktier) parts.push(`Antal aktier: ${antalAktier.toLocaleString('sv-SE')}.`)
      if (kvotvarde) parts.push(`Kvotvärde per aktie: ${kvotvarde.toLocaleString('sv-SE')} kr.`)
      notes.push({
        number: notes.length + 1,
        title: 'Aktiekapital',
        body: parts.join(' '),
      })
    } else {
      // Don't write a "saknas — komplettera" placeholder into the PDF body —
      // that text would land in the Bolagsverket-filed document as a user-
      // facing error string and the filing would be K2-non-compliant
      // (BFNAR 2016:10 punkt 5.4 / ÅRL 5 kap 14 § require the actual
      // registered amount). Omit the note entirely and surface a warning so
      // the UI can flag this pre-download.
      warnings.push(
        'Aktiekapitalnoten saknas eftersom uppgifter om aktiekapital inte finns i Inställningar → Företag. K2 / ÅRL kräver att noten innehåller registrerat belopp innan inlämning till Bolagsverket.',
      )
    }
  }

  // Avskrivningstider — derive from asset register
  const assets = await listAssets(supabase, companyId)
  if (assets.length > 0) {
    const byCategory = new Map<string, Set<number>>()
    for (const a of assets) {
      if (a.disposed_at) continue
      const years = Math.round(a.useful_life_months / 12)
      if (!byCategory.has(a.category)) byCategory.set(a.category, new Set())
      byCategory.get(a.category)!.add(years)
    }
    if (byCategory.size > 0) {
      const lines: string[] = ['Avskrivningar görs linjärt över bedömd nyttjandeperiod:']
      const categoryLabels: Record<string, string> = {
        immaterial: 'Immateriella anläggningstillgångar',
        building: 'Byggnader',
        land_improvement: 'Markanläggningar',
        machinery: 'Maskiner',
        equipment: 'Inventarier',
        vehicle: 'Fordon',
        computer: 'Datorer',
        other_tangible: 'Övriga materiella anläggningstillgångar',
      }
      for (const [cat, yearsSet] of byCategory.entries()) {
        const yrs = Array.from(yearsSet).sort((a, b) => a - b)
        const yrsLabel = yrs.length === 1 ? `${yrs[0]} år` : `${yrs[0]}–${yrs[yrs.length - 1]} år`
        lines.push(`• ${categoryLabels[cat] ?? cat}: ${yrsLabel}`)
      }
      notes.push({
        number: 2,
        title: 'Avskrivningar',
        body: lines.join('\n'),
      })
    }
  }

  // Medelantal anställda — count active employees as a proxy
  const { count: employeeCount } = await supabase
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_active', true)
  if ((employeeCount ?? 0) > 0) {
    notes.push({
      number: notes.length + 1,
      title: 'Medelantal anställda',
      body: `Under räkenskapsåret har medeltalet anställda uppgått till ${employeeCount}.`,
    })
  }

  notes.push({
    number: notes.length + 1,
    title: 'Ställda säkerheter och eventualförpliktelser',
    body: 'Inga.',
  })

  return { notes, warnings }
}

function flattenIncomeStatement(is: {
  revenue_sections: IncomeStatementSection[]
  total_revenue: number
  expense_sections: IncomeStatementSection[]
  total_expenses: number
  financial_sections: IncomeStatementSection[]
  total_financial: number
  net_result: number
}): IncomeStatementLine[] {
  const lines: IncomeStatementLine[] = []
  for (const s of is.revenue_sections) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
    }
  }
  lines.push({ label: 'Summa rörelseintäkter', amount: is.total_revenue, is_total: true })
  for (const s of is.expense_sections) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: -r.amount })
    }
  }
  lines.push({
    label: 'Rörelseresultat',
    amount: is.total_revenue - is.total_expenses,
    is_total: true,
  })

  // Split financial sections so the RR follows the K2 / ÅRL 3:2 structure:
  // financial items (80–87) → "Resultat efter finansiella poster" →
  // bokslutsdispositioner (88) → "Resultat före skatt" → skatt (89) →
  // "Årets resultat". Without the dispositioner + skatt rows the document
  // is non-compliant for any AB that posted bolagsskatt or
  // periodiseringsfond, and the RR doesn't reconcile to BS 2099.
  const finItems = is.financial_sections.filter(
    (s) => !/bokslutsdisposition|skatter och årets resultat/i.test(s.title),
  )
  const dispositionsSections = is.financial_sections.filter((s) =>
    /bokslutsdisposition/i.test(s.title),
  )
  const skattSections = is.financial_sections.filter((s) =>
    /skatter och årets resultat/i.test(s.title),
  )
  for (const s of finItems) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
    }
  }
  const finSubtotal = finItems.reduce((sum, s) => sum + s.subtotal, 0)
  const resAfterFinancial = is.total_revenue - is.total_expenses + finSubtotal
  lines.push({
    label: 'Resultat efter finansiella poster',
    amount: Math.round(resAfterFinancial * 100) / 100,
    is_total: true,
  })

  if (dispositionsSections.length > 0) {
    for (const s of dispositionsSections) {
      for (const r of s.rows) {
        lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
      }
    }
    const dispositionsSubtotal = dispositionsSections.reduce((sum, s) => sum + s.subtotal, 0)
    lines.push({
      label: 'Resultat före skatt',
      amount: Math.round((resAfterFinancial + dispositionsSubtotal) * 100) / 100,
      is_total: true,
    })
  } else {
    // No dispositioner posted — keep the simpler "Resultat före skatt" row
    // immediately after the finansnetto totals so the RR still has the
    // pre-tax subtotal expected by ÅRL.
    lines.push({
      label: 'Resultat före skatt',
      amount: Math.round(resAfterFinancial * 100) / 100,
      is_total: true,
    })
  }

  if (skattSections.length > 0) {
    for (const s of skattSections) {
      for (const r of s.rows) {
        lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
      }
    }
  }

  lines.push({ label: 'Årets resultat', amount: is.net_result, is_total: true })
  return lines
}

function flattenBalanceSheet(bs: {
  asset_sections: BalanceSheetSection[]
  total_assets: number
  equity_liability_sections: BalanceSheetSection[]
  total_equity_liabilities: number
}): {
  assets: BalanceSheetLine[]
  total_assets: number
  equity_liabilities: BalanceSheetLine[]
  total_equity_liabilities: number
} {
  const assetLines: BalanceSheetLine[] = []
  for (const s of bs.asset_sections) {
    assetLines.push({ label: s.title, amount: s.subtotal, is_total: true, indent: 0 })
    for (const r of s.rows) {
      assetLines.push({
        label: `${r.account_number} ${r.account_name}`,
        amount: r.amount,
        indent: 1,
      })
    }
  }
  const eqLines: BalanceSheetLine[] = []
  for (const s of bs.equity_liability_sections) {
    eqLines.push({ label: s.title, amount: s.subtotal, is_total: true, indent: 0 })
    for (const r of s.rows) {
      eqLines.push({
        label: `${r.account_number} ${r.account_name}`,
        amount: r.amount,
        indent: 1,
      })
    }
  }
  return {
    assets: assetLines,
    total_assets: bs.total_assets,
    equity_liabilities: eqLines,
    total_equity_liabilities: bs.total_equity_liabilities,
  }
}
