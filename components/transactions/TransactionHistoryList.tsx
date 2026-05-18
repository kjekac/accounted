'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getCategoryDisplayName } from '@/lib/tax/expense-warnings'
import {
  Search,
  ArrowUpRight,
  ArrowDownRight,
  ArrowLeftRight,
  Check,
  Landmark,
  Link2,
  FileText,
  Loader2,
  Trash2,
} from 'lucide-react'
import { TransactionAttachmentIndicator } from './TransactionAttachmentIndicator'
import CorrectionAffordance from '@/components/bookkeeping/CorrectionAffordance'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { TransactionWithInvoice, HistoryFilter } from './transaction-types'
import type {
  SkattekontoTransactionWithSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'

type SourceFilter = 'all' | 'bank' | 'skatteverket'

type HistoryRow =
  | { source: 'bank'; date: string; data: TransactionWithInvoice }
  | { source: 'skatteverket'; date: string; data: SkattekontoTransactionWithSuggestion }

interface TransactionHistoryListProps {
  transactions: TransactionWithInvoice[]
  skvRows?: SkattekontoTransactionWithSuggestion[]
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
  onSkvBokfor?: (row: StoredSkattekontoTransaction) => void
  onSkvMatch?: (row: StoredSkattekontoTransaction) => void
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
}

export default function TransactionHistoryList({
  transactions,
  skvRows = [],
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onDelete,
  onSkvBokfor,
  onSkvMatch,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: TransactionHistoryListProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')

  // The bank/private filter doesn't apply to SKV rows — they have no
  // is_business flag. So when the filter is 'business' or 'private' we
  // implicitly hide SKV (it doesn't match either). Source filter narrows
  // further if the user picks one explicitly.
  const bankFiltered = transactions.filter((t) => {
    const matchesSearch = t.description.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesFilter =
      filter === 'all' ||
      (filter === 'business' && t.is_business === true) ||
      (filter === 'private' && t.is_business === false)
    return matchesSearch && matchesFilter
  })

  const skvFiltered = skvRows.filter((r) => {
    if (filter !== 'all') return false
    return r.transaktionstext.toLowerCase().includes(searchTerm.toLowerCase())
  })

  const merged: HistoryRow[] = []
  if (sourceFilter !== 'skatteverket') {
    for (const t of bankFiltered) {
      merged.push({ source: 'bank', date: t.date, data: t })
    }
  }
  if (sourceFilter !== 'bank') {
    for (const r of skvFiltered) {
      merged.push({ source: 'skatteverket', date: r.transaktionsdatum, data: r })
    }
  }
  merged.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    return a.source === 'bank' ? -1 : 1
  })

  const showSourceFilter = skvRows.length > 0 && transactions.length > 0
  const filtered = merged

  return (
    <div className="space-y-4">
      {/* Search + filter pills */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Sök transaktioner..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex gap-1.5">
          {(['all', 'business', 'private'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'default' : 'outline'}
              className="h-9"
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'Alla' : f === 'business' ? 'Företag' : 'Privat'}
            </Button>
          ))}
        </div>
      </div>

      {showSourceFilter && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Källa:</span>
          {(['all', 'bank', 'skatteverket'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-3 py-1 transition-colors',
                sourceFilter === s
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {s === 'skatteverket' && <Landmark className="h-3 w-3" />}
              {s === 'all' ? 'Alla' : s === 'bank' ? 'Bank' : 'Skatteverket'}
            </button>
          ))}
        </div>
      )}

      {/* Transaction list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <ArrowLeftRight className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">Inga transaktioner</h3>
            <p className="text-muted-foreground text-center mt-1">
              {searchTerm
                ? 'Inga transaktioner matchar din sökning'
                : 'Inga transaktioner att visa med valt filter'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) =>
            item.source === 'bank' ? (
              <BankHistoryRow
                key={`bank-${item.data.id}`}
                transaction={item.data}
                onOpenMatchDialog={onOpenMatchDialog}
                onOpenCategoryDialog={onOpenCategoryDialog}
                onDelete={onDelete}
              />
            ) : (
              <SkattekontoHistoryRow
                key={`skv-${item.data.id}`}
                row={item.data}
                onBokfor={onSkvBokfor}
                onMatch={onSkvMatch}
              />
            ),
          )}
          {hasMore && onLoadMore && !searchTerm && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={onLoadMore}
                disabled={isLoadingMore}
              >
                {isLoadingMore ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Laddar...
                  </>
                ) : (
                  'Ladda fler'
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BankHistoryRow({
  transaction,
  onOpenMatchDialog,
  onOpenCategoryDialog,
  onDelete,
}: {
  transaction: TransactionWithInvoice
  onOpenMatchDialog: (transaction: TransactionWithInvoice) => void
  onOpenCategoryDialog: (transaction: TransactionWithInvoice) => void
  onDelete?: (id: string) => void
}) {
  // Viewers must not see write affordances. CorrectionAffordance opens a
  // dialog that stages a storno + correction journal entry; the API path
  // already 403s for viewers but rendering the trigger creates a confusing
  // dead end. Mirrors the canWrite gate on the invoice detail page.
  const { canWrite } = useCanWrite()
  return (
    <Card data-tx-id={transaction.id} className="hover:border-primary/50 transition-colors">
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                transaction.amount > 0
                  ? 'bg-success/10 text-success'
                  : 'bg-destructive/10 text-destructive'
              }`}
            >
              {transaction.amount > 0 ? (
                <ArrowUpRight className="h-5 w-5" />
              ) : (
                <ArrowDownRight className="h-5 w-5" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <p className="font-medium">{transaction.description}</p>
                <TransactionAttachmentIndicator documentId={transaction.document_id} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{formatDate(transaction.date)}</span>
                {transaction.is_business !== null &&
                  !(
                    transaction.is_business &&
                    transaction.category === 'uncategorized' &&
                    transaction.journal_entry_id
                  ) && (
                    <>
                      <span>·</span>
                      <Badge variant={transaction.is_business ? 'default' : 'secondary'}>
                        {transaction.is_business
                          ? getCategoryDisplayName(transaction.category)
                          : 'Privat'}
                      </Badge>
                    </>
                  )}
                {transaction.invoice_id && (
                  <>
                    <span>·</span>
                    <Badge variant="outline" className="text-primary border-primary">
                      <Link2 className="h-3 w-3 mr-1" />
                      Kopplad till faktura
                    </Badge>
                  </>
                )}
                {transaction.journal_entry_id ? (
                  <>
                    <span>·</span>
                    <Badge variant="outline" className="text-success border-success">
                      <Check className="h-3 w-3 mr-1" />
                      Bokförd
                    </Badge>
                    <Link
                      href={`/bookkeeping/${transaction.journal_entry_id}`}
                      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      Visa verifikation
                    </Link>
                    {canWrite && (
                      <CorrectionAffordance journalEntryId={transaction.journal_entry_id}>
                        {({ open, isLoading }) => (
                          <button
                            type="button"
                            onClick={open}
                            disabled={isLoading}
                            className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
                          >
                            {isLoading ? 'Hämtar…' : 'Skapa ändringsverifikation'}
                          </button>
                        )}
                      </CorrectionAffordance>
                    )}
                  </>
                ) : (
                  <>
                    <span>·</span>
                    <button
                      type="button"
                      className="inline-flex items-center rounded-md border border-warning px-2.5 py-0.5 text-xs font-semibold text-warning-foreground hover:bg-warning/10 transition-colors"
                      onClick={() => onOpenCategoryDialog(transaction)}
                    >
                      Ej bokförd
                    </button>
                  </>
                )}
                {transaction.potential_invoice && !transaction.invoice_id && (
                  <>
                    <span>·</span>
                    <button
                      type="button"
                      className="inline-flex items-center rounded-md border border-primary px-2.5 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10 transition-colors"
                      onClick={() => onOpenMatchDialog(transaction)}
                    >
                      <FileText className="h-3 w-3 mr-1" />
                      Möjlig match: Faktura {transaction.potential_invoice.invoice_number}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {!transaction.journal_entry_id && (
              <Button
                size="sm"
                variant="default"
                className="h-10 text-xs"
                onClick={() => onOpenCategoryDialog(transaction)}
              >
                Bokför
              </Button>
            )}
            {!transaction.journal_entry_id && onDelete && (
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(transaction.id)}
                aria-label="Ta bort transaktion"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <div className="text-right">
              <p className="font-medium tabular-nums">
                {transaction.amount > 0 ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </p>
              {transaction.currency !== 'SEK' && transaction.amount_sek && (
                <p className="text-sm text-muted-foreground">
                  {formatCurrency(transaction.amount_sek)}
                </p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SkattekontoHistoryRow({
  row,
  onBokfor,
  onMatch,
}: {
  row: SkattekontoTransactionWithSuggestion
  onBokfor?: (row: StoredSkattekontoTransaction) => void
  onMatch?: (row: StoredSkattekontoTransaction) => void
}) {
  const amount = Number(row.belopp_skatteverket)
  const isIncome = amount > 0
  const isBooked = !!row.journal_entry_id
  return (
    <Card className="hover:border-primary/50 transition-colors">
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0',
                isIncome ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
              )}
            >
              {isIncome ? (
                <ArrowUpRight className="h-5 w-5" />
              ) : (
                <ArrowDownRight className="h-5 w-5" />
              )}
            </div>
            <div>
              <p className="font-medium">{row.transaktionstext}</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{formatDate(row.transaktionsdatum)}</span>
                <span>·</span>
                <Badge variant="outline" className="gap-1">
                  <Landmark className="h-3 w-3" />
                  Skatteverket
                </Badge>
                {isBooked ? (
                  <>
                    <span>·</span>
                    <Badge variant="outline" className="text-success border-success">
                      <Check className="h-3 w-3 mr-1" />
                      Bokförd
                    </Badge>
                  </>
                ) : row.match_suggestion ? (
                  <>
                    <span>·</span>
                    <Badge variant="outline" className="border-warning text-warning">
                      Möjlig dublett
                    </Badge>
                  </>
                ) : (
                  <>
                    <span>·</span>
                    <Badge variant="outline">Ej bokförd</Badge>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {!isBooked && onMatch && (
              <Button
                size="sm"
                variant={row.match_suggestion ? 'default' : 'outline'}
                className="h-10 text-xs"
                onClick={() => onMatch(row)}
              >
                <Link2 className="mr-1 h-3 w-3" />
                {row.match_suggestion ? 'Koppla' : 'Matcha'}
              </Button>
            )}
            {!isBooked && !row.match_suggestion && onBokfor && (
              <Button
                size="sm"
                variant="default"
                className="h-10 text-xs"
                onClick={() => onBokfor(row)}
              >
                Bokför
              </Button>
            )}
            {isBooked && (
              <Button asChild size="sm" variant="ghost" className="h-10 text-xs">
                <Link href={`/bookkeeping/${row.journal_entry_id}`}>Visa verifikat</Link>
              </Button>
            )}
            <div className="text-right">
              <p
                className={cn(
                  'font-medium tabular-nums',
                  isIncome && 'text-success',
                )}
              >
                {isIncome ? '+' : ''}
                {formatCurrency(amount)}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
