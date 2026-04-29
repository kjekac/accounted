import { decryptPersonnummer } from '../personnummer'
import { getBranding } from '@/lib/branding/service'

/**
 * AGI XML generator — Arbetsgivardeklaration på individnivå.
 *
 * Produces XML conforming to Skatteverket's schema:
 *   http://xmls.skatteverket.se/se/skatteverket/da/instans/schema/1.1
 *
 * The XML can be uploaded on Skatteverket's AGI e-tjänst. For programmatic
 * submission use the JSON API flow via the skatteverket extension instead.
 *
 * Sources verified against Skatteverket's schema + technical description
 * (SKV 269, teknisk beskrivning 1.1.16):
 *   - Root: <Skatteverket omrade="Arbetsgivardeklaration">
 *   - HU totals: SummaSkatteavdr (497), SummaArbAvgSlf (487), TotalSjuklonekostnad (499)
 *   - IU identity: BetalningsmottagarId (215), Specifikationsnummer (570)
 *   - IU amounts: KontantErsattningUlagAG (011), AvdrPrelSkatt (001)
 *   - Every HU and IU must include AgRegistreradId (201) + RedovisningsPeriod (006)
 *
 * CRITICAL: FK570 (specifikationsnummer) must stay consistent per employee.
 * Corrections are detected by Skatteverket matching the same FK570.
 *
 * NOT HANDLED HERE (future work):
 *   - <Franvarouppgift>: separate top-level section for parental leave events
 *     (FK821 FranvaroDatum, FK823 FranvaroTyp={TILLFALLIG_FORALDRAPENNING|
 *     FORALDRAPENNING}, etc.). Requires per-event date records, not a simple
 *     day count. Per-employee sick days are NOT reported via AGI at all —
 *     they go to Försäkringskassan separately.
 */

const INSTANS_NS = 'http://xmls.skatteverket.se/se/skatteverket/da/instans/schema/1.1'
const KOMPONENT_NS = 'http://xmls.skatteverket.se/se/skatteverket/da/komponent/schema/1.1'

export interface AGIEmployeeData {
  personnummer: string       // Encrypted — decrypted for XML
  specificationNumber: number // FK570 — MUST stay consistent per employee
  grossSalary: number         // FK011 KontantErsattningUlagAG
  taxWithheld: number         // FK001 AvdrPrelSkatt
  avgifterBasis: number       // Retained for backwards compat; equals grossSalary for standard cases. Not emitted separately (FK011 already captures basis).
  fSkattPayment?: number      // FK131 KontantErsattningEjUlagSA
  benefitCar?: number         // FK013 SkatteplBilformanUlagAG
  benefitFuel?: number        // FK018 DrivmVidBilformanUlagAG
  benefitHousing?: number     // FK043 BostadsformanEjSmahusUlagAG (non-småhus default)
  benefitOther?: number       // FK012 SkatteplOvrigaFormanerUlagAG
  /** @deprecated Meal benefit element name not verified against schema; kept for snapshot compatibility only (not emitted). */
  benefitMeals?: number
  /** @deprecated Per-employee sick days are not reported via AGI (goes to Försäkringskassan separately). Kept for snapshot compatibility. */
  sickDays?: number
  /** @deprecated VAB is reported via top-level <Franvarouppgift> as per-event records, not as an IU day count. Kept for snapshot compatibility. */
  vabDays?: number
  /** @deprecated Parental leave is reported via top-level <Franvarouppgift> as per-event records, not as an IU day count. Kept for snapshot compatibility. */
  parentalDays?: number
}

export interface AGICompanyData {
  orgNumber: string          // 10 digits after stripping dashes
  companyName: string
  periodYear: number
  periodMonth: number
  contactName: string
  contactPhone: string
  contactEmail: string
}

export interface AGITotals {
  totalTax: number                // FK497 SummaSkatteavdr
  totalAvgifterBasis: number      // retained for compat (sum of IU underlag)
  totalAvgifterAmount: number     // FK487 SummaArbAvgSlf (sum of calculated avgifter across categories)
  /**
   * FK499 TotalSjuklonekostnad — company's total sjuklön cost for the period
   * (sum of sjuklön paid days 2–14 across all employees). Required per 2025+ rules.
   * Day 1 is karens (unpaid); day 15+ is Försäkringskassan, not employer.
   */
  totalSjuklonekostnad?: number
  avgifterByCategory: {
    standard?: { basis: number; amount: number }
    reduced65plus?: { basis: number; amount: number }
    youth?: { basis: number; amount: number }
  }
}

/**
 * Thrown when required AGI data is missing. Caller should surface the message
 * to the user so they can fill in the missing field (org number, contact info).
 */
export class AGIIncompleteDataError extends Error {
  constructor(message: string, public readonly missingFields: string[]) {
    super(message)
    this.name = 'AGIIncompleteDataError'
  }
}

function assertRequiredCompanyData(company: AGICompanyData): void {
  const missing: string[] = []
  const orgNumberDigits = (company.orgNumber || '').replace(/\D/g, '')
  // Skatteverket's IDENTITET type requires either 10 digits (AB orgnr, we prefix
  // with "16") or 12 digits (personnummer for enskild firma). Any other length
  // is a data-entry error that we cannot silently fix.
  if (orgNumberDigits.length !== 10 && orgNumberDigits.length !== 12) missing.push('organisationsnummer')
  if (!company.contactName.trim()) missing.push('kontaktperson (namn)')
  if (!company.contactPhone.trim()) missing.push('telefon')
  if (!company.contactEmail.trim()) missing.push('e-post')

  if (missing.length > 0) {
    throw new AGIIncompleteDataError(
      `AGI kan inte genereras — följande uppgifter saknas: ${missing.join(', ')}. ` +
        'Fyll i dem under Inställningar → Företag och Inställningar → Lön.',
      missing
    )
  }
}

/**
 * Skatteverket's IDENTITET pattern (from the AGI XSD). Accepts:
 *   - 12-digit personnummer YYYYMMDDXXXX (real dates 19xx/20xx, incl. leap days
 *     and samordningsnummer where day = actual_day + 60)
 *   - 12-digit AB/organisationsnummer: literal "16" + 10-digit orgnr, where the
 *     3rd digit (first of the 10-digit orgnr) is 1-3, 5, 6, 7, 8 or 9 (NOT 4,
 *     and with specific restrictions) and the 5th is 2-9.
 *
 * Mirrored here so we can fail fast with a user-friendly message instead of
 * emitting XML that Skatteverket's validator will reject cryptically.
 */
const IDENTITET_PATTERN = /^(((19|20)[0-9][0-9])((((01|03|05|07|08|10|12)(6[1-9]|7[0-9]|8[0-9]|9[0-1]))|((04|06|09|11)(6[1-9]|7[0-9]|8[0-9]|90))|((02)(6[1-9]|7[0-9]|8[0-8])))|00[6-9][0-9]|[0-9][0-9]60)|(((19|20)(04|08|12|16|20|24|28|32|36|40|44|48|52|56|60|64|68|72|76|80|84|88|92|96)(0289))|(20000289)))(00[1-9]|0[1-9][0-9]|[1-9][0-9][0-9])[0-9]|16(1[0-9]|2[0-9]|3[0-9]|5[0-9]|6[0-4]|66|68|7[0-9]|8[0-9]|9[0-9])[2-9]\d{7}|((((19|20)[0-9][0-9])(((01|03|05|07|08|10|12)(0[1-9]|1[0-9]|2[0-9]|3[0-1]))|((04|06|09|11)(0[1-9]|1[0-9]|2[0-9]|30))|((02)(0[1-9]|1[0-9]|2[0-8]))))|(((19|20)(04|08|12|16|20|24|28|32|36|40|44|48|52|56|60|64|68|72|76|80|84|88|92|96)(0229))|(20000229)))(00[1-9]|0[1-9][0-9]|[1-9][0-9][0-9])[0-9]$/

/**
 * Normalize an org number or personnummer to Skatteverket's 12-character
 * IDENTITET format, required by the AGI schema for Avsandare/Organisationsnummer,
 * AgRegistreradId, and Arendeagare.
 *
 *   - 10-digit orgnr (AB e.g. 5561234567) → prefixed with "16" → 165561234567
 *   - 12-digit personnummer (EF e.g. 196904206942) → used as-is
 *
 * Throws AGIIncompleteDataError if the resulting value cannot match the
 * IDENTITET pattern — this catches bogus test data (e.g. "420694-2069") before
 * the file reaches Skatteverket.
 */
function toIdentitet(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  let candidate: string
  if (digits.length === 12) candidate = digits
  else if (digits.length === 10) candidate = `16${digits}`
  else {
    throw new AGIIncompleteDataError(
      `Ogiltigt organisations-/personnummer (${digits.length} siffror). ` +
        'Ange ett giltigt svenskt organisationsnummer (10 siffror, t.ex. 556123-4567) ' +
        'eller fullständigt personnummer (12 siffror, YYYYMMDD-XXXX) under Inställningar → Företag.',
      ['organisationsnummer']
    )
  }

  if (!IDENTITET_PATTERN.test(candidate)) {
    throw new AGIIncompleteDataError(
      `Ogiltigt organisationsnummer "${raw}" — värdet är inte ett svenskt organisationsnummer eller personnummer enligt Skatteverkets format. ` +
        'Kontrollera värdet under Inställningar → Företag. För AB ska det vara 10 siffror (t.ex. 556123-4567). ' +
        'För enskild firma ska det vara ett fullständigt 12-siffrigt personnummer (YYYYMMDD-XXXX).',
      ['organisationsnummer']
    )
  }
  return candidate
}

/**
 * Generate AGI XML for a period.
 *
 * Throws AGIIncompleteDataError if required fields (orgNumber, contact info)
 * are missing — we never emit partial XML that Skatteverket would reject.
 */
export function generateAGIXml(
  company: AGICompanyData,
  employees: AGIEmployeeData[],
  totals: AGITotals,
  _isCorrection: boolean = false
): string {
  assertRequiredCompanyData(company)

  const orgIdentitet = toIdentitet(company.orgNumber)
  const period = `${company.periodYear}${String(company.periodMonth).padStart(2, '0')}`
  const createdAt = new Date().toISOString().replace(/\.\d+Z$/, '')

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<Skatteverket omrade="Arbetsgivardeklaration" xmlns="${INSTANS_NS}" xmlns:gem="${KOMPONENT_NS}">`
  )

  // ── Avsandare (komponent namespace) ──────────────────────────
  lines.push('  <gem:Avsandare>')
  lines.push(`    <gem:Programnamn>${escapeXml(getBranding().appName.toLowerCase())}</gem:Programnamn>`)
  lines.push(`    <gem:Organisationsnummer>${orgIdentitet}</gem:Organisationsnummer>`)
  lines.push('    <gem:TekniskKontaktperson>')
  lines.push(`      <gem:Namn>${escapeXml(company.contactName)}</gem:Namn>`)
  lines.push(`      <gem:Telefon>${escapeXml(company.contactPhone)}</gem:Telefon>`)
  lines.push(`      <gem:Epostadress>${escapeXml(company.contactEmail)}</gem:Epostadress>`)
  lines.push('    </gem:TekniskKontaktperson>')
  lines.push(`    <gem:Skapad>${createdAt}</gem:Skapad>`)
  lines.push('  </gem:Avsandare>')

  // ── Blankettgemensamt (komponent namespace) ──────────────────
  lines.push('  <gem:Blankettgemensamt>')
  lines.push('    <gem:Arbetsgivare>')
  lines.push(`      <gem:AgRegistreradId>${orgIdentitet}</gem:AgRegistreradId>`)
  lines.push('      <gem:Kontaktperson>')
  lines.push(`        <gem:Namn>${escapeXml(company.contactName)}</gem:Namn>`)
  lines.push(`        <gem:Telefon>${escapeXml(company.contactPhone)}</gem:Telefon>`)
  lines.push(`        <gem:Epostadress>${escapeXml(company.contactEmail)}</gem:Epostadress>`)
  lines.push('      </gem:Kontaktperson>')
  lines.push('    </gem:Arbetsgivare>')
  lines.push('  </gem:Blankettgemensamt>')

  // ── Blankett: Huvuduppgift (komponent namespace) ─────────────
  lines.push('  <gem:Blankett>')
  lines.push('    <gem:Arendeinformation>')
  lines.push(`      <gem:Arendeagare>${orgIdentitet}</gem:Arendeagare>`)
  lines.push(`      <gem:Period>${period}</gem:Period>`)
  lines.push('    </gem:Arendeinformation>')
  lines.push('    <gem:Blankettinnehall>')
  // HU/IU substitute for the abstract gem:Uppgift element in the komponent
  // namespace (substitution group head). Use the concrete element directly —
  // gem:Uppgift itself is abstract and cannot appear in an instance document.
  lines.push('      <gem:HU>')
  // AgRegistreradId is wrapped in ArbetsgivareHUGROUP, all payload elements
  // live in the komponent namespace (gem: prefix).
  lines.push('        <gem:ArbetsgivareHUGROUP>')
  lines.push(`          <gem:AgRegistreradId faltkod="201">${orgIdentitet}</gem:AgRegistreradId>`)
  lines.push('        </gem:ArbetsgivareHUGROUP>')
  lines.push(`        <gem:RedovisningsPeriod faltkod="006">${period}</gem:RedovisningsPeriod>`)

  // FK497 — Summa skatteavdrag (total from all IU)
  if (totals.totalTax > 0) {
    lines.push(`        <gem:SummaSkatteavdr faltkod="497">${formatAmount(totals.totalTax)}</gem:SummaSkatteavdr>`)
  }

  // FK487 — Summa arbetsgivaravgifter och SLF (calculated total, NOT basis)
  if (totals.totalAvgifterAmount > 0) {
    lines.push(`        <gem:SummaArbAvgSlf faltkod="487">${formatAmount(totals.totalAvgifterAmount)}</gem:SummaArbAvgSlf>`)
  }

  // FK499 — Total sjuklönekostnad (legal requirement from 2025 when > 0)
  if (totals.totalSjuklonekostnad && totals.totalSjuklonekostnad > 0) {
    lines.push(`        <gem:TotalSjuklonekostnad faltkod="499">${formatAmount(totals.totalSjuklonekostnad)}</gem:TotalSjuklonekostnad>`)
  }

  lines.push('      </gem:HU>')
  lines.push('    </gem:Blankettinnehall>')
  lines.push('  </gem:Blankett>')

  // ── Blankett: Individuppgift (one per employee) ──────────────
  for (const emp of employees) {
    let pnr: string
    try {
      pnr = decryptPersonnummer(emp.personnummer)
    } catch {
      throw new Error(
        `Kunde inte dekryptera personnummer för anställd med FK570=${emp.specificationNumber}. ` +
          'AGI kan inte genereras utan giltigt personnummer.'
      )
    }

    lines.push('  <gem:Blankett>')
    lines.push('    <gem:Arendeinformation>')
    lines.push(`      <gem:Arendeagare>${orgIdentitet}</gem:Arendeagare>`)
    lines.push(`      <gem:Period>${period}</gem:Period>`)
    lines.push('    </gem:Arendeinformation>')
    lines.push('    <gem:Blankettinnehall>')
    lines.push('      <gem:IU>')
    // Identity groups wrap AgRegistreradId and BetalningsmottagarId in IU.
    lines.push('        <gem:ArbetsgivareIUGROUP>')
    lines.push(`          <gem:AgRegistreradId faltkod="201">${orgIdentitet}</gem:AgRegistreradId>`)
    lines.push('        </gem:ArbetsgivareIUGROUP>')
    // BetalningsmottagarId must be inside BetalningsmottagareIDChoice (an
    // xs:choice allowing BetalningsmottagarId | Fodelsetid | AnnatId).
    lines.push('        <gem:BetalningsmottagareIUGROUP>')
    lines.push('          <gem:BetalningsmottagareIDChoice>')
    lines.push(`            <gem:BetalningsmottagarId faltkod="215">${pnr}</gem:BetalningsmottagarId>`)
    lines.push('          </gem:BetalningsmottagareIDChoice>')
    lines.push('        </gem:BetalningsmottagareIUGROUP>')
    lines.push(`        <gem:RedovisningsPeriod faltkod="006">${period}</gem:RedovisningsPeriod>`)
    lines.push(`        <gem:Specifikationsnummer faltkod="570">${emp.specificationNumber}</gem:Specifikationsnummer>`)

    // FK011 — Kontant ersättning, underlag arbetsgivaravgifter (= gross salary)
    if (emp.grossSalary > 0) {
      lines.push(`        <gem:KontantErsattningUlagAG faltkod="011">${formatAmount(emp.grossSalary)}</gem:KontantErsattningUlagAG>`)
    }

    // FK001 — Avdragen preliminärskatt
    if (emp.taxWithheld > 0) {
      lines.push(`        <gem:AvdrPrelSkatt faltkod="001">${formatAmount(emp.taxWithheld)}</gem:AvdrPrelSkatt>`)
    }

    // FK013 — Bilförmån (skattepliktig, underlag AG)
    if (emp.benefitCar && emp.benefitCar > 0) {
      lines.push(`        <gem:SkatteplBilformanUlagAG faltkod="013">${formatAmount(emp.benefitCar)}</gem:SkatteplBilformanUlagAG>`)
    }

    // FK018 — Drivmedel vid bilförmån
    if (emp.benefitFuel && emp.benefitFuel > 0) {
      lines.push(`        <gem:DrivmVidBilformanUlagAG faltkod="018">${formatAmount(emp.benefitFuel)}</gem:DrivmVidBilformanUlagAG>`)
    }

    // FK043 — Bostadsförmån (ej småhus). TODO: for single-family home use
    // BostadsformanSmahusUlagAG (FK041); currently defaults to non-småhus.
    if (emp.benefitHousing && emp.benefitHousing > 0) {
      lines.push(`        <gem:BostadsformanEjSmahusUlagAG faltkod="043">${formatAmount(emp.benefitHousing)}</gem:BostadsformanEjSmahusUlagAG>`)
    }

    // FK012 — Övriga skattepliktiga förmåner
    if (emp.benefitOther && emp.benefitOther > 0) {
      lines.push(`        <gem:SkatteplOvrigaFormanerUlagAG faltkod="012">${formatAmount(emp.benefitOther)}</gem:SkatteplOvrigaFormanerUlagAG>`)
    }

    // Meal benefit: element name not verified in the component schema yet.
    // Intentionally omitted until we have an authoritative mapping.
    void emp.benefitMeals

    // FK131 — Ersättning till mottagare med F-skattsedel (ej underlag SA)
    if (emp.fSkattPayment && emp.fSkattPayment > 0) {
      lines.push(`        <gem:KontantErsattningEjUlagSA faltkod="131">${formatAmount(emp.fSkattPayment)}</gem:KontantErsattningEjUlagSA>`)
    }

    // Sjuk/VAB/föräldra-dagar flows elsewhere:
    //   - Per-employee sick days are reported to Försäkringskassan, not AGI.
    //     The company-level total goes in HU as TotalSjuklonekostnad (FK499).
    //   - VAB and parental leave are reported via the top-level
    //     <Franvarouppgift> section (FK820-827) as per-event date records,
    //     not as per-IU day counts. Not implemented in this generator yet.
    void emp.sickDays
    void emp.vabDays
    void emp.parentalDays

    lines.push('      </gem:IU>')
    lines.push('    </gem:Blankettinnehall>')
    lines.push('  </gem:Blankett>')
  }

  lines.push('</Skatteverket>')

  return lines.join('\n')
}

/**
 * Build individuppgifter snapshot for storage in agi_declarations table.
 * Used for corrections — must reference same FK570.
 */
export function buildIndividuppgifterSnapshot(
  employees: AGIEmployeeData[]
): Record<string, unknown>[] {
  return employees.map(emp => {
    let pnr: string
    try {
      pnr = decryptPersonnummer(emp.personnummer)
    } catch {
      pnr = 'DECRYPTION_FAILED'
    }

    return {
      personnummer: pnr,
      fk570: emp.specificationNumber,
      ruta011: emp.grossSalary,
      ruta001: emp.taxWithheld,
      ruta020: emp.avgifterBasis,
      fk821: emp.sickDays || 0,
      fk822: emp.vabDays || 0,
      fk823: emp.parentalDays || 0,
    }
  })
}

// ============================================================
// Helpers
// ============================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function formatAmount(amount: number): string {
  return Math.round(amount).toString()
}
