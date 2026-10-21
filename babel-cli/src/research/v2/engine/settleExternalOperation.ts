import type { MissionWriteContext } from '../contracts/common.js'
import type { ExternalOperationCompletion } from '../contracts/operations.js'
import type { ResearchStore } from '../ports/researchStore.js'

export interface ExternalOperationOutcome {
  settlement: ExternalOperationCompletion['settlement']
  failureCategory?: string
  message?: string
}

/** Persist intent completion for non-model external operations (search/fetch). */
export async function settleExternalOperation(
  store: ResearchStore,
  ctx: MissionWriteContext,
  missionId: string,
  operationId: string,
  attemptId: string,
  outcome: ExternalOperationOutcome,
  completedAt: string,
): Promise<void> {
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: missionId,
    operation_id: operationId,
    attempt_id: attemptId,
    completed_at: completedAt,
    settlement: outcome.settlement,
    ...(outcome.failureCategory ? { failure_category: outcome.failureCategory } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
  })
}
