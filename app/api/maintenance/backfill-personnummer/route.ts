import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyCronSecret } from '@/lib/auth/cron'
import { encryptPersonnummer, extractLast4 } from '@/lib/salary/personnummer'

export const dynamic = 'force-dynamic'

const PLAINTEXT = /^\d{12}$/

/**
 * TEMPORARY maintenance endpoint: re-encrypt employees.personnummer rows that
 * were stored as plaintext by the v1 REST create route before the #911 fix.
 *
 * This exists because PERSONNUMMER_ENCRYPTION_KEY is a sensitive Vercel env
 * var (unreadable outside the runtime), so the committed local backfill
 * script (scripts/backfill-encrypt-personnummer.ts) cannot obtain the
 * production key. This route runs the same guarded, idempotent backfill
 * inside the production runtime, where the key already lives.
 *
 * Gated by CRON_SECRET. Dry-run by default; writes only with ?confirm=true.
 * The response carries counts only, never personnummer values.
 *
 * DELETE this route once the backfill is verified (tracked in issue #979).
 */
export async function POST(request: Request) {
  const unauthorized = verifyCronSecret(request)
  if (unauthorized) return unauthorized

  const confirm = new URL(request.url).searchParams.get('confirm') === 'true'

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  const { data, error } = await supabase
    .from('employees')
    .select('id, personnummer, personnummer_last4')
  if (error) {
    return NextResponse.json({ error: 'Failed to read employees' }, { status: 500 })
  }

  const rows = data ?? []
  const plaintextRows = rows.filter((r) => PLAINTEXT.test(String(r.personnummer ?? '')))

  let updated = 0
  let failed = 0
  if (confirm) {
    for (const row of plaintextRows) {
      const plaintext = String(row.personnummer)
      const patch: Record<string, string> = { personnummer: encryptPersonnummer(plaintext) }
      const last4 = extractLast4(plaintext)
      if (row.personnummer_last4 !== last4) patch.personnummer_last4 = last4

      // Guard on the still-plaintext value: idempotent and safe against a
      // concurrent write; can never double-encrypt.
      const { error: updateError } = await supabase
        .from('employees')
        .update(patch)
        .eq('id', row.id)
        .eq('personnummer', plaintext)
      if (updateError) failed++
      else updated++
    }
  }

  return NextResponse.json({
    mode: confirm ? 'write' : 'dry_run',
    scanned: rows.length,
    plaintext: plaintextRows.length,
    updated,
    failed,
  })
}
