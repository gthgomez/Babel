import { createHash } from 'node:crypto'
import { PassageTextRefSchema } from '../../contracts/passages.js'

/** Frozen PassageTextRefSchema inline `text` max (UTF-16 code units). */
export const MAX_INLINE_PASSAGE_UTF16_UNITS = 32_000

export function passageTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function utf16UnitsForCodePoint(codePoint: string): number {
  const cp = codePoint.codePointAt(0)
  if (cp === undefined) return 0
  return cp > 0xffff ? 2 : 1
}

export function truncateToInlinePassageTextLimit(fullText: string): {
  emitted: string
  truncated: boolean
  originalCodePoints: number
  originalUtf16Units: number
} {
  const codePoints = [...fullText]
  const originalUtf16Units = fullText.length
  if (originalUtf16Units <= MAX_INLINE_PASSAGE_UTF16_UNITS) {
    return {
      emitted: fullText,
      truncated: false,
      originalCodePoints: codePoints.length,
      originalUtf16Units,
    }
  }
  let emitted = ''
  let emittedUnits = 0
  for (const cp of codePoints) {
    const units = utf16UnitsForCodePoint(cp)
    if (emittedUnits + units > MAX_INLINE_PASSAGE_UTF16_UNITS) break
    emitted += cp
    emittedUnits += units
  }
  if (!emitted) {
    throw new Error('inline passage text cannot be represented within UTF-16 unit limit')
  }
  return {
    emitted,
    truncated: emitted !== fullText,
    originalCodePoints: codePoints.length,
    originalUtf16Units,
  }
}

/** Hash and emit only stored inline text; whole code points; within schema UTF-16 max. */
export function buildInlinePassageTextRef(fullText: string): {
  text: string
  text_hash: string
  truncationNotes: string[]
} {
  const { emitted, truncated, originalCodePoints, originalUtf16Units } =
    truncateToInlinePassageTextLimit(fullText)
  const truncationNotes: string[] = []
  if (truncated) {
    truncationNotes.push(
      `inline_text_truncated:${originalCodePoints}_codepoints_${originalUtf16Units}_utf16_to_${emitted.length}_utf16`,
    )
  }
  const text_ref = {
    mode: 'inline' as const,
    text: emitted,
    text_hash: passageTextHash(emitted),
  }
  PassageTextRefSchema.parse(text_ref)
  return {
    text: emitted,
    text_hash: text_ref.text_hash,
    truncationNotes,
  }
}
