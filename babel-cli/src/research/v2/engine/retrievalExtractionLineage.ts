import type { PassageRecord } from '../contracts/passages.js'
import type { ExternalOperationCompletion, ExternalOperationIntent } from '../contracts/operations.js'
import {
  sourceFetchEvidenceOwnerKey,
  type SourceFetchEvidenceOwner,
} from '../contracts/retrievalEvidenceOwnership.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'

export interface SourceFetchAttemptRef {
  missionId: string
  operationId: string
  attemptId: string
}

function sourceFetchIntent(event: ResearchStoreEvent): ExternalOperationIntent | undefined {
  if (event.kind !== 'external_operation_intent') return undefined
  const intent = (event.payload as { intent: ExternalOperationIntent }).intent
  if (intent.operation_kind !== 'source_fetch') return undefined
  return intent
}

function completionRecord(event: ResearchStoreEvent): ExternalOperationCompletion | undefined {
  if (event.kind !== 'external_operation_completed') return undefined
  return (event.payload as { completion: ExternalOperationCompletion }).completion
}

function attemptRefFromIntent(intent: ExternalOperationIntent): SourceFetchAttemptRef {
  return {
    missionId: intent.mission_id,
    operationId: intent.operation_id,
    attemptId: intent.attempt_id,
  }
}

function completionMatchesAttempt(
  completion: ExternalOperationCompletion,
  attempt: SourceFetchAttemptRef,
): boolean {
  return (
    completion.mission_id === attempt.missionId &&
    completion.operation_id === attempt.operationId &&
    completion.attempt_id === attempt.attemptId
  )
}

function ownerKeyFromRef(ref: SourceFetchAttemptRef): string {
  return sourceFetchEvidenceOwnerKey({
    mission_id: ref.missionId,
    operation_id: ref.operationId,
    attempt_id: ref.attemptId,
  })
}

/** Terminal `succeeded` `source_fetch` attempt keys (mission + operation + attempt). */
export function succeededSourceFetchAttemptOwnerKeys(
  events: readonly ResearchStoreEvent[],
): Set<string> {
  const succeeded = new Set<string>()
  for (let i = 0; i < events.length; i++) {
    const intent = sourceFetchIntent(events[i]!)
    if (!intent) continue
    const attempt = attemptRefFromIntent(intent)
    for (let j = i + 1; j < events.length; j++) {
      const completion = completionRecord(events[j]!)
      if (!completion || !completionMatchesAttempt(completion, attempt)) continue
      if (completion.settlement === 'succeeded') {
        succeeded.add(ownerKeyFromRef(attempt))
      }
      break
    }
  }
  return succeeded
}

/** @deprecated Use {@link succeededSourceFetchAttemptOwnerKeys}; operation-id-only sets are ambiguous. */
export function succeededSourceFetchOperationIds(
  events: readonly ResearchStoreEvent[],
): Set<string> {
  const ids = new Set<string>()
  for (const key of succeededSourceFetchAttemptOwnerKeys(events)) {
    const parts = key.split('\0')
    const operationId = parts[1]
    if (operationId) ids.add(operationId)
  }
  return ids
}

function passageOwnerKey(passage: PassageRecord): string | undefined {
  const owner = passage.source_fetch_owner
  if (!owner) return undefined
  return sourceFetchEvidenceOwnerKey(owner)
}

/**
 * Whether this passage record (not passage_id alone) is eligible for extraction: write-time owner
 * must match a terminal succeeded `source_fetch` attempt. Ownerless legacy rows fail closed.
 */
export function passageIsAdmittedForExtractionLineage(
  passage: PassageRecord,
  events: readonly ResearchStoreEvent[],
): boolean {
  const succeededOwners = succeededSourceFetchAttemptOwnerKeys(events)
  if (succeededOwners.size === 0) {
    return false
  }
  const ownerKey = passageOwnerKey(passage)
  if (!ownerKey) {
    return false
  }
  return succeededOwners.has(ownerKey)
}

/**
 * Passage ids admitted for extraction after per-record owner filtering.
 * Duplicate passage_ids across attempts collapse in this set; use {@link filterPassagesForExtractionLineage}
 * when record-level text/owner must be preserved.
 */
export function passageIdsAdmittedUnderSucceededSourceFetches(
  events: readonly ResearchStoreEvent[],
): Set<string> {
  const passages = events
    .filter((e) => e.kind === 'passage_recorded')
    .map((e) => (e.payload as { passage: PassageRecord }).passage)
  return new Set(
    filterPassagesForExtractionLineage(passages, events).map((p) => p.passage_id),
  )
}

/**
 * Extraction may resume after close/reopen; omit passages without succeeded attempt ownership.
 * Each record is filtered by its own `source_fetch_owner`, not by a shared passage_id allow-set.
 * Original store events are never deleted.
 */
export function filterPassagesForExtractionLineage(
  passages: readonly PassageRecord[],
  events: readonly ResearchStoreEvent[],
): PassageRecord[] {
  const succeededOwners = succeededSourceFetchAttemptOwnerKeys(events)
  if (succeededOwners.size === 0) {
    return []
  }
  return passages.filter((passage) => {
    const ownerKey = passageOwnerKey(passage)
    return ownerKey !== undefined && succeededOwners.has(ownerKey)
  })
}

/** Report limitations for ownerless legacy passages excluded from extraction (no ownership backfill). */
export function extractionLineageReportLimitations(
  allPassages: readonly PassageRecord[],
  _events: readonly ResearchStoreEvent[],
): string[] {
  const ownerlessExcluded = allPassages.filter((p) => !p.source_fetch_owner).length
  if (ownerlessExcluded === 0) {
    return []
  }
  return [
    `extraction_lineage_excluded_ownerless_legacy_passage_count:${ownerlessExcluded}`,
  ]
}

export function passageIdsForExtractionLineage(
  passages: readonly PassageRecord[],
  events: readonly ResearchStoreEvent[],
): string[] {
  return filterPassagesForExtractionLineage(passages, events).map((p) => p.passage_id)
}

export function ownerMatchesSucceededAttempt(
  owner: SourceFetchEvidenceOwner,
  events: readonly ResearchStoreEvent[],
): boolean {
  return succeededSourceFetchAttemptOwnerKeys(events).has(sourceFetchEvidenceOwnerKey(owner))
}
