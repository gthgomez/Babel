import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { PassageRecord } from '../../contracts/passages.js'
import type { SourceRevision } from '../../contracts/sources.js'
import { validateTechnicalRepositoryAdmission } from './technicalRepositoryAdmission.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { passagesFromValidatedPlainBytes } from './plainTextByteExcerpt.js'

export const TECHNICAL_PLAIN_EXTRACTION_VERSION = 'technical-plain-2'

/** Adapter-owned extraction from validated host admission (no network). */
export function passagesFromAdmittedPlainText(
  source: SourceRecord,
  fetchOperationId: string,
  responseOperationId: string,
  revision: SourceRevision,
  admitted: AdmittedContent,
): PassageRecord[] {
  const bytes = validateTechnicalRepositoryAdmission(
    source,
    fetchOperationId,
    responseOperationId,
    admitted,
  )
  return passagesFromValidatedPlainBytes(revision, bytes)
}
