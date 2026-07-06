/**
 * Regression test for the plaintext-personnummer crash.
 *
 * GET /api/salary/employees decrypts every employee's personnummer on read and
 * maps over the whole roster. A row whose personnummer was stored UNENCRYPTED
 * (a pre-fix v1 REST create, or a seed) used to throw
 * ERR_CRYPTO_INVALID_AUTH_TAG ("Invalid authentication tag length: 6") inside
 * the .map(), 500-ing the entire endpoint for the affected company. The decrypt
 * helper now passes a raw 12-digit value through unchanged, so a mixed
 * encrypted/plaintext table no longer takes the roster down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyEntityType: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { GET } from '../route'
import { createClient } from '@/lib/supabase/server'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

const mockCreateClient = createClient as ReturnType<typeof vi.fn>

// Synthetic 12-digit values (year 1900 / 1902, zero suffix): obviously not
// real birthdates. ISO A.5.34 / GDPR Art.5(1)(c): fixtures must not look like
// production PII.
const PLAINTEXT_PNR = '190001010000'
const ENCRYPTED_PNR = encryptPersonnummer('190203040000')

function supabaseWithRows(rows: unknown[]) {
  const query: Record<string, unknown> = {}
  query.select = vi.fn(() => query)
  query.eq = vi.fn(() => query)
  query.order = vi.fn(() => Promise.resolve({ data: rows, error: null }))
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    from: vi.fn(() => query),
  }
}

function req() {
  return new Request('https://x.test/api/salary/employees')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/salary/employees', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    })

    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('does not 500 on a mixed plaintext + encrypted roster; masks both', async () => {
    mockCreateClient.mockResolvedValue(
      supabaseWithRows([
        { id: 'e1', last_name: 'A', personnummer: PLAINTEXT_PNR },
        { id: 'e2', last_name: 'B', personnummer: ENCRYPTED_PNR },
      ]),
    )

    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    // Both rows masked birthdate-visible, last-4 hidden.
    expect(body.data[0].personnummer).toBe('19000101-XXXX')
    expect(body.data[1].personnummer).toBe('19020304-XXXX')
    // Neither the plaintext nor the stored ciphertext may leak.
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_PNR)
    expect(JSON.stringify(body)).not.toContain(ENCRYPTED_PNR)
  })
})
