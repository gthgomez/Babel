import { createHash } from 'node:crypto'
import type { PassageRecord } from '../../contracts/passages.js'
import type { SourceRevision } from '../../contracts/sources.js'

export const MAX_TECHNICAL_PASSAGE_BYTES = 4000

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function deterministicPassageId(revisionId: string, textHash: string): string {
  return `passage-${createHash('sha256').update(`${revisionId}:${textHash}`).digest('hex').slice(0, 24)}`
}

/** Truncate without splitting UTF-8 code units (no lone surrogates). */
export function utf8SafePrefix(bytes: Buffer, maxBytes: number): { prefix: Buffer; truncated: boolean } {
  if (bytes.length <= maxBytes) {
    return { prefix: bytes, truncated: false }
  }
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1
  }
  return { prefix: bytes.subarray(0, end), truncated: true }
}

export function passagesFromValidatedPlainBytes(
  revision: SourceRevision,
  sourceBytes: Buffer,
  maxPassageBytes = MAX_TECHNICAL_PASSAGE_BYTES,
): PassageRecord[] {
  const { prefix, truncated } = utf8SafePrefix(sourceBytes, maxPassageBytes)
  const excerptBytes = sourceBytes.subarray(0, prefix.length)
  if (!excerptBytes.equals(prefix)) {
    throw new Error('technical byte excerpt slice does not match admitted prefix bytes')
  }
  const text = prefix.toString('utf8')
  const textHash = sha256(prefix)
  if (sha256(excerptBytes) !== textHash) {
    throw new Error('technical byte excerpt hash does not match emitted passage hash')
  }
  const passageId = deterministicPassageId(revision.revision_id, textHash)
  const endOffset = prefix.length
  const locator: PassageRecord['locator'] = truncated
    ? { kind: 'byte_offset', start_offset: 0, end_offset: endOffset }
    : { kind: 'byte_offset', start_offset: 0, end_offset: endOffset }
  const extraction_notes = truncated ? ['excerpt_truncated_by_byte_limit'] : undefined
  return [
    {
      passage_id: passageId,
      source_revision_id: revision.revision_id,
      locator,
      text_ref: {
        mode: 'inline',
        text,
        text_hash: textHash,
      },
      extraction_notes,
    },
  ]
}
