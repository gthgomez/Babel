import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { assertAdmissionBindsToPinnedSource } from './repositoryFilePinning.js'

const ALLOWED_REPOSITORY_MEDIA = new Set([
  'text/plain',
  'text/x-typescript',
  'application/typescript',
  'text/javascript',
  'application/javascript',
])

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeStrictUtf8(bytes: Buffer): string {
  const text = bytes.toString('utf8')
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0) {
    throw new TechnicalRepositoryAdmissionError('admitted bytes are not valid UTF-8')
  }
  return text
}

export class TechnicalRepositoryAdmissionError extends Error {
  readonly failureCategory = 'admission_rejected'

  constructor(message: string) {
    super(message)
    this.name = 'TechnicalRepositoryAdmissionError'
  }
}

/** Validates host admission before technical plain extraction (contract tests prove behavior). */
export function validateTechnicalRepositoryAdmission(
  source: SourceRecord,
  fetchOperationId: string,
  responseOperationId: string,
  admitted: AdmittedContent,
): Buffer {
  assertAdmissionBindsToPinnedSource(source, fetchOperationId, admitted, responseOperationId)
  if (admitted.payload.mode !== 'inline_bytes') {
    throw new TechnicalRepositoryAdmissionError('admission must use inline_bytes payload')
  }
  const media = admitted.media_type.toLowerCase().split(';')[0]?.trim() ?? ''
  if (!ALLOWED_REPOSITORY_MEDIA.has(media)) {
    throw new TechnicalRepositoryAdmissionError(`unsupported repository media type: ${admitted.media_type}`)
  }
  const bytes = Buffer.from(admitted.payload.bytes_base64, 'base64')
  if (bytes.length === 0) {
    throw new TechnicalRepositoryAdmissionError('admitted body is empty')
  }
  if (bytes.length !== admitted.payload.byte_length) {
    throw new TechnicalRepositoryAdmissionError('admitted byte_length disagrees with decoded payload')
  }
  if (admitted.revision.byte_length_received !== undefined && admitted.revision.byte_length_received !== bytes.length) {
    throw new TechnicalRepositoryAdmissionError('revision byte_length_received disagrees with payload')
  }
  const hash = sha256(bytes)
  if (hash !== admitted.payload.content_hash || hash !== admitted.revision.content_hash) {
    throw new TechnicalRepositoryAdmissionError('admitted content hash is inconsistent')
  }
  decodeStrictUtf8(bytes)
  return bytes
}
