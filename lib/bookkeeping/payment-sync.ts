import type { SupabaseClient } from '@supabase/supabase-js'
import type { JournalEntry } from '@/types'

export const PAYMENT_SOURCE_TYPES = [
  'invoice_paid',
  'invoice_cash_payment',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
] as const

export function isPaymentSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  return (PAYMENT_SOURCE_TYPES as readonly string[]).includes(sourceType)
}

/**
 * Revert the business-level paid status on the invoice or supplier invoice
 * that a payment journal entry was attached to. Used by both reverseEntry()
 * (storno) and the DELETE journal entry route — both paths leave the GL in a
 * consistent state but the invoice's status/paid_amount/paid_at would otherwise
 * stay stuck on "paid".
 *
 * Safe to call with any entry — returns early if source_type is not a payment.
 */
export async function syncInvoiceStatusFromPaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
): Promise<void> {
  if (!isPaymentSourceType(entry.source_type) || !entry.source_id) return

  const entryId = entry.id

  if (entry.source_type.startsWith('supplier_invoice')) {
    const { data: payment } = await supabase
      .from('supplier_invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .single()

    const { data: supplierInvoice } = await supabase
      .from('supplier_invoices')
      .select('paid_amount, total_amount, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    if (supplierInvoice && payment) {
      const newPaidAmount = Math.round((supplierInvoice.paid_amount - payment.amount) * 100) / 100
      const newRemaining = Math.round((supplierInvoice.total_amount - Math.max(0, newPaidAmount)) * 100) / 100
      let newStatus: string
      if (newPaidAmount > 0) {
        newStatus = 'partially_paid'
      } else if (supplierInvoice.due_date && new Date(supplierInvoice.due_date) < new Date()) {
        newStatus = 'overdue'
      } else {
        newStatus = 'approved'
      }

      await supabase
        .from('supplier_invoices')
        .update({
          status: newStatus,
          paid_amount: Math.max(0, newPaidAmount),
          remaining_amount: newRemaining,
          paid_at: null,
          payment_journal_entry_id: null,
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
    }
  } else {
    const { data: payment } = await supabase
      .from('invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .single()

    const { data: customerInvoice } = await supabase
      .from('invoices')
      .select('paid_amount, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    if (customerInvoice) {
      const paymentAmount = payment?.amount ?? customerInvoice.paid_amount
      const newPaidAmount = Math.round((customerInvoice.paid_amount - paymentAmount) * 100) / 100
      const revertStatus = newPaidAmount > 0
        ? 'partially_paid'
        : customerInvoice.due_date && new Date(customerInvoice.due_date) < new Date()
          ? 'overdue'
          : 'sent'

      await supabase
        .from('invoices')
        .update({
          status: revertStatus,
          paid_at: null,
          paid_amount: Math.max(0, newPaidAmount),
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
        .in('status', ['paid', 'partially_paid'])
    }
  }
}
