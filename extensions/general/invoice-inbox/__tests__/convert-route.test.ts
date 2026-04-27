import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  makeInvoiceInboxItem,
  makeSupplier,
  makeCompanySettings,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
}))

// ── Helpers ──────────────────────────────────────────────────

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path
  )!
}

function buildCtx(supabase: unknown, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
    ...overrides,
  } as ExtensionContext
}

const SUPPLIER_UUID = '00000000-0000-4000-8000-000000000001'
const ITEM_UUID = '00000000-0000-4000-8000-000000000002'

const VALID_CONVERT_BODY = {
  supplier_id: SUPPLIER_UUID,
  supplier_invoice_number: 'F-2024-001',
  invoice_date: '2024-06-15',
  due_date: '2024-07-15',
  items: [
    { description: 'Konsulttjänster', amount: 10000, account_number: '6200', vat_rate: 0.25 },
  ],
}

// ── POST /items/:id/convert ──────────────────────────────────

describe('POST /items/:id/convert', () => {
  const route = findRoute('POST', '/items/:id/convert')

  it('returns 401 when no context', async () => {
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, undefined)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 404 when item not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'Not found' } }) // fetch inbox item

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 when item status is not ready', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'confirmed' }) }) // fetch inbox item

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('returns 400 when required fields missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'ready' }) }) // fetch inbox item

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: { items: [] }, // missing required fields
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when supplier not found in company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'ready' }) }) // fetch inbox item
    enqueue({ data: null, error: { message: 'Not found' } }) // fetch supplier

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('successfully converts inbox item to supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inboxItem = makeInvoiceInboxItem({ status: 'ready', document_id: 'doc-1' })
    const supplier = makeSupplier({ id: 'supplier-1' })
    const createdInvoice = {
      id: 'invoice-1',
      user_id: 'user-1',
      company_id: 'company-1',
      supplier_id: SUPPLIER_UUID,
      arrival_number: 42,
      supplier_invoice_number: 'F-2024-001',
      total: 12500,
      status: 'registered',
    }

    enqueue({ data: inboxItem }) // fetch inbox item
    enqueue({ data: supplier }) // fetch supplier
    enqueue({ data: 42 }) // get_next_arrival_number RPC
    enqueue({ data: createdInvoice }) // insert supplier_invoices
    enqueue({ data: null, error: null }) // insert supplier_invoice_items
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) }) // company_settings
    enqueue({ data: null, error: null }) // update inbox item

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{ data: { id: string; inbox_item_id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('invoice-1')
    expect(body.data.inbox_item_id).toBe('item-1')
  })

  it('emits supplier_invoice.registered and supplier_invoice.confirmed events', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'ready' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    enqueue({ data: 42 }) // arrival number
    enqueue({ data: { id: 'invoice-1', status: 'registered' } }) // insert
    enqueue({ data: null, error: null }) // insert items
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null }) // update inbox item

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    await route.handler(request, ctx)

    const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls
    expect(emitCalls.length).toBe(2)
    expect(emitCalls[0][0].type).toBe('supplier_invoice.registered')
    expect(emitCalls[1][0].type).toBe('supplier_invoice.confirmed')
  })

  it('creates registration journal entry when accounting method is accrual', async () => {
    const { createSupplierInvoiceRegistrationEntry } = await import('@/lib/bookkeeping/supplier-invoice-entries')

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'ready' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    enqueue({ data: 42 }) // arrival number
    enqueue({ data: { id: 'invoice-1', status: 'registered' } }) // insert invoice
    enqueue({ data: null, error: null }) // insert items
    enqueue({ data: makeCompanySettings({ accounting_method: 'accrual' }) })
    enqueue({ data: null, error: null }) // update registration_journal_entry_id
    enqueue({ data: null, error: null }) // update inbox item

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{ data: { registration_journal_entry_id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.registration_journal_entry_id).toBe('je-1')
    expect(createSupplierInvoiceRegistrationEntry).toHaveBeenCalled()

    // The emitted supplier_invoice.confirmed payload must reflect the just-written
    // registration_journal_entry_id so the core handler's payload-level guard
    // short-circuits instead of double-posting.
    const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls
    const confirmed = emitCalls.find((c) => c[0].type === 'supplier_invoice.confirmed')
    expect(confirmed).toBeDefined()
    expect(confirmed![0].payload.supplierInvoice.registration_journal_entry_id).toBe('je-1')
  })
})

// ── PATCH /items/:id/reject ──────────────────────────────────

describe('PATCH /items/:id/reject', () => {
  const route = findRoute('PATCH', '/items/:id/reject')

  it('returns 401 when no context', async () => {
    const request = createMockRequest('/items/item-1/reject', {
      method: 'PATCH',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, undefined)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 404 when item not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'Not found' } })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/reject', {
      method: 'PATCH',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 when item already confirmed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'item-1', status: 'confirmed' } })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/reject', {
      method: 'PATCH',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('updates item status to rejected', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'item-1', status: 'ready' } }) // fetch
    enqueue({ data: null, error: null }) // update

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/reject', {
      method: 'PATCH',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{ data: { id: string; status: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.status).toBe('rejected')
  })
})
