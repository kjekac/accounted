'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import type { TransactionWithInvoice } from './transaction-types'

interface DuplicateCandidate {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  description: string | null
  amount: number
  bank_account_number: string
  reason: 'exact_amount_same_date' | 'exact_amount_within_window'
}

interface InvoiceMatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  isConfirming: boolean
  onConfirm: (opts?: { force?: boolean; expected_journal_entry_id?: string }) => void
  onLinkToExisting?: (journalEntryId: string) => void
}

export default function InvoiceMatchDialog({
  open,
  onOpenChange,
  transaction,
  isConfirming,
  onConfirm,
  onLinkToExisting,
}: InvoiceMatchDialogProps) {
  const isSupplierInvoice = !!transaction?.potential_supplier_invoice
  const isCustomerInvoice = !!transaction?.potential_invoice
  const transactionId = transaction?.id ?? null

  // Customer-side only: pre-flight check for a manual verifikation that
  // already books this receipt. Supplier-side duplicate-payment surfacing
  // is handled by the mark-paid guard on the supplier-invoice side; here
  // we only need the customer flow for the reported issue.
  const [candidate, setCandidate] = useState<DuplicateCandidate | null>(null)
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false)

  useEffect(() => {
    if (!open || !transactionId || !isCustomerInvoice || !onLinkToExisting) {
      setCandidate(null)
      return
    }
    let cancelled = false
    async function check() {
      setIsCheckingDuplicate(true)
      try {
        const res = await fetch(`/api/transactions/${transactionId}/duplicate-payment-check`)
        if (!res.ok) return
        const data = (await res.json()) as { candidate: DuplicateCandidate | null }
        if (!cancelled) setCandidate(data.candidate ?? null)
      } catch {
        // Fail-open: hide the warning panel; the server still enforces the guard.
      } finally {
        if (!cancelled) setIsCheckingDuplicate(false)
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [open, transactionId, isCustomerInvoice, onLinkToExisting])

  // The invoice candidate the dialog is about, normalized to a single shape.
  // Supplier invoices show the negative-amount paid-out match; customer
  // invoices show the positive-amount paid-in match. Each side carries its
  // own follow-up action language.
  const matchTitle = isSupplierInvoice ? 'Bekräfta leverantörsfakturamatchning' : 'Bekräfta fakturamatchning'
  const matchDescription = isSupplierInvoice
    ? 'Vill du koppla denna transaktion till leverantörsfakturan? Fakturan kommer att markeras som betald och en betalningsverifikation skapas.'
    : 'Vill du koppla denna transaktion till fakturan? Fakturan kommer att markeras som betald.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{matchTitle}</DialogTitle>
          <DialogDescription>{matchDescription}</DialogDescription>
        </DialogHeader>

        {transaction && (isCustomerInvoice || isSupplierInvoice) && (
          <div className="space-y-4">
            {/* Duplicate-payment warning — customer-side only, only when a candidate exists */}
            {candidate && isCustomerInvoice && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-warning-foreground" />
                  <div className="text-sm space-y-1">
                    <p className="font-medium text-warning-foreground">Möjlig dubblettbokning</p>
                    <p className="text-muted-foreground">
                      Det finns redan en bokförd verifikation <span className="font-mono">{candidate.voucher_label}</span> på samma belopp ({formatCurrency(candidate.amount, transaction.currency)}) {candidate.reason === 'exact_amount_same_date' ? 'på samma datum' : `inom ±7 dagar (${formatDate(candidate.entry_date)})`}.
                      Har du redan bokfört denna betalning manuellt?
                    </p>
                    {candidate.description && (
                      // Truncate to a short head before render. The
                      // description is free-text and may carry a customer
                      // name or note that's not strictly required to
                      // identify the verifikation (voucher_label + amount +
                      // date already do that). Cap length to keep the
                      // dialog tight and limit incidental PII surfacing
                      // in the rendered DOM. GDPR Art.5(1)(c).
                      <p className="text-xs text-muted-foreground truncate">
                        {candidate.description.length > 80
                          ? `${candidate.description.slice(0, 80).trimEnd()}…`
                          : candidate.description}
                      </p>
                    )}
                  </div>
                </div>
                {onLinkToExisting && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => onLinkToExisting(candidate.journal_entry_id)}
                      disabled={isConfirming}
                      className="sm:flex-1"
                    >
                      Koppla till {candidate.voucher_label}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onConfirm({
                          force: true,
                          // Echo the candidate the user reviewed back to
                          // the server so the bypass is bound to this
                          // specific duplicate. See match-invoice route.
                          expected_journal_entry_id: candidate.journal_entry_id,
                        })
                      }
                      disabled={isConfirming}
                      className="sm:flex-1"
                    >
                      Skapa ny verifikation ändå
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Transaction details */}
            <div className="rounded-lg border p-4 space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Transaktion</p>
              <p className="font-medium">{transaction.description}</p>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{formatDate(transaction.date)}</span>
                <span className={`font-medium ${transaction.amount > 0 ? 'text-success' : ''}`}>
                  {transaction.amount > 0 ? '+' : ''}
                  {formatCurrency(transaction.amount, transaction.currency)}
                </span>
              </div>
            </div>

            {/* Invoice details */}
            {isCustomerInvoice && (
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Faktura</p>
                <p className="font-medium">
                  Faktura {transaction.potential_invoice!.invoice_number}
                </p>
                <p className="text-sm text-muted-foreground">
                  {transaction.potential_invoice!.customer?.name || 'Okänd kund'}
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Förfaller: {formatDate(transaction.potential_invoice!.due_date)}
                  </span>
                  <span className="font-medium">
                    {formatCurrency(
                      transaction.potential_invoice!.total,
                      transaction.potential_invoice!.currency,
                    )}
                  </span>
                </div>
              </div>
            )}

            {isSupplierInvoice && (
              <div className="rounded-lg border p-4 space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Leverantörsfaktura</p>
                <p className="font-medium">
                  Faktura {transaction.potential_supplier_invoice!.supplier_invoice_number}
                </p>
                <p className="text-sm text-muted-foreground">
                  Ankomstnr: {transaction.potential_supplier_invoice!.arrival_number}
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    Förfaller: {formatDate(transaction.potential_supplier_invoice!.due_date)}
                  </span>
                  <span className="font-medium">
                    {formatCurrency(
                      transaction.potential_supplier_invoice!.total,
                      transaction.potential_supplier_invoice!.currency,
                    )}
                  </span>
                </div>
              </div>
            )}

            {/* Amount comparison */}
            {(() => {
              const txAbs = Math.abs(transaction.amount)
              const invTotal = isSupplierInvoice
                ? transaction.potential_supplier_invoice!.remaining_amount ?? transaction.potential_supplier_invoice!.total
                : transaction.potential_invoice!.total
              const invCurrency = isSupplierInvoice
                ? transaction.potential_supplier_invoice!.currency
                : transaction.potential_invoice!.currency
              const sameCurrency = transaction.currency === invCurrency
              const amountsMatch = sameCurrency && Math.abs(txAbs - invTotal) < 0.01

              if (amountsMatch) {
                return (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 text-success">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                    <p className="text-sm font-medium">Beloppen stämmer</p>
                  </div>
                )
              }

              const diff = Math.abs(txAbs - invTotal)
              return (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 text-warning-foreground">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium">Beloppen skiljer sig</p>
                    <p>
                      Differens: {formatCurrency(diff, transaction.currency)}
                      {!sameCurrency && ' (olika valutor)'}
                      {isSupplierInvoice && diff > 0.01 && sameCurrency && ' — fakturan blir delbetald.'}
                    </p>
                  </div>
                </div>
              )
            })()}

            {/* What will happen */}
            <div className="rounded-lg bg-muted/50 p-4 space-y-2">
              <p className="text-sm font-medium">Vid bekräftelse:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Transaktionen kopplas till {isSupplierInvoice ? 'leverantörsfakturan' : 'fakturan'}</li>
                <li>• {isSupplierInvoice ? 'Leverantörsfakturan markeras som betald' : 'Fakturan markeras som betald'}</li>
                <li>• Bokföringsverifikation skapas automatiskt</li>
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isConfirming}>
            Avbryt
          </Button>
          <Button onClick={() => onConfirm()} disabled={isConfirming || isCheckingDuplicate}>
            {isConfirming ? 'Bekräftar...' : 'Bekräfta matchning'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
