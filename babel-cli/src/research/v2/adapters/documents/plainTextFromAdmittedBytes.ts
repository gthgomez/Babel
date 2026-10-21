import type { AdmittedContent, PassageRecord } from '../frozenPorts0ccd1733.js'

const EXTRACTION_VERSION = 'general-plain-text/0.1.0'

/**
 * Extract line-bounded passages from admitted inline UTF-8 text (no network).
 */
export function passagesFromAdmittedPlainText(admitted: AdmittedContent): PassageRecord[] {
  if (admitted.media_type !== 'text/plain' && !admitted.media_type.startsWith('text/')) {
    throw new Error(`unsupported media_type for plain extractor: ${admitted.media_type}`)
  }
  const raw = Buffer.from(admitted.payload.bytes_base64, 'base64').toString('utf8')
  if (raw.length !== admitted.payload.byte_length) {
    throw new Error('admitted byte_length does not match decoded UTF-8 length')
  }
  const lines = raw.split(/\n/)
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
  return passages
}

export { EXTRACTION_VERSION as plainTextExtractionVersion }
