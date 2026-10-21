/**
 * Test-only HTML/UTF-8 fixtures (not transport). Used to assert read-path hash/locator invariants.
 */
import { createHash } from 'node:crypto'

/** Truncate on a UTF-8 code point boundary (never leaves a partial multibyte sequence). */
export function utf8SafeTruncateBytes(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1
  }
  return buf.subarray(0, end)
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Build UTF-8 HTML with an exact byte length (ASCII filler). */
export function syntheticHtmlWithByteLength(targetBytes: number): Buffer {
  const open = '<!doctype html><html><body><h1>Evidence</h1>'
  const close = '</body></html>'
  const openBytes = Buffer.byteLength(open + close, 'utf8')
  if (targetBytes < openBytes) {
    throw new Error('targetBytes too small for synthetic HTML envelope')
  }
  const fillerLen = targetBytes - openBytes
  const html = `${open}${'x'.repeat(fillerLen)}${close}`
  const buf = Buffer.from(html, 'utf8')
  if (buf.length !== targetBytes) {
    throw new Error(`synthetic HTML length ${buf.length} !== target ${targetBytes}`)
  }
  return buf
}

/**
 * HTML where a 4-byte UTF-8 character would be split by a naive maxBytes cut.
 * Returns full buffer and the safe truncated form A should admit.
 */
export function htmlWithMultibyteStraddlingCut(maxBytes: number): {
  full: Buffer
  utf8SafeAtCap: Buffer
} {
  const head = '<html><body>'
  const tail = '</body></html>'
  const envelope = Buffer.byteLength(head + tail, 'utf8')
  const snake = '🐍'
  const innerAscii = 'a'.repeat(Math.max(0, maxBytes - envelope - 1))
  const full = Buffer.from(`${head}${innerAscii}${snake}z${tail}`, 'utf8')
  if (full.length <= maxBytes) {
    throw new Error('full HTML must exceed decode cap for multibyte fixture')
  }
  const utf8SafeAtCap = utf8SafeTruncateBytes(full, maxBytes)
  if (utf8SafeAtCap.length >= full.length) {
    throw new Error('utf8-safe cap must be shorter than full HTML')
  }
  return { full, utf8SafeAtCap }
}
