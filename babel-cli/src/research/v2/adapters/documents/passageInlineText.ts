import { createHash } from 'node:crypto'

/** Contract max for inline passage text (Unicode code points). */
export const MAX_INLINE_PASSAGE_CODE_POINTS = 32_000

export function passageTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function truncateToCodePointLimit(
  text: string,
  limit: number,
): { emitted: string; truncated: boolean; originalCodePoints: number } {
  const codePoints = [...text]
  if (codePoints.length <= limit) {
    return { emitted: text, truncated: false, originalCodePoints: codePoints.length }
  }
  return {
    emitted: codePoints.slice(0, limit).join(''),
    truncated: true,
    originalCodePoints: codePoints.length,
  }
}

/** Hash and emit only the stored inline text; truncate on code-point boundaries. */
export function buildInlinePassageTextRef(fullText: string): {
  text: string
  text_hash: string
  truncationNotes: string[]
} {
  const { emitted, truncated, originalCodePoints } = truncateToCodePointLimit(
    fullText,
    MAX_INLINE_PASSAGE_CODE_POINTS,
  )
  const truncationNotes: string[] = []
  if (truncated) {
    truncationNotes.push(
      `inline_text_truncated:${originalCodePoints}_to_${MAX_INLINE_PASSAGE_CODE_POINTS}_codepoints`,
    )
  }
  return {
    text: emitted,
    text_hash: passageTextHash(emitted),
    truncationNotes,
  }
}
