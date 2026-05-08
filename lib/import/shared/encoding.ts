/**
 * Encoding detection and conversion for Swedish import files.
 *
 * Used by bank file, supplier, customer, and opening-balance parsers.
 * Swedish data exports use either UTF-8 or Windows-1252 (ISO-8859-1).
 * We detect encoding by checking for valid Swedish characters.
 */

/**
 * Decode file content, handling both UTF-8 and Windows-1252 encodings.
 *
 * Strategy: Try UTF-8 first. If the result contains replacement characters
 * (U+FFFD) or garbled Swedish chars, fall back to Windows-1252.
 */
export function decodeFileContent(buffer: ArrayBuffer): string {
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  const utf8Result = utf8Decoder.decode(buffer)

  if (!hasEncodingIssues(utf8Result)) {
    return utf8Result
  }

  const latin1Decoder = new TextDecoder('windows-1252', { fatal: false })
  return latin1Decoder.decode(buffer)
}

/**
 * Re-decode a string that suffered the canonical "UTF-8 bytes read as Latin-1"
 * mojibake (e.g. "MalmÃ¶" → "Malmö", "GÃ–TEBORG" → "GÖTEBORG").
 *
 * Mechanism: each char in the input is a codepoint that was originally a UTF-8
 * byte misinterpreted as a Latin-1/Windows-1252 character. We pack those chars
 * back into a byte sequence and decode the bytes as UTF-8 to recover the
 * original text.
 *
 * No-op when the string is already clean (no garbled patterns).
 */
export function decodeStringContent(content: string): string {
  if (!hasEncodingIssues(content)) {
    return content
  }

  try {
    const bytes = new Uint8Array(content.length)
    for (let i = 0; i < content.length; i++) {
      bytes[i] = content.charCodeAt(i) & 0xff
    }
    const decoder = new TextDecoder('utf-8', { fatal: false })
    return decoder.decode(bytes)
  } catch {
    return content
  }
}

/**
 * Check if a string has encoding issues (garbled Swedish characters).
 */
export function hasEncodingIssues(text: string): boolean {
  if (text.includes('\uFFFD')) return true

  // Common garbled patterns when Windows-1252 is read as UTF-8:
  // Ã¥ = å, Ã¤ = ä, Ã¶ = ö, Ã… = Å, Ã„ = Ä, Ã– = Ö
  const garbledPatterns = ['Ã¥', 'Ã¤', 'Ã¶', 'Ã\u0085', 'Ã\u0084', 'Ã\u0096']
  return garbledPatterns.some((pattern) => text.includes(pattern))
}

/**
 * Normalize line endings to \n
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Strip BOM (Byte Order Mark) from start of content
 */
export function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1)
  }
  return content
}

/**
 * Prepare file content for parsing: strip BOM, normalize line endings, handle encoding
 */
export function prepareContent(content: string): string {
  return normalizeLineEndings(stripBOM(decodeStringContent(content)))
}
