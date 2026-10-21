export class Utf8InteriorCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Utf8InteriorCorruptionError'
  }
}

/**
 * At a host byte cap, drop at most 3 trailing bytes when they are only an incomplete
 * UTF-8 sequence (not interior corruption). O(1) — no scan from zero.
 */
export function trimIncompleteUtf8SequenceSuffix(bytes: Buffer): Buffer {
  if (bytes.length === 0) {
    return bytes
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return bytes
  } catch {
    const len = bytes.length
    for (let trim = 1; trim <= 3 && trim <= len; trim++) {
      const suffix = bytes.subarray(len - trim)
      if (!isOnlyIncompleteUtf8Suffix(suffix)) {
        continue
      }
      const prefix = bytes.subarray(0, len - trim)
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(prefix)
        return prefix
      } catch {
        break
      }
    }
    throw new Utf8InteriorCorruptionError(
      'decoded bytes contain invalid UTF-8 (not only a trailing incomplete sequence)',
    )
  }
}

function isOnlyIncompleteUtf8Suffix(suffix: Buffer): boolean {
  if (suffix.length === 0 || suffix.length > 3) {
    return false
  }
  const lead = suffix[0]!
  if ((lead & 0x80) === 0) {
    return false
  }
  if ((lead & 0xc0) === 0x80) {
    return false
  }
  if (lead >= 0xc0 && lead <= 0xdf) {
    return suffix.length < 2
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    return suffix.length < 3
  }
  if (lead >= 0xf0 && lead <= 0xf7) {
    return suffix.length < 4
  }
  return suffix.every((b) => (b & 0xc0) === 0x80)
}
