import type { MissionWriteContext } from '../contracts/common.js'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { MissionRegistryBundle } from '../registry/missionAdapterResolution.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import { missionRequirementsPayload } from './planFromModelOutput.js'
import { runAdmittedPlanningIteration, type AdmittedPlanningSession } from './researchIterationLoop.js'
import { runAdmittedRetrievalIteration } from './researchRetrievalLoop.js'
import { runAdmittedComposedRetrievalIteration } from './researchComposedRetrievalLoop.js'
import { missionUsesComposedTechnicalRetrieval } from './technicalRetrievalComposition.js'
import { buildSemanticSupportReviewInput } from './buildSemanticSupportReviewInput.js'
import {
  applySemanticSupportReview,
  findingsFromExtractModelOutput,
} from './findingsFromModelOutput.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import { listSourceRevisionsFromStoreEvents } from './listSourceRevisionsFromStoreEvents.js'
import { settleModelOperation } from './settleModelOperation.js'
import { unknownUsageSettlement } from './settleExternalOperation.js'
import type { ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import {
  assertModelInvocationReceiptBound,
  ModelReceiptBindingError,
} from './validateModelInvocationReceipt.js'

export interface ResearchEndToEndPassRequest {
  session: AdmittedPlanningSession
  store: ResearchStore
  model: ResearchModelPort
  access: SourceAccessPort
  adapter: SourceAdapter
  readAdapter?: SourceAdapter
  registries?: MissionRegistryBundle
  discoverQuery: string
  planOperationId: string
  planAttemptId: string
  planRevisionId: string
  retrievalSearchOperationId: string
  retrievalSearchAttemptId: string
  retrievalFetchOperationId: string
  retrievalFetchAttemptId: string
  extractOperationId: string
  extractAttemptId: string
  reviewOperationId: string
  reviewAttemptId: string
  synthesizeOperationId: string
  synthesizeAttemptId: string
  dispatchedAt: string
  signal: AbortSignal
  now?: () => string
}

export interface ResearchEndToEndPassResult {
  handle: ResearchStoreMissionHandle
  writeContext: MissionWriteContext
  planRevisionId: string
  passageIds: string[]
  findingIds: string[]
  terminalReportEmitted: true
}

function throwIfAborted(signal: AbortSignal, phase: string): void {
  if (signal.aborted) {
    throw new Error(`research end-to-end pass aborted before ${phase}`)
  }
}

async function invokeModelPhase(
  store: ResearchStore,
  ctx: MissionWriteContext,
  model: ResearchModelPort,
  params: {
    operationId: string
    attemptId: string
    kind: 'extract_findings' | 'semantic_support_review' | 'synthesize_report'
    input: Record<string, unknown>
    signal: AbortSignal
    dispatchedAt: string
    now: () => string
  },
): Promise<Record<string, unknown>> {
  throwIfAborted(params.signal, `${params.kind} intent`)
  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: params.operationId,
    attempt_id: params.attemptId,
    operation_kind: 'model_invoke',
    dispatched_at: params.dispatchedAt,
    idempotency_key: params.operationId,
  })
  let result: ResearchModelInvocationResult
  try {
    result = await model.invokeStructured({
      operationId: params.operationId,
      attemptId: params.attemptId,
      kind: params.kind,
      input: params.input,
      signal: params.signal,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const thrown: ResearchModelInvocationResult = {
      status: 'uncertain',
      operationId: params.operationId,
      message: params.signal.aborted
        ? `model ${params.kind} rejected during cancellation: ${message}`
        : message,
      usageSettlement: unknownUsageSettlement(params.attemptId),
    }
    await settleModelOperation(
      store,
      ctx,
      ctx.mission_id,
      params.operationId,
      params.attemptId,
      thrown,
      params.now(),
    )
    throw err instanceof Error ? err : new Error(message)
  }

  if (params.signal.aborted) {
    const cancelled: ResearchModelInvocationResult = {
      status: 'cancelled',
      operationId: params.operationId,
      usageSettlement:
        result.status === 'ok'
          ? result.receipt.usage_settlement
          : result.status === 'failed' || result.status === 'cancelled' || result.status === 'uncertain'
            ? result.usageSettlement
            : unknownUsageSettlement(params.attemptId),
    }
    await settleModelOperation(
      store,
      ctx,
      ctx.mission_id,
      params.operationId,
      params.attemptId,
      cancelled,
      params.now(),
    )
    throw new Error(`model ${params.kind} cancelled after invoke`)
  }

  if (result.status === 'cancelled' || result.status === 'failed' || result.status === 'uncertain') {
    await settleModelOperation(
      store,
      ctx,
      ctx.mission_id,
      params.operationId,
      params.attemptId,
      result,
      params.now(),
    )
    throw new Error(
      result.status === 'failed' || result.status === 'uncertain'
        ? result.message
        : `model ${params.kind} cancelled`,
    )
  }

  throwIfAborted(params.signal, `${params.kind} evidence`)
  try {
    assertModelInvocationReceiptBound(params.operationId, params.attemptId, result)
  } catch (err: unknown) {
    const message = err instanceof ModelReceiptBindingError ? err.message : String(err)
    await settleModelOperation(
      store,
      ctx,
      ctx.mission_id,
      params.operationId,
      params.attemptId,
      {
        status: 'failed',
        operationId: params.operationId,
        failureCategory: 'contract_violation',
        message,
        usageSettlement: unknownUsageSettlement(params.attemptId),
      },
      params.now(),
    )
    throw err instanceof Error ? err : new Error(message)
  }
  await store.appendModelReceipt(ctx, result.receipt)
  await settleModelOperation(
    store,
    ctx,
    ctx.mission_id,
    params.operationId,
    params.attemptId,
    result,
    params.now(),
  )
  return result.output
}

/**
 * One offline/governed research pass: requirements → plan → admitted search/fetch/read →
 * extract → semantic review → cited synthesis report (honest partial outcomes).
 */
export async function runAdmittedResearchEndToEndPass(
  request: ResearchEndToEndPassRequest,
): Promise<ResearchEndToEndPassResult> {
  const now = request.now ?? (() => new Date().toISOString())
  const planned = await runAdmittedPlanningIteration({
    session: request.session,
    store: request.store,
    model: request.model,
    modelOperationId: request.planOperationId,
    modelAttemptId: request.planAttemptId,
    planRevisionId: request.planRevisionId,
    revisionReason: 'e2e_model_planning',
    dispatchedAt: request.dispatchedAt,
    signal: request.signal,
    now,
  })

  const planEvents = await request.store.listEvents(request.session.mission.mission_id)
  const activePlan = planEvents
    .filter((e) => e.kind === 'plan_revised')
    .map((e) => (e.payload as { plan: PlanRevision }).plan)
    .find((p) => p.plan_revision_id === planned.planRevisionId)
  if (!activePlan) {
    throw new Error('planned revision missing from store')
  }

  const composed = missionUsesComposedTechnicalRetrieval(request.session.mission)
  if (composed && !request.registries) {
    throw new Error('composed technical retrieval requires registries')
  }

  const retrieved = composed
    ? await runAdmittedComposedRetrievalIteration({
        session: {
          mission: request.session.mission,
          handle: planned.handle,
          activePlanRevisionId: planned.planRevisionId,
        },
        store: request.store,
        access: request.access,
        adapter: request.adapter,
        registries: request.registries!,
        activePlan,
        discoverQuery: request.discoverQuery,
        searchOperationId: request.retrievalSearchOperationId,
        searchAttemptId: request.retrievalSearchAttemptId,
        fetchOperationId: request.retrievalFetchOperationId,
        fetchAttemptId: request.retrievalFetchAttemptId,
        dispatchedAt: request.dispatchedAt,
        signal: request.signal,
        now,
      })
    : await runAdmittedRetrievalIteration({
        session: {
          mission: request.session.mission,
          handle: planned.handle,
          activePlanRevisionId: planned.planRevisionId,
        },
        store: request.store,
        access: request.access,
        adapter: request.adapter,
        ...(request.readAdapter ? { readAdapter: request.readAdapter } : {}),
        ...(request.registries ? { registries: request.registries } : {}),
        activePlan,
        discoverQuery: request.discoverQuery,
        searchOperationId: request.retrievalSearchOperationId,
        searchAttemptId: request.retrievalSearchAttemptId,
        fetchOperationId: request.retrievalFetchOperationId,
        fetchAttemptId: request.retrievalFetchAttemptId,
        dispatchedAt: request.dispatchedAt,
        signal: request.signal,
        now,
      })

  const composedRetrievalLimitations = composed && 'limitations' in retrieved ? retrieved.limitations : []

  const ctx = retrieved.writeContext
  const passageEvents = (await request.store.listEvents(request.session.mission.mission_id)).filter(
    (e) => e.kind === 'passage_recorded',
  )
  const passages: PassageRecord[] = passageEvents.map(
    (e) => (e.payload as { passage: PassageRecord }).passage,
  )

  const extractOutput = await invokeModelPhase(request.store, ctx, request.model, {
    operationId: request.extractOperationId,
    attemptId: request.extractAttemptId,
    kind: 'extract_findings',
    input: {
      mission_id: request.session.mission.mission_id,
      plan_revision_id: planned.planRevisionId,
      mission_requirements: missionRequirementsPayload(request.session.mission),
      passage_ids: retrieved.passageIds,
      passages: passages.map((p) => ({
        passage_id: p.passage_id,
        text: p.text_ref.mode === 'inline' ? p.text_ref.text : '',
      })),
      plan_questions: activePlan.questions.map((q) => ({
        question_id: q.question_id,
        text: q.text,
      })),
    },
    signal: request.signal,
    dispatchedAt: request.dispatchedAt,
    now,
  })

  let findings: FindingRecord[] = findingsFromExtractModelOutput({
    operationId: request.extractOperationId,
    modelOutput: extractOutput,
    plan: activePlan,
    passages,
    createdAt: now(),
  })
  for (const finding of findings) {
    throwIfAborted(request.signal, 'finding persistence')
    await request.store.appendFinding(ctx, finding)
  }

  const reviewInput = buildSemanticSupportReviewInput(findings, passages, activePlan)
  const reviewOutput = await invokeModelPhase(request.store, ctx, request.model, {
    operationId: request.reviewOperationId,
    attemptId: request.reviewAttemptId,
    kind: 'semantic_support_review',
    input: {
      mission_id: request.session.mission.mission_id,
      ...reviewInput,
    },
    signal: request.signal,
    dispatchedAt: request.dispatchedAt,
    now,
  })

  findings = applySemanticSupportReview(findings, reviewOutput, now())
  for (const finding of findings) {
    throwIfAborted(request.signal, 'semantic judgment persistence')
    await request.store.appendFinding(ctx, finding)
  }

  const synthesizeOutput = await invokeModelPhase(request.store, ctx, request.model, {
    operationId: request.synthesizeOperationId,
    attemptId: request.synthesizeAttemptId,
    kind: 'synthesize_report',
    input: {
      mission_id: request.session.mission.mission_id,
      primary_question: request.session.mission.primary_question,
      findings: findings.map((f) => ({
        finding_id: f.finding_id,
        question_id: f.question_id,
        assertion_text: f.assertion_text,
        semantic_support: f.semantic_support?.status ?? 'not_checked',
      })),
    },
    signal: request.signal,
    dispatchedAt: request.dispatchedAt,
    now,
  })

  throwIfAborted(request.signal, 'terminal report')
  const evidenceEvents = await request.store.listEvents(request.session.mission.mission_id)
  const sourceRevisions = listSourceRevisionsFromStoreEvents(evidenceEvents)
  const report = buildSynthesizedResearchReport({
    mission: request.session.mission,
    plan: activePlan,
    ctx,
    findings,
    passages,
    sourceRevisions,
    modelOutput: synthesizeOutput,
    generatedAt: now(),
    ...(composedRetrievalLimitations.length > 0
      ? { additionalLimitations: composedRetrievalLimitations }
      : {}),
  })
  await request.store.appendTerminalReport(ctx, report)

  return {
    handle: retrieved.handle,
    writeContext: ctx,
    planRevisionId: planned.planRevisionId,
    passageIds: retrieved.passageIds,
    findingIds: findings.map((f) => f.finding_id),
    terminalReportEmitted: true,
  }
}
