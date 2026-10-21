import type { MissionWriteContext } from '../contracts/common.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import type { AdmittedPlanningSession } from './researchIterationLoop.js'
import {
  buildOfflineRetrievalReport,
  type RetrievalExecutionProvenance,
} from './buildOfflineRetrievalReport.js'
import {
  settleExternalOperation,
  unknownUsageSettlement,
} from './settleExternalOperation.js'
import { ResearchPassFailedError } from './researchPassFailure.js'
import {
  RetrievalEvidenceBindingError,
  validateRetrievalEvidenceBindings,
} from './validateRetrievalEvidenceBindings.js'
import {
  resolveReadAdapterForSource,
  type MissionRegistryBundle,
} from '../registry/missionAdapterResolution.js'

export interface RetrievalIterationRequest {
  session: AdmittedPlanningSession
  store: ResearchStore
  access: SourceAccessPort
  /** Adapter used for source discover (search-backed). */
  adapter: SourceAdapter
  /** Adapter used for read/extract; defaults to {@link RetrievalIterationRequest.adapter}. */
  readAdapter?: SourceAdapter
  /** When set, resolves read adapter from discovered source if readAdapter is omitted. */
  registries?: MissionRegistryBundle
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
  /** Labels terminal report limitations; omit to avoid claiming offline-only execution. */
  executionProvenance?: RetrievalExecutionProvenance
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

function throwIfAborted(signal: AbortSignal, phase: string): void {
  if (signal.aborted) {
    throw new Error(`retrieval iteration aborted before ${phase}`)
  }
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

  let discover
  try {
    discover = await request.adapter.discover(
      {
        operationId: request.searchOperationId,
        query: request.discoverQuery,
        signal: request.signal,
      },
      request.access,
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.searchOperationId,
      request.searchAttemptId,
      {
        settlement: 'uncertain',
        message: request.signal.aborted
          ? `source discover rejected during cancellation: ${message}`
          : message,
        usage_settlement: unknownUsageSettlement(request.searchAttemptId),
      },
      now(),
    )
    throw err instanceof Error ? err : new Error(message)
  }

  if (discover.status === 'cancelled' || request.signal.aborted) {
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
  if (discover.status === 'ok' && discover.operationId !== request.searchOperationId) {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.searchOperationId,
      request.searchAttemptId,
      {
        settlement: 'failed',
        failureCategory: 'contract_violation',
        message: 'discover operationId does not match admitted search operation',
      },
      now(),
    )
    throw new Error('discover operationId does not match admitted search operation')
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

  const readAdapter =
    request.readAdapter ??
    (request.registries
      ? resolveReadAdapterForSource(candidate, request.registries)
      : undefined) ??
    request.adapter

  throwIfAborted(request.signal, 'source_search settlement')

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

  let read
  try {
    read = await readAdapter.read(
      {
        operationId: request.fetchOperationId,
        source: candidate,
        signal: request.signal,
      },
      request.access,
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.fetchOperationId,
      request.fetchAttemptId,
      {
        settlement: 'uncertain',
        message: request.signal.aborted
          ? `source read rejected during cancellation: ${message}`
          : message,
        usage_settlement: unknownUsageSettlement(request.fetchAttemptId),
      },
      now(),
    )
    throw err instanceof Error ? err : new Error(message)
  }

  if (read.status === 'cancelled' || request.signal.aborted) {
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
        ...(read.status === 'failed' && read.acquisition_diagnostics
          ? { acquisition_diagnostics: read.acquisition_diagnostics }
          : {}),
      },
      now(),
    )
    throw new ResearchPassFailedError(read.message, {
      stoppingReason: 'source_retrieval_failed',
      failurePhase: 'retrieval',
    })
  }

  throwIfAborted(request.signal, 'evidence persistence')

  let revision
  let passages: PassageRecord[]
  try {
    const bound = validateRetrievalEvidenceBindings({
      searchOperationId: request.searchOperationId,
      fetchOperationId: request.fetchOperationId,
      discover,
      read,
      candidate,
      mission: request.session.mission,
      plan: request.activePlan,
      ctx,
    })
    revision = bound.revision
    passages = bound.passages
  } catch (err: unknown) {
    const message = err instanceof RetrievalEvidenceBindingError ? err.message : String(err)
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.fetchOperationId,
      request.fetchAttemptId,
      {
        settlement: 'failed',
        failureCategory: 'evidence_binding_failed',
        message,
      },
      now(),
    )
    throw err instanceof Error ? err : new Error(message)
  }

  try {
    await request.store.appendSource(ctx, candidate)
    throwIfAborted(request.signal, 'source revision persistence')
    await request.store.appendSourceRevision(ctx, revision)
    for (const passage of passages) {
      throwIfAborted(request.signal, 'passage persistence')
      await request.store.appendPassage(ctx, passage)
    }
    throwIfAborted(request.signal, 'evidence persistence completion')
  } catch (err: unknown) {
    if (request.signal.aborted) {
      await settleExternalOperation(
        request.store,
        ctx,
        ctx.mission_id,
        request.fetchOperationId,
        request.fetchAttemptId,
        {
          settlement: 'cancelled',
          message: 'evidence persistence aborted',
          usage_settlement: unknownUsageSettlement(request.fetchAttemptId),
        },
        now(),
      )
      throw new Error('retrieval iteration aborted during evidence persistence')
    }
    throw err instanceof Error ? err : new Error(String(err))
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
    throwIfAborted(request.signal, 'terminal report')
    const report = buildOfflineRetrievalReport({
      mission: request.session.mission,
      plan: request.activePlan,
      ctx,
      passages,
      generatedAt: now(),
      ...(request.executionProvenance !== undefined
        ? { executionProvenance: request.executionProvenance }
        : {}),
    })
    await request.store.appendTerminalReport(ctx, report)
    terminalReportEmitted = true
  }

  return {
    handle: acquired,
    writeContext: ctx,
    source: candidate,
    revisionId: revision.revision_id,
    passageIds: passages.map((p) => p.passage_id),
    searchOperationId: request.searchOperationId,
    fetchOperationId: request.fetchOperationId,
    terminalReportEmitted,
  }
}
