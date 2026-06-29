import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireCompanyId } from '@/lib/company/context'
import { createServiceClient } from '@/lib/supabase/server'
import { getStripe, priceIdForPlan, type BillingPlan } from '@/lib/stripe/client'

/**
 * Create a Stripe subscription Checkout Session and return its hosted URL.
 * The client redirects to it; provisioning happens via the webhook on
 * checkout.session.completed (never trust the success redirect for fulfilment).
 */
export async function POST(request: Request) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  let companyId: string
  try {
    companyId = await requireCompanyId(supabase, user.id)
  } catch {
    return NextResponse.json({ error: 'No company context' }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as { plan?: string }
  const plan: BillingPlan = body.plan === 'yearly' ? 'yearly' : 'monthly'
  const priceId = priceIdForPlan(plan)
  if (!priceId) {
    return NextResponse.json({ error: 'Stripe price not configured' }, { status: 500 })
  }

  const stripe = getStripe()
  const service = createServiceClient()

  // Reuse the company's Stripe customer if we already created one.
  const { data: existing } = await service
    .from('company_subscriptions')
    .select('stripe_customer_id')
    .eq('company_id', companyId)
    .maybeSingle()

  let customerId = (existing as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { company_id: companyId },
    })
    customerId = customer.id
    await service
      .from('company_subscriptions')
      .upsert({ company_id: companyId, stripe_customer_id: customerId }, { onConflict: 'company_id' })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: companyId,
    metadata: { company_id: companyId },
    subscription_data: { metadata: { company_id: companyId } },
    allow_promotion_codes: true,
    success_url: `${appUrl}/settings/billing?success=1`,
    cancel_url: `${appUrl}/settings/billing?canceled=1`,
  })

  return NextResponse.json({ url: session.url })
}
