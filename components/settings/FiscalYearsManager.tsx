'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Plus } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import type { FiscalPeriod } from '@/types'
import CreatePeriodDialog from '@/components/bookkeeping/CreatePeriodDialog'

/** Status of a fiscal period, in legal precedence: closed > locked > open. */
function periodStatus(p: FiscalPeriod): 'closed' | 'locked' | 'open' {
  if (p.is_closed) return 'closed'
  if (p.locked_at) return 'locked'
  return 'open'
}

const STATUS_VARIANT: Record<'closed' | 'locked' | 'open', 'secondary' | 'warning' | 'success'> = {
  closed: 'secondary',
  locked: 'warning',
  open: 'success',
}

/** ISO date one day after the latest period ends — seeds the create dialog so
 *  its suggestion chains forward onto the most recent year. UTC throughout to
 *  avoid timezone-offset date drift. */
function nextEntryDate(periods: FiscalPeriod[]): string {
  if (periods.length === 0) {
    return new Date().toISOString().split('T')[0]
  }
  const latestEnd = periods
    .map((p) => p.period_end)
    .sort((a, b) => a.localeCompare(b))
    .at(-1)!
  const d = new Date(latestEnd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().split('T')[0]
}

export function FiscalYearsManager() {
  const t = useTranslations('settings_bookkeeping')
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)

  const fetchPeriods = useCallback(async () => {
    try {
      const res = await fetch('/api/bookkeeping/fiscal-periods')
      if (!res.ok) throw new Error('fetch failed')
      const { data } = await res.json()
      setPeriods((data as FiscalPeriod[]) || [])
      setHasError(false)
    } catch {
      setHasError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { fetchPeriods() }, [fetchPeriods])

  // Newest first — matches the API's ordering and reads most-recent-at-top.
  const sorted = [...periods].sort((a, b) => b.period_start.localeCompare(a.period_start))

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('fy_heading')}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogOpen(true)}
          disabled={isLoading}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {t('fy_create')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t('fy_help')}</p>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : hasError ? (
        <p className="text-sm text-muted-foreground">{t('fy_load_error')}</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('fy_empty')}</p>
      ) : (
        <div className="divide-y divide-border">
          {sorted.map((p) => {
            const status = periodStatus(p)
            return (
              <div key={p.id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="ml-2 text-sm text-muted-foreground tabular-nums">
                    {formatDate(p.period_start)} – {formatDate(p.period_end)}
                  </span>
                </div>
                <Badge variant={STATUS_VARIANT[status]}>{t(`fy_status_${status}`)}</Badge>
              </div>
            )
          })}
        </div>
      )}

      <CreatePeriodDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entryDate={nextEntryDate(periods)}
        periods={periods}
        onCreated={fetchPeriods}
      />
    </section>
  )
}
