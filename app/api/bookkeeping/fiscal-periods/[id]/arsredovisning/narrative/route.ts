import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  getNarrative,
  upsertNarrative,
} from '@/lib/bokslut/arsredovisning/narrative-service'

const PostSchema = z.object({
  // Match the DB CHECK lengths exactly so a payload that would fail at the
  // storage layer instead returns a clean 400 here.
  description: z.string().max(4000).nullable().optional(),
  important_events: z.string().max(4000).nullable().optional(),
  resultatdisposition: z.string().max(2000).nullable().optional(),
  // ISO YYYY-MM-DD per the DATE column; null clears it. Validate as a
  // real calendar date (not just regex) so '2024-13-99' returns 400 from
  // the API instead of bubbling up as a Postgres 500.
  agm_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (s) => {
        const d = new Date(`${s}T00:00:00Z`)
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
      },
      { message: 'Invalid calendar date' },
    )
    .nullable()
    .optional(),
})

export const GET = withRouteContext(
  'period.arsredovisning_narrative_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      // Mirror the POST handler's period-ownership pre-check so a valid
      // JWT for company A can't probe / enumerate company B's period IDs
      // through this endpoint.
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      const data = await getNarrative(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

export const POST = withRouteContext(
  'period.arsredovisning_narrative_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PostSchema)
    if (!validation.success) return validation.response
    try {
      // Verify the fiscal period belongs to the authenticated company before
      // writing — defense-in-depth alongside RLS, gives a cleaner 404 than
      // the RLS rejection envelope. Also refuse mutations on locked/closed
      // periods (BFL 5 kap 5 § — räkenskapsinformation immutability).
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (period.is_closed || period.locked_at || period.closing_entry_id) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }
      const data = await upsertNarrative(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
