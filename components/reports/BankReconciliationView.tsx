'use client'

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { AccountNumber } from '@/components/ui/account-number'
import { AlertCircle, ChevronDown, ChevronRight, Link2, Unlink, Play, Eye, EyeOff, PiggyBank, MoreHorizontal, Search, X } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { CashAccountSelector } from '@/components/common/CashAccountSelector'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import type { CashAccount } from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const METHOD_LABELS: Record<string, string> = {
  auto_exact: 'Exakt matchning',
  auto_date_range: 'Datumintervall',
  auto_reference: 'Referensmatchning',
  auto_fuzzy: 'Ungefärlig matchning',
  manual: 'Manuell',
}

// ============================================================
// Types
// ============================================================

interface ReconciliationStatus {
  bank_transaction_total: number
  /**
   * @deprecated Kept on the server response for back-compat. The UI no longer
   * reads it — `gl_1930_period_movement` is required.
   */
  gl_1930_balance: number
  gl_1930_period_movement: number
  gl_1930_opening_balance: number
  difference: number
  is_reconciled: boolean
  matched_count: number
  unmatched_transaction_count: number
  unmatched_gl_line_count: number
}

interface UnlinkedGLLine {
  line_id: string
  journal_entry_id: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  entry_date: string
  voucher_number: number
  voucher_series: string
  entry_description: string
  source_type: string
}

interface UnmatchedTransaction {
  id: string
  date: string
  description: string
  amount: number
  reference: string | null
  currency: string
  is_ignored?: boolean
}

interface MatchedTransaction {
  id: string
  date: string
  description: string
  amount: number
  reconciliation_method: string | null
  journal_entry_id: string | null
}

interface DryRunMatch {
  transaction_id: string
  transaction_date: string
  transaction_description: string
  transaction_amount: number
  journal_entry_id: string
  voucher_number: number
  voucher_series: string
  entry_date: string
  entry_description: string
  method: string
  confidence: number
}

// ============================================================
// Searchable verifikation picker
// ============================================================

/**
 * Inline combobox for choosing a journal entry to match a bank transaction
 * against. The native <select> couldn't be searched, and the unmatched-GL list
 * routinely runs to hundreds of rows (historical SIE imports), so the old UX
 * forced users to scroll a giant unsorted dropdown. This picker filters by
 * voucher number, date, amount or description as the user types, and renders
 * the selected verifikation as a removable chip.
 */
interface MatchPickerProps {
  glLines: UnlinkedGLLine[]
  value: string
  onChange: (journalEntryId: string) => void
  disabled?: boolean
  placeholder?: string
}

function MatchVerifikationPicker({
  glLines,
  value,
  onChange,
  disabled,
  placeholder = 'Sök ver.nr, datum, belopp eller beskrivning…',
}: MatchPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const selected = glLines.find((l) => l.journal_entry_id === value) || null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q.length === 0
      ? glLines
      : glLines.filter((line) => {
          const amt = (line.debit_amount > 0 ? line.debit_amount : line.credit_amount).toString()
          return (
            formatVoucher(line).toLowerCase().includes(q) ||
            line.entry_date.toLowerCase().includes(q) ||
            amt.includes(q) ||
            (line.entry_description || '').toLowerCase().includes(q) ||
            (line.line_description || '').toLowerCase().includes(q)
          )
        })
    return base.slice(0, 25)
  }, [search, glLines])

  if (selected) {
    const amount = selected.debit_amount > 0 ? selected.debit_amount : -selected.credit_amount
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
        <span className="font-mono text-xs shrink-0">{formatVoucher(selected)}</span>
        <span className="text-muted-foreground shrink-0 tabular-nums">{formatDate(selected.entry_date)}</span>
        <span className="font-mono tabular-nums shrink-0">{formatCurrency(amount)}</span>
        <span className="truncate text-muted-foreground">{selected.entry_description}</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="ml-auto h-6 w-6 shrink-0"
          onClick={() => onChange('')}
          disabled={disabled}
          aria-label="Avmarkera verifikation"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="pl-9"
        />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-[var(--shadow-md)]">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">
              Inga verifikationer matchar &quot;{search}&quot;
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {filtered.map((line) => {
                const amount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
                return (
                  <button
                    key={line.line_id}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/60 focus:bg-secondary/60 focus:outline-none"
                    onMouseDown={(e) => {
                      // mousedown beats blur — without this the popover closes
                      // before the click registers when the user has tabbed
                      // through and uses keyboard.
                      e.preventDefault()
                    }}
                    onClick={() => {
                      onChange(line.journal_entry_id)
                      setSearch('')
                      setOpen(false)
                    }}
                  >
                    <span className="font-mono text-xs shrink-0 w-12">{formatVoucher(line)}</span>
                    <span className="text-muted-foreground shrink-0 tabular-nums w-24">{formatDate(line.entry_date)}</span>
                    <span className="font-mono tabular-nums shrink-0 w-24 text-right">{formatCurrency(amount)}</span>
                    <span className="truncate text-muted-foreground flex-1">
                      {line.line_description || line.entry_description}
                    </span>
                  </button>
                )
              })}
              {glLines.length > filtered.length && (
                <div className="px-3 py-2 text-[11px] text-muted-foreground border-t border-border bg-secondary/30">
                  Visar {filtered.length} av {glLines.length} — sök för att filtrera fler.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// Component
// ============================================================

export function BankReconciliationView() {
  const [status, setStatus] = useState<ReconciliationStatus | null>(null)
  const [unmatchedTx, setUnmatchedTx] = useState<UnmatchedTransaction[]>([])
  const [glLines, setGlLines] = useState<UnlinkedGLLine[]>([])
  const [matchedTx, setMatchedTx] = useState<MatchedTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [accountNumber, setAccountNumber] = useState('1930')
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([])

  const [dryRunResults, setDryRunResults] = useState<DryRunMatch[] | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [applyLoading, setApplyLoading] = useState(false)
  const [linkLoading, setLinkLoading] = useState<string | null>(null)
  const [unlinkLoading, setUnlinkLoading] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const [showMatched, setShowMatched] = useState(false)
  // Default expanded so users discover the undo path. The card itself only
  // renders when ignoredTx.length > 0 — collapsing it by default hid the
  // recovery affordance from anyone who didn't already know it was there.
  const [showIgnored, setShowIgnored] = useState(true)
  const [ignoredTx, setIgnoredTx] = useState<UnmatchedTransaction[]>([])
  const [selectedMatch, setSelectedMatch] = useState<Record<string, string>>({})

  const { dialogProps: confirmDialogProps, confirm } = useDestructiveConfirm()
  const { toast } = useToast()

  // Derive the currency for the selected ledger account from cash_accounts.
  // Without this the lists below would hardcode SEK and silently return zero
  // rows for users on 1932 EUR (or any other non-SEK cash account).
  const accountCurrency =
    cashAccounts.find((a) => a.ledger_account === accountNumber)?.currency ?? 'SEK'

  useEffect(() => {
    let cancelled = false
    fetch('/api/cash-accounts')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && Array.isArray(j.data)) setCashAccounts(j.data as CashAccount[])
      })
      .catch(() => {
        // Non-critical — falls back to 'SEK' currency, matches old behaviour.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      params.set('account_number', accountNumber)
      const qs = `?${params}`

      const txParams = new URLSearchParams()
      txParams.set('currency', accountCurrency)
      txParams.set('account_number', accountNumber)
      if (dateFrom) txParams.set('date_from', dateFrom)
      if (dateTo) txParams.set('date_to', dateTo)
      const unmatchedQs = `?unmatched=true&${txParams}`
      const reconciledQs = `?reconciled=true&${txParams}`

      const [statusRes, glRes, unmatchedRes, matchedRes] = await Promise.all([
        fetch(`/api/reconciliation/bank/status${qs}`),
        fetch(`/api/reconciliation/bank/unmatched-entries${qs}`),
        fetch(`/api/transactions${unmatchedQs}`),
        fetch(`/api/transactions${reconciledQs}`),
      ])

      const [statusData, glData, unmatchedData, matchedData] = await Promise.all([
        statusRes.json(),
        glRes.json(),
        unmatchedRes.json(),
        matchedRes.json(),
      ])

      if (statusData.data) setStatus(statusData.data)
      setGlLines(glData.data || [])
      setUnmatchedTx(unmatchedData.data || [])
      setMatchedTx(matchedData.data || [])

      // Refresh the ignored list whenever the main lists refresh.
      // Deliberately NOT filtered by account or currency — if a user ignored
      // a row on 1932 EUR and then switched to 1930 SEK, the recovery card
      // would disappear and the row would feel "stuck". Company-wide scope
      // keeps the Återställ path reachable from any account selection. The
      // date filter is also dropped so old ignores stay visible.
      try {
        const ignoredRes = await fetch(`/api/transactions?unmatched=true&only_ignored=true`)
        const ignoredData = await ignoredRes.json()
        setIgnoredTx(ignoredData.data || [])
      } catch {
        setIgnoredTx([])
      }
    } catch (e) {
      console.error('[reconciliation] fetchAll failed', e)
      setError('Kunde inte hämta avstämningsdata')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, accountNumber, accountCurrency])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const handleDryRun = async () => {
    setRunLoading(true)
    setDryRunResults(null)
    try {
      const res = await fetch('/api/reconciliation/bank/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          account_number: accountNumber,
          dry_run: true,
        }),
      })
      const result = await res.json()
      if (result.data?.matches) {
        setDryRunResults(result.data.matches)
      }
    } catch {
      setError('Kunde inte köra förhandsgranskning')
    } finally {
      setRunLoading(false)
    }
  }

  const handleApply = async () => {
    setApplyLoading(true)
    try {
      await fetch('/api/reconciliation/bank/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          account_number: accountNumber,
          dry_run: false,
        }),
      })
      setDryRunResults(null)
      await fetchAll()
    } catch {
      setError('Kunde inte tillämpa matchningar')
    } finally {
      setApplyLoading(false)
    }
  }

  const handleManualLink = async (transactionId: string) => {
    const journalEntryId = selectedMatch[transactionId]
    if (!journalEntryId) return

    setLinkLoading(transactionId)
    try {
      const res = await fetch('/api/reconciliation/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transactionId,
          journal_entry_id: journalEntryId,
        }),
      })
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        setSelectedMatch((prev) => {
          const next = { ...prev }
          delete next[transactionId]
          return next
        })
        await fetchAll()
      }
    } catch {
      setError('Kunde inte matcha transaktion')
    } finally {
      setLinkLoading(null)
    }
  }

  const handleUnlink = async (transactionId: string) => {
    setUnlinkLoading(transactionId)
    try {
      const res = await fetch('/api/reconciliation/bank/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId }),
      })
      const result = await res.json()
      if (result.error) {
        setError(result.error)
      } else {
        await fetchAll()
      }
    } catch {
      setError('Kunde inte avmatcha transaktion')
    } finally {
      setUnlinkLoading(null)
    }
  }

  /**
   * Inline shortcut for the most common "stuck on the unmatched list" cause:
   * a small ränteintäkt that has no upstream voucher to match against. Calls
   * the standard categorize endpoint with the existing bank_interest_income
   * template so the resulting verifikation is identical to the /transactions
   * flow — no parallel booking path.
   */
  const handleBookInterestIncome = async (transactionId: string) => {
    setActionLoading(transactionId)
    try {
      const res = await fetch(`/api/transactions/${transactionId}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: true,
          template_id: 'bank_interest_income',
          confirm_no_match: true,
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        setError(result.error?.message || result.error || 'Kunde inte bokföra ränteintäkten')
        return
      }
      if (result.journal_entry_error) {
        setError(result.journal_entry_error)
        return
      }
      await fetchAll()
    } catch {
      setError('Kunde inte bokföra ränteintäkten')
    } finally {
      setActionLoading(null)
    }
  }

  const handleIgnore = async (tx: UnmatchedTransaction) => {
    // Even though Ignorera is fully reversible, it's still a state change the
    // user could miss after a misclick — the row vanishes from the unmatched
    // list immediately. Confirmation before the write + an explicit Ångra
    // toast on success gives two recovery affordances. The persistent
    // "Ignorerade transaktioner" card is the third.
    const ok = await confirm({
      title: 'Ignorera transaktionen?',
      description: `${tx.description} — ${formatCurrency(tx.amount)} (${formatDate(tx.date)}) försvinner från avstämningen utan att bokföras. Du kan återställa den från "Ignorerade transaktioner" nedan när som helst.`,
      confirmLabel: 'Ignorera',
      cancelLabel: 'Avbryt',
      variant: 'warning',
    })
    if (!ok) return

    setActionLoading(tx.id)
    try {
      const res = await fetch(`/api/transactions/${tx.id}/ignore`, {
        method: 'POST',
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        setError(result.error || 'Kunde inte ignorera transaktionen')
        return
      }
      await fetchAll()
      toast({
        title: 'Transaktionen ignorerad',
        description: `${tx.description} — ${formatCurrency(tx.amount)}`,
        action: (
          <ToastAction
            altText="Ångra ignorera"
            onClick={() => handleUnignore(tx.id)}
          >
            Ångra
          </ToastAction>
        ),
      })
    } catch {
      setError('Kunde inte ignorera transaktionen')
    } finally {
      setActionLoading(null)
    }
  }

  const handleUnignore = async (transactionId: string) => {
    setActionLoading(transactionId)
    try {
      const res = await fetch(`/api/transactions/${transactionId}/ignore`, {
        method: 'DELETE',
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        setError(result.error || 'Kunde inte återställa transaktionen')
        return
      }
      await fetchAll()
    } catch {
      setError('Kunde inte återställa transaktionen')
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Laddar bankavstämning...
        </CardContent>
      </Card>
    )
  }

  if (error && !status) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card>
          <CardContent className="py-3 text-center text-destructive text-sm">
            <AlertCircle className="h-4 w-4 inline mr-1" />
            {error}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => setError(null)}>
              Stäng
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Status Card */}
      {status && (
        <Card className="border-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Avstämning mot <AccountNumber number={accountNumber} /></CardTitle>
              {status.is_reconciled ? (
                <Badge className="bg-success/10 text-success">Avstämd</Badge>
              ) : (
                <Badge variant="destructive">Ej avstämd</Badge>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Avstämningen körs mot <AccountNumber number={accountNumber} /> ({accountCurrency}). Övriga bankkonton (t.ex. Plusgiro <AccountNumber number="1920" />, kreditkort <AccountNumber number="1940" /> eller valutakonton) stäms av separat — välj kontot i listan nedan.
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Banktransaktioner i perioden</span>
                <span className="font-mono">{formatCurrency(status.bank_transaction_total)}</span>
              </div>
              <div className="flex justify-between">
                <span>Bokfört på <AccountNumber number={accountNumber} /> i perioden</span>
                <span className="font-mono">
                  {formatCurrency(status.gl_1930_period_movement)}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span>
                  {formatCurrency(status.difference)}
                </span>
              </div>
              {status.gl_1930_opening_balance !== 0 && (
                <p className="pt-2 text-xs text-muted-foreground">
                  Ingående balans (IB) på <AccountNumber number={accountNumber} />:{' '}
                  <span className="font-mono">{formatCurrency(status.gl_1930_opening_balance)}</span>
                  {' '}— räknas inte i avstämningen.
                </p>
              )}
              <div className="flex gap-4 pt-2 text-xs text-muted-foreground">
                <span>Matchade: {status.matched_count}</span>
                <span>Omatchade transaktioner: {status.unmatched_transaction_count}</span>
                <span>Omatchade verifikationer: {status.unmatched_gl_line_count}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action Bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <CashAccountSelector
              value={accountNumber}
              onChange={setAccountNumber}
            />
            <div>
              <Label>Datum från</Label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label>Datum till</Label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <Button onClick={fetchAll} variant="outline">
              Filtrera
            </Button>
            <div className="flex-1" />
            <Button onClick={handleDryRun} disabled={runLoading} variant="outline">
              <Eye className="h-4 w-4 mr-2" />
              {runLoading ? 'Analyserar...' : 'Förhandsgranska'}
            </Button>
            {dryRunResults && dryRunResults.length > 0 && (
              <Button onClick={handleApply} disabled={applyLoading}>
                <Play className="h-4 w-4 mr-2" />
                {applyLoading ? 'Tillämpar...' : `Tillämpa ${dryRunResults.length} matchningar`}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Dry Run Preview */}
      {dryRunResults && dryRunResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Förhandsgranskning — {dryRunResults.length} matchningar hittade
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2">Transaktion</th>
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2 w-28 text-right">Belopp</th>
                  <th className="py-2 w-8 text-center">&harr;</th>
                  <th className="py-2">Verifikation</th>
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2 w-28">Metod</th>
                </tr>
              </thead>
              <tbody>
                {dryRunResults.map((m) => (
                  <tr key={m.transaction_id} className="border-b last:border-0">
                    <td className="py-2 truncate max-w-[180px]">{m.transaction_description}</td>
                    <td className="py-2 tabular-nums">{formatDate(m.transaction_date)}</td>
                    <td className="py-2 text-right font-mono">{formatAmount(m.transaction_amount)}</td>
                    <td className="py-2 text-center text-muted-foreground">&harr;</td>
                    <td className="py-2">
                      <span className="font-mono text-xs">{formatVoucher(m)}</span>
                      <span className="ml-2 text-muted-foreground truncate">{m.entry_description}</span>
                    </td>
                    <td className="py-2 tabular-nums">{formatDate(m.entry_date)}</td>
                    <td className="py-2">
                      <Badge variant="outline" className="text-xs">
                        {METHOD_LABELS[m.method] || m.method}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {dryRunResults && dryRunResults.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            Inga automatiska matchningar hittades.
          </CardContent>
        </Card>
      )}

      {/* Unmatched Transactions */}
      {unmatchedTx.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Omatchade transaktioner ({unmatchedTx.length})
            </h2>
            {glLines.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {glLines.length} verifikation{glLines.length === 1 ? '' : 'er'} att matcha mot
              </p>
            )}
          </div>
          <div className="space-y-3">
            {unmatchedTx.map((tx) => {
              // Piggy-bank shortcut hardcodes the 1930↔8310 ränteintäkt template,
              // so only offer it on a SEK account using 1930. On EUR (1932) or
              // other settlement accounts the booking would post the EUR amount
              // to the SEK cash account — silently wrong, hide it.
              const canBookInterest = tx.amount > 0 && accountNumber === '1930'
              const isPositive = tx.amount > 0
              return (
                <div
                  key={tx.id}
                  className="rounded-lg border border-border bg-card p-4 space-y-4"
                >
                  {/* Header row: meta + description + amount + menu */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
                        <span>{formatDate(tx.date)}</span>
                        <span aria-hidden>·</span>
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                          {tx.currency}
                        </Badge>
                        {tx.reference && (
                          <>
                            <span aria-hidden>·</span>
                            <span>Ref: {tx.reference}</span>
                          </>
                        )}
                      </div>
                      <div className="mt-1.5 text-sm font-medium truncate">{tx.description}</div>
                    </div>
                    <div className="flex items-start gap-2 shrink-0">
                      <div
                        className={`font-display text-xl tabular-nums ${
                          isPositive ? 'text-success' : ''
                        }`}
                      >
                        {isPositive ? '+' : ''}
                        {formatCurrency(tx.amount)}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            aria-label="Fler åtgärder"
                            disabled={actionLoading === tx.id}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-72">
                          {canBookInterest && (
                            <DropdownMenuItem
                              onClick={() => handleBookInterestIncome(tx.id)}
                              disabled={actionLoading === tx.id}
                            >
                              <PiggyBank className="h-4 w-4" />
                              <div className="flex flex-col">
                                <span>Bokför som ränteintäkt</span>
                                <span className="text-xs text-muted-foreground">
                                  1930 mot 8310, ingen moms
                                </span>
                              </div>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => handleIgnore(tx)}
                            disabled={actionLoading === tx.id}
                          >
                            <EyeOff className="h-4 w-4" />
                            <div className="flex flex-col">
                              <span>Ignorera transaktion…</span>
                              <span className="text-xs text-muted-foreground">
                                Dölj utan att bokföra. Går att återställa.
                              </span>
                            </div>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Match action row */}
                  <div className="pt-3 border-t border-border space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        Matcha mot verifikation
                      </Label>
                      {glLines.length === 0 && (
                        <span className="text-[11px] text-muted-foreground">
                          Inga omatchade verifikationer på <AccountNumber number={accountNumber} />
                        </span>
                      )}
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <MatchVerifikationPicker
                          glLines={glLines}
                          value={selectedMatch[tx.id] || ''}
                          onChange={(v) =>
                            setSelectedMatch((prev) => ({ ...prev, [tx.id]: v }))
                          }
                          disabled={linkLoading === tx.id || glLines.length === 0}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!selectedMatch[tx.id] || linkLoading === tx.id}
                        onClick={() => handleManualLink(tx.id)}
                        className="shrink-0 h-10"
                      >
                        <Link2 className="h-3.5 w-3.5 mr-1.5" />
                        {linkLoading === tx.id ? 'Matchar…' : 'Matcha'}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Unmatched GL Lines */}
      {glLines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Omatchade verifikationer på <AccountNumber number={accountNumber} /> ({glLines.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-16">Ver.nr</th>
                  <th className="py-2 w-24">Datum</th>
                  <th className="py-2">Beskrivning</th>
                  <th className="py-2 w-28 text-right">Belopp</th>
                  <th className="py-2 w-24">Typ</th>
                </tr>
              </thead>
              <tbody>
                {glLines.map((line) => {
                  const amount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
                  return (
                    <tr key={line.line_id} className="border-b last:border-0">
                      <td className="py-2 font-mono text-xs">
                        {formatVoucher(line)}
                      </td>
                      <td className="py-2 tabular-nums">{formatDate(line.entry_date)}</td>
                      <td className="py-2 truncate max-w-[300px]">
                        {line.line_description || line.entry_description}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {formatCurrency(amount)}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">{line.source_type}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Ignored transactions (undo) */}
      {ignoredTx.length > 0 && (
        <Card>
          <CardHeader
            className="cursor-pointer"
            onClick={() => setShowIgnored(!showIgnored)}
          >
            <div className="flex items-center gap-2">
              {showIgnored ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <CardTitle className="text-lg">
                Ignorerade transaktioner ({ignoredTx.length})
              </CardTitle>
            </div>
          </CardHeader>
          {showIgnored && (
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Rader du valt att dölja från avstämningen. De påverkar inte saldot på <AccountNumber number={accountNumber} /> — de är bara gömda från listan.
              </p>
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-2 w-24">Datum</th>
                    <th className="py-2">Beskrivning</th>
                    <th className="py-2 w-20">Valuta</th>
                    <th className="py-2 w-28 text-right">Belopp</th>
                    <th className="py-2 w-28"></th>
                  </tr>
                </thead>
                <tbody>
                  {ignoredTx.map((tx) => (
                    <tr key={tx.id} className="border-b last:border-0 text-muted-foreground">
                      <td className="py-2">{tx.date}</td>
                      <td className="py-2 truncate max-w-[300px]">{tx.description}</td>
                      <td className="py-2 text-xs">
                        <Badge variant="outline" className="text-xs">{tx.currency}</Badge>
                      </td>
                      <td className="py-2 text-right font-mono">
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className="py-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actionLoading === tx.id}
                          onClick={() => handleUnignore(tx.id)}
                        >
                          {actionLoading === tx.id ? '...' : 'Återställ'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          )}
        </Card>
      )}

      {/* Recently Matched */}
      {matchedTx.length > 0 && (
        <Card>
          <CardHeader
            className="cursor-pointer"
            onClick={() => setShowMatched(!showMatched)}
          >
            <div className="flex items-center gap-2">
              {showMatched ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <CardTitle className="text-lg">
                Matchade transaktioner ({matchedTx.length})
              </CardTitle>
            </div>
          </CardHeader>
          {showMatched && (
            <CardContent>
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-2 w-24">Datum</th>
                    <th className="py-2">Beskrivning</th>
                    <th className="py-2 w-28 text-right">Belopp</th>
                    <th className="py-2 w-32">Metod</th>
                    <th className="py-2 w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {matchedTx.map((tx) => (
                    <tr key={tx.id} className="border-b last:border-0">
                      <td className="py-2">{tx.date}</td>
                      <td className="py-2 truncate max-w-[300px]">{tx.description}</td>
                      <td className="py-2 text-right font-mono">
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className="py-2">
                        {tx.reconciliation_method && (
                          <Badge variant="outline" className="text-xs">
                            {METHOD_LABELS[tx.reconciliation_method] || tx.reconciliation_method}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2">
                        {tx.reconciliation_method && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={unlinkLoading === tx.id}
                            onClick={() => handleUnlink(tx.id)}
                          >
                            <Unlink className="h-3 w-3 mr-1" />
                            {unlinkLoading === tx.id ? '...' : 'Avmatcha'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          )}
        </Card>
      )}

      {/* Empty state */}
      {unmatchedTx.length === 0 && glLines.length === 0 && matchedTx.length === 0 && ignoredTx.length === 0 && !loading && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Inga transaktioner eller verifikationer att stämma av.
          </CardContent>
        </Card>
      )}

      <DestructiveConfirmDialog {...confirmDialogProps} />
    </div>
  )
}
