import type { PassageRecord } from '../contracts/passages.js'
import type { ExternalOperationCompletion } from '../contracts/operations.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'

function intentOperationKind(event: ResearchStoreEvent): string | undefined {
  if (event.kind !== 'external_operation_intent') return undefined
  return (event.payload as { intent: { operation_kind?: string } }).intent.operation_kind
}

function intentOperationId(event: ResearchStoreEvent): string | undefined {
  if (event.kind !== 'external_operation_intent') return undefined
  return (event.payload as { intent: { operation_id?: string } }).intent.operation_id
}

function completionRecord(event: ResearchStoreEvent): ExternalOperationCompletion | undefined {
  if (event.kind !== 'external_operation_completed') return undefined
  return (event.payload as { completion: ExternalOperationCompletion }).completion
}

/** `source_fetch` operation ids with terminal settlement `succeeded` (durable store lineage). */
export function succeededSourceFetchOperationIds(
  events: readonly ResearchStoreEvent[],
): Set<string> {
  const fetchOps = new Set<string>()
  for (const event of events) {
    if (intentOperationKind(event) === 'source_fetch') {
      const id = intentOperationId(event)
      if (id) fetchOps.add(id)
    }
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
 * Passage ids recorded after a `source_fetch` intent and before its terminal completion,
 * only when that fetch settled `succeeded`. Orphans from failed/partial persistence stay in the store
 * but are excluded (including deterministic `passage-*` ids from technical adapters).
 */
export function passageIdsAdmittedUnderSucceededSourceFetches(
  events: readonly ResearchStoreEvent[],
): Set<string> {
  const succeeded = succeededSourceFetchOperationIds(events)
  const admitted = new Set<string>()

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (event.kind !== 'external_operation_intent') continue
    if (intentOperationKind(event) !== 'source_fetch') continue
    const operationId = intentOperationId(event)
    if (!operationId || !succeeded.has(operationId)) continue

    let completionIdx = -1
    for (let j = i + 1; j < events.length; j++) {
      const completion = completionRecord(events[j]!)
      if (completion?.operation_id === operationId) {
        completionIdx = j
        break
      }
    }
    if (completionIdx < 0) continue

    for (let k = i + 1; k < completionIdx; k++) {
      const mid = events[k]!
      if (mid.kind !== 'passage_recorded') continue
      const passage = (mid.payload as { passage: PassageRecord }).passage
      admitted.add(passage.passage_id)
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
