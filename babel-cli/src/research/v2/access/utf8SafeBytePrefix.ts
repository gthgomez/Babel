/** Trim a byte prefix to the longest valid UTF-8 prefix (fatal decode). */
export function utf8SafeBytePrefix(bytes: Buffer, maxBytes: number): Buffer {
  const limit = Math.min(bytes.length, maxBytes)
  let end = limit
  while (end > 0) {
    const slice = bytes.subarray(0, end)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(slice)
      return slice
    } catch {
      end -= 1
    }
  }
  return Buffer.alloc(0)
}
