import { Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { statusGrantsAccess } from '@/lib/stripe/subscription-sync'
import { isStripeConfigured } from '@/lib/stripe/client'
import { BillingActions } from '@/components/settings/BillingActions'

export const metadata = { title: 'Abonnemang' }

// What the paid tier unlocks (mirrors lib/entitlements PAID_CAPABILITIES).
const INCLUDED = [
  'AI-assistent: chatt, kategorisering och dokumenttolkning',
  'Bankkoppling och automatisk synk (PSD2)',
  'Skatteverket: moms- och AGI-inlämning',
  'E-postutskick av fakturor, påminnelser och lönebesked',
]

// Free for everyone — reassures users that the core ledger is never withheld.
const ALWAYS_FREE =
  'All bokföring, fakturering, rapporter, SIE-export, org.nr-uppslag och momsnummerkontroll ingår alltid utan kostnad.'

/**
 * Upgrade / subscription page — the destination every "Uppgradera" affordance
 * points to. Reads the active company's subscription status to show either the
 * Checkout CTA or the manage-subscription portal; fulfilment itself happens via
 * the Stripe webhook, never this page.
 */
export default async function BillingPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let isActive = false
  if (user) {
    const companyId = await getActiveCompanyId(supabase, user.id)
    if (companyId) {
      const { data: sub } = await supabase
        .from('company_subscriptions')
        .select('status')
        .eq('company_id', companyId)
        .maybeSingle()
      isActive = statusGrantsAccess((sub as { status: string | null } | null)?.status)
    }
  }
  const configured = isStripeConfigured()

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-2xl tracking-tight mb-1">Abonnemang</h1>
      <p className="text-muted-foreground mb-6">
        {isActive
          ? 'Ditt abonnemang är aktivt. Du kan hantera eller avsluta det när som helst.'
          : 'Lås upp AI-assistenten, bankkoppling, Skatteverket-inlämning och e-postutskick.'}
      </p>

      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-3xl tracking-tight">199 kr</span>
          <span className="text-muted-foreground">/ månad</span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          eller 1&nbsp;999 kr per år (två månader gratis).
        </p>

        <ul className="mt-5 space-y-2.5">
          {INCLUDED.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-sm">
              <Check className="h-4 w-4 mt-0.5 shrink-0 text-foreground" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="mt-6">
          <BillingActions isActive={isActive} configured={configured} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-4 leading-relaxed">{ALWAYS_FREE}</p>
    </div>
  )
}
