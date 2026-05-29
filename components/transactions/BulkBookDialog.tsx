'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { Loader2, FileText, AlertTriangle, Check } from 'lucide-react'
import type { BookingTemplateLibrary, BookingTemplateLibraryLine } from '@/types'
import type { TransactionWithInvoice } from './transaction-types'

interface BulkBookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transactions: TransactionWithInvoice[]
  onSuccess: () => void
}

type Mode = 'one_line_per_tx' | 'sum_per_account'

interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | undefined
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export default function BulkBookDialog({
  open,
  onOpenChange,
  transactions,
  onSuccess,
}: BulkBookDialogProps) {
  const { toast } = useToast()
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const t = useTranslations('tx_bulk_book')

  const [templates, setTemplates] = useState<BookingTemplateLibrary[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('one_line_per_tx')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const txCount = transactions.length
  const sharedDate = transactions[0]?.date
  const sharedCurrency = transactions[0]?.currency ?? 'SEK'
  const direction: 'income' | 'expense' = useMemo(() => {
    if (transactions.length === 0) return 'income'
    return transactions[0]!.amount > 0 ? 'income' : 'expense'
  }, [transactions])
  const txSumAbs = useMemo(
    () => round2(transactions.reduce((s, tx) => s + Math.abs(tx.amount), 0)),
    [transactions],
  )

  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  )

  // Load templates when the dialog opens. RLS scopes to user's companies +
  // system templates; no company_id filter needed.
  useEffect(() => {
    if (!open || !company) return
    let cancelled = false
    async function load() {
      setLoadingTemplates(true)
      try {
        const { data } = await supabase
          .from('booking_template_library')
          .select('*')
          .eq('is_active', true)
          .order('is_system', { ascending: false })
          .order('name', { ascending: true })
        if (cancelled) return
        setTemplates((data ?? []) as BookingTemplateLibrary[])
      } finally {
        if (!cancelled) setLoadingTemplates(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [open, company, supabase])

  // Reset state when dialog closes so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setSelectedTemplateId(null)
      setMode('one_line_per_tx')
      setDescription('')
    } else if (sharedDate) {
      // Pre-fill description with a sensible default the user can edit.
      setDescription(t('default_description', { date: sharedDate }))
    }
  }, [open, sharedDate, t])

  // Live line preview — recomputes when template/mode/tx-set changes.
  const previewLines = useMemo<PreviewLine[]>(() => {
    if (!selectedTemplate) return []
    const templateLines = (selectedTemplate.lines ?? []) as BookingTemplateLibraryLine[]
    const lines: PreviewLine[] = []
    if (mode === 'sum_per_account') {
      const applied = applyTemplate(templateLines, txSumAbs)
      for (const fl of applied) {
        const debit = parseFloat(fl.debit_amount || '0') || 0
        const credit = parseFloat(fl.credit_amount || '0') || 0
        if (debit === 0 && credit === 0) continue
        lines.push({
          account_number: fl.account_number,
          debit_amount: round2(debit),
          credit_amount: round2(credit),
          line_description: fl.line_description,
        })
      }
    } else {
      for (const tx of transactions) {
        const applied = applyTemplate(templateLines, Math.abs(tx.amount))
        for (const fl of applied) {
          const debit = parseFloat(fl.debit_amount || '0') || 0
          const credit = parseFloat(fl.credit_amount || '0') || 0
          if (debit === 0 && credit === 0) continue
          const tag = (tx.description || '').slice(0, 40).trim()
          lines.push({
            account_number: fl.account_number,
            debit_amount: round2(debit),
            credit_amount: round2(credit),
            line_description: tag
              ? `${fl.line_description ?? ''} – ${tag}`.trim()
              : fl.line_description,
          })
        }
      }
    }
    return lines
  }, [selectedTemplate, mode, transactions, txSumAbs])

  const previewTotals = useMemo(() => {
    const debit = previewLines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = previewLines.reduce((s, l) => s + l.credit_amount, 0)
    return { debit: round2(debit), credit: round2(credit) }
  }, [previewLines])

  // Balance + bank-leg match are the two invariants the RPC will check; we
  // surface them here so the user knows whether confirm will succeed.
  const isBalanced = Math.abs(previewTotals.debit - previewTotals.credit) < 0.005
  const bankLineNet = previewLines
    .filter((l) => l.account_number >= '1900' && l.account_number <= '1999')
    .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0)
  const expectedBankNet = direction === 'income' ? txSumAbs : -txSumAbs
  const bankMatches = Math.abs(bankLineNet - expectedBankNet) < 0.005

  const canConfirm =
    !submitting &&
    selectedTemplate !== null &&
    description.trim().length > 0 &&
    previewLines.length >= 2 &&
    isBalanced &&
    bankMatches

  async function handleConfirm() {
    if (!canConfirm) return
    setSubmitting(true)
    try {
      const response = await fetch('/api/transactions/bulk-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_ids: transactions.map((tx) => tx.id),
          template_id: selectedTemplateId,
          mode,
          entry_description: description.trim(),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        toast({
          title: t('error_title'),
          description: getErrorMessage(body, { statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      const body = (await response.json()) as {
        data: { voucher_series: string | null; voucher_number: number | null }
      }
      const voucherLabel =
        body.data.voucher_series && body.data.voucher_number != null
          ? `${body.data.voucher_series}-${body.data.voucher_number}`
          : t('unknown_voucher')
      toast({
        title: t('success_title'),
        description: t('success_description', { count: txCount, voucher: voucherLabel }),
        variant: 'success',
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('error_title'),
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (transactions.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t('title', { count: txCount, date: sharedDate ? formatDate(sharedDate) : '' })}
          </DialogTitle>
          <DialogDescription>
            {direction === 'income' ? t('description_income') : t('description_expense')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Selection summary */}
          <div className="rounded-lg border bg-card p-3 flex items-center justify-between">
            <div className="text-sm">
              <p className="font-medium">
                {t('summary_count', { count: txCount })}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {sharedDate ? formatDate(sharedDate) : ''}
              </p>
            </div>
            <p className="font-medium tabular-nums">
              {direction === 'income' ? '+' : '−'}
              {formatCurrency(txSumAbs, sharedCurrency)}
            </p>
          </div>

          {/* Template picker */}
          <div className="space-y-2">
            <Label>{t('template_label')}</Label>
            {loadingTemplates ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-lg border border-dashed bg-muted/30 p-4 text-center text-sm text-muted-foreground">
                {t('no_templates')}
              </div>
            ) : (
              <ul className="space-y-1 max-h-[180px] overflow-y-auto">
                {templates.map((tpl) => (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedTemplateId(tpl.id)}
                      className={cn(
                        'w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-secondary/60',
                        selectedTemplateId === tpl.id
                          ? 'border-foreground'
                          : 'border-border',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-sm font-medium truncate">{tpl.name}</span>
                            {tpl.is_system && (
                              <Badge variant="outline" className="text-[10px]">
                                {t('system_badge')}
                              </Badge>
                            )}
                          </div>
                          {tpl.description && (
                            <p className="mt-1 text-xs text-muted-foreground truncate">
                              {tpl.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Mode toggle — segmented control pattern (no RadioGroup primitive
              in the design system; two outlined buttons act as a selectable
              pair) */}
          {selectedTemplate && (
            <div className="space-y-2">
              <Label>{t('mode_label')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMode('one_line_per_tx')}
                  className={cn(
                    'rounded-lg border bg-card p-3 text-left transition-colors hover:bg-secondary/60',
                    mode === 'one_line_per_tx' ? 'border-foreground' : 'border-border',
                  )}
                >
                  <p className="text-sm font-medium">{t('mode_per_tx')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('mode_per_tx_hint')}</p>
                </button>
                <button
                  type="button"
                  onClick={() => setMode('sum_per_account')}
                  className={cn(
                    'rounded-lg border bg-card p-3 text-left transition-colors hover:bg-secondary/60',
                    mode === 'sum_per_account' ? 'border-foreground' : 'border-border',
                  )}
                >
                  <p className="text-sm font-medium">{t('mode_sum')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('mode_sum_hint')}</p>
                </button>
              </div>
            </div>
          )}

          {/* Description */}
          {selectedTemplate && (
            <div className="space-y-2">
              <Label htmlFor="bulk-description">{t('description_label')}</Label>
              <Input
                id="bulk-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>
          )}

          {/* Live preview */}
          {selectedTemplate && previewLines.length > 0 && (
            <div className="space-y-2">
              <Label>
                {t('preview_label', { count: previewLines.length })}
              </Label>
              <div className="rounded-lg border bg-muted/30 overflow-hidden">
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">{t('col_account')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('col_description')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('col_debit')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('col_credit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewLines.slice(0, 30).map((line, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-b-0">
                        <td className="px-3 py-1.5 font-mono">{line.account_number}</td>
                        <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[240px]">
                          {line.line_description ?? '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {line.debit_amount > 0 ? formatCurrency(line.debit_amount) : ''}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {line.credit_amount > 0 ? formatCurrency(line.credit_amount) : ''}
                        </td>
                      </tr>
                    ))}
                    {previewLines.length > 30 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-1.5 text-center text-muted-foreground">
                          {t('preview_truncated', { remaining: previewLines.length - 30 })}
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-card font-medium">
                      <td colSpan={2} className="px-3 py-2 text-right">{t('total_label')}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(previewTotals.debit)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(previewTotals.credit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Invariant indicators */}
              <div className="space-y-1">
                {isBalanced ? (
                  <div className="flex items-center gap-2 text-xs text-success">
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('balance_ok')}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>{t('balance_off', {
                      delta: formatCurrency(Math.abs(previewTotals.debit - previewTotals.credit)),
                    })}</span>
                  </div>
                )}
                {bankMatches ? (
                  <div className="flex items-center gap-2 text-xs text-success">
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('bank_ok')}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>{t('bank_off')}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
