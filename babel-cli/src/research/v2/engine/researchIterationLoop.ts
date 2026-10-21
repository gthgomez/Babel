import type { MissionWriteContext } from '../contracts/common.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'

export interface PlanningIterationRequest {
  mission: ResearchMissionV2
  store: ResearchStore
  model: ResearchModelPort
  access: SourceAccessPort
  planRevision: PlanRevision
  modelOperationId: string
  modelAttemptId: string
  signal: AbortSignal
}

export interface PlanningIterationResult {
  handle: ResearchStoreMissionHandle
  writeContext: MissionWriteContext
  modelOperationId: string
  plannedQuestionCount: number
}

/**
 * One admitted planning iteration: dispatch model intent, invoke structured plan_questions,
 * persist plan revision. Uses injected ports only (no live API gate here).
 */
export async function runAdmittedPlanningIteration(
  request: PlanningIterationRequest,
): Promise<PlanningIterationResult> {
  if (request.signal.aborted) {
    throw new Error('planning iteration aborted')
  }
  const handle = await request.store.appendMission(request.mission)
  const acquired = await request.store.acquireWriterOwnership({
    mission_id: handle.mission_id,
    expected_writer_generation: handle.writer_generation,
  })
  const ctx: MissionWriteContext = {
    mission_id: acquired.mission_id,
    plan_revision_id: request.planRevision.plan_revision_id,
    writer_generation: acquired.writer_generation,
  }
  await request.store.appendPlanRevision(ctx, request.planRevision)
  await request.store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: request.modelOperationId,
    attempt_id: request.modelAttemptId,
    operation_kind: 'model_invoke',
    dispatched_at: new Date().toISOString(),
    idempotency_key: request.modelOperationId,
  })
  const modelResult = await request.model.invokeStructured({
    operationId: request.modelOperationId,
    attemptId: request.modelAttemptId,
    kind: 'plan_questions',
    input: { mission_id: ctx.mission_id },
    signal: request.signal,
  })
  if (modelResult.status === 'cancelled') {
    throw new Error('model invoke cancelled during planning iteration')
  }
  if (modelResult.status !== 'ok') {
    throw new Error(
      modelResult.status === 'failed' ? modelResult.message : 'model invoke uncertain during planning',
    )
  }
  const questions = (modelResult.output.questions as unknown[] | undefined) ?? []
  return {
    handle: acquired,
    writeContext: ctx,
    modelOperationId: request.modelOperationId,
    plannedQuestionCount: questions.length,
  }
}

/** Technical discover/read using frozen registry + admitted {@link SourceAccessPort}. */
export async function readTechnicalRepositorySource(
  access: SourceAccessPort,
  params: {
    operationId: string
    source: import('../contracts/sources.js').SourceRecord
    signal: AbortSignal
  },
) {
  const adapter = new TechnicalRepositoryFileAdapter()
  return adapter.read(
    { operationId: params.operationId, source: params.source, signal: params.signal },
    access,
  )
}
