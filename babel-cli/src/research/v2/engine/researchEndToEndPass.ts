import type { MissionWriteContext } from '../contracts/common.js'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import { missionRequirementsPayload } from './planFromModelOutput.js'
import { runAdmittedPlanningIteration, type AdmittedPlanningSession } from './researchIterationLoop.js'
import { runAdmittedRetrievalIteration } from './researchRetrievalLoop.js'
import { settleExternalOperation } from './settleExternalOperation.js'
import {
  applySemanticSupportReview,
  findingsFromExtractModelOutput,
} from './findingsFromModelOutput.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'

export interface ResearchEndToEndPassRequest {
  session: AdmittedPlanningSession
  store: ResearchStore
  model: ResearchModelPort
  access: SourceAccessPort
  adapter: SourceAdapter
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
  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: params.operationId,
    attempt_id: params.attemptId,
    operation_kind: 'model_invoke',
    dispatched_at: params.dispatchedAt,
    idempotency_key: params.operationId,
  })
  const result = await model.invokeStructured({
    operationId: params.operationId,
    attemptId: params.attemptId,
    kind: params.kind,
    input: params.input,
    signal: params.signal,
  })
  if (result.status === 'cancelled') {
    await settleExternalOperation(
      store,
      ctx,
      ctx.mission_id,
      params.operationId,
      params.attemptId,
      { settlement: 'cancelled' },
      params.now(),
    )
    throw new Error(`model ${params.kind} cancelled`)
  }
  if (result.status === 'failed' || result.status === 'uncertain') {
    await settleExternalOperation(
      store,
      ctx,
      ctx.mission_id,
      params.operationId,
      params.attemptId,
      {
        settlement: result.status === 'uncertain' ? 'uncertain' : 'failed',
        message: result.message,
        ...(result.status === 'failed' ? { failureCategory: result.failureCategory } : {}),
      },
      params.now(),
    )
    throw new Error(result.message)
  }
  await store.appendModelReceipt(ctx, result.receipt)
  await settleExternalOperation(
    store,
    ctx,
    ctx.mission_id,
    params.operationId,
    params.attemptId,
    { settlement: 'succeeded' },
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

  const retrieved = await runAdmittedRetrievalIteration({
    session: {
      mission: request.session.mission,
      handle: planned.handle,
      activePlanRevisionId: planned.planRevisionId,
    },
    store: request.store,
    access: request.access,
    adapter: request.adapter,
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
    await request.store.appendFinding(ctx, finding)
  }

  const reviewOutput = await invokeModelPhase(request.store, ctx, request.model, {
    operationId: request.reviewOperationId,
    attemptId: request.reviewAttemptId,
    kind: 'semantic_support_review',
    input: {
      mission_id: request.session.mission.mission_id,
      findings: findings.map((f) => ({
        finding_id: f.finding_id,
        assertion_text: f.assertion_text,
        passage_ids: f.passage_ids,
      })),
    },
    signal: request.signal,
    dispatchedAt: request.dispatchedAt,
    now,
  })

  findings = applySemanticSupportReview(findings, reviewOutput, now())

  const synthesizeOutput = await invokeModelPhase(request.store, ctx, request.model, {
    operationId: request.synthesizeOperationId,
    attemptId: request.synthesizeAttemptId,
    kind: 'synthesize_report',
    input: {
      mission_id: request.session.mission.mission_id,
      primary_question: request.session.mission.primary_question,
      findings: findings.map((f) => ({
        finding_id: f.finding_id,
        assertion_text: f.assertion_text,
        semantic_support: f.semantic_support?.status ?? 'not_checked',
      })),
    },
    signal: request.signal,
    dispatchedAt: request.dispatchedAt,
    now,
  })

  const report = buildSynthesizedResearchReport({
    mission: request.session.mission,
    plan: activePlan,
    ctx,
    findings,
    modelOutput: synthesizeOutput,
    generatedAt: now(),
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
