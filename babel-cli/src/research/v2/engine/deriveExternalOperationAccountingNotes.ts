import type { ResearchStoreEvent } from '../ports/researchStore.js'

/** Honest terminal coverage note derived from intent/completion events (no blanket "settled" claim). */
export function deriveExternalOperationAccountingNotes(
  events: readonly ResearchStoreEvent[],
): string {
  const intentOperationIds: string[] = []
  const completedOperationIds = new Set<string>()
  for (const event of events) {
    if (event.kind === 'external_operation_intent') {
      const intent = (event.payload as { intent?: { operation_id?: string } }).intent
      const operationId = intent?.operation_id
      if (operationId) intentOperationIds.push(operationId)
    }
    if (event.kind === 'external_operation_completed') {
      const operationId = (event.payload as { completion?: { operation_id?: string } })
        .completion?.operation_id
      if (operationId) completedOperationIds.add(operationId)
    }
  }
  const pending = intentOperationIds.filter((id) => !completedOperationIds.has(id))
  if (intentOperationIds.length === 0) {
    return 'External operation accounting: no external_operation_intent events recorded for this mission.'
  }
  if (pending.length === 0) {
    return 'External operation accounting: each recorded external_operation_intent has a matching external_operation_completed event.'
  }
  const sample = pending.slice(0, 4).join(', ')
  const suffix = pending.length > 4 ? ` (+${pending.length - 4} more)` : ''
  return `External operation accounting: ${pending.length} intent(s) lack completion (${sample}${suffix}); usage may be pending or unknown.`
}
