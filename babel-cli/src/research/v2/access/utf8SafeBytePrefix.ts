export class Utf8InteriorCorruptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Utf8InteriorCorruptionError'
  }
}

export function isUtf8TextMediaType(mediaType: string): boolean {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return base.startsWith('text/') || base === 'application/json' || base === 'application/xml'
}

/**
 * At a host-decoded truncation boundary for UTF-8 text, drop at most 3 trailing bytes
 * when they are only an incomplete (not malformed) UTF-8 sequence. O(1).
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

function isValidContinuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf
}

function isLegalUtf8Lead(byte: number): boolean {
  return (byte >= 0xc2 && byte <= 0xdf) || (byte >= 0xe0 && byte <= 0xef) || (byte >= 0xf0 && byte <= 0xf4)
}

/**
 * True when suffix is a strict UTF-8 prefix of a multibyte character (missing continuations only).
 */
export function isOnlyIncompleteUtf8Suffix(suffix: Buffer): boolean {
  if (suffix.length === 0 || suffix.length > 3) {
    return false
  }
  const b0 = suffix[0]!
  if ((b0 & 0x80) === 0 || (b0 & 0xc0) === 0x80) {
    return false
  }
  if (!isLegalUtf8Lead(b0)) {
    return false
  }

  if (b0 >= 0xc2 && b0 <= 0xdf) {
    return suffix.length === 1
  }

  if (b0 >= 0xe0 && b0 <= 0xef) {
    if (suffix.length === 1) {
      return true
    }
    if (suffix.length === 2) {
      const b1 = suffix[1]!
      if (!isValidContinuation(b1)) {
        return false
      }
      if (b0 === 0xe0 && b1 < 0xa0) {
        return false
      }
      if (b0 === 0xed && b1 > 0x9f) {
        return false
      }
      return true
    }
    return false
  }

  if (b0 >= 0xf0 && b0 <= 0xf4) {
    if (suffix.length === 1) {
      return true
    }
    if (suffix.length === 2) {
      const b1 = suffix[1]!
      if (!isValidContinuation(b1)) {
        return false
      }
      if (b0 === 0xf0 && b1 < 0x90) {
        return false
      }
      if (b0 === 0xf4 && b1 > 0x8f) {
        return false
      }
      return true
    }
    if (suffix.length === 3) {
      const b1 = suffix[1]!
      const b2 = suffix[2]!
      if (!isValidContinuation(b1) || !isValidContinuation(b2)) {
        return false
      }
      if (b0 === 0xf0 && b1 < 0x90) {
        return false
      }
      if (b0 === 0xf4 && b1 > 0x8f) {
        return false
      }
      return true
    }
    return false
  }

  return false
}
