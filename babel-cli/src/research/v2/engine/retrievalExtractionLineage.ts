import type { PassageRecord } from '../contracts/passages.js'
import type { ExternalOperationCompletion, ExternalOperationIntent } from '../contracts/operations.js'
import type { SourceRevision } from '../contracts/sources.js'
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

function passageOwnedByFetchOperation(passage: PassageRecord, operationId: string): boolean {
  return passage.passage_id === operationId || passage.passage_id.startsWith(`${operationId}:`)
}

/** Terminal `succeeded` `source_fetch` operation ids (any attempt). */
export function succeededSourceFetchOperationIds(
  events: readonly ResearchStoreEvent[],
): Set<string> {
  const fetchOps = new Set<string>()
  for (const event of events) {
    const intent = sourceFetchIntent(event)
    if (intent) fetchOps.add(intent.operation_id)
  }
  const succeeded = new Set<string>()
  for (const event of events) {
    const completion = completionRecord(event)
    if (!completion) continue
    if (completion.settlement !== 'succeeded') continue
    if (fetchOps.has(completion.operation_id)) {
      succeeded.add(completion.operation_id)
    }
  }
  return succeeded
}

/**
 * Passage ids admitted under a specific `source_fetch` attempt that settled `succeeded`.
 * Ownership: revisions recorded on that attempt, then passages in the same attempt span whose
 * `source_revision_id` matches those revisions or whose `passage_id` is bound to the fetch operation.
 */
export function passageIdsAdmittedUnderSucceededSourceFetches(
  events: readonly ResearchStoreEvent[],
): Set<string> {
  const admitted = new Set<string>()

  for (let i = 0; i < events.length; i++) {
    const intent = sourceFetchIntent(events[i]!)
    if (!intent) continue
    const attempt = attemptRefFromIntent(intent)

    let completionIdx = -1
    let succeeded = false
    for (let j = i + 1; j < events.length; j++) {
      const completion = completionRecord(events[j]!)
      if (!completion || !completionMatchesAttempt(completion, attempt)) continue
      completionIdx = j
      succeeded = completion.settlement === 'succeeded'
      break
    }
    if (completionIdx < 0 || !succeeded) continue

    const revisionIds = new Set<string>()
    for (let k = i + 1; k < completionIdx; k++) {
      const mid = events[k]!
      if (mid.kind !== 'revision_recorded') continue
      const revision = (mid.payload as { revision: SourceRevision }).revision
      revisionIds.add(revision.revision_id)
    }

    for (let k = i + 1; k < completionIdx; k++) {
      const mid = events[k]!
      if (mid.kind !== 'passage_recorded') continue
      const passage = (mid.payload as { passage: PassageRecord }).passage
      if (
        revisionIds.has(passage.source_revision_id) ||
        passageOwnedByFetchOperation(passage, attempt.operationId)
      ) {
        admitted.add(passage.passage_id)
      }
    }
  }

  return admitted
}

/**
 * Extraction may resume after close/reopen; omit passages tied to incomplete or failed fetches.
 * Original store events are never deleted.
 */
export function filterPassagesForExtractionLineage(
  passages: readonly PassageRecord[],
  events: readonly ResearchStoreEvent[],
): PassageRecord[] {
  const admittedIds = passageIdsAdmittedUnderSucceededSourceFetches(events)
  if (admittedIds.size === 0) {
    return []
  }
  return passages.filter((passage) => admittedIds.has(passage.passage_id))
}

export function passageIdsForExtractionLineage(
  passages: readonly PassageRecord[],
  events: readonly ResearchStoreEvent[],
): string[] {
  return filterPassagesForExtractionLineage(passages, events).map((p) => p.passage_id)
}
