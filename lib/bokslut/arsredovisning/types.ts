/**
 * Structured data for a K2 årsredovisning. Generated server-side from
 * income statement + balance sheet + asset register + salary data; passed
 * to the @react-pdf/renderer template + the in-app preview.
 */

export interface FlerarsoversiktRow {
  /** Fiscal-year name (e.g. "2025"). */
  year: string
  net_revenue: number
  result_after_financial: number
  /** Soliditet = eget kapital / totala tillgångar, in percent. */
  soliditet_pct: number | null
}

export interface EgenKapitalRow {
  label: string
  /** Single SEK number — positive = credit balance (typical for equity). */
  amount: number
}

export interface NoteEntry {
  /** Note number per K2 convention (1 = redovisningsprinciper). */
  number: number
  /** Short Swedish title. */
  title: string
  /** Note body — supports newlines. Generated from data when possible
   *  (avskrivningstider from asset register, medelantal from salary),
   *  manual otherwise. */
  body: string
}

export interface IncomeStatementLine {
  label: string
  amount: number
  /** True for total / subtotal lines. */
  is_total?: boolean
}

export interface BalanceSheetLine {
  label: string
  amount: number
  is_total?: boolean
  /** Indent depth for nested grouping (0 = top, 1 = subgroup). */
  indent?: number
}

export interface ArsredovisningData {
  company: {
    name: string
    org_number: string
    /** Företagets säte (Bolagsverket-registered registered office city).
     *  Used in the underskrifter "Stad, datum" line and the fastställelseintyg. */
    city: string | null
  }
  fiscal_period: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  forvaltningsberattelse: {
    /** Beskrivning av verksamheten (företaget kan editera). */
    description: string
    /** Viktiga händelser (företaget kan editera). */
    important_events: string
    /** Har kontrollbalansräkning upprättats? */
    kontrollbalans_required: boolean
    flerarsoversikt: FlerarsoversiktRow[]
    /** Förändring av eget kapital. */
    egen_kapital_changes: EgenKapitalRow[]
    /** Styrelsens förslag till resultatdisposition (manual input). */
    resultatdisposition: string
    /** ISO date of the årsstämma where the årsredovisning was adopted.
     *  Populates the fastställelseintyg date blank. Null means "not yet
     *  recorded" — PDF then leaves the blank. */
    agm_date: string | null
  }
  resultatrakning: IncomeStatementLine[]
  balansrakning: {
    assets: BalanceSheetLine[]
    total_assets: number
    equity_liabilities: BalanceSheetLine[]
    total_equity_liabilities: number
  }
  noter: NoteEntry[]
  /** Underskrifter — names of board members + VD. Filled by signature flow. */
  signatures: {
    role: string
    name: string
    signed_at: string | null
  }[]
  /** Pre-download blockers / warnings the UI surfaces so the user knows the
   *  PDF is not yet Bolagsverket-fileable as-is. Examples: aktiekapital
   *  uppgifter saknas, AGM-datum saknas, K3 entity. Never an error — the
   *  user can still download to iterate. */
  warnings: string[]
}
