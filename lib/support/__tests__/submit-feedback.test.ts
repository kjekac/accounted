import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { submitFeedback } from '@/lib/support/submit-feedback'

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubRecapt(impl: (...args: unknown[]) => void) {
    vi.stubGlobal('window', { recapt: impl })
  }

  function stubNoRecapt() {
    vi.stubGlobal('window', {})
  }

  function stubFetchOk() {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  it('sends to both Recapt and email when SDK is present', async () => {
    const recapt = vi.fn()
    stubRecapt(recapt)
    const fetchSpy = stubFetchOk()

    const result = await submitFeedback({ subject: 'Hjälpsida', message: 'Hjälp tack' })

    expect(result.ok).toBe(true)
    expect(result.channels.sort()).toEqual(['email', 'recapt'])
    expect(recapt).toHaveBeenCalledWith('feedback', { message: '[Hjälpsida]\n\nHjälp tack' })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/support/contact',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ subject: 'Hjälpsida', message: 'Hjälp tack' }),
      })
    )
  })

  it('omits subject prefix in Recapt payload when subject not provided', async () => {
    const recapt = vi.fn()
    stubRecapt(recapt)
    stubFetchOk()

    await submitFeedback({ message: 'plain' })

    expect(recapt).toHaveBeenCalledWith('feedback', { message: 'plain' })
  })

  it('still reports success via email when Recapt throws', async () => {
    stubRecapt(() => {
      throw new Error('boom')
    })
    stubFetchOk()

    const result = await submitFeedback({ subject: 'X', message: 'msg' })

    expect(result.ok).toBe(true)
    expect(result.channels).toEqual(['email'])
  })

  it('uses email only when Recapt SDK is absent', async () => {
    stubNoRecapt()
    const fetchSpy = stubFetchOk()

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(true)
    expect(result.channels).toEqual(['email'])
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('reports success when Recapt succeeds even if email fails', async () => {
    const recapt = vi.fn()
    stubRecapt(recapt)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'down' }) })
    )

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(true)
    expect(result.channels).toEqual(['recapt'])
  })

  it('returns failure with email error when both channels fail', async () => {
    stubRecapt(() => {
      throw new Error('boom')
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Mailtjänsten är inte konfigurerad' }),
      })
    )

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.channels).toEqual([])
    expect(result.error).toBe('Mailtjänsten är inte konfigurerad')
  })

  it('returns failure when fetch itself throws and Recapt is absent', async () => {
    stubNoRecapt()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')))

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.channels).toEqual([])
    expect(result.error).toBe('Network down')
  })
})
