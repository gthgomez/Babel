import type { PassageRecord } from '../contracts/passages.js'
import type { SourceFetchEvidenceOwner } from '../contracts/retrievalEvidenceOwnership.js'
import type { SourceRevision } from '../contracts/sources.js'

export function stampSourceFetchEvidenceOwnerOnRevision(
  revision: SourceRevision,
  owner: SourceFetchEvidenceOwner,
): SourceRevision {
  return { ...revision, source_fetch_owner: owner }
}

export function stampSourceFetchEvidenceOwnerOnPassage(
  passage: PassageRecord,
  owner: SourceFetchEvidenceOwner,
): PassageRecord {
  return { ...passage, source_fetch_owner: owner }
}

export function sourceFetchOwnerFromFetch(
  missionId: string,
  operationId: string,
  attemptId: string,
): SourceFetchEvidenceOwner {
  return {
    mission_id: missionId,
    operation_id: operationId,
    attempt_id: attemptId,
  }
}
