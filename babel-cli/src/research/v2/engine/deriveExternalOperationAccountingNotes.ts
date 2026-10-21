import type { ExternalOperationIntent } from '../contracts/operations.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'

function operationIntentAccountingKey(
  missionId: string,
  operationId: string,
  attemptId: string,
): string {
  return `${missionId}::${operationId}::${attemptId}`
}

/** Intents without a matching completion for the same mission, operation, and attempt. */
export function listUnsettledExternalOperationIntents(
  events: readonly ResearchStoreEvent[],
  missionId: string,
): ExternalOperationIntent[] {
  const intents = new Map<string, ExternalOperationIntent>()
  const completed = new Set<string>()
  for (const event of events) {
    if (event.missionId !== missionId) continue
    if (event.kind === 'external_operation_intent') {
      const intent = (event.payload as { intent?: ExternalOperationIntent }).intent
      if (!intent) continue
      intents.set(
        operationIntentAccountingKey(intent.mission_id, intent.operation_id, intent.attempt_id),
        intent,
      )
    }
    if (event.kind === 'external_operation_completed') {
      const completion = (event.payload as {
        completion?: { mission_id: string; operation_id: string; attempt_id: string }
      }).completion
      if (!completion) continue
      completed.add(
        operationIntentAccountingKey(
          completion.mission_id,
          completion.operation_id,
          completion.attempt_id,
        ),
      )
    }
  }
  return [...intents.values()].filter(
    (intent) =>
      !completed.has(
        operationIntentAccountingKey(intent.mission_id, intent.operation_id, intent.attempt_id),
      ),
  )
}

/** Terminal coverage note from intent/completion events (no blanket "settled" claim). */
export function deriveExternalOperationAccountingNotes(
  events: readonly ResearchStoreEvent[],
  missionId: string,
): string {
  const intentKeys: string[] = []
  const completedKeys = new Set<string>()
  for (const event of events) {
    if (event.missionId !== missionId) continue
    if (event.kind === 'external_operation_intent') {
      const intent = (event.payload as { intent?: ExternalOperationIntent }).intent
      if (!intent) continue
      intentKeys.push(
        operationIntentAccountingKey(intent.mission_id, intent.operation_id, intent.attempt_id),
      )
    }
    if (event.kind === 'external_operation_completed') {
      const completion = (event.payload as {
        completion?: { mission_id: string; operation_id: string; attempt_id: string }
      }).completion
      if (!completion) continue
      completedKeys.add(
        operationIntentAccountingKey(
          completion.mission_id,
          completion.operation_id,
          completion.attempt_id,
        ),
      )
    }
  }
  const pending = intentKeys.filter((key) => !completedKeys.has(key))
  if (intentKeys.length === 0) {
    return 'External operation accounting: no external_operation_intent events recorded for this mission.'
  }
  if (pending.length === 0) {
    return 'External operation accounting: each recorded external_operation_intent has a matching external_operation_completed event for the same mission, operation, and attempt.'
  }
  const sample = pending
    .slice(0, 4)
    .map((key) => {
      const parts = key.split('::')
      return parts.length === 3 ? `${parts[1]}@${parts[2]}` : key
    })
    .join(', ')
  const suffix = pending.length > 4 ? ` (+${pending.length - 4} more)` : ''
  return `External operation accounting: ${pending.length} intent(s) lack completion (${sample}${suffix}); usage may be pending or unknown.`
}
