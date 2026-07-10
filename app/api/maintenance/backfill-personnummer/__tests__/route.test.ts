import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const mockVerifyCronSecret = vi.fn()
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (req: Request) => mockVerifyCronSecret(req),
}))

const mockUpdateEq2 = vi.fn()
const mockUpdateEq1 = vi.fn(() => ({ eq: mockUpdateEq2 }))
const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq1 }))
const mockSelect = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: mockSelect, update: mockUpdate }),
  }),
}))

import { POST } from '../route'

const ENCRYPTED =
  'a1b2c3d4e5f60718293a4b5c' + 'deadbeefdeadbeefdeadbeef' + 'cafebabecafebabecafebabecafebabe'

function makeRequest(confirm: boolean) {
  const url = `http://localhost/api/maintenance/backfill-personnummer${confirm ? '?confirm=true' : ''}`
  return new Request(url, { method: 'POST' })
}

describe('POST /api/maintenance/backfill-personnummer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyCronSecret.mockReturnValue(null)
    mockUpdateEq2.mockResolvedValue({ error: null })
    mockSelect.mockResolvedValue({
      data: [
        { id: 'emp-1', personnummer: '199001011234', personnummer_last4: null },
        { id: 'emp-2', personnummer: ENCRYPTED, personnummer_last4: '5678' },
      ],
      error: null,
    })
  })

  it('returns 401 when the cron secret is missing or wrong', async () => {
    mockVerifyCronSecret.mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )
    const res = await POST(makeRequest(true))
    expect(res.status).toBe(401)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('dry run counts plaintext rows without writing', async () => {
    const res = await POST(makeRequest(false))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ mode: 'dry_run', scanned: 2, plaintext: 1, updated: 0, failed: 0 })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('confirm encrypts only plaintext rows, guarded on the old value', async () => {
    const res = await POST(makeRequest(true))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ mode: 'write', scanned: 2, plaintext: 1, updated: 1, failed: 0 })

    expect(mockUpdate).toHaveBeenCalledTimes(1)
    const patch = mockUpdate.mock.calls[0][0] as { personnummer: string; personnummer_last4: string }
    // aes-256-gcm output: 12-byte iv + ciphertext + 16-byte tag, hex-encoded
    expect(patch.personnummer).toMatch(/^[0-9a-f]+$/)
    expect(patch.personnummer).not.toMatch(/^\d{12}$/)
    expect(patch.personnummer.length).toBeGreaterThan(60)
    expect(patch.personnummer_last4).toBe('1234')
    expect(mockUpdateEq1).toHaveBeenCalledWith('id', 'emp-1')
    expect(mockUpdateEq2).toHaveBeenCalledWith('personnummer', '199001011234')
  })

  it('returns 500 when the employees read fails', async () => {
    mockSelect.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const res = await POST(makeRequest(false))
    expect(res.status).toBe(500)
  })
})
