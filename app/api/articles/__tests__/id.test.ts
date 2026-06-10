/**
 * Tests for GET/PATCH/DELETE /api/articles/[id] (artikelregister).
 *
 * DELETE soft-deactivates (active = false) rather than hard-deleting, so the
 * article and its number survive for history. PATCH is a sparse update.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET, PATCH, DELETE } from '../[id]/route'

describe('GET/PATCH/DELETE /api/articles/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('GET returns 404 when the article is not found', async () => {
    enqueue({ data: null, error: { code: 'PGRST116', message: 'not found' } })

    const response = await GET(createMockRequest('/api/articles/a1'), createMockRouteParams({ id: 'a1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('ARTICLE_NOT_FOUND')
  })

  it('PATCH updates a field and returns the row', async () => {
    enqueue({ data: { id: 'a1', name: 'Konsulttimme', price_excl_vat: 1500 } })

    const request = createMockRequest('/api/articles/a1', {
      method: 'PATCH',
      body: { price_excl_vat: 1500 },
    })

    const response = await PATCH(request, createMockRouteParams({ id: 'a1' }))
    const { status, body } = await parseJsonResponse<{ data: { price_excl_vat: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.price_excl_vat).toBe(1500)
  })

  it('PATCH answers ACCOUNTS_NOT_IN_CHART for a BAS class-3 account missing from the chart', async () => {
    // chart_of_accounts lookup: no row, but 3999 is a known BAS class-3
    // account → activatable via the activate-and-retry dialog flow.
    enqueue({ data: null })

    const request = createMockRequest('/api/articles/a1', {
      method: 'PATCH',
      body: { revenue_account: '3999' },
    })

    const response = await PATCH(request, createMockRouteParams({ id: 'a1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[] }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['3999'])
  })

  it('PATCH rejects a 3xxx revenue_account unknown to both chart and BAS catalogue', async () => {
    // No chart row and 3041 is not in the BAS reference → invalid, no dialog.
    enqueue({ data: null })

    const request = createMockRequest('/api/articles/a1', {
      method: 'PATCH',
      body: { revenue_account: '3041' },
    })

    const response = await PATCH(request, createMockRouteParams({ id: 'a1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ARTICLE_REVENUE_ACCOUNT_INVALID')
  })

  it('DELETE soft-deactivates and returns success', async () => {
    enqueue({ data: { id: 'a1', active: false } })

    const response = await DELETE(createMockRequest('/api/articles/a1', { method: 'DELETE' }), createMockRouteParams({ id: 'a1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
