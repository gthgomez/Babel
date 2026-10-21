import type { MissionWriteContext } from '../contracts/common.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord } from '../contracts/sources.js'
import {
  missionScopedToDocumentRef,
  missionScopedToRepositoryPin,
} from '../access/missionPinnedRepositories.js'
import { sourceAccessForMission } from '../access/sourceAccessForMission.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import type { AdmittedPlanningSession } from './researchIterationLoop.js'
import {
  RetrievalIterationFailedAfterAcquireError,
  runAdmittedRetrievalIteration,
} from './researchRetrievalLoop.js'
import { stampCoverageSourceSlotOnSource } from './missionCoverageSourceSlots.js'
import {
  sanitizeSourceSearchProviderReceipt,
  sourceSearchCompletionOutcome,
} from './sourceDiscoverSearchReceipt.js'
import {
  missionUsesComposedTechnicalRetrieval,
  planTechnicalRetrievalSlots,
  slotOperationSuffix,
  type TechnicalRetrievalSlot,
} from './technicalRetrievalComposition.js'
import {
  resolveReadAdapterForSource,
  type MissionRegistryBundle,
} from '../registry/missionAdapterResolution.js'
import {
  settleExternalOperation,
  unknownUsageSettlement,
} from './settleExternalOperation.js'
import {
  RetrievalEvidenceBindingError,
  validateRetrievalEvidenceBindings,
} from './validateRetrievalEvidenceBindings.js'
import {
  sourceFetchOwnerFromFetch,
  stampSourceFetchEvidenceOwnerOnPassage,
  stampSourceFetchEvidenceOwnerOnRevision,
} from './retrievalEvidenceOwnership.js'
import { ResearchPassFailedError } from './researchPassFailure.js'

export interface ComposedRetrievalIterationRequest {
  session: AdmittedPlanningSession
  store: ResearchStore
  access: SourceAccessPort
  adapter: SourceAdapter
  registries: MissionRegistryBundle
  activePlan: PlanRevision
  discoverQuery: string
  searchOperationId: string
  searchAttemptId: string
  fetchOperationId: string
  fetchAttemptId: string
  dispatchedAt: string
  signal: AbortSignal
  now?: () => string
}

export interface ComposedRetrievalSlotOutcome {
  slotId: string
  kind: TechnicalRetrievalSlot['kind']
  searchOperationId: string
  fetchOperationId: string
  settlement: 'succeeded' | 'failed' | 'skipped_unsupported'
  sourceId?: string
  passageIds?: string[]
  message?: string
}

export interface ComposedRetrievalIterationResult {
  handle: ResearchStoreMissionHandle
  writeContext: MissionWriteContext
  sources: SourceRecord[]
  passageIds: string[]
  limitations: string[]
  slotOutcomes: ComposedRetrievalSlotOutcome[]
  searchOperationId: string
  fetchOperationId: string
  terminalReportEmitted: false
}

function throwIfAborted(signal: AbortSignal, phase: string): void {
  if (signal.aborted) {
    throw new Error(`composed retrieval aborted before ${phase}`)
  }
}

async function recordUnsupportedSlot(
  request: ComposedRetrievalIterationRequest,
  ctx: MissionWriteContext,
  slot: TechnicalRetrievalSlot,
  now: () => string,
): Promise<ComposedRetrievalSlotOutcome> {
  const searchOperationId = slotOperationSuffix(request.searchOperationId, slot.slotId)
  const searchAttemptId = slotOperationSuffix(request.searchAttemptId, slot.slotId)
  const message = slot.limitationMessage ?? `unsupported source slot ${slot.slotId}`
  await request.store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: searchOperationId,
    attempt_id: searchAttemptId,
    operation_kind: 'source_search',
    dispatched_at: request.dispatchedAt,
    idempotency_key: searchOperationId,
  })
  await settleExternalOperation(
    request.store,
    ctx,
    ctx.mission_id,
    searchOperationId,
    searchAttemptId,
    {
      settlement: 'failed',
      failureCategory: 'not_supported',
      message,
    },
    now(),
  )
  return {
    slotId: slot.slotId,
    kind: slot.kind,
    searchOperationId,
    fetchOperationId: slotOperationSuffix(request.fetchOperationId, slot.slotId),
    settlement: 'skipped_unsupported',
    message,
  }
}

async function runDocumentRefSlot(
  request: ComposedRetrievalIterationRequest,
  ctx: MissionWriteContext,
  slot: TechnicalRetrievalSlot,
  scopedMission: ReturnType<typeof missionScopedToDocumentRef>,
  slotAccess: SourceAccessPort,
  now: () => string,
): Promise<ComposedRetrievalSlotOutcome> {
  const searchOperationId = slotOperationSuffix(request.searchOperationId, slot.slotId)
  const searchAttemptId = slotOperationSuffix(request.searchAttemptId, slot.slotId)
  const fetchOperationId = slotOperationSuffix(request.fetchOperationId, slot.slotId)
  const fetchAttemptId = slotOperationSuffix(request.fetchAttemptId, slot.slotId)

  await request.store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: searchOperationId,
    attempt_id: searchAttemptId,
    operation_kind: 'source_search',
    dispatched_at: request.dispatchedAt,
    idempotency_key: searchOperationId,
  })

  let search
  try {
    search = await slotAccess.search({
      operationId: searchOperationId,
      query: slot.documentRef ?? slot.discoverQuery,
      sourceClasses: ['document'],
      signal: request.signal,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      searchOperationId,
      searchAttemptId,
      {
        settlement: 'uncertain',
        message: request.signal.aborted
          ? `document source search rejected during cancellation: ${message}`
          : message,
        usage_settlement: unknownUsageSettlement(searchAttemptId),
      },
      now(),
    )
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message,
    }
  }

  if (search.status === 'cancelled' || request.signal.aborted) {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      searchOperationId,
      searchAttemptId,
      { settlement: 'cancelled' },
      now(),
    )
    throw new Error('document source search cancelled during composed retrieval')
  }
  if (search.status === 'failed') {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      searchOperationId,
      searchAttemptId,
      {
        settlement: 'failed',
        failureCategory: search.failureCategory,
        message: search.message,
        ...(search.acquisition_diagnostics
          ? { acquisition_diagnostics: search.acquisition_diagnostics }
          : {}),
      },
      now(),
    )
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message: search.message,
    }
  }

  if (search.status === 'ok' && search.operationId !== searchOperationId) {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      searchOperationId,
      searchAttemptId,
      {
        settlement: 'failed',
        failureCategory: 'contract_violation',
        message: 'document search operationId does not match admitted search operation',
      },
      now(),
    )
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message: 'document search operationId does not match admitted search operation',
    }
  }

  const rawCandidate = search.hits[0]?.source
  if (!rawCandidate) {
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      searchOperationId,
      searchAttemptId,
      {
        settlement: 'failed',
        failureCategory: 'no_candidates',
        message: 'document search returned no candidates for selected ref',
      },
      now(),
    )
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message: 'document search returned no candidates',
    }
  }

  const candidate = stampCoverageSourceSlotOnSource(rawCandidate, slot.slotId)

  throwIfAborted(request.signal, 'document_search settlement')

  const searchReceipt =
    search.status === 'ok' && search.receipt
      ? sanitizeSourceSearchProviderReceipt(search.receipt)
      : undefined

  await settleExternalOperation(
    request.store,
    ctx,
    ctx.mission_id,
    searchOperationId,
    searchAttemptId,
    {
      settlement: 'succeeded',
      ...(searchReceipt
        ? sourceSearchCompletionOutcome({
            discoverReceipt: searchReceipt,
            searchAttemptId,
            completedAt: now(),
          })
        : {}),
    },
    now(),
  )

  const discover = {
    operationId: search.operationId,
    status: 'ok' as const,
    candidates: [candidate],
    ...(searchReceipt ? { search_provider_receipt: searchReceipt } : {}),
  }

  const readAdapter = resolveReadAdapterForSource(candidate, request.registries, {
    mediaType: 'application/pdf',
  })
  if (!readAdapter) {
    await request.store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: fetchOperationId,
      attempt_id: fetchAttemptId,
      operation_kind: 'source_fetch',
      dispatched_at: request.dispatchedAt,
      idempotency_key: fetchOperationId,
    })
    await settleExternalOperation(
      request.store,
      ctx,
      ctx.mission_id,
      fetchOperationId,
      fetchAttemptId,
      {
        settlement: 'failed',
        failureCategory: 'not_supported',
        message: 'no read adapter for document source',
      },
      now(),
    )
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message: 'no read adapter for document source',
    }
  }

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
      { operationId: fetchOperationId, source: candidate, signal: request.signal },
      slotAccess,
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
          ? `document read rejected during cancellation: ${message}`
          : message,
        usage_settlement: unknownUsageSettlement(fetchAttemptId),
      },
      now(),
    )
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message,
    }
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
    throw new Error('document read cancelled during composed retrieval')
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
        ...(read.acquisition_diagnostics ? { acquisition_diagnostics: read.acquisition_diagnostics } : {}),
      },
      now(),
    )
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message: read.message,
    }
  }

  throwIfAborted(request.signal, 'document evidence persistence')

  let boundPassages
  try {
    const bound = validateRetrievalEvidenceBindings({
      searchOperationId,
      fetchOperationId,
      discover,
      read,
      candidate,
      mission: scopedMission,
      plan: request.activePlan,
      ctx,
    })
    boundPassages = bound.passages
    const evidenceOwner = sourceFetchOwnerFromFetch(
      ctx.mission_id,
      fetchOperationId,
      fetchAttemptId,
    )
    await request.store.appendSource(ctx, candidate)
    throwIfAborted(request.signal, 'document source revision persistence')
    await request.store.appendSourceRevision(
      ctx,
      stampSourceFetchEvidenceOwnerOnRevision(bound.revision, evidenceOwner),
    )
    for (const passage of boundPassages) {
      throwIfAborted(request.signal, 'document passage persistence')
      await request.store.appendPassage(
        ctx,
        stampSourceFetchEvidenceOwnerOnPassage(passage, evidenceOwner),
      )
    }
    throwIfAborted(request.signal, 'document evidence persistence completion')
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
          message: 'document evidence persistence aborted',
          usage_settlement: unknownUsageSettlement(fetchAttemptId),
        },
        now(),
      )
      throw new Error('document composed retrieval aborted during evidence persistence')
    }
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
    return {
      slotId: slot.slotId,
      kind: slot.kind,
      searchOperationId,
      fetchOperationId,
      settlement: 'failed',
      message,
    }
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
  return {
    slotId: slot.slotId,
    kind: slot.kind,
    searchOperationId,
    fetchOperationId,
    settlement: 'succeeded',
    sourceId: candidate.source_id,
    passageIds: boundPassages.map((p) => p.passage_id),
  }
}

/**
 * Technical multi-slot retrieval: repository pins, selected documents, and evidenced unsupported classes.
 */
export async function runAdmittedComposedRetrievalIteration(
  request: ComposedRetrievalIterationRequest,
): Promise<ComposedRetrievalIterationResult> {
  if (!missionUsesComposedTechnicalRetrieval(request.session.mission)) {
    throw new Error('composed retrieval requires a technical mission with planned slots')
  }
  const now = request.now ?? (() => new Date().toISOString())
  const slots = planTechnicalRetrievalSlots(request.session.mission, request.discoverQuery)
  if (slots.length === 0) {
    throw new Error('composed retrieval has no planned slots')
  }

  const activePlanRevisionId = request.session.activePlanRevisionId
  if (!activePlanRevisionId) {
    throw new Error('composed retrieval requires an active admitted plan revision')
  }

  let workingHandle = request.session.handle
  let writeContext: MissionWriteContext | undefined

  const ensureWriteContext = async (): Promise<MissionWriteContext> => {
    if (writeContext) {
      return writeContext
    }
    const acquired = await request.store.acquireWriterOwnership({
      mission_id: workingHandle.mission_id,
      expected_writer_generation: workingHandle.writer_generation,
    })
    workingHandle = acquired
    writeContext = {
      mission_id: acquired.mission_id,
      plan_revision_id: activePlanRevisionId,
      writer_generation: acquired.writer_generation,
    }
    return writeContext
  }

  const slotOutcomes: ComposedRetrievalSlotOutcome[] = []
  const limitations: string[] = []
  const sources: SourceRecord[] = []
  const passageIds: string[] = []

  for (const slot of slots) {
    throwIfAborted(request.signal, `slot ${slot.slotId}`)
    if (slot.kind === 'unsupported_source_class') {
      const ctx = await ensureWriteContext()
      const outcome = await recordUnsupportedSlot(request, ctx, slot, now)
      slotOutcomes.push(outcome)
      limitations.push(`retrieval_slot_unsupported:${slot.slotId}:${outcome.message}`)
      continue
    }

    if (slot.kind === 'document_ref') {
      const ctx = await ensureWriteContext()
      const documentRef = slot.documentRef ?? slot.discoverQuery
      const scopedMission = missionScopedToDocumentRef(request.session.mission, documentRef)
      const slotAccess = sourceAccessForMission(request.access, scopedMission)
      const outcome = await runDocumentRefSlot(
        request,
        ctx,
        slot,
        scopedMission,
        slotAccess,
        now,
      )
      slotOutcomes.push(outcome)
      if (outcome.settlement === 'failed') {
        limitations.push(`retrieval_slot_failed:${slot.slotId}:${outcome.message ?? 'failed'}`)
      } else if (outcome.passageIds) {
        passageIds.push(...outcome.passageIds)
        if (outcome.sourceId) {
          const events = await request.store.listEvents(ctx.mission_id)
          const source = events
            .filter((e) => e.kind === 'source_recorded')
            .map((e) => (e.payload as { source: SourceRecord }).source)
            .find((s) => s.source_id === outcome.sourceId)
          if (source) sources.push(source)
        }
      }
      continue
    }

    if (slot.kind === 'repository_pin' && slot.repositoryPin) {
      const scopedMission = missionScopedToRepositoryPin(request.session.mission, slot.repositoryPin)
      const slotAccess = sourceAccessForMission(request.access, scopedMission)
      const searchOperationId = slotOperationSuffix(request.searchOperationId, slot.slotId)
      const searchAttemptId = slotOperationSuffix(request.searchAttemptId, slot.slotId)
      const fetchOperationId = slotOperationSuffix(request.fetchOperationId, slot.slotId)
      const fetchAttemptId = slotOperationSuffix(request.fetchAttemptId, slot.slotId)
      try {
        const result = await runAdmittedRetrievalIteration({
          session: {
            mission: scopedMission,
            handle: workingHandle,
            activePlanRevisionId,
          },
          store: request.store,
          access: slotAccess,
          adapter: request.adapter,
          registries: request.registries,
          activePlan: request.activePlan,
          discoverQuery: slot.discoverQuery,
          searchOperationId,
          searchAttemptId,
          fetchOperationId,
          fetchAttemptId,
          coverageSourceSlotId: slot.slotId,
          dispatchedAt: request.dispatchedAt,
          signal: request.signal,
          now,
        })
        workingHandle = result.handle
        writeContext = result.writeContext
        sources.push(result.source)
        passageIds.push(...result.passageIds)
        slotOutcomes.push({
          slotId: slot.slotId,
          kind: slot.kind,
          searchOperationId,
          fetchOperationId,
          settlement: 'succeeded',
          sourceId: result.source.source_id,
        })
      } catch (err: unknown) {
        if (err instanceof RetrievalIterationFailedAfterAcquireError) {
          workingHandle = err.acquiredHandle
          writeContext = err.writeContext
        }
        const message = err instanceof Error ? err.message : String(err)
        slotOutcomes.push({
          slotId: slot.slotId,
          kind: slot.kind,
          searchOperationId,
          fetchOperationId,
          settlement: 'failed',
          message,
        })
        limitations.push(`retrieval_slot_failed:${slot.slotId}:${message}`)
      }
    }
  }

  const uniquePassageIds = [...new Set(passageIds)]
  const succeededExecutable = slotOutcomes.filter((o) => o.settlement === 'succeeded')
  if (succeededExecutable.length === 0) {
    throw new ResearchPassFailedError('composed retrieval produced no admitted sources', {
      stoppingReason: 'source_retrieval_failed',
      failurePhase: 'retrieval',
    })
  }

  if (!writeContext) {
    throw new ResearchPassFailedError('composed retrieval produced no admitted sources', {
      stoppingReason: 'source_retrieval_failed',
      failurePhase: 'retrieval',
    })
  }

  return {
    handle: workingHandle,
    writeContext,
    sources,
    passageIds: uniquePassageIds,
    limitations,
    slotOutcomes,
    searchOperationId: request.searchOperationId,
    fetchOperationId: request.fetchOperationId,
    terminalReportEmitted: false,
  }
}
