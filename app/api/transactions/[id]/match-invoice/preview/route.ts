/**
 * GET /api/transactions/[id]/match-invoice/preview?invoice_id=...
 *
 * Returns the journal entry lines that match-invoice would create for this
 * (transaction, invoice) pair. Read-only — does not stage or write anything.
 *
 * The shape mirrors the routing decision in the POST handler: if the invoice
 * was already booked (invoice.journal_entry_id is set, i.e. 1510 is on the
 * books), we preview the clearing entry (Dr 1930 / Cr 1510). Only when the
 * invoice was never booked AND the company is on kontantmetoden AND the
 * receipt fully pays the invoice do we preview the cash entry (Dr 1930 /
 * Cr 30xx / Cr 26xx).
 *
 * The UI uses this to show the user the exact lines before they confirm —
 * the lack of any preview was part of the reported bug.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { getRevenueAccount, getOutputVatAccount } from '@/lib/bookkeeping/invoice-entries'
import type { EntityType, Invoice, InvoiceItem } from '@/types'
import { z } from 'zod'

type PreviewLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

const QuerySchema = z.object({
  invoice_id: z.string().uuid(),
})

export const GET = withRouteContext(
  'transaction.match_invoice_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const parsed = QuerySchema.safeParse({ invoice_id: url.searchParams.get('invoice_id') })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'invoice_id', message: 'invoice_id must be a UUID' },
      })
    }
    const { invoice_id } = parsed.data

    const { data: transaction, error: txErr } = await supabase
      .from('transactions')
      .select('id, date, amount, currency')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()
    if (txErr || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('*, items:invoice_items(*)')
      .eq('id', invoice_id)
      .eq('company_id', companyId)
      .single()
    if (invErr || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', log, { requestId })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    const paidAmount = transaction.amount
    const currentRemaining =
      invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
    const newRemaining = Math.max(
      0,
      Math.round((currentRemaining - paidAmount) * 100) / 100,
    )
    const isFullyPaid = newRemaining <= 0

    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'

    if (useCashEntry) {
      entryType = 'cash'
      // Mirror createInvoiceCashEntry: per-rate revenue + VAT credits, 1930 debit.
      const inv = invoice as Invoice & { items?: InvoiceItem[] }
      const items = inv.items ?? []
      const isForeign = inv.currency !== 'SEK'

      // Per-item rate aggregation (matches generatePerRateLines semantics).
      // InvoiceItem.line_total is the gross-net-line; the subtotal contribution
      // is line_total minus that line's vat_amount.
      const byRate = new Map<number, { subtotal: number; vat: number }>()
      if (items.length > 0) {
        for (const it of items) {
          const rate = it.vat_rate ?? 25
          const itemVat = resolveSekAmount(it.vat_amount, null, inv.currency, inv.exchange_rate)
          const itemTotal = resolveSekAmount(it.line_total, null, inv.currency, inv.exchange_rate)
          const sub = Math.round((itemTotal - itemVat) * 100) / 100
          const bucket = byRate.get(rate) ?? { subtotal: 0, vat: 0 }
          bucket.subtotal += sub
          bucket.vat += itemVat
          byRate.set(rate, bucket)
        }
      } else {
        // Fallback to invoice-level totals
        const sub = resolveSekAmount(inv.subtotal, inv.subtotal_sek, inv.currency, inv.exchange_rate)
        const vat = resolveSekAmount(inv.vat_amount, inv.vat_amount_sek, inv.currency, inv.exchange_rate)
        byRate.set(inv.vat_rate ?? 25, { subtotal: sub, vat })
      }

      const creditLines: PreviewLine[] = []
      for (const [rate, totals] of byRate) {
        const vatTreatment = totals.vat > 0
          ? (rate === 25 ? 'standard_25' : rate === 12 ? 'reduced_12' : rate === 6 ? 'reduced_6' : inv.vat_treatment)
          : inv.vat_treatment
        const revenueAcct = getRevenueAccount(vatTreatment, entityType)
        creditLines.push({
          account_number: revenueAcct,
          debit_amount: 0,
          credit_amount: Math.round(totals.subtotal * 100) / 100,
          description: `Försäljning ${rate}%`,
        })
        if (totals.vat > 0) {
          creditLines.push({
            account_number: getOutputVatAccount(vatTreatment),
            debit_amount: 0,
            credit_amount: Math.round(totals.vat * 100) / 100,
            description: `Utgående moms ${rate}%`,
          })
        }
      }

      const totalCredits = creditLines.reduce((s, l) => s + l.credit_amount, 0)
      const cashDebit = isForeign
        ? Math.round(totalCredits * 100) / 100
        : resolveSekAmount(inv.total, inv.total_sek, inv.currency, inv.exchange_rate)

      lines.push({
        account_number: '1930',
        debit_amount: Math.round(cashDebit * 100) / 100,
        credit_amount: 0,
        description: 'Inbetalning från bank',
      })
      lines.push(...creditLines)
    } else {
      // Clearing entry: Dr 1930 / Cr 1510 at the paid amount in SEK.
      const inv = invoice as Invoice
      const bookedSek = resolveSekAmount(paidAmount, null, inv.currency, inv.exchange_rate)
      const amount = Math.round(bookedSek * 100) / 100
      lines.push({
        account_number: '1930',
        debit_amount: amount,
        credit_amount: 0,
        description: 'Inbetalning från bank',
      })
      lines.push({
        account_number: '1510',
        debit_amount: 0,
        credit_amount: amount,
        description: 'Kvittning kundfordran',
      })
    }

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: invoiceAlreadyBooked,
      accounting_method: accountingMethod,
      is_fully_paid: isFullyPaid,
    })
  },
)
