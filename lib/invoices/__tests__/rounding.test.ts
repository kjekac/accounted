import { describe, expect, it } from 'vitest'
import { getDisplayTotal } from '@/lib/invoices/rounding'

const inv = (total: number, currency: 'SEK' | 'EUR' = 'SEK') => ({ total, currency })
const co = (ore_rounding: boolean) => ({ ore_rounding })

describe('getDisplayTotal', () => {
  it('rounds SEK with rounding enabled and a non-integer total', () => {
    const r = getDisplayTotal(inv(1234.56), co(true))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(1235)
    expect(r.roundingDelta).toBe(0.44)
  })

  it('rounds down when fractional part < 0.5', () => {
    const r = getDisplayTotal(inv(1234.4), co(true))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(1234)
    expect(r.roundingDelta).toBe(-0.4)
  })

  it('does not apply when setting is disabled', () => {
    const r = getDisplayTotal(inv(1234.56), co(false))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(1234.56)
    expect(r.roundingDelta).toBe(0)
  })

  it('does not apply for non-SEK currencies', () => {
    const r = getDisplayTotal(inv(1234.56, 'EUR'), co(true))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(1234.56)
  })

  it('does not apply when total is already an integer', () => {
    const r = getDisplayTotal(inv(1235), co(true))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(1235)
    expect(r.roundingDelta).toBe(0)
  })

  it('treats missing company settings as default-on', () => {
    const r = getDisplayTotal(inv(99.99), null)
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(100)
  })

  it('per-invoice flag (true) wins over a disabled company setting', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: true }, co(false))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(100)
  })

  it('per-invoice flag (false) wins over an enabled company setting', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: false }, co(true))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(99.99)
  })

  it('null per-invoice flag falls back to the company setting', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: null }, co(true))
    expect(r.applies).toBe(true)
    expect(r.displayed).toBe(100)
  })

  it('null per-invoice flag with company-off resolves to off (supplier-invoice convention)', () => {
    const r = getDisplayTotal({ total: 99.99, currency: 'SEK', ore_rounding: null }, co(false))
    expect(r.applies).toBe(false)
    expect(r.displayed).toBe(99.99)
  })
})
