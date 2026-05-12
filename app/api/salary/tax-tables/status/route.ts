import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchTaxTableRates, TaxTableUnavailableError } from '@/lib/salary/tax-tables'

/**
 * Probe Skatteverket's open data API to confirm tax tables are reachable.
 * Used by the salary settings page to surface that fetching is automatic.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || String(new Date().getFullYear()))

  try {
    const { source } = await fetchTaxTableRates(year, 30, 1)
    return NextResponse.json({
      data: {
        year,
        source,
        reachable: source === 'api',
        checkedAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    if (err instanceof TaxTableUnavailableError) {
      return NextResponse.json({
        data: {
          year,
          source: 'unavailable' as const,
          reachable: false,
          checkedAt: new Date().toISOString(),
          message: err.message,
        },
      })
    }
    throw err
  }
}
