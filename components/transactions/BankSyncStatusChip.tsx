'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'

interface ConnectionRow {
  id: string
  status: string | null
  last_synced_at: string | null
}

function useAgeFormatter() {
  const t = useTranslations('transactions')
  return (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime()
    const min = Math.floor(ms / 60000)
    if (min < 1) return t('bank_sync_age_just_now')
    if (min < 60) return t('bank_sync_age_minutes', { count: min })
    const h = Math.floor(min / 60)
    if (h < 24) return t('bank_sync_age_hours', { count: h })
    const d = Math.floor(h / 24)
    return t('bank_sync_age_days', { count: d })
  }
}

export default function BankSyncStatusChip() {
  const t = useTranslations('transactions')
  const formatAge = useAgeFormatter()
  const { company } = useCompany()
  const [rows, setRows] = useState<ConnectionRow[] | null>(null)

  useEffect(() => {
    if (!company?.id) return
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('bank_connections')
      .select('id, status, last_synced_at')
      .eq('company_id', company.id)
      .then(({ data }) => {
        if (!cancelled) setRows(data ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  if (!rows || rows.length === 0) return null

  const needsAttention = rows.filter(
    (r) => r.status === 'expired' || r.status === 'error',
  )

  if (needsAttention.length > 0) {
    return (
      <Link
        href="/settings/banking"
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          {needsAttention.length === 1
            ? t('bank_sync_attention_one')
            : t('bank_sync_attention_many', { count: needsAttention.length })}
        </span>
      </Link>
    )
  }

  const mostRecent = rows
    .map((r) => r.last_synced_at)
    .filter((s): s is string => Boolean(s))
    .sort()
    .pop()

  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground">
      <RefreshCw className="h-3.5 w-3.5" />
      <span>
        {t('bank_sync_auto_nightly')}
        {mostRecent && (
          <>
            {t('bank_sync_last_separator')}
            <span className="tabular-nums">{formatAge(mostRecent)}</span>
          </>
        )}
      </span>
    </div>
  )
}
