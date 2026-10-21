import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'

export const PLAIN_TEXT_MEDIA_TYPE = 'text/plain'
export const PLAIN_TEXT_EXTRACTION_VERSION = 'general-plain-text/0.1.0'

function passageTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Decode and integrity-check inline admitted bytes (no network). */
export function decodeAdmittedUtf8Bytes(admitted: AdmittedContent): Buffer {
  if (admitted.payload.mode !== 'inline_bytes') {
    throw new Error(`unsupported payload mode: ${admitted.payload.mode}`)
  }
  const raw = Buffer.from(admitted.payload.bytes_base64, 'base64')
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
 * Extract line-bounded passages from admitted inline UTF-8 plain text only.
 */
export function passagesFromAdmittedPlainText(admitted: AdmittedContent): PassageRecord[] {
  if (admitted.media_type !== PLAIN_TEXT_MEDIA_TYPE) {
    throw new Error(
      `unsupported media_type for plain extractor: ${admitted.media_type} (only ${PLAIN_TEXT_MEDIA_TYPE})`,
    )
  }
  const raw = decodeAdmittedUtf8Bytes(admitted)
  const text = raw.toString('utf8')
  const lines = text.split(/\n/)
  const passages: PassageRecord[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    const lineNo = i + 1
    const record: PassageRecord = {
      passage_id: `${admitted.operation_id}:L${lineNo}`,
      source_revision_id: admitted.revision.revision_id,
      locator: { kind: 'line_range', start_line: lineNo, end_line: lineNo },
      text_ref: {
        mode: 'inline',
        text: line,
        text_hash: passageTextHash(line),
      },
    }
    PassageRecordSchema.parse(record)
    const expectedLine = lines[lineNo - 1] ?? ''
    if (record.text_ref.mode === 'inline' && record.text_ref.text !== expectedLine) {
      throw new Error('passage text does not match admitted raw line bytes')
    }
    passages.push(record)
  }
  return passages
}
