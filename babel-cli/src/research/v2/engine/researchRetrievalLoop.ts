import type { MissionWriteContext } from '../contracts/common.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import type { AdmittedPlanningSession } from './researchIterationLoop.js'
import { buildOfflineRetrievalReport } from './buildOfflineRetrievalReport.js'
import { settleExternalOperation } from './settleExternalOperation.js'

export interface RetrievalIterationRequest {
  session: AdmittedPlanningSession
  store: ResearchStore
  access: SourceAccessPort
  adapter: SourceAdapter
  activePlan: PlanRevision
  discoverQuery: string
  searchOperationId: string
  searchAttemptId: string
  fetchOperationId: string
  fetchAttemptId: string
  dispatchedAt: string
  signal: AbortSignal
  /** When true, append an honest offline partial terminal report after evidence writes. */
  emitOfflineTerminalReport?: boolean
  now?: () => string
}

export interface RetrievalIterationResult {
  handle: ResearchStoreMissionHandle
  writeContext: MissionWriteContext
  source: SourceRecord
  revisionId: string
  passageIds: string[]
  searchOperationId: string
  fetchOperationId: string
  terminalReportEmitted: boolean
}

function assertActivePlan(session: AdmittedPlanningSession): string {
  const planRevisionId = session.activePlanRevisionId
  if (!planRevisionId) {
    throw new Error('retrieval requires an active admitted plan revision on the session')
  }
  return planRevisionId
}

/**
 * Admitted discover → read → evidence persistence through {@link SourceAdapter} + {@link SourceAccessPort}.
 * IO stays on the access port; extraction stays in profile adapters (technical today; general via B registry later).
 */
export async function runAdmittedRetrievalIteration(
  request: RetrievalIterationRequest,
): Promise<RetrievalIterationResult> {
  if (request.signal.aborted) {
    throw new Error('retrieval iteration aborted')
  }
  const now = request.now ?? (() => new Date().toISOString())
  const activePlanRevisionId = assertActivePlan(request.session)
  if (request.activePlan.plan_revision_id !== activePlanRevisionId) {
    throw new Error('activePlan does not match session active plan revision')
  }

  const acquired = await request.store.acquireWriterOwnership({
    mission_id: request.session.handle.mission_id,
    expected_writer_generation: request.session.handle.writer_generation,
  })
  const ctx: MissionWriteContext = {
    mission_id: acquired.mission_id,
    plan_revision_id: activePlanRevisionId,
    writer_generation: acquired.writer_generation,
  }

  await request.store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: request.searchOperationId,
    attempt_id: request.searchAttemptId,
    operation_kind: 'source_search',
    dispatched_at: request.dispatchedAt,
    idempotency_key: request.searchOperationId,
  })

  const discover = await request.adapter.discover(
    {
      operationId: request.searchOperationId,
      query: request.discoverQuery,
      signal: request.signal,
    },
    request.access,
  )

  if (discover.status === 'cancelled') {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.searchOperationId,
      request.searchAttemptId,
      { settlement: 'cancelled' },
      now(),
    )
    throw new Error('source discover cancelled during retrieval iteration')
  }
  if (discover.status === 'failed') {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.searchOperationId,
      request.searchAttemptId,
      {
        settlement: 'failed',
        failureCategory: discover.failureCategory,
        message: discover.message,
      },
      now(),
    )
    throw new Error(discover.message)
  }

  const candidate = discover.candidates[0]
  if (!candidate) {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.searchOperationId,
      request.searchAttemptId,
      {
        settlement: 'failed',
        failureCategory: 'no_candidates',
        message: 'discover returned no source candidates',
      },
      now(),
    )
    throw new Error('discover returned no source candidates')
  }

  await settleExternalOperation(
    request.store,
    ctx,
    ctx.mission_id,
    request.searchOperationId,
    request.searchAttemptId,
    { settlement: 'succeeded' },
    now(),
  )

  await request.store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: request.fetchOperationId,
    attempt_id: request.fetchAttemptId,
    operation_kind: 'source_fetch',
    dispatched_at: request.dispatchedAt,
    idempotency_key: request.fetchOperationId,
  })

  const read = await request.adapter.read(
    {
      operationId: request.fetchOperationId,
      source: candidate,
      signal: request.signal,
    },
    request.access,
  )

  if (read.status === 'cancelled') {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.fetchOperationId,
      request.fetchAttemptId,
      { settlement: 'cancelled' },
      now(),
    )
    throw new Error('source read cancelled during retrieval iteration')
  }
  if (read.status === 'failed') {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.fetchOperationId,
      request.fetchAttemptId,
      {
        settlement: 'failed',
        failureCategory: read.failureCategory,
        message: read.message,
      },
      now(),
    )
    throw new Error(read.message)
  }

  await request.store.appendSource(ctx, candidate)
  await request.store.appendSourceRevision(ctx, read.revision)
  const passages: PassageRecord[] = []
  for (const passage of read.passages) {
    await request.store.appendPassage(ctx, passage)
    passages.push(passage)
  }

  await settleExternalOperation(
    request.store,
    ctx,
    ctx.mission_id,
    request.fetchOperationId,
    request.fetchAttemptId,
    { settlement: 'succeeded' },
    now(),
  )

  let terminalReportEmitted = false
  if (request.emitOfflineTerminalReport) {
    const report = buildOfflineRetrievalReport({
      mission: request.session.mission,
      plan: request.activePlan,
      ctx,
      passages,
      generatedAt: now(),
    })
    await request.store.appendTerminalReport(ctx, report)
    terminalReportEmitted = true
  }

  return {
    handle: acquired,
    writeContext: ctx,
    source: candidate,
    revisionId: read.revision.revision_id,
    passageIds: passages.map((p) => p.passage_id),
    searchOperationId: request.searchOperationId,
    fetchOperationId: request.fetchOperationId,
    terminalReportEmitted,
  }
}
