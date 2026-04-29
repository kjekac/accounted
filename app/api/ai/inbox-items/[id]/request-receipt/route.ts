import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { getEmailService } from '@/lib/email/service'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { gateAgentInbox } from '@/lib/ai/feature-flag'
import { getBranding } from '@/lib/branding/service'
import type { InvoiceInboxItem } from '@/types'

ensureInitialized()

/**
 * POST /api/ai/inbox-items/[id]/request-receipt
 *
 * Ask every member of the company to upload a receipt file for this inbox
 * item. Used when the AI couldn't book because no source document is
 * attached (BFL compliance gate) or the existing image is too poor to read.
 *
 * Sends one email per member with a deep link back to agent-inkorg.
 * No-op when the email service isn't configured — returns 503 so the UI
 * can explain.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = gateAgentInbox()
  if (gate) return gate

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)
  const { id } = await params

  const { data: inboxRow } = await supabase
    .from('invoice_inbox_items')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!inboxRow) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const inbox = inboxRow as InvoiceInboxItem

  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    return NextResponse.json(
      { error: 'E-posttjänsten är inte konfigurerad.' },
      { status: 503 }
    )
  }

  // Load every member's email address. profiles.email is populated by the
  // handle_new_user trigger and kept in sync with auth.users.
  const { data: members, error: memberError } = await supabase
    .from('company_members')
    .select('user_id, profiles:user_id(email, full_name)')
    .eq('company_id', companyId)

  if (memberError) {
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  // Shape of the joined profiles column depends on RLS/relationship —
  // defensively support both single-object and array.
  const recipients: Array<{ email: string; name: string | null }> = []
  for (const row of members ?? []) {
    type ProfileShape = { email?: string | null; full_name?: string | null }
    const profile: ProfileShape | ProfileShape[] | null | undefined =
      (row as { profiles?: ProfileShape | ProfileShape[] | null }).profiles
    const profileRow = Array.isArray(profile) ? profile[0] : profile
    const email = profileRow?.email
    if (email) recipients.push({ email, name: profileRow?.full_name ?? null })
  }

  if (recipients.length === 0) {
    return NextResponse.json(
      { error: 'Inga medlemmar med e-postadress hittades.' },
      { status: 404 }
    )
  }

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .maybeSingle()

  const companyName = companyRow?.company_name ?? 'ditt företag'

  // Pull a short summary of the receipt so recipients know which one to fix.
  const extracted = inbox.extracted_data as {
    merchant?: { name?: string | null } | null
    totals?: { total?: number | null } | null
    receipt?: { date?: string | null; currency?: string | null } | null
  } | null
  const merchant = extracted?.merchant?.name ?? 'okänd handlare'
  const total = extracted?.totals?.total ?? null
  const currency = extracted?.receipt?.currency ?? 'SEK'
  const date = extracted?.receipt?.date ?? null

  const appUrl = getBranding().appUrl
  const deepLink = `${appUrl.replace(/\/$/, '')}/agent-inbox`

  const subject = `[${companyName}] Kvittobild behövs för bokföring`

  const summaryLine = [
    merchant,
    total != null ? `${total} ${currency}` : null,
    date,
  ]
    .filter(Boolean)
    .join(' · ')

  const html = buildHtml({ companyName, summaryLine, deepLink, senderName: user.email ?? null })
  const text = buildText({ companyName, summaryLine, deepLink, senderName: user.email ?? null })

  // Fire emails in parallel. Track successes and failures separately so a
  // single bad address doesn't block the rest.
  const results = await Promise.allSettled(
    recipients.map((r) =>
      emailService.sendEmail({
        to: r.email,
        subject,
        html,
        text,
      })
    )
  )

  let sent = 0
  let failed = 0
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.success) sent += 1
    else failed += 1
  }

  // Audit trail so the user can see "Emil requested receipt from 3 members".
  try {
    if (inbox.correlation_id) {
      await appendProcessingHistory({
        companyId,
        correlationId: inbox.correlation_id,
        aggregateType: 'Document',
        aggregateId: inbox.document_id ?? inbox.id,
        eventType: 'ReceiptRequested',
        payload: {
          inbox_item_id: inbox.id,
          recipients: recipients.length,
          sent,
          failed,
        },
        actor: { type: 'user', id: user.id },
        occurredAt: new Date(),
      })
    }
  } catch (err) {
    console.error('[ai/request-receipt] processing_history append failed:', err)
  }

  return NextResponse.json({
    data: {
      sent,
      failed,
      total: recipients.length,
    },
  })
}

interface TemplateArgs {
  companyName: string
  summaryLine: string
  deepLink: string
  senderName: string | null
}

function buildHtml({ companyName, summaryLine, deepLink, senderName }: TemplateArgs): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;">Source documents required for receipt and transaction mapping</h2>
  <p style="margin:0 0 16px;color:#555;">
    ${senderName ? `${senderName} ` : ''}behöver ett kvittounderlag för ${companyName} innan en transaktion kan bokföras.
  </p>
  <p style="margin:0 0 20px;padding:12px;background:#f4f4f5;border-radius:6px;font-family:monospace;font-size:14px;">
    ${summaryLine || 'Kvitto utan extraherade uppgifter'}
  </p>
  <p style="margin:0 0 16px;">Öppna agent-inkorgen och ladda upp en tydlig bild eller PDF av kvittot:</p>
  <p style="margin:0 0 24px;">
    <a href="${deepLink}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;">Öppna agent-inkorg</a>
  </p>
  <p style="margin:0;color:#888;font-size:13px;">
    Send in receipts. Utan källunderlag kan bokföringen inte slutföras enligt BFL 5 kap 7§.
  </p>
</body></html>`
}

function buildText({ companyName, summaryLine, deepLink, senderName }: TemplateArgs): string {
  return [
    'Source documents required for receipt and transaction mapping.',
    '',
    `${senderName ? `${senderName} ` : ''}behöver ett kvittounderlag för ${companyName} innan en transaktion kan bokföras.`,
    '',
    summaryLine || 'Kvitto utan extraherade uppgifter',
    '',
    'Öppna agent-inkorgen och ladda upp en tydlig bild eller PDF av kvittot:',
    deepLink,
    '',
    'Send in receipts. Utan källunderlag kan bokföringen inte slutföras enligt BFL 5 kap 7§.',
  ].join('\n')
}
