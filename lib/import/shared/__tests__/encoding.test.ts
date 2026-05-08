import { describe, it, expect } from 'vitest'
import {
  decodeFileContent,
  decodeStringContent,
  hasEncodingIssues,
} from '../encoding'

describe('decodeStringContent', () => {
  it('recovers UTF-8-as-Latin-1 mojibake for lowercase Swedish chars', () => {
    expect(decodeStringContent('MalmÃ¶')).toBe('Malmö')
    expect(decodeStringContent('Ã¥re')).toBe('Åre'.toLowerCase())
    expect(decodeStringContent('LinkÃ¶ping')).toBe('Linköping')
  })

  it('recovers UTF-8-as-Latin-1 mojibake for uppercase Swedish chars', () => {
    // The middle char is U+0096 (control), invisible in most renderings → "GÃTEBORG"
    expect(decodeStringContent('GÃ\u0096TEBORG')).toBe('GÖTEBORG')
    expect(decodeStringContent('HISINGS KÃ\u0084RRA')).toBe('HISINGS KÄRRA')
    expect(decodeStringContent('Ã\u0085NGE')).toBe('ÅNGE')
  })

  it('is a no-op on already-correct Swedish strings', () => {
    expect(decodeStringContent('GÖTEBORG')).toBe('GÖTEBORG')
    expect(decodeStringContent('Malmö')).toBe('Malmö')
    expect(decodeStringContent('STOCKHOLM')).toBe('STOCKHOLM')
    expect(decodeStringContent('')).toBe('')
  })

  it('is idempotent (running twice equals running once)', () => {
    const once = decodeStringContent('MalmÃ¶')
    const twice = decodeStringContent(once)
    expect(twice).toBe(once)
    expect(twice).toBe('Malmö')
  })

  it('preserves non-Swedish strings unchanged', () => {
    expect(decodeStringContent('Café')).toBe('Café')
    expect(decodeStringContent('München')).toBe('München')
    expect(decodeStringContent('123 Main St')).toBe('123 Main St')
  })
})

describe('hasEncodingIssues', () => {
  it('detects U+FFFD replacement characters', () => {
    expect(hasEncodingIssues('Foo\uFFFDbar')).toBe(true)
  })

  it('detects all six Swedish mojibake patterns', () => {
    expect(hasEncodingIssues('MalmÃ¶')).toBe(true) // ö
    expect(hasEncodingIssues('Ã¥re')).toBe(true) // å
    expect(hasEncodingIssues('Ã¤lg')).toBe(true) // ä
    expect(hasEncodingIssues('GÃ\u0096TEBORG')).toBe(true) // Ö
    expect(hasEncodingIssues('Ã\u0085NGE')).toBe(true) // Å
    expect(hasEncodingIssues('Ã\u0084RRA')).toBe(true) // Ä
  })

  it('returns false for clean strings', () => {
    expect(hasEncodingIssues('Stockholm')).toBe(false)
    expect(hasEncodingIssues('Malmö')).toBe(false)
    expect(hasEncodingIssues('Café')).toBe(false)
  })
})

describe('decodeFileContent', () => {
  function buf(bytes: number[]): ArrayBuffer {
    return new Uint8Array(bytes).buffer
  }

  it('decodes UTF-8 bytes correctly', () => {
    const utf8 = new TextEncoder().encode('GÖTEBORG').buffer
    expect(decodeFileContent(utf8)).toBe('GÖTEBORG')
  })

  it('falls back to Windows-1252 when UTF-8 decode is invalid', () => {
    // 0xD6 = Ö in Windows-1252; lone 0xD6 is not valid UTF-8 start byte
    const cp1252 = buf([0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47])
    expect(decodeFileContent(cp1252)).toBe('GÖTEBORG')
  })
})
