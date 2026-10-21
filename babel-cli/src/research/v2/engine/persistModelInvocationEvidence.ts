import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import type { ResearchStore } from '../ports/researchStore.js'
import { settleModelOperation } from './settleModelOperation.js'

/**
 * Persist receipt + settle usage after a bound successful model invoke.
 * If receipt append fails, still attempts completion settlement with request-local usage.
 */
export async function persistModelInvocationEvidence(params: {
  store: ResearchStore
  ctx: MissionWriteContext
  missionId: string
  operationId: string
  attemptId: string
  modelResult: Extract<ResearchModelInvocationResult, { status: 'ok' }>
  completedAt: string
}): Promise<void> {
  try {
    await params.store.appendModelReceipt(params.ctx, params.modelResult.receipt)
  } catch (receiptErr: unknown) {
    const receiptMessage =
      receiptErr instanceof Error ? receiptErr.message : String(receiptErr)
    try {
      await settleModelOperation(
        params.store,
        params.ctx,
        params.missionId,
        params.operationId,
        params.attemptId,
        params.modelResult,
        params.completedAt,
      )
    } catch {
      // Secondary settlement failure: report receipt failure; accounting may remain pending.
    }
    throw new Error(
      `model receipt persistence failed after successful invoke: ${receiptMessage}`,
    )
  }
  await settleModelOperation(
    params.store,
    params.ctx,
    params.missionId,
    params.operationId,
    params.attemptId,
    params.modelResult,
    params.completedAt,
  )
}
