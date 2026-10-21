import { createHash } from 'node:crypto'
import type { AdmittedContent, PassageRecord } from '../frozenPorts0ccd1733.js'

const EXTRACTION_VERSION = 'general-plain-text/0.1.0'

/** Decode and integrity-check inline admitted bytes (no network). */
export function decodeAdmittedUtf8Bytes(admitted: AdmittedContent): Buffer {
  if (admitted.payload.mode !== 'inline_bytes') {
    throw new Error(`unsupported payload mode: ${admitted.payload.mode}`)
  }
  let raw: Buffer
  try {
    raw = Buffer.from(admitted.payload.bytes_base64, 'base64')
  } catch {
    throw new Error('admitted bytes_base64 is not valid base64')
  }
  if (raw.length !== admitted.payload.byte_length) {
    throw new Error('admitted byte_length does not match decoded buffer length')
  }
  const digest = createHash('sha256').update(raw).digest('hex')
  if (digest !== admitted.payload.content_hash) {
    throw new Error('admitted payload content_hash does not match decoded bytes')
  }
  if (digest !== admitted.revision.content_hash) {
    throw new Error('admitted revision content_hash does not match decoded bytes')
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new Error('admitted bytes are not valid UTF-8')
  }
  return raw
}

/**
 * Extract line-bounded passages from admitted inline UTF-8 text (no network).
 */
export function passagesFromAdmittedPlainText(admitted: AdmittedContent): PassageRecord[] {
  if (admitted.media_type !== 'text/plain' && !admitted.media_type.startsWith('text/')) {
    throw new Error(`unsupported media_type for plain extractor: ${admitted.media_type}`)
  }
  const raw = decodeAdmittedUtf8Bytes(admitted)
  const text = raw.toString('utf8')
  const lines = text.split(/\n/)
  const passages: PassageRecord[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    const lineNo = i + 1
    passages.push({
      passage_id: `${admitted.operation_id}:L${lineNo}`,
      source_id: admitted.revision.source_id,
      revision_id: admitted.revision.revision_id,
      locator: { kind: 'line_range', start_line: lineNo, end_line: lineNo },
      text: line,
      extraction_version: EXTRACTION_VERSION,
    })
  }
  for (const passage of passages) {
    if (passage.source_id !== admitted.revision.source_id) {
      throw new Error('passage source_id does not match admitted revision')
    }
    if (passage.revision_id !== admitted.revision.revision_id) {
      throw new Error('passage revision_id does not match admitted revision')
    }
    if (passage.locator.start_line !== passage.locator.end_line) {
      throw new Error('plain-text locator must be a single line_range')
    }
    const expectedLine = lines[passage.locator.start_line - 1] ?? ''
    if (passage.text !== expectedLine) {
      throw new Error('passage text does not match admitted raw line bytes')
    }
  }
  return passages
}

export { EXTRACTION_VERSION as plainTextExtractionVersion }
