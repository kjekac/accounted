'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { CheckCircle2, AlertTriangle, Trash2, Plus, Pencil } from 'lucide-react'
import type { TransactionWithInvoice } from './transaction-types'
import type { BASAccount } from '@/types'

interface DuplicateCandidate {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  description: string | null
  amount: number
  bank_account_number: string
  reason: 'exact_amount_same_date' | 'exact_amount_within_window'
}

interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

interface MatchPreview {
  entry_type: 'clearing' | 'cash'
  lines: PreviewLine[]
  invoice_already_booked: boolean
  accounting_method: 'accrual' | 'cash'
  is_fully_paid: boolean
}

// String-typed working copy of a line. The amount is a single value plus a
// side (debit / credit) — modeling a verifikationsrad as one positive number
// with a direction matches how Swedish accountants think and tightens the
// failure modes (you can't accidentally fill both sides). Conversion back
// to the server's { debit_amount, credit_amount } shape happens at submit.
interface EditableLine {
  account_number: string
  side: 'debit' | 'credit'
  amount: string
  description: string
}

export interface ConfirmOpts {
  force?: boolean
  expected_journal_entry_id?: string
  lines?: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    line_description?: string
  }>
}

interface InvoiceMatchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  isConfirming: boolean
  onConfirm: (opts?: ConfirmOpts) => void
  onLinkToExisting?: (journalEntryId: string) => void
}

function previewToEditable(line: PreviewLine): EditableLine {
  const isDebit = line.debit_amount > 0
  return {
    account_number: line.account_number,
    side: isDebit ? 'debit' : 'credit',
    amount: String(isDebit ? line.debit_amount : line.credit_amount),
    description: line.description,
  }
}

function parseAmount(s: string): number {
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export default function InvoiceMatchDialog({
  open,
  onOpenChange,
  transaction,
  isConfirming,
  onConfirm,
  onLinkToExisting,
}: InvoiceMatchDialogProps) {
  const t = useTranslations('tx_invoice_match')
  const isSupplierInvoice = !!transaction?.potential_supplier_invoice
  const isCustomerInvoice = !!transaction?.potential_invoice
  const transactionId = transaction?.id ?? null

  const [candidate, setCandidate] = useState<DuplicateCandidate | null>(null)
  const [isCheckingDuplicate, setIsCheckingDuplicate] = useState(false)

  const invoiceId = transaction?.potential_invoice?.id ?? null
  const supplierInvoiceId = transaction?.potential_supplier_invoice?.id ?? null
  const [preview, setPreview] = useState<MatchPreview | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editLines, setEditLines] = useState<EditableLine[]>([])
  // BAS accounts power the AccountCombobox suggestions in edit mode. Loaded
  // once on dialog open; same endpoint that PaymentBookingDialog uses.
  const [accounts, setAccounts] = useState<BASAccount[]>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/bookkeeping/accounts')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setAccounts((data?.data as BASAccount[]) ?? [])
      } catch {
        // Non-fatal: combobox just shows no suggestions, user can still
        // type the number manually.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !transactionId) {
      setPreview(null)
      setPreviewFailed(false)
      setIsEditing(false)
      setEditLines([])
      return
    }
    let cancelled = false
    const previewUrl = isCustomerInvoice && invoiceId
      ? `/api/transactions/${transactionId}/match-invoice/preview?invoice_id=${invoiceId}`
      : isSupplierInvoice && supplierInvoiceId
        ? `/api/transactions/${transactionId}/match-supplier-invoice/preview?supplier_invoice_id=${supplierInvoiceId}`
        : null
    if (!previewUrl) {
      setPreview(null)
      setPreviewFailed(false)
      return
    }
    async function loadPreview() {
      setPreviewFailed(false)
      try {
        const res = await fetch(previewUrl!)
        if (!res.ok) {
          if (!cancelled) setPreviewFailed(true)
          return
        }
        const data = (await res.json()) as MatchPreview
        if (!cancelled) {
          setPreview(data)
          setEditLines(data.lines.map(previewToEditable))
        }
      } catch {
        if (!cancelled) setPreviewFailed(true)
      }
    }
    loadPreview()
    return () => {
      cancelled = true
    }
  }, [open, transactionId, isCustomerInvoice, isSupplierInvoice, invoiceId, supplierInvoiceId])

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

  // Live balance + validity. The dialog disables Confirm while edit mode is
  // active and the entry is invalid; an out-of-balance entry can't be sent.
  const editValidation = useMemo(() => {
    if (!isEditing) return { isBalanced: true, isValid: true, diff: 0, totalDebit: 0, totalCredit: 0, accountInvalid: false }
    const totalDebit = round2(
      editLines.filter((l) => l.side === 'debit').reduce((s, l) => s + parseAmount(l.amount), 0),
    )
    const totalCredit = round2(
      editLines.filter((l) => l.side === 'credit').reduce((s, l) => s + parseAmount(l.amount), 0),
    )
    const isBalanced = totalDebit === totalCredit && totalDebit > 0
    const accountInvalid = editLines.some((l) => !/^\d{4}$/.test(l.account_number.trim()))
    return {
      isBalanced,
      accountInvalid,
      isValid: isBalanced && !accountInvalid,
      diff: round2(totalDebit - totalCredit),
      totalDebit,
      totalCredit,
    }
  }, [isEditing, editLines])

  const handleConfirm = (opts?: { force?: boolean; expected_journal_entry_id?: string }) => {
    const linesPayload = isEditing && preview && editValidation.isValid
      ? editLines.map((l) => {
          const amount = round2(parseAmount(l.amount))
          return {
            account_number: l.account_number.trim(),
            debit_amount: l.side === 'debit' ? amount : 0,
            credit_amount: l.side === 'credit' ? amount : 0,
            line_description: l.description?.trim() || undefined,
          }
        })
      : undefined
    onConfirm({ ...(opts ?? {}), ...(linesPayload ? { lines: linesPayload } : {}) })
  }

  const resetEdits = () => {
    if (preview) setEditLines(preview.lines.map(previewToEditable))
  }

  const addEditLine = () => {
    setEditLines((prev) => [...prev, { account_number: '', side: 'debit', amount: '', description: '' }])
  }

  const removeEditLine = (i: number) => {
    setEditLines((prev) => prev.filter((_, idx) => idx !== i))
  }

  const updateEditLine = (i: number, patch: Partial<EditableLine>) => {
    setEditLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  const matchTitle = isSupplierInvoice ? t('title_supplier') : t('title_customer')
  const matchDescription = isSupplierInvoice
    ? t('description_supplier')
    : t('description_customer')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
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
                    <p className="font-medium text-warning-foreground">{t('duplicate_title')}</p>
                    <p className="text-muted-foreground">
                      {candidate.reason === 'exact_amount_same_date'
                        ? t('duplicate_body_same_date', {
                            label: candidate.voucher_label,
                            amount: formatCurrency(candidate.amount, transaction.currency),
                          })
                        : t('duplicate_body_window', {
                            label: candidate.voucher_label,
                            amount: formatCurrency(candidate.amount, transaction.currency),
                            date: formatDate(candidate.entry_date),
                          })}
                    </p>
                    {candidate.description && (
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
                      {t('link_to_existing', { label: candidate.voucher_label })}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        handleConfirm({
                          force: true,
                          expected_journal_entry_id: candidate.journal_entry_id,
                        })
                      }
                      disabled={isConfirming}
                      className="sm:flex-1"
                    >
                      {t('create_new_anyway')}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Transaction details */}
            <div className="rounded-lg border p-4 space-y-2">
              <p className="text-sm font-medium text-muted-foreground">{t('transaction_label')}</p>
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
                <p className="text-sm font-medium text-muted-foreground">{t('invoice_label')}</p>
                <p className="font-medium">
                  {t('invoice_number', { number: transaction.potential_invoice!.invoice_number ?? '' })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {transaction.potential_invoice!.customer?.name || t('unknown_customer')}
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('due_date', { date: formatDate(transaction.potential_invoice!.due_date) })}
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
                <p className="text-sm font-medium text-muted-foreground">{t('supplier_invoice_label')}</p>
                <p className="font-medium">
                  {t('invoice_number', { number: transaction.potential_supplier_invoice!.supplier_invoice_number ?? '' })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('arrival_number', { number: transaction.potential_supplier_invoice!.arrival_number ?? '' })}
                </p>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('due_date', { date: formatDate(transaction.potential_supplier_invoice!.due_date) })}
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
                    <p className="text-sm font-medium">{t('amounts_match')}</p>
                  </div>
                )
              }

              const diff = Math.abs(txAbs - invTotal)
              return (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 text-warning-foreground">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium">{t('amounts_differ')}</p>
                    <p>
                      {t('amount_diff', { amount: formatCurrency(diff, transaction.currency) })}
                      {!sameCurrency && t('different_currencies')}
                      {isSupplierInvoice && diff > 0.01 && sameCurrency && t('partial_payment_note')}
                    </p>
                  </div>
                </div>
              )
            })()}

            {/* Bookkeeping preview — editable. Read-only by default; user
                clicks "Redigera" to switch the rows to inputs. */}
            {(preview || previewFailed) && (
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{t('booking_title')}</p>
                  {preview && (
                    <div className="flex gap-2">
                      {isEditing && (
                        <Button variant="ghost" size="sm" onClick={resetEdits} disabled={isConfirming}>
                          {t('booking_reset')}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsEditing((v) => !v)}
                        disabled={isConfirming}
                      >
                        {isEditing ? t('booking_done_editing') : (
                          <>
                            <Pencil className="h-3 w-3 mr-1" />
                            {t('booking_edit')}
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </div>

                {previewFailed && !preview && (
                  <p className="text-sm text-muted-foreground">{t('booking_unavailable')}</p>
                )}

                {preview && !isEditing && (
                  <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t('booking_account')}
                    </div>
                    <div />
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground text-right">
                      {t('booking_debit')}
                    </div>
                    <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground text-right">
                      {t('booking_credit')}
                    </div>
                    {preview.lines.map((line, i) => (
                      <div key={i} className="contents">
                        <div className="font-medium">{line.account_number}</div>
                        <div className="text-muted-foreground truncate">{line.description}</div>
                        <div className="text-right">
                          {line.debit_amount > 0
                            ? formatCurrency(line.debit_amount, transaction.currency)
                            : ''}
                        </div>
                        <div className="text-right">
                          {line.credit_amount > 0
                            ? formatCurrency(line.credit_amount, transaction.currency)
                            : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {preview && isEditing && (
                  <div className="space-y-2">
                    {editLines.map((line, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-[minmax(180px,1.6fr)_minmax(0,1fr)_140px_110px_28px] gap-2 items-center"
                      >
                        <AccountCombobox
                          value={line.account_number}
                          accounts={accounts}
                          onChange={(acc) => updateEditLine(i, { account_number: acc })}
                        />
                        <Input
                          value={line.description}
                          onChange={(e) => updateEditLine(i, { description: e.target.value })}
                          placeholder={t('booking_description_placeholder')}
                        />
                        {/* Side toggle — segmented control. Clicking either
                            button picks that side; the amount stays the
                            same. */}
                        <div className="inline-flex rounded-md border bg-background overflow-hidden h-9">
                          <button
                            type="button"
                            onClick={() => updateEditLine(i, { side: 'debit' })}
                            className={cn(
                              'flex-1 px-2 text-xs font-medium transition-colors',
                              line.side === 'debit'
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground hover:bg-secondary/60',
                            )}
                            aria-pressed={line.side === 'debit'}
                          >
                            {t('booking_debit')}
                          </button>
                          <button
                            type="button"
                            onClick={() => updateEditLine(i, { side: 'credit' })}
                            className={cn(
                              'flex-1 px-2 text-xs font-medium border-l transition-colors',
                              line.side === 'credit'
                                ? 'bg-secondary text-foreground'
                                : 'text-muted-foreground hover:bg-secondary/60',
                            )}
                            aria-pressed={line.side === 'credit'}
                          >
                            {t('booking_credit')}
                          </button>
                        </div>
                        <Input
                          inputMode="decimal"
                          value={line.amount}
                          onChange={(e) => updateEditLine(i, { amount: e.target.value })}
                          className="text-right tabular-nums"
                          placeholder="0"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeEditLine(i)}
                          disabled={editLines.length <= 2}
                          aria-label={t('booking_remove_line')}
                          className="h-8 w-8"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}

                    <div className="flex items-center justify-between pt-1">
                      <Button variant="ghost" size="sm" onClick={addEditLine}>
                        <Plus className="h-3 w-3 mr-1" />
                        {t('booking_add_line')}
                      </Button>
                      <div className="text-xs tabular-nums text-muted-foreground">
                        {t('booking_debit')} {formatCurrency(editValidation.totalDebit, transaction.currency)}
                        {' / '}
                        {t('booking_credit')} {formatCurrency(editValidation.totalCredit, transaction.currency)}
                      </div>
                    </div>

                    {!editValidation.isBalanced && (
                      <p className="text-xs text-destructive">
                        {t('booking_unbalanced', {
                          diff: formatCurrency(Math.abs(editValidation.diff), transaction.currency),
                        })}
                      </p>
                    )}
                    {editValidation.accountInvalid && (
                      <p className="text-xs text-destructive">{t('booking_account_invalid')}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* What will happen */}
            <div className="rounded-lg bg-muted/50 p-4 space-y-2">
              <p className="text-sm font-medium">{t('on_confirm_title')}</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• {isSupplierInvoice ? t('on_confirm_link_supplier') : t('on_confirm_link_customer')}</li>
                <li>• {isSupplierInvoice ? t('on_confirm_mark_paid_supplier') : t('on_confirm_mark_paid_customer')}</li>
                <li>• {t('on_confirm_voucher')}</li>
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isConfirming}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => handleConfirm()}
            disabled={isConfirming || isCheckingDuplicate || (isEditing && !editValidation.isValid)}
          >
            {isConfirming ? t('confirming') : t('confirm_match')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
