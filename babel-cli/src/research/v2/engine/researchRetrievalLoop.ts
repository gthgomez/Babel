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
  sourceFetchOwnerFromFetch,
  stampSourceFetchEvidenceOwnerOnPassage,
  stampSourceFetchEvidenceOwnerOnRevision,
} from './retrievalEvidenceOwnership.js'
import {
  resolveReadAdapterForSource,
  type MissionRegistryBundle,
} from '../registry/missionAdapterResolution.js'
import { resolveMissionWebRetrievalCandidates } from '../access/missionWebRetrievalSelection.js'
import { stampCoverageSourceSlotOnSource } from './missionCoverageSourceSlots.js'
import {
  reportLimitationsFromSearchProviderReceipt,
  searchProviderReceiptFromDiscover,
  sourceSearchCompletionOutcome,
} from './sourceDiscoverSearchReceipt.js'
import { slotOperationSuffix } from './technicalRetrievalComposition.js'
import type { SourceSearchProviderReceipt } from '../contracts/sourceSearchProviderReceipt.js'

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
  /**
   * When set (composed repository-pin child), stamps `coverage_source_slot` on persisted sources
   * instead of legacy `discover-primary` for single-candidate discover.
   */
  coverageSourceSlotId?: string
  now?: () => string
}

export interface RetrievalIterationResult {
  handle: ResearchStoreMissionHandle
  writeContext: MissionWriteContext
  source: SourceRecord
  sources: SourceRecord[]
  revisionId: string
  passageIds: string[]
  limitations: string[]
  searchOperationId: string
  fetchOperationId: string
  terminalReportEmitted: boolean
  searchProviderReceipt?: SourceSearchProviderReceipt
}

function resolveSlotFetchOperationIds(
  request: RetrievalIterationRequest,
  slotId: string,
  multiWebRetrieval: boolean,
): { fetchOperationId: string; fetchAttemptId: string } {
  if (!multiWebRetrieval) {
    return {
      fetchOperationId: request.fetchOperationId,
      fetchAttemptId: request.fetchAttemptId,
    }
  }
  return {
    fetchOperationId: slotOperationSuffix(request.fetchOperationId, slotId),
    fetchAttemptId: slotOperationSuffix(request.fetchAttemptId, slotId),
  }
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

/** Child iteration acquired writer ownership then failed; carries this controller's CAS handle only. */
export class RetrievalIterationFailedAfterAcquireError extends Error {
  readonly acquiredHandle: ResearchStoreMissionHandle
  readonly writeContext: MissionWriteContext

  constructor(
    message: string,
    acquiredHandle: ResearchStoreMissionHandle,
    writeContext: MissionWriteContext,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RetrievalIterationFailedAfterAcquireError'
    this.acquiredHandle = acquiredHandle
    this.writeContext = writeContext
  }

  static from(
    acquired: ResearchStoreMissionHandle,
    ctx: MissionWriteContext,
    err: unknown,
  ): RetrievalIterationFailedAfterAcquireError {
    const message = err instanceof Error ? err.message : String(err)
    return new RetrievalIterationFailedAfterAcquireError(
      message,
      acquired,
      ctx,
      err instanceof Error ? { cause: err } : undefined,
    )
  }

  static withMessage(
    acquired: ResearchStoreMissionHandle,
    ctx: MissionWriteContext,
    message: string,
  ): RetrievalIterationFailedAfterAcquireError {
    return new RetrievalIterationFailedAfterAcquireError(message, acquired, ctx)
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
    throw RetrievalIterationFailedAfterAcquireError.from(acquired, ctx, err)
  }

  if (discover.status === 'cancelled' || request.signal.aborted) {
    const cancelledSearchReceipt = searchProviderReceiptFromDiscover(discover)
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.searchOperationId,
      request.searchAttemptId,
      {
        settlement: 'cancelled',
        ...(cancelledSearchReceipt
          ? sourceSearchCompletionOutcome({
              discoverReceipt: cancelledSearchReceipt,
              searchAttemptId: request.searchAttemptId,
              completedAt: now(),
            })
          : {}),
      },
      now(),
    )
    throw RetrievalIterationFailedAfterAcquireError.withMessage(
      acquired,
      ctx,
      'source discover cancelled during retrieval iteration',
    )
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
    throw RetrievalIterationFailedAfterAcquireError.withMessage(
      acquired,
      ctx,
      'discover operationId does not match admitted search operation',
    )
  }

  if (discover.status === 'failed') {
    const failedSearchReceipt = discover.search_provider_receipt
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
        ...(failedSearchReceipt
          ? sourceSearchCompletionOutcome({
              discoverReceipt: failedSearchReceipt,
              searchAttemptId: request.searchAttemptId,
              completedAt: now(),
            })
          : {}),
      },
      now(),
    )
    throw RetrievalIterationFailedAfterAcquireError.withMessage(acquired, ctx, discover.message)
  }

  const resolution = resolveMissionWebRetrievalCandidates(
    discover.candidates,
    request.session.mission,
  )
  const multiWebRetrieval = (request.session.mission.source_policy.selected_web_refs ?? []).length > 0
  const searchProviderReceipt =
    discover.status === 'ok' ? discover.search_provider_receipt : undefined
  const limitations = [
    ...resolution.limitations,
    ...(searchProviderReceipt
      ? reportLimitationsFromSearchProviderReceipt(searchProviderReceipt)
      : []),
  ]

  if (resolution.slots.length === 0) {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      request.searchOperationId,
      request.searchAttemptId,
      {
        settlement: 'failed',
        failureCategory: 'no_candidates',
        message: 'discover returned no admitted source candidates',
        ...(searchProviderReceipt
          ? sourceSearchCompletionOutcome({
              discoverReceipt: searchProviderReceipt,
              searchAttemptId: request.searchAttemptId,
              completedAt: now(),
            })
          : {}),
      },
      now(),
    )
    throw RetrievalIterationFailedAfterAcquireError.withMessage(
      acquired,
      ctx,
      'discover returned no admitted source candidates',
    )
  }

  throwIfAborted(request.signal, 'source_search settlement')

  await settleExternalOperation(
    request.store,
    ctx,
    ctx.mission_id,
    request.searchOperationId,
    request.searchAttemptId,
    {
      settlement: 'succeeded',
      ...(searchProviderReceipt
        ? sourceSearchCompletionOutcome({
            discoverReceipt: searchProviderReceipt,
            searchAttemptId: request.searchAttemptId,
            completedAt: now(),
          })
        : {}),
    },
    now(),
  )

  const persistedSources: SourceRecord[] = []
  const allPassages: PassageRecord[] = []
  let firstRevisionId = ''

  for (const slot of resolution.slots) {
    throwIfAborted(request.signal, `source_fetch ${slot.slotId}`)
    const coverageSlotId = request.coverageSourceSlotId ?? slot.slotId
    const candidate = stampCoverageSourceSlotOnSource(slot.candidate, coverageSlotId)
    const { fetchOperationId, fetchAttemptId } = resolveSlotFetchOperationIds(
      request,
      slot.slotId,
      multiWebRetrieval,
    )

    const readAdapter =
      request.readAdapter ??
      (request.registries
        ? resolveReadAdapterForSource(candidate, request.registries)
        : undefined) ??
      request.adapter

    await request.store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: fetchOperationId,
      attempt_id: fetchAttemptId,
      operation_kind: 'source_fetch',
      dispatched_at: request.dispatchedAt,
      idempotency_key: fetchOperationId,
    })

    let read
    try {
      read = await readAdapter.read(
        {
          operationId: fetchOperationId,
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
        fetchOperationId,
        fetchAttemptId,
        {
          settlement: 'uncertain',
          message: request.signal.aborted
            ? `source read rejected during cancellation: ${message}`
            : message,
          usage_settlement: unknownUsageSettlement(fetchAttemptId),
        },
        now(),
      )
      if (request.signal.aborted || !multiWebRetrieval) {
        throw RetrievalIterationFailedAfterAcquireError.from(acquired, ctx, err)
      }
      limitations.push(`retrieval_web_ref_failed:${slot.slotId}:${message}`)
      continue
    }

    if (read.status === 'cancelled' || request.signal.aborted) {
      await settleExternalOperation(
        request.store,
        ctx,
        ctx.mission_id,
        fetchOperationId,
        fetchAttemptId,
        { settlement: 'cancelled' },
        now(),
      )
      throw RetrievalIterationFailedAfterAcquireError.withMessage(
        acquired,
        ctx,
        'source read cancelled during retrieval iteration',
      )
    }
    if (read.status === 'failed') {
      await settleExternalOperation(
        request.store,
        ctx,
        ctx.mission_id,
        fetchOperationId,
        fetchAttemptId,
        {
          settlement: 'failed',
          failureCategory: read.failureCategory,
          message: read.message,
          ...(read.acquisition_diagnostics
            ? { acquisition_diagnostics: read.acquisition_diagnostics }
            : {}),
        },
        now(),
      )
      if (!multiWebRetrieval) {
        throw RetrievalIterationFailedAfterAcquireError.from(
          acquired,
          ctx,
          new ResearchPassFailedError(read.message, {
            stoppingReason: 'source_retrieval_failed',
            failurePhase: 'retrieval',
          }),
        )
      }
      limitations.push(`retrieval_web_ref_failed:${slot.slotId}:${read.message}`)
      continue
    }

    throwIfAborted(request.signal, 'evidence persistence')

    let revision
    let passages: PassageRecord[]
    try {
      const bound = validateRetrievalEvidenceBindings({
        searchOperationId: request.searchOperationId,
        fetchOperationId,
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
        fetchOperationId,
        fetchAttemptId,
        {
          settlement: 'failed',
          failureCategory: 'evidence_binding_failed',
          message,
        },
        now(),
      )
      if (!multiWebRetrieval) {
        throw RetrievalIterationFailedAfterAcquireError.from(acquired, ctx, err)
      }
      limitations.push(`retrieval_web_ref_failed:${slot.slotId}:${message}`)
      continue
    }

    try {
      const evidenceOwner = sourceFetchOwnerFromFetch(
        ctx.mission_id,
        fetchOperationId,
        fetchAttemptId,
      )
      await request.store.appendSource(ctx, candidate)
      throwIfAborted(request.signal, 'source revision persistence')
      await request.store.appendSourceRevision(
        ctx,
        stampSourceFetchEvidenceOwnerOnRevision(revision, evidenceOwner),
      )
      for (const passage of passages) {
        throwIfAborted(request.signal, 'passage persistence')
        await request.store.appendPassage(
          ctx,
          stampSourceFetchEvidenceOwnerOnPassage(passage, evidenceOwner),
        )
      }
      throwIfAborted(request.signal, 'evidence persistence completion')
    } catch (err: unknown) {
      if (request.signal.aborted) {
        await settleExternalOperation(
          request.store,
          ctx,
          ctx.mission_id,
          fetchOperationId,
          fetchAttemptId,
          {
            settlement: 'cancelled',
            message: 'evidence persistence aborted',
            usage_settlement: unknownUsageSettlement(fetchAttemptId),
          },
          now(),
        )
        throw RetrievalIterationFailedAfterAcquireError.withMessage(
          acquired,
          ctx,
          'retrieval iteration aborted during evidence persistence',
        )
      }
      const message = err instanceof Error ? err.message : String(err)
      await settleExternalOperation(
        request.store,
        ctx,
        ctx.mission_id,
        fetchOperationId,
        fetchAttemptId,
        {
          settlement: 'failed',
          failureCategory: 'evidence_persistence_failed',
          message,
        },
        now(),
      )
      throw RetrievalIterationFailedAfterAcquireError.from(acquired, ctx, err)
    }

    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      fetchOperationId,
      fetchAttemptId,
      { settlement: 'succeeded' },
      now(),
    )
    persistedSources.push(candidate)
    allPassages.push(...passages)
    if (!firstRevisionId) {
      firstRevisionId = revision.revision_id
    }
  }

  if (persistedSources.length === 0) {
    throw RetrievalIterationFailedAfterAcquireError.from(
      acquired,
      ctx,
      new ResearchPassFailedError('retrieval produced no admitted sources', {
        stoppingReason: 'source_retrieval_failed',
        failurePhase: 'retrieval',
      }),
    )
  }

  const primarySource = persistedSources[0]!

  let terminalReportEmitted = false
  if (request.emitOfflineTerminalReport) {
    throwIfAborted(request.signal, 'terminal report')
    const report = buildOfflineRetrievalReport({
      mission: request.session.mission,
      plan: request.activePlan,
      ctx,
      passages: allPassages,
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
    source: primarySource,
    sources: persistedSources,
    revisionId: firstRevisionId,
    passageIds: allPassages.map((p) => p.passage_id),
    limitations,
    searchOperationId: request.searchOperationId,
    fetchOperationId: request.fetchOperationId,
    terminalReportEmitted,
    ...(searchProviderReceipt ? { searchProviderReceipt } : {}),
  }
}
