import type { Invoice, CompanySettings } from '@/types'

/**
 * Shape accepted by getDisplayTotal. `currency` is widened to `string` so the
 * helper works for both customer (`Invoice`) and supplier (`SupplierInvoice`)
 * rows. `ore_rounding` is the optional per-invoice override (see below).
 */
type InvoiceTotalShape = {
  total: Invoice['total']
  currency: string
  /** Per-invoice öresavrundning override. Wins over the company setting when set. */
  ore_rounding?: boolean | null
}
type CompanyRoundingShape = Pick<CompanySettings, 'ore_rounding'>

export interface DisplayTotal {
  /** Total to render to the user (rounded if öresavrundning applies, raw otherwise). */
  displayed: number
  /** displayed - raw total. Zero when rounding does not apply or the total is already an integer. */
  roundingDelta: number
  /** True when rounding is enabled, currency is SEK, and there are öre to round. */
  applies: boolean
}

/**
 * Single source of truth for öresavrundning display logic. Mirrors the rule
 * baked into the PDF template since day one: only SEK invoices, only when
 * rounding is enabled, and only when there's actually a non-integer total to
 * round. The helper centralizes the rule so the list, detail page, and PDF
 * cannot drift apart.
 *
 * Resolution order for "is rounding enabled":
 *   1. the per-invoice override (`invoice.ore_rounding`) when not null,
 *   2. else the company-wide setting (`company.ore_rounding`),
 *   3. else default-on.
 * Callers that want a different null-fallback (e.g. supplier invoices, where
 * rounding never existed historically) pass `{ ore_rounding: false }` as the
 * company arg so a null per-invoice flag resolves to off.
 */
export function getDisplayTotal(
  invoice: InvoiceTotalShape,
  company: CompanyRoundingShape | null | undefined,
): DisplayTotal {
  const enabled = invoice.ore_rounding ?? company?.ore_rounding ?? true
  if (!enabled || invoice.currency !== 'SEK') {
    return { displayed: invoice.total, roundingDelta: 0, applies: false }
  }
  const rounded = Math.round(invoice.total)
  if (rounded === invoice.total) {
    return { displayed: invoice.total, roundingDelta: 0, applies: false }
  }
  return {
    displayed: rounded,
    roundingDelta: Math.round((rounded - invoice.total) * 100) / 100,
    applies: true,
  }
}
