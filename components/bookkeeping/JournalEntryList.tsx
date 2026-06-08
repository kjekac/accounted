'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import {
  FiscalYearSelector,
  STORAGE_KEY_PREFIX as FISCAL_YEAR_STORAGE_KEY_PREFIX,
  ALL_YEARS_VALUE as FISCAL_YEAR_ALL_VALUE,
} from '@/components/common/FiscalYearSelector'
import { ChevronDown, ChevronRight, Paperclip, AlertTriangle, CircleSlash, Loader2, BookOpen, X, Copy, Lock, Search, SlidersHorizontal } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { Input } from '@/components/ui/input'
import { AccountNumber } from '@/components/ui/account-number'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import NoDocRequiredToggle from '@/components/bookkeeping/NoDocRequiredToggle'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import JournalEntryStatusBadge from '@/components/bookkeeping/JournalEntryStatusBadge'
import AttachmentPreviewSheet from '@/components/bookkeeping/AttachmentPreviewSheet'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { FiscalPeriod, JournalEntry, JournalEntryLine } from '@/types'

const NEEDS_ATTACHMENT = new Set([
  'manual',
  'bank_transaction',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'import',
])

type SortBy = 'date_desc' | 'date_asc' | 'voucher_asc' | 'voucher_desc'

// Per-company persistence of the sort dropdown. Mirrors the localStorage
// convention used by FiscalYearSelector ('Accounted:fiscal-year:<companyId>').
const SORT_STORAGE_KEY_PREFIX = 'Accounted:journal-sort:'
const SORT_VALUES = new Set<SortBy>(['date_desc', 'date_asc', 'voucher_asc', 'voucher_desc'])

export default function JournalEntryList() {
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const company = useCompanyOptional()?.company ?? null
  const t = useTranslations('journal_list')
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [committingId, setCommittingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  const [noDocRequired, setNoDocRequired] = useState<Map<string, string | null>>(new Map())
  const [showMissingOnly, setShowMissingOnly] = useState(false)
  const [correctionEntry, setCorrectionEntry] = useState<JournalEntry | null>(null)
  const [previewEntryId, setPreviewEntryId] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortBy>('date_desc')
  const [sortHydrated, setSortHydrated] = useState(false)
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [periodHydrated, setPeriodHydrated] = useState(false)
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateFromInput, setDateFromInput] = useState('')
  const [dateToInput, setDateToInput] = useState('')
  const [seriesFilter, setSeriesFilter] = useState<string>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const pageSize = 20

  const normalizeDate = (v: string): string | null => {
    const trimmed = v.trim()
    if (!trimmed) return null
    // YYYY
    if (/^\d{4}$/.test(trimmed)) {
      const y = parseInt(trimmed, 10)
      if (y < 1900 || y > 2100) return null
      return `${trimmed}-01-01`
    }
    // YYYY-MM
    if (/^\d{4}-\d{2}$/.test(trimmed)) {
      const [y, m] = trimmed.split('-').map(Number)
      if (y < 1900 || y > 2100 || m < 1 || m > 12) return null
      return `${trimmed}-01`
    }
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(trimmed + 'T00:00:00')
      if (isNaN(d.getTime())) return null
      // Verify the date didn't roll over (e.g. 2024-02-31 → March)
      const [y, m, day] = trimmed.split('-').map(Number)
      if (d.getFullYear() !== y || d.getMonth() + 1 !== m || d.getDate() !== day) return null
      return trimmed
    }
    return null
  }

  const applyDateFilter = () => {
    const fromVal = dateFromInput.trim()
    const toVal = dateToInput.trim()
    const nextFrom = fromVal === '' ? '' : normalizeDate(fromVal) ?? dateFrom
    const nextTo = toVal === '' ? '' : normalizeDate(toVal) ?? dateTo
    setDateFromInput(nextFrom)
    setDateToInput(nextTo)
    if (nextFrom !== dateFrom || nextTo !== dateTo) {
      setDateFrom(nextFrom)
      setDateTo(nextTo)
      setPage(0)
    }
  }

  const fetchAttachmentCounts = useCallback(async (entryIds: string[]) => {
    if (entryIds.length === 0) return
    try {
      const res = await fetch(
        `/api/documents/counts?journal_entry_ids=${entryIds.join(',')}`
      )
      const { data } = await res.json()
      setAttachmentCounts(data || {})
    } catch {
      // Non-critical — silently ignore
    }
  }, [])

  const fetchNoDocRequired = useCallback(async () => {
    try {
      const res = await fetch('/api/bookkeeping/no-doc-required')
      if (!res.ok) return
      const { data } = await res.json()
      const map = new Map<string, string | null>()
      for (const row of (data || []) as { journal_entry_id: string; reason: string | null }[]) {
        map.set(row.journal_entry_id, row.reason)
      }
      setNoDocRequired(map)
    } catch {
      // Non-critical — silently ignore
    }
  }, [])

  useEffect(() => {
    fetchNoDocRequired()
  }, [fetchNoDocRequired])

  // Restore the persisted sort order (per company). Read in an effect rather
  // than the useState initializer to avoid an SSR/client hydration mismatch.
  // sortHydrated gates the first fetch so the list is fetched once, already in
  // the saved order — no flash of the default sort.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(SORT_STORAGE_KEY_PREFIX + (company?.id ?? 'default'))
      if (stored && SORT_VALUES.has(stored as SortBy)) setSortBy(stored as SortBy)
    }
    setSortHydrated(true)
  }, [company?.id])

  // Restore the persisted fiscal-year selection (per company), reading the same
  // localStorage key FiscalYearSelector writes. The selector lives inside the
  // filter dialog and only mounts when opened, so we resolve the saved scope
  // here — independent of the dialog — to keep the initial fetch correct.
  // periodHydrated gates the first fetch so the list loads already scoped.
  useEffect(() => {
    if (company?.id && typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(FISCAL_YEAR_STORAGE_KEY_PREFIX + company.id)
      setPeriodId(stored && stored !== FISCAL_YEAR_ALL_VALUE ? stored : null)
    } else {
      setPeriodId(null)
    }
    setPeriodHydrated(true)
  }, [company?.id])

  // Fetch fiscal periods so the active räkenskapsår can be labelled on the
  // filter bar without opening the dialog (BFL period-orientation: the user
  // should always see which year the ledger is scoped to). Read-only — the
  // dialog's FiscalYearSelector still owns selection; this copy resolves the
  // name for display.
  useEffect(() => {
    if (!company?.id) {
      setPeriods([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/bookkeeping/fiscal-periods')
        if (!res.ok) return
        const { data } = await res.json()
        if (!cancelled) setPeriods((data || []) as FiscalPeriod[])
      } catch {
        // Non-critical — the chip falls back to the active-filter count badge.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [company?.id])

  // Debounce the free-text search before it reaches the API. Require ≥2 chars:
  // a single character matches almost every verifikationstext and isn't a useful
  // filter, so 0–1 chars are treated as "no search" instead of firing a query on
  // every keystroke (ASVS V2.4).
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim()
      setSearch(trimmed.length >= 2 ? trimmed : '')
      setPage(0)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchInput])

  async function fetchEntries() {
    setLoading(true)
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
      sort_by: sortBy,
    })
    if (periodId) params.set('period_id', periodId)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    if (seriesFilter !== 'all') params.set('series', seriesFilter)
    if (search) params.set('search', search)

    const res = await fetch(`/api/bookkeeping/journal-entries?${params}`)
    if (!res.ok) {
      setLoading(false)
      return
    }
    const { data, count: total } = await res.json()
    const loadedEntries = data || []
    setEntries(loadedEntries)
    setCount(total || 0)
    setLoading(false)

    // Fetch attachment counts for the loaded entries
    const ids = loadedEntries.map((e: JournalEntry) => e.id)
    fetchAttachmentCounts(ids)
  }

  useEffect(() => {
    if (!sortHydrated || !periodHydrated) return
    fetchEntries()
  }, [periodId, page, sortBy, dateFrom, dateTo, seriesFilter, search, sortHydrated, periodHydrated])

  const handleAttachmentCountChange = useCallback((entryId: string, count: number) => {
    setAttachmentCounts((prev) => ({ ...prev, [entryId]: count }))
  }, [])

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  const handleCommit = async (entryId: string) => {
    setCommittingId(entryId)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${entryId}/commit`, { method: 'POST' })
      const result = await res.json()
      if (res.ok) {
        const posted = result.data
        toast({
          title: t('toast_posted_title'),
          description: t('toast_posted_description', { voucher: formatVoucher(posted ?? {}) }),
        })
        await fetchEntries()
      } else {
        toast({ title: t('toast_post_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setCommittingId(null)
    }
  }

  const filteredEntries = showMissingOnly
    ? entries.filter(
        (e) =>
          NEEDS_ATTACHMENT.has(e.source_type) &&
          !attachmentCounts[e.id] &&
          e.status === 'posted' &&
          !noDocRequired.has(e.id)
      )
    : entries

  // Count of active dialog filters, shown as a badge on the Filtrera button so
  // the user can tell the list is scoped without opening the dialog. Sort order
  // is a view preference (always set), not a filter, so it is excluded.
  const activeFilterCount =
    (periodId ? 1 : 0) +
    (seriesFilter !== 'all' ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (showMissingOnly ? 1 : 0)

  // When any filter or search is active we keep the filter bar mounted even
  // with zero results, so the user can edit or clear their query. The pristine
  // "no entries yet" state below only applies to an untouched, empty ledger.
  const hasActiveFilters = Boolean(search) || activeFilterCount > 0

  // Resolve the active fiscal-year scope for the bar chip. "All years" (periodId
  // null) renders immediately; a specific period waits until its name resolves
  // from the fetched list (scopeLabel stays null meanwhile, so the chip never
  // flashes the wrong scope). Surfacing this keeps the period visible per BFL
  // without the user having to open the filter dialog.
  const activePeriod = periodId ? periods.find((p) => p.id === periodId) ?? null : null
  const scopeLabel = periodId ? activePeriod?.name ?? null : t('scope_all_years')

  // Apply a fiscal-year selection from the dialog. The FiscalYearSelector
  // persists the choice to localStorage itself; here we only mirror it into
  // local state and reset pagination.
  const handlePeriodChange = (next: string | null) => {
    setPeriodId(next)
    setPage(0)
  }

  const clearAllFilters = () => {
    setPeriodId(null)
    // Mirror the selector's "Alla räkenskapsår" write so the cleared scope
    // survives a remount/reload instead of being restored from a stale value.
    if (company?.id && typeof window !== 'undefined') {
      window.localStorage.setItem(FISCAL_YEAR_STORAGE_KEY_PREFIX + company.id, FISCAL_YEAR_ALL_VALUE)
    }
    setSeriesFilter('all')
    setShowMissingOnly(false)
    setDateFrom('')
    setDateTo('')
    setDateFromInput('')
    setDateToInput('')
    setPage(0)
  }

  if (!loading && entries.length === 0 && !hasActiveFilters) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <div className="p-4 rounded-full bg-muted mb-4">
            <BookOpen className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-1">{t('empty_title')}</h3>
          <p className="text-sm text-muted-foreground text-center max-w-sm">
            {t('empty_description')}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Search (always visible) + filter dialog for everything else */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 sm:flex-none sm:w-[280px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            inputMode="search"
            placeholder={t('search_placeholder')}
            aria-label={t('search_placeholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-8 pl-8 pr-7 text-xs"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm hover:bg-muted text-muted-foreground"
              title={t('clear_search')}
              aria-label={t('clear_search')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2 text-xs shrink-0"
              aria-label={
                activeFilterCount > 0
                  ? t('filter_with_count', { count: activeFilterCount })
                  : t('filter')
              }
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t('filter')}
              {activeFilterCount > 0 && (
                <Badge
                  variant="secondary"
                  className="h-4 min-w-4 justify-center px-1 text-[10px] tabular-nums"
                >
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('filter_dialog_title')}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Räkenskapsår */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_period')}</Label>
                <FiscalYearSelector
                  value={periodId}
                  onChange={handlePeriodChange}
                  label={null}
                  className="w-full"
                />
              </div>

              {/* Sortering */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_sort')}</Label>
                <Select
                  value={sortBy}
                  onValueChange={(v) => {
                    const next = v as SortBy
                    setSortBy(next)
                    setPage(0)
                    if (typeof window !== 'undefined') {
                      window.localStorage.setItem(SORT_STORAGE_KEY_PREFIX + (company?.id ?? 'default'), next)
                    }
                  }}
                >
                  <SelectTrigger className="h-9 w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="date_desc">{t('sort_date_desc')}</SelectItem>
                    <SelectItem value="date_asc">{t('sort_date_asc')}</SelectItem>
                    <SelectItem value="voucher_asc">{t('sort_voucher_asc')}</SelectItem>
                    <SelectItem value="voucher_desc">{t('sort_voucher_desc')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Verifikationsserie */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_series')}</Label>
                <Select value={seriesFilter} onValueChange={(v) => { setSeriesFilter(v); setPage(0) }}>
                  <SelectTrigger className="h-9 w-full text-sm font-mono" aria-label={t('filter_section_series')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Alla serier</SelectItem>
                    {'ABCDEFG'.split('').map((letter) => (
                      <SelectItem key={letter} value={letter} className="font-mono">
                        Serie {letter}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Datumintervall */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_date')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    placeholder={t('date_from_placeholder')}
                    value={dateFromInput}
                    onChange={(e) => setDateFromInput(e.target.value)}
                    onBlur={applyDateFilter}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        applyDateFilter()
                      }
                    }}
                    className="h-9 flex-1 text-sm"
                  />
                  <span className="text-sm text-muted-foreground">–</span>
                  <Input
                    type="text"
                    placeholder={t('date_to_placeholder')}
                    value={dateToInput}
                    onChange={(e) => setDateToInput(e.target.value)}
                    onBlur={applyDateFilter}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        applyDateFilter()
                      }
                    }}
                    className="h-9 flex-1 text-sm"
                  />
                  {(dateFrom || dateTo) && (
                    <button
                      type="button"
                      onClick={() => { setDateFrom(''); setDateTo(''); setDateFromInput(''); setDateToInput(''); setPage(0) }}
                      className="p-1 rounded-sm hover:bg-muted text-muted-foreground shrink-0"
                      title={t('clear_date_filter')}
                      aria-label={t('clear_date_filter')}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Visa saknade underlag */}
              <div className="flex items-center gap-2">
                <Switch
                  id="missing-attachments"
                  checked={showMissingOnly}
                  onCheckedChange={setShowMissingOnly}
                />
                <Label htmlFor="missing-attachments" className="text-sm cursor-pointer">
                  {t('show_missing')}
                </Label>
                {showMissingOnly && (
                  <Badge variant="secondary" className="text-xs tabular-nums">
                    {filteredEntries.length}
                  </Badge>
                )}
              </div>
            </div>

            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAllFilters}
                disabled={activeFilterCount === 0}
              >
                {t('filter_clear_all')}
              </Button>
              <DialogClose asChild>
                <Button variant="outline" size="sm">{t('filter_done')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Active fiscal-year scope — visible without opening the filter dialog so
          the user always sees which räkenskapsår the ledger is scoped to (BFL
          period-correctness). Clicking it opens the dialog to change the scope. */}
      {periodHydrated && scopeLabel && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('scope_label')}</span>
          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 font-medium text-foreground transition-colors duration-150 hover:bg-secondary/60"
          >
            {scopeLabel}
            {(activePeriod?.locked_at || activePeriod?.is_closed) && (
              <Lock className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">{t('loading')}</p>
          </CardContent>
        </Card>
      ) : filteredEntries.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="p-4 rounded-full bg-muted mb-4">
              <Search className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">{t('no_results_title')}</h3>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              {t('no_results_description')}
            </p>
          </CardContent>
        </Card>
      ) : (
      <div className="space-y-2">
        {filteredEntries.map((entry) => {
          const isExpanded = expandedId === entry.id
          const lines = (entry.lines || []) as JournalEntryLine[]

          return (
            <Card key={entry.id}>
              <button
                onClick={() => toggleExpand(entry.id)}
                aria-expanded={isExpanded}
                className="w-full p-4 text-left hover:bg-muted/50 transition-colors min-h-[44px]"
              >
                {/* Desktop: single row */}
                <div className="hidden sm:flex items-center gap-3 flex-1">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  )}
                  <Link
                    href={`/bookkeeping/${entry.id}`}
                    className="font-mono text-sm text-primary hover:underline w-16"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {formatVoucher(entry)}
                  </Link>
                  <span className="text-sm text-muted-foreground tabular-nums w-24">
                    {formatDate(entry.entry_date)}
                  </span>
                  {entry.out_of_period && (
                    <Badge
                      variant="outline"
                      className="text-xs font-normal shrink-0"
                      title={t('out_of_period_tooltip')}
                    >
                      {t('out_of_period_label')}
                    </Badge>
                  )}
                  {(entry.status === 'reversed' || entry.status === 'draft' || entry.source_type === 'storno' || entry.source_type === 'correction') && (
                    <JournalEntryStatusBadge entry={entry} showStatus={entry.status === 'reversed' || entry.status === 'draft'} />
                  )}
                  <span className="flex-1 truncate">{entry.description}</span>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                  >
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t('copy_voucher_tooltip')}
                      title={t('copy_voucher_tooltip')}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        router.push(`/bookkeeping?copy_from=${entry.id}`)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          router.push(`/bookkeeping?copy_from=${entry.id}`)
                        }
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </span>
                  </Button>
                  {attachmentCounts[entry.id] ? (
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 mr-1 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('view_attachments')}
                        title={t('attachment_count_tooltip', { count: attachmentCounts[entry.id] })}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setPreviewEntryId(entry.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            setPreviewEntryId(entry.id)
                          }
                        }}
                      >
                        <span className="flex items-center gap-0.5">
                          <Paperclip className="h-3.5 w-3.5" />
                          <span className="text-xs">{attachmentCounts[entry.id]}</span>
                        </span>
                      </span>
                    </Button>
                  ) : (
                    NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && (
                      noDocRequired.has(entry.id) ? (
                        <span className="mr-1" title={t('no_doc_required_indicator_tooltip')}>
                          <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
                        </span>
                      ) : (
                        <span className="mr-1" title={t('missing_attachment_tooltip')}>
                          <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground" />
                        </span>
                      )
                    )
                  )}
                </div>
                {/* Mobile: two rows */}
                <div className="sm:hidden">
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0" />
                    )}
                    <Link
                      href={`/bookkeeping/${entry.id}`}
                      className="font-mono text-sm text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {formatVoucher(entry)}
                    </Link>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {formatDate(entry.entry_date)}
                    </span>
                    {entry.out_of_period && (
                      <Badge
                        variant="outline"
                        className="text-xs font-normal shrink-0"
                        title={t('out_of_period_tooltip_mobile')}
                      >
                        {t('out_of_period_label')}
                      </Badge>
                    )}
                    {(entry.status === 'reversed' || entry.status === 'draft' || entry.source_type === 'storno' || entry.source_type === 'correction') && (
                      <JournalEntryStatusBadge entry={entry} showStatus={entry.status === 'reversed' || entry.status === 'draft'} />
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      <Button
                        asChild
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                      >
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={t('copy_voucher_tooltip')}
                          title={t('copy_voucher_tooltip')}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            router.push(`/bookkeeping?copy_from=${entry.id}`)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              e.stopPropagation()
                              router.push(`/bookkeeping?copy_from=${entry.id}`)
                            }
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </span>
                      </Button>
                      {attachmentCounts[entry.id] ? (
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                        >
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={t('view_attachments')}
                            title={t('attachment_count_tooltip', { count: attachmentCounts[entry.id] })}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setPreviewEntryId(entry.id)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                e.stopPropagation()
                                setPreviewEntryId(entry.id)
                              }
                            }}
                          >
                            <span className="flex items-center gap-0.5">
                              <Paperclip className="h-3.5 w-3.5" />
                              <span className="text-xs">{attachmentCounts[entry.id]}</span>
                            </span>
                          </span>
                        </Button>
                      ) : (
                        NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && (
                          noDocRequired.has(entry.id) ? (
                            <span title={t('no_doc_required_indicator_tooltip')}>
                              <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
                            </span>
                          ) : (
                            <span title={t('missing_attachment_tooltip')}>
                              <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground" />
                            </span>
                          )
                        )
                      )}
                    </span>
                  </div>
                  <p className="mt-1 ml-6 text-sm truncate">{entry.description}</p>
                </div>
              </button>

              {isExpanded && (
                <CardContent className="pt-0 pb-4">
                  {lines.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">{t('no_lines')}</p>
                  ) : (
                  <>
                    <div className="space-y-3">
                      {lines
                        .sort((a, b) => a.sort_order - b.sort_order)
                        .map((line) => {
                          const accountName = getAccountDescription(line.account_number)?.name
                          const desc = line.line_description
                          const showDesc = desc
                            && desc.toLowerCase() !== accountName?.toLowerCase()
                            && desc.toLowerCase() !== entry.description?.toLowerCase()
                          return (
                          <div key={line.id} className="rounded-lg border p-3 space-y-1.5">
                            <div className="text-sm">
                              <AccountNumber number={line.account_number} showName />
                            </div>
                            {showDesc && (
                              <p className="text-xs text-muted-foreground">{desc}</p>
                            )}
                            <div className="flex justify-between items-center pt-1 border-t text-sm">
                              <span className="text-muted-foreground">
                                {Number(line.debit_amount) > 0 ? t('debit') : t('credit')}
                              </span>
                              <div className="text-right">
                                <span className="font-mono tabular-nums font-medium">
                                  {Number(line.debit_amount) > 0
                                    ? Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })
                                    : Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                                </span>
                                {line.currency && line.currency !== 'SEK' && line.amount_in_currency != null && (
                                  <span className="block text-xs text-muted-foreground font-mono tabular-nums">
                                    {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          )
                        })}
                      <div className="rounded-lg bg-muted/50 p-3 text-sm font-semibold space-y-1">
                        <div className="flex justify-between">
                          <span>{t('sum_debit')}</span>
                          <span className="font-mono tabular-nums">{lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t('sum_credit')}</span>
                          <span className="font-mono tabular-nums">{lines.reduce((sum, l) => sum + (Number(l.credit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    </div>
                  </>
                  )}

                  {entry.notes && (
                    <p className="mt-3 text-xs text-muted-foreground italic px-1">
                      {entry.notes}
                    </p>
                  )}

                  <JournalEntryAttachments
                    journalEntryId={entry.id}
                    onCountChange={(c) => handleAttachmentCountChange(entry.id, c)}
                  />

                  {entry.status === 'posted' && NEEDS_ATTACHMENT.has(entry.source_type) && (
                    <NoDocRequiredToggle
                      entryId={entry.id}
                      initialExempt={noDocRequired.has(entry.id)}
                      initialReason={noDocRequired.get(entry.id) ?? null}
                      canWrite={canWrite}
                      onChange={(exempted, reason) => {
                        setNoDocRequired((prev) => {
                          const next = new Map(prev)
                          if (exempted) next.set(entry.id, reason ?? null)
                          else next.delete(entry.id)
                          return next
                        })
                      }}
                    />
                  )}

                  <div className="mt-4 pt-3 border-t flex flex-col sm:flex-row gap-2">
                    {entry.status === 'draft' && (
                      <Button
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => handleCommit(entry.id)}
                        disabled={!canWrite || committingId === entry.id}
                        title={!canWrite ? t('read_only_tooltip') : undefined}
                      >
                        {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : committingId === entry.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {t('post')}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="w-full sm:w-auto" asChild>
                      <Link href={`/bookkeeping/${entry.id}`}>{t('show_details')}</Link>
                    </Button>
                    {entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => setCorrectionEntry(entry)}
                      >
                        {t('create_correction')}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => router.push(`/bookkeeping?copy_from=${entry.id}`)}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      {t('copy')}
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>
      )}

      {/* Correction dialog */}
      {correctionEntry && (
        <CorrectionEntryDialog
          entry={correctionEntry}
          open={!!correctionEntry}
          onOpenChange={(open) => { if (!open) setCorrectionEntry(null) }}
          onCorrected={() => { setCorrectionEntry(null); fetchEntries() }}
        />
      )}

      {/* Attachment preview sheet */}
      <AttachmentPreviewSheet
        entryId={previewEntryId}
        open={previewEntryId !== null}
        onOpenChange={(open) => { if (!open) setPreviewEntryId(null) }}
      />

      {/* Pagination */}
      {count > pageSize && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            {t('previous')}
          </Button>
          <span className="text-sm text-muted-foreground self-center">
            {t('page_of', { page: page + 1, total: Math.ceil(count / pageSize) })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * pageSize >= count}
            onClick={() => setPage(page + 1)}
          >
            {t('next')}
          </Button>
        </div>
      )}
    </div>
  )
}
