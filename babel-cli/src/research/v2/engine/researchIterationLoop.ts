import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import {
  buildBootstrapPlanRevision,
  buildPlanRevisionFromPlanQuestions,
  missionRequirementsPayload,
} from './planFromModelOutput.js'

export interface AdmittedPlanningSession {
  mission: ResearchMissionV2
  handle: ResearchStoreMissionHandle
  /** When set, planning continues under an existing admitted plan revision (no bootstrap). */
  activePlanRevisionId?: string
}

export interface PlanningIterationRequest {
  session: AdmittedPlanningSession
  store: ResearchStore
  model: ResearchModelPort
  /** Retained for upcoming retrieval slices; not used during planning-only iteration. */
  access?: SourceAccessPort
  modelOperationId: string
  modelAttemptId: string
  planRevisionId: string
  bootstrapPlanRevisionId?: string
  revisionReason: string
  dispatchedAt: string
  signal: AbortSignal
  now?: () => string
}

export interface PlanningIterationResult {
  handle: ResearchStoreMissionHandle
  writeContext: MissionWriteContext
  modelOperationId: string
  planRevisionId: string
  plannedQuestionCount: number
  modelResult: ResearchModelInvocationResult
}

async function settleOperation(
  store: ResearchStore,
  ctx: MissionWriteContext,
  missionId: string,
  operationId: string,
  attemptId: string,
  modelResult: ResearchModelInvocationResult,
  completedAt: string,
): Promise<void> {
  const usage =
    modelResult.status === 'ok'
      ? modelResult.receipt.usage_settlement
      : modelResult.status === 'failed' || modelResult.status === 'cancelled' || modelResult.status === 'uncertain'
        ? modelResult.usageSettlement
        : undefined

  if (modelResult.status === 'ok') {
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: missionId,
      operation_id: operationId,
      attempt_id: attemptId,
      completed_at: completedAt,
      settlement: 'succeeded',
      usage_settlement: usage,
    })
    return
  }
  if (modelResult.status === 'cancelled') {
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: missionId,
      operation_id: operationId,
      attempt_id: attemptId,
      completed_at: completedAt,
      settlement: 'cancelled',
      usage_settlement: usage,
    })
    return
  }
  if (modelResult.status === 'uncertain') {
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: missionId,
      operation_id: operationId,
      attempt_id: attemptId,
      completed_at: completedAt,
      settlement: 'uncertain',
      usage_settlement: usage,
      message: modelResult.message,
    })
    return
  }
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: missionId,
    operation_id: operationId,
    attempt_id: attemptId,
    completed_at: completedAt,
    settlement: 'failed',
    usage_settlement: usage,
    failure_category: modelResult.failureCategory,
    message: modelResult.message,
  })
}

/**
 * One admitted planning iteration on an existing mission session: intent → model → persisted plan + accounting.
 * Does not recreate the mission or persist a plan before inference completes.
 */
export async function runAdmittedPlanningIteration(
  request: PlanningIterationRequest,
): Promise<PlanningIterationResult> {
  if (request.signal.aborted) {
    throw new Error('planning iteration aborted')
  }
  const now = request.now ?? (() => new Date().toISOString())
  const acquired = await request.store.acquireWriterOwnership({
    mission_id: request.session.handle.mission_id,
    expected_writer_generation: request.session.handle.writer_generation,
  })
  const activePlanRevisionId =
    request.session.activePlanRevisionId ??
    request.bootstrapPlanRevisionId ??
    `${request.planRevisionId}-bootstrap`
  if (!request.session.activePlanRevisionId) {
    const bootstrapCtx: MissionWriteContext = {
      mission_id: acquired.mission_id,
      plan_revision_id: activePlanRevisionId,
      writer_generation: acquired.writer_generation,
    }
    await request.store.appendPlanRevision(
      bootstrapCtx,
      buildBootstrapPlanRevision({
        mission: request.session.mission,
        planRevisionId: activePlanRevisionId,
        createdAt: request.dispatchedAt,
      }),
    )
  }
  const ctx: MissionWriteContext = {
    mission_id: acquired.mission_id,
    plan_revision_id: activePlanRevisionId,
    writer_generation: acquired.writer_generation,
  }

  await request.store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: request.modelOperationId,
    attempt_id: request.modelAttemptId,
    operation_kind: 'model_invoke',
    dispatched_at: request.dispatchedAt,
    idempotency_key: request.modelOperationId,
  })

  const modelResult = await request.model.invokeStructured({
    operationId: request.modelOperationId,
    attemptId: request.modelAttemptId,
    kind: 'plan_questions',
    input: missionRequirementsPayload(request.session.mission),
    signal: request.signal,
  })

  if (request.signal.aborted) {
    await settleOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.modelOperationId,
      request.modelAttemptId,
      {
        status: 'cancelled',
        operationId: request.modelOperationId,
        usageSettlement: modelResult.status === 'ok'
          ? modelResult.receipt.usage_settlement
          : modelResult.status === 'failed' || modelResult.status === 'cancelled' || modelResult.status === 'uncertain'
            ? modelResult.usageSettlement
            : { attempt_id: request.modelAttemptId, cost: { status: 'unknown' } },
      },
      now(),
    )
    throw new Error('planning iteration cancelled after model invoke')
  }

  if (modelResult.status === 'cancelled') {
    await settleOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.modelOperationId,
      request.modelAttemptId,
      modelResult,
      now(),
    )
    throw new Error('model invoke cancelled during planning iteration')
  }

  if (modelResult.status === 'uncertain') {
    await settleOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.modelOperationId,
      request.modelAttemptId,
      modelResult,
      now(),
    )
    throw new Error(modelResult.message)
  }

  if (modelResult.status === 'failed') {
    await settleOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.modelOperationId,
      request.modelAttemptId,
      modelResult,
      now(),
    )
    throw new Error(modelResult.message)
  }

  const planRevision = buildPlanRevisionFromPlanQuestions({
    mission: request.session.mission,
    planRevisionId: request.planRevisionId,
    revisionReason: request.revisionReason,
    createdAt: now(),
    modelOutput: modelResult.output,
  })

  await request.store.appendPlanRevision(ctx, planRevision)
  const evidenceCtx: MissionWriteContext = {
    ...ctx,
    plan_revision_id: planRevision.plan_revision_id,
  }
  await request.store.appendModelReceipt(evidenceCtx, modelResult.receipt)
  await settleOperation(
    request.store,
    evidenceCtx,
    ctx.mission_id,
    request.modelOperationId,
    request.modelAttemptId,
    modelResult,
    now(),
  )

  return {
    handle: acquired,
    writeContext: ctx,
    modelOperationId: request.modelOperationId,
    planRevisionId: planRevision.plan_revision_id,
    plannedQuestionCount: planRevision.questions.length,
    modelResult,
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
