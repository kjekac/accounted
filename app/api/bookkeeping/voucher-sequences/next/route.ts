import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext(
  'voucher_sequence.next',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const today = new Date().toISOString().split('T')[0]

    const [{ data: period, error: periodError }, { data: settings, error: settingsError }] =
      await Promise.all([
        supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .lte('period_start', today)
          .gte('period_end', today)
          .maybeSingle(),
        supabase
          .from('company_settings')
          .select('default_voucher_series')
          .eq('company_id', companyId)
          .maybeSingle(),
      ])

    if (periodError) {
      log.error('fiscal_periods lookup failed', periodError)
      return errorResponse(periodError, log, { requestId })
    }
    if (settingsError) {
      log.error('company_settings lookup failed', settingsError)
      return errorResponse(settingsError, log, { requestId })
    }

    const series = settings?.default_voucher_series || 'A'

    if (!period) {
      return NextResponse.json({ data: { next: null, series, fiscal_period_id: null } })
    }

    const { data: sequence, error: sequenceError } = await supabase
      .from('voucher_sequences')
      .select('last_number')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', period.id)
      .eq('voucher_series', series)
      .maybeSingle()

    if (sequenceError) {
      log.error('voucher_sequences lookup failed', sequenceError)
      return errorResponse(sequenceError, log, { requestId })
    }

    const next = (sequence?.last_number ?? 0) + 1

    return NextResponse.json({
      data: { next, series, fiscal_period_id: period.id },
    })
  },
)
