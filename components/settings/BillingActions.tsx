'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import type { BillingPlan } from '@/lib/stripe/client'

/**
 * Client CTA for the billing page. Active subscribers get the Stripe Customer
 * Portal (manage/cancel); everyone else gets a plan toggle + Checkout. Both
 * POST to a route that returns a hosted Stripe URL we redirect to.
 */
export function BillingActions({ isActive, configured }: { isActive: boolean; configured: boolean }) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<BillingPlan>('yearly')

  async function go(endpoint: string, payload?: Record<string, unknown>) {
    setLoading(true)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !data.url) throw new Error(data.error || 'Något gick fel')
      window.location.href = data.url
    } catch (e) {
      toast({
        title: 'Kunde inte öppna betalningen',
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      })
      setLoading(false)
    }
  }

  if (isActive) {
    return (
      <Button size="lg" onClick={() => go('/api/billing/portal')} disabled={loading} className="w-full sm:w-auto">
        Hantera abonnemang
      </Button>
    )
  }

  if (!configured) {
    return (
      <Button size="lg" disabled className="w-full sm:w-auto">
        Uppgradering öppnar snart
      </Button>
    )
  }

  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg border border-border p-1 text-sm">
        {(['monthly', 'yearly'] as BillingPlan[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPlan(p)}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              plan === p ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {p === 'monthly' ? 'Månadsvis' : 'Årsvis'}
          </button>
        ))}
      </div>
      <div>
        <Button
          size="lg"
          onClick={() => go('/api/billing/checkout', { plan })}
          disabled={loading}
          className="w-full sm:w-auto"
        >
          Uppgradera
        </Button>
      </div>
    </div>
  )
}
