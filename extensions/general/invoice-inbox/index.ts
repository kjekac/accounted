import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { classifyDocument } from './lib/classify-document'
import { analyzeExpenseWithTextract, checkTotalsAgreement } from './lib/textract-expense'
import type { TextractExpenseResult, AgreementResult } from './lib/textract-expense'
import {
  verifyInboundWebhook,
  fetchReceivingEmail,
  fetchInboundAttachment,
  extractLocalPartForDomain,
  isEmailReceivedEvent,
  ResendSignatureError,
} from './lib/resend-inbound'
import {
  rotateCompanyInbox,
  getActiveInbox,
  composeInboxAddress,
} from './lib/inbox-provisioning'
import { toSwedishInboxError } from './lib/error-messages'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { eventBus } from '@/lib/events/bus'
import type { InvoiceExtractionResult, InvoiceInboxItem, SupplierInvoice, SupplierInvoiceItem } from '@/types'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // Match MAX_DOCUMENT_SIZE from document-service

const UPLOAD_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
])

interface EmailMeta {
  from?: string | null
  subject?: string | null
  receivedAt?: string | null
  messageId?: string | null
  bodyText?: string | null
  resendEmailId?: string | null
  resendAttachmentId?: string | null
}

// ── Shared helper: upload + classify + create inbox item ─────

async function uploadAndClassify(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  companyId: string,
  file: { name: string; buffer: ArrayBuffer; type: string },
  source: 'upload' | 'email',
  emailMeta?: EmailMeta,
  ctx?: ExtensionContext
) {
  // Correlation ID threads through ingest → classify → match → book.
  const correlationId = crypto.randomUUID()

  // Store in WORM archive
  const doc = await uploadDocument(supabase, userId, companyId, {
    name: file.name,
    buffer: file.buffer,
    type: file.type,
  }, {
    upload_source: source === 'email' ? 'email' : 'file_upload',
  })

  // Audit: DocumentIngested
  try {
    await appendProcessingHistory({
      companyId,
      correlationId,
      aggregateType: 'Document',
      aggregateId: doc.id,
      eventType: 'DocumentIngested',
      payload: {
        channel: source,
        document_id: doc.id,
        mime_type: file.type,
        size_bytes: file.buffer.byteLength,
      },
      actor: source === 'email' ? { type: 'system', id: 'resend-inbound' } : { type: 'user', id: userId },
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[invoice-inbox] Failed to append DocumentIngested:', err)
  }

  // Classify with AI (Claude) + OCR (Textract) in parallel, then cross-check.
  const verification = await extractWithVerification(
    Buffer.from(file.buffer),
    file.type,
    file.name
  )
  const { classificationResult, classificationError, textract, agreement, needsReview } = verification

  // Audit: DocumentExtractionAttempted (fires whether classification succeeded or failed)
  try {
    await appendProcessingHistory({
      companyId,
      correlationId,
      aggregateType: 'Document',
      aggregateId: doc.id,
      eventType: 'DocumentExtractionAttempted',
      payload: {
        document_id: doc.id,
        succeeded: !classificationError,
        document_type: classificationResult?.documentType ?? null,
        confidence: classificationResult?.confidence ? classificationResult.confidence / 100 : null,
        llm_input_tokens: classificationResult?.usage?.inputTokens ?? 0,
        llm_output_tokens: classificationResult?.usage?.outputTokens ?? 0,
        error: classificationError,
      },
      actor: { type: 'llm', id: 'classify-document' },
      occurredAt: new Date(),
    })
  } catch (err) {
    console.error('[invoice-inbox] Failed to append DocumentExtractionAttempted:', err)
  }

  // Supplier matching
  let matchedSupplierId: string | null = null
  if (classificationResult?.documentType === 'supplier_invoice' && classificationResult.extractedData) {
    const extractedData = classificationResult.extractedData as InvoiceExtractionResult
    const orgNumber = extractedData.supplier?.orgNumber
    const supplierName = extractedData.supplier?.name

    if (orgNumber) {
      const normalized = orgNumber.replace(/\D/g, '')
      const { data: s } = await supabase
        .from('suppliers')
        .select('id')
        .eq('company_id', companyId)
        .eq('org_number', normalized)
        .limit(1)
        .maybeSingle()
      if (s) matchedSupplierId = s.id
    }
    if (!matchedSupplierId && supplierName) {
      const { data: s } = await supabase
        .from('suppliers')
        .select('id')
        .eq('company_id', companyId)
        .ilike('name', supplierName)
        .limit(1)
        .maybeSingle()
      if (s) matchedSupplierId = s.id
    }
  }

  // Create inbox item
  const { data: inbox, error: inboxError } = await supabase
    .from('invoice_inbox_items')
    .insert({
      company_id: companyId,
      user_id: userId,
      // OCR-only rows land as 'ready' with the Textract numbers populated —
      // still usable, just without Claude's semantic layer.
      status: classificationError && !textract ? 'error' : 'ready',
      source,
      document_id: doc.id,
      document_type: classificationResult?.documentType || (textract ? 'receipt' : 'unknown'),
      extracted_data: enrichExtractedData(classificationResult, textract, agreement),
      raw_llm_response: classificationResult?.rawResponse || null,
      confidence: classificationResult?.confidence
        ? classificationResult.confidence / 100
        : null,
      matched_supplier_id: matchedSupplierId,
      email_from: emailMeta?.from || null,
      email_subject: emailMeta?.subject || null,
      email_received_at: emailMeta?.receivedAt || null,
      email_body_text: emailMeta?.bodyText || null,
      resend_email_id: emailMeta?.resendEmailId || null,
      resend_attachment_id: emailMeta?.resendAttachmentId || null,
      raw_email_payload: emailMeta?.messageId
        ? { messageId: emailMeta.messageId, filename: file.name }
        : null,
      // Only surface the error when both reads failed. OCR fallback is a
      // successful outcome from the user's perspective.
      error_message: classificationError && !textract ? classificationError : null,
      correlation_id: correlationId,
    })
    .select('*')
    .single()

  if (inboxError) throw new Error(`Failed to create inbox item: ${inboxError.message}`)
  if (needsReview) {
    console.log('[invoice-inbox] OCR disagrees with Claude on inbox', inbox.id, agreement)
  }

  // Audit: DocumentClassified (only when classification succeeded)
  if (!classificationError && classificationResult) {
    try {
      await appendProcessingHistory({
        companyId,
        correlationId,
        aggregateType: 'Document',
        aggregateId: doc.id,
        eventType: 'DocumentClassified',
        payload: {
          document_id: doc.id,
          inbox_item_id: inbox.id,
          classification: classificationResult.documentType,
          confidence: classificationResult.confidence / 100,
        },
        actor: { type: 'system', id: 'invoice-inbox' },
        occurredAt: new Date(),
      })
    } catch (err) {
      console.error('[invoice-inbox] Failed to append DocumentClassified:', err)
    }
  }

  // Emit generic classified event for all document types.
  // Always emit via eventBus directly so the webhook path (no ExtensionContext) still triggers handlers.
  try {
    await eventBus.emit({
      type: 'inbox_item.classified',
      payload: {
        inboxItem: inbox as unknown as InvoiceInboxItem,
        documentType: inbox.document_type,
        confidence: inbox.confidence,
        correlationId,
        userId,
        companyId,
      },
    })
  } catch { /* non-blocking */ }

  // Emit supplier-invoice-specific events (kept for backward compatibility)
  if (inbox.document_type === 'supplier_invoice') {
    try {
      await eventBus.emit({
        type: 'supplier_invoice.received',
        payload: { inboxItem: inbox as unknown as InvoiceInboxItem, userId, companyId },
      })
    } catch { /* non-blocking */ }

    if (!classificationError && classificationResult?.confidence) {
      try {
        await eventBus.emit({
          type: 'supplier_invoice.extracted',
          payload: { inboxItem: inbox as unknown as InvoiceInboxItem, confidence: classificationResult.confidence / 100, userId, companyId },
        })
      } catch { /* non-blocking */ }
    }
  }

  return {
    document_id: doc.id,
    inbox_item_id: inbox.id,
    status: inbox.status,
    document_type: inbox.document_type,
    extracted_data: classificationResult?.extractedData || null,
    confidence: inbox.confidence,
    matched_supplier_id: inbox.matched_supplier_id,
    error_message: inbox.error_message,
  }
}

// ── Extraction + OCR cross-check helper ──────────────────────
//
// Runs Claude (vision) and Textract (receipt-specialized OCR) in parallel on
// the same file and returns an agreement verdict. Claude owns structure and
// semantics (merchant, line items, VAT treatment); Textract owns the raw
// numbers as a hallucination anchor. Disagreement on the total by more than
// 1 öre downgrades the row to needs_review so the UI can flag it.
//
// The two calls are independent; either can fail without killing the other.
// Claude-only is the historical default and still works if Textract skips
// (unsupported mime, too-large file, missing AWS perms).
interface ExtractionWithVerification {
  classificationResult: Awaited<ReturnType<typeof classifyDocument>> | undefined
  classificationError: string | null
  textract: TextractExpenseResult | null
  agreement: AgreementResult | null
  needsReview: boolean
}

async function extractWithVerification(
  fileBuffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<ExtractionWithVerification> {
  const claudePromise = classifyDocument({ fileBuffer, mimeType, fileName })
    .then((r) => ({ ok: true as const, value: r }))
    .catch((err) => {
      console.error('[invoice-inbox/classify] Bedrock classify failed:', err)
      return { ok: false as const, error: toSwedishInboxError(err) }
    })

  const textractPromise = analyzeExpenseWithTextract(fileBuffer, mimeType)

  const [claudeResult, textract] = await Promise.all([claudePromise, textractPromise])

  const classificationResult = claudeResult.ok ? claudeResult.value : undefined
  const classificationError = claudeResult.ok ? null : claudeResult.error

  // Pull Claude's receipt/invoice total for comparison. Handles both shapes.
  const data = classificationResult?.extractedData as
    | { totals?: { total?: number | null } }
    | null
    | undefined
  const claudeTotal = data?.totals?.total ?? null
  const agreement = checkTotalsAgreement(claudeTotal, textract)

  // needs_review when the two reads disagree. Missing-total cases are handled
  // elsewhere (rowNeedsRescan) and shouldn't double-flag here.
  const needsReview = agreement !== null && !agreement.agrees

  return { classificationResult, classificationError, textract, agreement, needsReview }
}

// Build the enriched extracted_data JSON: Claude's output plus an _ocr and
// _verification block. Stays non-breaking — existing consumers read the
// top-level fields unchanged; new consumers (UI, audit) can read the nested
// verification block.
function enrichExtractedData(
  classificationResult: Awaited<ReturnType<typeof classifyDocument>> | undefined,
  textract: TextractExpenseResult | null,
  agreement: AgreementResult | null
): Record<string, unknown> | null {
  if (!classificationResult?.extractedData) {
    // Claude failed but Textract may have run. Surface OCR as a fallback so
    // the UI can still show _something_ from the receipt.
    if (!textract) return null
    return {
      merchant: textract.vendor ? { name: textract.vendor.value } : null,
      receipt: textract.date ? { date: textract.date.value, currency: textract.currency } : null,
      totals: textract.total
        ? { total: textract.total.value, vatAmount: textract.tax?.value ?? null, subtotal: textract.subtotal?.value ?? null }
        : null,
      _ocr: textract,
      _verification: { claude_available: false },
      _source: 'ocr_only',
    }
  }
  return {
    ...(classificationResult.extractedData as unknown as Record<string, unknown>),
    _ocr: textract,
    _verification: agreement,
  }
}

// ── Rescan helper ────────────────────────────────────────────

// Re-runs classification on an existing inbox item's source file. Used by the
// per-row "Skanna igen" button and the batch "Skanna oskannade" action so
// users can recover rows that errored or came back with incomplete data
// without reuploading. The row is updated in place — same id, same document,
// refreshed extracted_data and status.
async function rescanInboxItem(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  companyId: string,
  inboxItemId: string
): Promise<{ ok: true; id: string } | { ok: false; id: string; error: string }> {
  const { data: item } = await supabase
    .from('invoice_inbox_items')
    .select('id, company_id, document_id, correlation_id, status')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!item) return { ok: false, id: inboxItemId, error: 'Inbox item not found' }
  if (!item.document_id) return { ok: false, id: inboxItemId, error: 'No source document attached' }
  if (item.status === 'confirmed') return { ok: false, id: inboxItemId, error: 'Already booked' }

  const { data: doc } = await supabase
    .from('document_attachments')
    .select('storage_path, mime_type, file_name')
    .eq('id', item.document_id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!doc || !doc.storage_path) return { ok: false, id: inboxItemId, error: 'Document file missing' }

  const { data: blob, error: dlError } = await supabase.storage
    .from('documents')
    .download(doc.storage_path)
  if (dlError || !blob) return { ok: false, id: inboxItemId, error: dlError?.message || 'Download failed' }

  const buffer = Buffer.from(await blob.arrayBuffer())

  const verification = await extractWithVerification(
    buffer,
    doc.mime_type ?? 'application/octet-stream',
    doc.file_name ?? 'document'
  )
  const { classificationResult, classificationError, textract, agreement } = verification

  const { error: updateError } = await supabase
    .from('invoice_inbox_items')
    .update({
      status: classificationError && !textract ? 'error' : 'ready',
      document_type: classificationResult?.documentType ?? (textract ? 'receipt' : 'unknown'),
      extracted_data: enrichExtractedData(classificationResult, textract, agreement),
      raw_llm_response: classificationResult?.rawResponse ?? null,
      confidence: classificationResult?.confidence ? classificationResult.confidence / 100 : null,
      error_message: classificationError && !textract ? classificationError : null,
    })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)

  if (updateError) return { ok: false, id: inboxItemId, error: updateError.message }

  // Audit — same event shape as initial classify so the history timeline is consistent.
  if (item.correlation_id) {
    try {
      await appendProcessingHistory({
        companyId,
        correlationId: item.correlation_id,
        aggregateType: 'Document',
        aggregateId: item.document_id,
        eventType: 'DocumentExtractionAttempted',
        payload: {
          document_id: item.document_id,
          inbox_item_id: inboxItemId,
          succeeded: !classificationError,
          document_type: classificationResult?.documentType ?? null,
          confidence: classificationResult?.confidence ? classificationResult.confidence / 100 : null,
          llm_input_tokens: classificationResult?.usage?.inputTokens ?? 0,
          llm_output_tokens: classificationResult?.usage?.outputTokens ?? 0,
          error: classificationError,
          retry: true,
        },
        actor: { type: 'llm', id: 'classify-document' },
        occurredAt: new Date(),
      })
    } catch (err) {
      console.error('[invoice-inbox/rescan] appendProcessingHistory failed:', err)
    }
  }

  // Re-emit classified event on any successful extraction (Claude or OCR
  // fallback) so the AI orchestrator can generate a match proposal.
  const succeeded = classificationResult != null || textract != null
  if (succeeded) {
    try {
      const { data: refreshed } = await supabase
        .from('invoice_inbox_items')
        .select('*')
        .eq('id', inboxItemId)
        .maybeSingle()
      if (refreshed) {
        await eventBus.emit({
          type: 'inbox_item.classified',
          payload: {
            inboxItem: refreshed as unknown as InvoiceInboxItem,
            documentType: refreshed.document_type,
            confidence: refreshed.confidence,
            correlationId: item.correlation_id ?? crypto.randomUUID(),
            userId: (refreshed as { user_id: string }).user_id,
            companyId,
          },
        })
      }
    } catch { /* non-blocking */ }
  }

  return succeeded
    ? { ok: true, id: inboxItemId }
    : { ok: false, id: inboxItemId, error: classificationError ?? 'Extraction failed' }
}

// A row needs rescanning when extraction failed, or when it succeeded but
// came back without the fields we actually need to propose a match (total +
// date). Keep the heuristic permissive — false positives just mean a user
// clicking "Skanna igen" on a good row, which is harmless.
function needsRescan(row: {
  status: string | null
  extracted_data: unknown
}): boolean {
  if (row.status === 'error') return true
  const data = row.extracted_data as { totals?: { total?: number | null } } | null
  if (!data) return true
  if (data.totals?.total == null) return true
  return false
}

// ── Admin/owner check helper ──────────────────────────────────

async function isCompanyAdmin(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  userId: string,
  companyId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  return !!data && ['owner', 'admin'].includes(data.role)
}

// ── Extension definition ─────────────────────────────────────

export const invoiceInboxExtension: Extension = {
  id: 'invoice-inbox',
  name: 'Dokumentinkorg',
  version: '2.0.0',

  apiRoutes: [
    // ── Upload ──────────────────────────────────────────────
    {
      method: 'POST',
      path: '/upload',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const formData = await request.formData()
        const file = formData.get('file') as File | null

        if (!file) {
          return NextResponse.json({ error: 'No file provided' }, { status: 400 })
        }
        if (file.size > MAX_FILE_SIZE) {
          return NextResponse.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` }, { status: 400 })
        }
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(file.type)) {
          return NextResponse.json(
            { error: `Unsupported file type: ${file.type}. Allowed: PDF, JPEG, PNG, HEIC, WebP` },
            { status: 400 }
          )
        }

        try {
          const buffer = await file.arrayBuffer()
          const result = await uploadAndClassify(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            { name: file.name, buffer, type: file.type },
            'upload',
            undefined,
            ctx
          )
          return NextResponse.json({ data: result })
        } catch (error) {
          console.error('[invoice-inbox/upload] Failed:', error)
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Upload failed' },
            { status: 500 }
          )
        }
      },
    },

    // ── Rescan (per-row or batch) ───────────────────────────
    // Re-runs the LLM classifier against the already-uploaded source file.
    // Body shapes:
    //   { inbox_item_ids: uuid[] }  → rescan those rows (must belong to company)
    //   {}                          → rescan all receipt rows that look stuck
    //                                 (status='error' or missing extracted totals)
    {
      method: 'POST',
      path: '/rescan',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: { inbox_item_ids?: string[] } = {}
        try { body = await request.json() } catch { /* allow empty body */ }

        let ids: string[] = []
        if (Array.isArray(body.inbox_item_ids) && body.inbox_item_ids.length > 0) {
          ids = body.inbox_item_ids.filter((id): id is string => typeof id === 'string')
        } else {
          const { data: rows } = await ctx.supabase
            .from('invoice_inbox_items')
            .select('id, status, extracted_data')
            .eq('company_id', ctx.companyId)
            .eq('document_type', 'receipt')
            .not('status', 'eq', 'confirmed')
            .not('document_id', 'is', null)
            .limit(100)
          ids = (rows ?? []).filter((r) => needsRescan(r)).map((r) => r.id)
        }

        if (ids.length === 0) {
          return NextResponse.json({ data: { rescanned: 0, failed: 0, outcomes: [] } })
        }

        // Serial rather than parallel — Bedrock rate limits kick in hard past
        // ~5 concurrent. 100-receipt rescan × 3s each = 5min, acceptable as a
        // backgrounded action. The UI fires and refreshes, doesn't block.
        const outcomes: Array<{ id: string; ok: boolean; error?: string }> = []
        for (const id of ids) {
          const res = await rescanInboxItem(ctx.supabase, ctx.companyId, id)
          outcomes.push(res.ok ? { id, ok: true } : { id, ok: false, error: res.error })
        }

        const rescanned = outcomes.filter((o) => o.ok).length
        const failed = outcomes.length - rescanned

        return NextResponse.json({ data: { rescanned, failed, outcomes } })
      },
    },

    // ── Manual extraction fallback ──────────────────────────
    // Lets the user type merchant/date/total when the LLM can't read the image.
    // The picture is untouched (still attached as source document); we just
    // overwrite extracted_data with user-supplied values and flip status to
    // 'ready' so downstream matching can proceed.
    {
      method: 'POST',
      path: '/manual-extract',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        let body: {
          inbox_item_id?: string
          merchant?: string
          date?: string
          total?: number
          currency?: string
          vat_amount?: number | null
        } = {}
        try { body = await request.json() } catch { /* fall through to validation */ }

        const { inbox_item_id, merchant, date, total, currency } = body
        if (!inbox_item_id || !merchant || !date || typeof total !== 'number') {
          return NextResponse.json(
            { error: 'inbox_item_id, merchant, date och total krävs.' },
            { status: 400 }
          )
        }

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id, correlation_id, status')
          .eq('id', inbox_item_id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()
        if (!item) return NextResponse.json({ error: 'Kvittot hittades inte.' }, { status: 404 })
        if (!item.document_id) {
          return NextResponse.json({ error: 'Kvittobild saknas — ladda upp en bild först.' }, { status: 400 })
        }
        if (item.status === 'confirmed') {
          return NextResponse.json({ error: 'Redan bokfört.' }, { status: 409 })
        }

        const extracted_data = {
          merchant: { name: merchant },
          receipt: { date, currency: currency ?? 'SEK' },
          totals: {
            total,
            vatAmount: typeof body.vat_amount === 'number' ? body.vat_amount : null,
            subtotal: null,
          },
          lineItems: null,
          flags: null,
          _entry_method: 'manual',
        }

        const { error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({
            status: 'ready',
            document_type: 'receipt',
            extracted_data,
            confidence: 1,
            error_message: null,
          })
          .eq('id', inbox_item_id)
          .eq('company_id', ctx.companyId)

        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

        if (item.correlation_id) {
          try {
            await appendProcessingHistory({
              companyId: ctx.companyId,
              correlationId: item.correlation_id,
              aggregateType: 'Document',
              aggregateId: item.document_id,
              eventType: 'DocumentExtractionAttempted',
              payload: {
                document_id: item.document_id,
                inbox_item_id,
                succeeded: true,
                document_type: 'receipt',
                confidence: 1,
                llm_input_tokens: 0,
                llm_output_tokens: 0,
                error: null,
                manual: true,
              },
              actor: { type: 'user', id: ctx.userId },
              occurredAt: new Date(),
            })
          } catch (err) {
            console.error('[invoice-inbox/manual-extract] appendProcessingHistory failed:', err)
          }
        }

        // Fire match-proposal generation via the classified event.
        try {
          const { data: refreshed } = await ctx.supabase
            .from('invoice_inbox_items')
            .select('*')
            .eq('id', inbox_item_id)
            .maybeSingle()
          if (refreshed) {
            await eventBus.emit({
              type: 'inbox_item.classified',
              payload: {
                inboxItem: refreshed as unknown as InvoiceInboxItem,
                documentType: 'receipt',
                confidence: 1,
                correlationId: item.correlation_id ?? crypto.randomUUID(),
                userId: ctx.userId,
                companyId: ctx.companyId,
              },
            })
          }
        } catch { /* non-blocking */ }

        return NextResponse.json({ data: { ok: true } })
      },
    },

    // ── List inbox items ────────────────────────────────────
    {
      method: 'GET',
      path: '/items',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const status = url.searchParams.get('status')
        const documentType = url.searchParams.get('document_type')
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 20), 50)

        let query = ctx.supabase
          .from('invoice_inbox_items')
          .select(`
            id, status, document_type, confidence, source, created_at, extracted_data,
            matched_supplier_id, document_id, email_from, email_subject, error_message,
            resend_email_id,
            matched_transaction_id, match_confidence, match_method, match_reasoning,
            matched_transaction:transactions!matched_transaction_id(id, description, amount, currency, date)
          `)
          .eq('company_id', ctx.companyId)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (status) query = query.eq('status', status)
        if (documentType) query = query.eq('document_type', documentType)

        const { data, error } = await query
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        return NextResponse.json({ data: { items: data, count: data?.length ?? 0 } })
      },
    },

    // ── Get processing_history timeline for an inbox item ───
    {
      method: 'GET',
      path: '/items/:id/history',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        // Resolve correlation_id via the inbox item (also enforces company scope)
        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, correlation_id, company_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        if (!item.correlation_id) {
          // Legacy rows created before the correlation_id column have no history
          return NextResponse.json({ data: { events: [] } })
        }

        const { data: events, error } = await ctx.supabase
          .from('processing_history')
          .select('event_id, event_type, occurred_at, payload, actor, causation_id')
          .eq('company_id', ctx.companyId)
          .eq('correlation_id', item.correlation_id)
          .order('occurred_at', { ascending: true })
          .limit(100)

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({ data: { events: events ?? [] } })
      },
    },

    // ── Get single inbox item ───────────────────────────────
    {
      method: 'GET',
      path: '/items/:id',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data, error } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('*')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .single()

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

        return NextResponse.json({ data })
      },
    },

    // ── Attach a source document to an existing inbox item ──
    // For rows that ended up without a picture (e.g. email came through but
    // attachment extraction failed, or manually-created rows). Uploads the
    // file, links document_id on the row, then runs classify so the numbers
    // get extracted in the same request.
    {
      method: 'POST',
      path: '/items/:id/attach-document',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const formData = await request.formData()
        const file = formData.get('file') as File | null
        if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
        if (file.size > MAX_FILE_SIZE) {
          return NextResponse.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` }, { status: 400 })
        }
        if (!UPLOAD_ALLOWED_MIME_TYPES.has(file.type)) {
          return NextResponse.json(
            { error: `Unsupported file type: ${file.type}. Allowed: PDF, JPEG, PNG, HEIC, WebP` },
            { status: 400 }
          )
        }

        const { data: item } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, document_id, status, correlation_id')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .maybeSingle()

        if (!item) return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        if (item.status === 'confirmed') {
          return NextResponse.json({ error: 'Redan bokfört — kan inte ersätta bilden.' }, { status: 409 })
        }
        if (item.document_id) {
          return NextResponse.json({ error: 'Kvittot har redan en bild.' }, { status: 409 })
        }

        try {
          const buffer = await file.arrayBuffer()
          const doc = await uploadDocument(ctx.supabase, ctx.userId, ctx.companyId, {
            name: file.name,
            buffer,
            type: file.type,
          }, {
            upload_source: 'file_upload',
          })

          const { error: linkError } = await ctx.supabase
            .from('invoice_inbox_items')
            .update({ document_id: doc.id })
            .eq('id', id)
            .eq('company_id', ctx.companyId)
          if (linkError) {
            return NextResponse.json({ error: linkError.message }, { status: 500 })
          }

          // Audit the ingest — mirrors the initial-upload path.
          if (item.correlation_id) {
            try {
              await appendProcessingHistory({
                companyId: ctx.companyId,
                correlationId: item.correlation_id,
                aggregateType: 'Document',
                aggregateId: doc.id,
                eventType: 'DocumentIngested',
                payload: {
                  channel: 'upload',
                  document_id: doc.id,
                  inbox_item_id: id,
                  mime_type: file.type,
                  size_bytes: file.size,
                  attached_to_existing: true,
                },
                actor: { type: 'user', id: ctx.userId },
                occurredAt: new Date(),
              })
            } catch (err) {
              console.error('[invoice-inbox/attach-document] appendProcessingHistory failed:', err)
            }
          }

          // Now run classification on the freshly-attached image.
          const rescan = await rescanInboxItem(ctx.supabase, ctx.companyId, id)
          return NextResponse.json({
            data: {
              document_id: doc.id,
              inbox_item_id: id,
              classified: rescan.ok,
              error: rescan.ok ? null : rescan.error,
            },
          })
        } catch (error) {
          console.error('[invoice-inbox/attach-document] Failed:', error)
          return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Attach failed' },
            { status: 500 }
          )
        }
      },
    },

    // ── Get this company's inbox address ────────────────────
    {
      method: 'GET',
      path: '/inbox/address',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const domain = process.env.RESEND_INBOUND_DOMAIN
        if (!domain) {
          return NextResponse.json({ error: 'RESEND_INBOUND_DOMAIN not configured' }, { status: 503 })
        }

        try {
          const inbox = await getActiveInbox(ctx.supabase, ctx.companyId)
          if (!inbox) {
            return NextResponse.json({ error: 'No active inbox' }, { status: 404 })
          }
          return NextResponse.json({
            data: {
              address: composeInboxAddress(inbox.local_part, domain),
              local_part: inbox.local_part,
              status: inbox.status,
              created_at: inbox.created_at,
            },
          })
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Failed to load inbox' },
            { status: 500 }
          )
        }
      },
    },

    // ── Rotate inbox address (admin/owner only) ─────────────
    {
      method: 'POST',
      path: '/inbox/rotate',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const domain = process.env.RESEND_INBOUND_DOMAIN
        if (!domain) {
          return NextResponse.json({ error: 'RESEND_INBOUND_DOMAIN not configured' }, { status: 503 })
        }

        const isAdmin = await isCompanyAdmin(ctx.supabase, ctx.userId, ctx.companyId)
        if (!isAdmin) return NextResponse.json({ error: 'Behörighet saknas.' }, { status: 403 })

        try {
          // rotate_company_inbox is SECURITY DEFINER and does its own
          // auth.uid() role check. Call it through the user's JWT-bearing
          // client — a service-role client has no session, so auth.uid()
          // returns NULL and the in-RPC check always fails with 42501.
          const newInbox = await rotateCompanyInbox(ctx.supabase, ctx.companyId)
          return NextResponse.json({
            data: {
              address: composeInboxAddress(newInbox.local_part, domain),
              local_part: newInbox.local_part,
              status: newInbox.status,
            },
          })
        } catch (err) {
          console.error('[invoice-inbox/inbox/rotate] Failed:', err)
          return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Rotation failed' },
            { status: 500 }
          )
        }
      },
    },

    // ── Resend Inbound webhook (Svix-signed, no user auth) ──
    {
      method: 'POST',
      path: '/inbound',
      skipAuth: true,
      handler: async (request: Request) => {
        const domain = process.env.RESEND_INBOUND_DOMAIN
        if (!domain) {
          console.error('[invoice-inbox/inbound] RESEND_INBOUND_DOMAIN not configured')
          return NextResponse.json({ error: 'Inbound not configured' }, { status: 503 })
        }

        const rawBody = await request.text()

        // 1. Verify Svix signature
        let event
        try {
          event = verifyInboundWebhook(rawBody, request.headers)
        } catch (err) {
          if (err instanceof ResendSignatureError) {
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
          }
          console.error('[invoice-inbox/inbound] Verification error:', err)
          return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
        }

        // 2. Only process email.received events
        if (!isEmailReceivedEvent(event)) {
          return NextResponse.json({ data: { ignored: event.type } }, { status: 200 })
        }

        const { email_id, to, from, subject, message_id, created_at } = event.data

        // 3. Find the recipient that matches our domain
        const localPart = extractLocalPartForDomain(to, domain)
        if (!localPart) {
          console.warn('[invoice-inbox/inbound] No recipient matched domain', { to, domain })
          return NextResponse.json({ error: 'No matching recipient' }, { status: 404 })
        }

        // 4. Look up company_inbox (service role — webhook has no user session)
        const serviceSupabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        const { data: inbox } = await serviceSupabase
          .from('company_inboxes')
          .select('id, company_id, status')
          .eq('local_part', localPart)
          .maybeSingle()

        if (!inbox) {
          return NextResponse.json({ error: 'Address not found' }, { status: 404 })
        }
        if (inbox.status !== 'active') {
          // Deprecated or blocked → hard-bounce so Resend returns a 5xx to the sender
          return NextResponse.json({ error: 'Address no longer active' }, { status: 410 })
        }

        // 5. Resolve a user_id for the inbox item (schema requires NOT NULL).
        //    Use company owner (companies.created_by).
        const { data: company } = await serviceSupabase
          .from('companies')
          .select('created_by')
          .eq('id', inbox.company_id)
          .single()

        if (!company?.created_by) {
          console.error('[invoice-inbox/inbound] Company has no created_by', inbox.company_id)
          return NextResponse.json({ error: 'Company owner missing' }, { status: 500 })
        }
        const userId = company.created_by

        // 7. Fetch full email (body + attachment metadata)
        let fullEmail
        try {
          fullEmail = await fetchReceivingEmail(email_id)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.error('[invoice-inbox/inbound] Failed to fetch received email:', err)
          return NextResponse.json({ error: `Fetch failed: ${message}` }, { status: 500 })
        }

        const bodyText = fullEmail.text ?? null
        const attachments = fullEmail.attachments ?? []

        // 8. If no attachments, still log the email as an inbox item so the user sees it
        if (attachments.length === 0) {
          await serviceSupabase.from('invoice_inbox_items').insert({
            company_id: inbox.company_id,
            user_id: userId,
            status: 'error',
            source: 'email',
            email_from: from,
            email_subject: subject,
            email_received_at: created_at,
            email_body_text: bodyText,
            resend_email_id: email_id,
            document_type: 'unknown',
            error_message: 'Email had no attachments',
            raw_email_payload: { messageId: message_id },
          })
          return NextResponse.json({ data: { processed: 0, reason: 'no_attachments' } })
        }

        // 9. Download + classify each attachment (per-attachment idempotency)
        const results: Array<{ attachment_id: string; inbox_item_id?: string; error?: string; duplicate?: boolean }> = []
        for (const att of attachments) {
          try {
            // Skip if this (email_id, attachment_id) was already processed
            const { data: existing } = await serviceSupabase
              .from('invoice_inbox_items')
              .select('id')
              .eq('resend_email_id', email_id)
              .eq('resend_attachment_id', att.id)
              .maybeSingle()
            if (existing) {
              results.push({ attachment_id: att.id, inbox_item_id: existing.id, duplicate: true })
              continue
            }

            const download = await fetchInboundAttachment(email_id, att.id)
            if (!UPLOAD_ALLOWED_MIME_TYPES.has(download.contentType)) {
              results.push({ attachment_id: att.id, error: `Unsupported type ${download.contentType}` })
              continue
            }
            if (download.buffer.byteLength > MAX_FILE_SIZE) {
              results.push({ attachment_id: att.id, error: 'Attachment too large' })
              continue
            }

            const result = await uploadAndClassify(
              serviceSupabase,
              userId,
              inbox.company_id,
              { name: download.filename, buffer: download.buffer, type: download.contentType },
              'email',
              {
                from,
                subject,
                receivedAt: created_at,
                messageId: message_id,
                bodyText,
                resendEmailId: email_id,
                resendAttachmentId: att.id,
              }
            )
            results.push({ attachment_id: att.id, inbox_item_id: result.inbox_item_id })
          } catch (err) {
            console.error('[invoice-inbox/inbound] Attachment processing failed:', err)
            results.push({
              attachment_id: att.id,
              error: err instanceof Error ? err.message : 'Unknown error',
            })
          }
        }

        return NextResponse.json({ data: { processed: results.length, results } })
      },
    },

    // ── Reject inbox item ──────────────────────────────────
    {
      method: 'PATCH',
      path: '/items/:id/reject',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(_request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        const { data: item, error: fetchError } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('id, status')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .single()

        if (fetchError || !item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
        if (item.status === 'confirmed') return NextResponse.json({ error: 'Cannot reject a confirmed item' }, { status: 409 })

        const { error: updateError } = await ctx.supabase
          .from('invoice_inbox_items')
          .update({ status: 'rejected' })
          .eq('id', id)
          .eq('company_id', ctx.companyId)

        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
        return NextResponse.json({ data: { id, status: 'rejected' } })
      },
    },

    // ── Convert inbox item to supplier invoice ─────────────
    {
      method: 'POST',
      path: '/items/:id/convert',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

        // Fetch inbox item
        const { data: item, error: fetchError } = await ctx.supabase
          .from('invoice_inbox_items')
          .select('*')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .single()

        if (fetchError || !item) return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 })
        if (item.status !== 'ready') return NextResponse.json({ error: 'Item is not in ready status' }, { status: 409 })

        // Validate request body
        let body: ReturnType<typeof CreateSupplierInvoiceSchema.parse>
        try {
          const json = await request.json()
          body = CreateSupplierInvoiceSchema.parse(json)
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid request body'
          return NextResponse.json({ error: message }, { status: 400 })
        }

        // Verify supplier exists
        const { data: supplier, error: supplierError } = await ctx.supabase
          .from('suppliers')
          .select('*')
          .eq('id', body.supplier_id)
          .eq('company_id', ctx.companyId)
          .single()

        if (supplierError || !supplier) {
          return NextResponse.json({ error: 'Supplier not found' }, { status: 404 })
        }

        // Get next arrival number
        const { data: arrivalNum, error: arrivalError } = await ctx.supabase
          .rpc('get_next_arrival_number', { p_company_id: ctx.companyId })

        if (arrivalError) {
          return NextResponse.json({ error: 'Failed to get arrival number' }, { status: 500 })
        }

        // Calculate totals (same logic as app/api/supplier-invoices/route.ts)
        const items = body.items.map((bodyItem, index) => {
          const vatRate = bodyItem.vat_rate ?? 0.25
          const lineTotal = bodyItem.amount != null
            ? Math.round(bodyItem.amount * 100) / 100
            : Math.round((bodyItem.quantity ?? 1) * (bodyItem.unit_price ?? 0) * 100) / 100
          const vatAmount = Math.round(lineTotal * vatRate * 100) / 100
          return {
            sort_order: index,
            description: bodyItem.description,
            quantity: bodyItem.amount != null ? 1 : (bodyItem.quantity ?? 1),
            unit: bodyItem.amount != null ? 'st' : (bodyItem.unit || 'st'),
            unit_price: bodyItem.amount != null ? lineTotal : (bodyItem.unit_price ?? 0),
            line_total: lineTotal,
            account_number: bodyItem.account_number,
            vat_code: bodyItem.vat_code || null,
            vat_rate: vatRate,
            vat_amount: vatAmount,
          }
        })

        const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
        const totalVat = items.reduce((sum, i) => sum + i.vat_amount, 0)
        const total = Math.round((subtotal + totalVat) * 100) / 100

        const exchangeRate = body.exchange_rate || null
        const subtotalSek = exchangeRate ? Math.round(subtotal * exchangeRate * 100) / 100 : null
        const vatAmountSek = exchangeRate ? Math.round(totalVat * exchangeRate * 100) / 100 : null
        const totalSek = exchangeRate ? Math.round(total * exchangeRate * 100) / 100 : null

        // Insert supplier invoice
        const { data: invoice, error: invoiceError } = await ctx.supabase
          .from('supplier_invoices')
          .insert({
            user_id: ctx.userId,
            company_id: ctx.companyId,
            supplier_id: body.supplier_id,
            arrival_number: arrivalNum,
            supplier_invoice_number: body.supplier_invoice_number,
            invoice_date: body.invoice_date,
            due_date: body.due_date,
            delivery_date: body.delivery_date || null,
            status: 'registered',
            currency: body.currency || 'SEK',
            exchange_rate: exchangeRate,
            vat_treatment: body.vat_treatment || 'standard_25',
            reverse_charge: body.reverse_charge || false,
            payment_reference: body.payment_reference || null,
            subtotal: Math.round(subtotal * 100) / 100,
            subtotal_sek: subtotalSek,
            vat_amount: Math.round(totalVat * 100) / 100,
            vat_amount_sek: vatAmountSek,
            total: Math.round(total * 100) / 100,
            total_sek: totalSek,
            remaining_amount: Math.round(total * 100) / 100,
            document_id: item.document_id || null,
            notes: body.notes || null,
          })
          .select()
          .single()

        if (invoiceError || !invoice) {
          return NextResponse.json({ error: invoiceError?.message || 'Failed to create invoice' }, { status: 500 })
        }

        // Insert line items
        const itemInserts = items.map((lineItem) => ({
          supplier_invoice_id: invoice.id,
          ...lineItem,
        }))

        const { error: itemsError } = await ctx.supabase
          .from('supplier_invoice_items')
          .insert(itemInserts)

        if (itemsError) {
          await ctx.supabase.from('supplier_invoices').delete().eq('id', invoice.id)
          return NextResponse.json({ error: itemsError.message }, { status: 500 })
        }

        // Accrual method: create registration journal entry
        const { data: settings } = await ctx.supabase
          .from('company_settings')
          .select('accounting_method')
          .eq('company_id', ctx.companyId)
          .single()

        const accountingMethod = settings?.accounting_method || 'accrual'
        let registrationJournalEntryId: string | null = null

        if (accountingMethod === 'accrual') {
          try {
            const journalEntry = await createSupplierInvoiceRegistrationEntry(
              ctx.supabase,
              ctx.companyId,
              ctx.userId,
              invoice as SupplierInvoice,
              items as SupplierInvoiceItem[],
              supplier.supplier_type,
              supplier.name
            )
            if (journalEntry) {
              registrationJournalEntryId = journalEntry.id
              ;(invoice as SupplierInvoice).registration_journal_entry_id = journalEntry.id
              await ctx.supabase
                .from('supplier_invoices')
                .update({ registration_journal_entry_id: journalEntry.id })
                .eq('id', invoice.id)

              // Link the document to the journal entry
              if (item.document_id) {
                await ctx.supabase
                  .from('document_attachments')
                  .update({ journal_entry_id: journalEntry.id })
                  .eq('id', item.document_id)
                  .eq('company_id', ctx.companyId)
              }
            }
          } catch (err) {
            console.error('[invoice-inbox/convert] Failed to create registration journal entry:', err)
          }
        }

        // Emit supplier_invoice.registered
        try {
          await ctx.emit({
            type: 'supplier_invoice.registered',
            payload: { supplierInvoice: invoice as SupplierInvoice, companyId: ctx.companyId, userId: ctx.userId },
          })
        } catch { /* non-blocking */ }

        // Update inbox item to confirmed
        await ctx.supabase
          .from('invoice_inbox_items')
          .update({ status: 'confirmed', created_supplier_invoice_id: invoice.id })
          .eq('id', id)

        // Emit supplier_invoice.confirmed
        try {
          await ctx.emit({
            type: 'supplier_invoice.confirmed',
            payload: {
              inboxItem: { ...item, status: 'confirmed', created_supplier_invoice_id: invoice.id } as InvoiceInboxItem,
              supplierInvoice: invoice as SupplierInvoice,
              userId: ctx.userId,
              companyId: ctx.companyId,
            },
          })
        } catch { /* non-blocking */ }

        // Suggest matching transaction (don't book — user confirms in UI)
        let suggestedTransaction: { id: string; description: string; amount: number; currency: string; date: string } | null = null
        try {
          const invoiceTotal = Math.round(total * 100) / 100
          const invoiceTotalSek = totalSek ? Math.round(totalSek * 100) / 100 : null

          const { data: candidates } = await ctx.supabase
            .from('transactions')
            .select('id, description, amount, currency, date')
            .eq('company_id', ctx.companyId)
            .is('supplier_invoice_id', null)
            .lt('amount', 0)
            .order('date', { ascending: false })
            .limit(100)

          if (candidates?.length) {
            const supplierWords = supplier.name.toLowerCase().replace(/[,.\-]/g, ' ').split(/\s+/).filter((w: string) => w.length >= 3)

            const match = candidates.find((tx) => {
              const txAmount = Math.round(Math.abs(tx.amount) * 100) / 100
              const txDesc = tx.description?.toLowerCase() || ''

              const exactMatch = txAmount === invoiceTotal
              const sekMatch = invoiceTotalSek != null && tx.currency === 'SEK' && Math.abs(txAmount - invoiceTotalSek) / invoiceTotalSek < 0.05

              const nameMatch = supplierWords.some((word: string) => {
                if (txDesc.includes(word)) return true
                const txWords = txDesc.split(/\s+/)
                return txWords.some((tw: string) => {
                  if (tw.length < 3 || word.length < 3) return false
                  if (Math.abs(tw.length - word.length) > 1) return false
                  let diffs = 0
                  const longer = tw.length >= word.length ? tw : word
                  const shorter = tw.length >= word.length ? word : tw
                  let j = 0
                  for (let i = 0; i < longer.length && diffs <= 1; i++) {
                    if (longer[i] !== shorter[j]) { diffs++; if (longer.length === shorter.length) j++ }
                    else { j++ }
                  }
                  return diffs <= 1
                })
              })

              return (exactMatch || sekMatch) && nameMatch
            })

            if (match) {
              suggestedTransaction = match as unknown as typeof suggestedTransaction
            }
          }
        } catch (err) {
          console.error('[invoice-inbox/convert] Transaction suggestion failed (non-blocking):', err)
        }

        return NextResponse.json({
          data: {
            ...invoice,
            items: itemInserts,
            registration_journal_entry_id: registrationJournalEntryId,
            inbox_item_id: id,
            suggested_transaction: suggestedTransaction,
          },
        })
      },
    },
  ],
}
