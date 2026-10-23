import { createHash } from 'node:crypto'
import type { MissionWriteContext } from '../contracts/common.js'
import {
  isResumableTerminalState,
  ResearchContinuationResumeSchema,
  WriterOwnershipAcquireSchema,
} from '../contracts/storeLifecycle.js'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision, ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import {
  pinnedGithubBlobUrlToRawContentUrl,
  parsePinnedGithubBlobUrl,
} from '../profiles/technical/repositoryFilePinning.js'
import type {
  ExternalOperationCompletion,
  ExternalOperationIntent,
  ExternalOperationReconciliation,
} from '../contracts/operations.js'
import { parseValidatedModelOutput } from '../contracts/modelOutputs.js'
import type {
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
  ModelRouteReceipt,
} from '../ports/researchModelPort.js'
import type {
  SourceAccessPort,
  SourceFetchRequest,
  SourceFetchResult,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import type {
  ResearchStore,
  ResearchStoreEvent,
  ResearchStoreMissionHandle,
  ResearchStoreWriteResult,
} from '../ports/researchStore.js'
import { assertSnapshotIntegrity } from '../persistence/snapshotIntegrity.js'

export interface FakePortClock {
  now(): string
}

export class SystemFakeClock implements FakePortClock {
  now(): string {
    return new Date().toISOString()
  }
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function issueRevisionId(sourceId: string, contentHash: string): string {
  return `rev-${sourceId}-${contentHash.slice(0, 16)}`
}

const MAX_PASSAGE_INLINE_CHARS = 4000

function lineRangeLocatorForText(body: string): PassageRecord['locator'] {
  const lines = body.split('\n')
  const end = Math.max(1, lines.length)
  return { kind: 'line_range', start_line: 1, end_line: end }
}

function boundedExcerpt(text: string): { excerpt: string; truncated: boolean } {
  if (text.length <= MAX_PASSAGE_INLINE_CHARS) {
    return { excerpt: text, truncated: false }
  }
  let cut = MAX_PASSAGE_INLINE_CHARS
  const lastNl = text.lastIndexOf('\n', cut - 1)
  if (lastNl > 0) cut = lastNl
  return { excerpt: text.slice(0, cut), truncated: true }
}

function deterministicPassageId(revisionId: string, textHash: string): string {
  return `passage-${sha256(`${revisionId}:${textHash}`).slice(0, 24)}`
}

function unknownUsageSettlement(attemptId: string) {
  return {
    attempt_id: attemptId,
    cost: { status: 'unknown' as const },
  }
}

export class StoreContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreContractError'
  }
}

export class FakeResearchModelPort implements ResearchModelPort {
  constructor(private readonly clock: FakePortClock = new SystemFakeClock()) {}

  private readonly scriptedOutputs = new Map<string, unknown>()

  scriptOutput(operationId: string, output: unknown): void {
    this.scriptedOutputs.set(operationId, output)
  }

  async invokeStructured(
    request: ResearchModelInvocationRequest,
  ): Promise<ResearchModelInvocationResult> {
    const attemptId = request.attemptId
    if (!attemptId) {
      throw new Error('ResearchModelInvocationRequest.attemptId is required')
    }
    if (request.signal.aborted) {
      return {
        status: 'cancelled',
        operationId: request.operationId,
        usageSettlement: unknownUsageSettlement(attemptId),
      }
    }
    const raw = this.scriptedOutputs.get(request.operationId) ?? {
      kind: request.kind,
      ...(request.kind === 'plan_questions' ? { questions: [] } : {}),
      ...(request.kind === 'extract_findings' ? { findings: [] } : {}),
      ...(request.kind === 'semantic_support_review' ? { judgments: [] } : {}),
      ...(request.kind === 'synthesize_report'
        ? { answer_summary: 'partial', stopping_reason: 'fixture' }
        : {}),
    }
    try {
      const output = parseValidatedModelOutput(request.kind, raw)
      const receipt: ModelRouteReceipt = {
        operation_id: request.operationId,
        backend_key: 'fake-model',
        provider: 'fixture',
        provider_model_id: 'fixture/structured',
        resolved_at: this.clock.now(),
        usage_settlement: unknownUsageSettlement(attemptId),
      }
      return { status: 'ok', operationId: request.operationId, output, receipt }
    } catch (err) {
      return {
        status: 'failed',
        operationId: request.operationId,
        failureCategory: 'invalid_model_output',
        message: err instanceof Error ? err.message : String(err),
        usageSettlement: unknownUsageSettlement(attemptId),
      }
    }
  }
}

export interface FakeCorpusSource {
  source: SourceRecord
  body: string
  mediaType: string
  finalUrl?: string
  redirectChain?: string[]
}

export class FakeSourceAccessPort implements SourceAccessPort {
  constructor(
    private readonly corpus: FakeCorpusSource[],
    private readonly clock: FakePortClock = new SystemFakeClock(),
    private readonly maxAdmittedBytes?: number,
  ) {}

  async search(request: SourceSearchRequest): Promise<SourceSearchResult> {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    const terms = request.query.toLowerCase().split(/\s+/).filter(Boolean)
    const hits = this.corpus
      .filter((entry) => request.sourceClasses.includes(entry.source.kind))
      .filter((entry) => {
        const hay = `${entry.source.title ?? ''} ${entry.body}`.toLowerCase()
        return terms.length === 0 || terms.every((t) => hay.includes(t))
      })
      .map((entry) => ({
        source: entry.source,
        snippet: entry.body.slice(0, 240),
        completeness: 'snippet' as const,
      }))
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    return { operationId: request.operationId, status: 'ok', hits }
  }

  async fetchContent(request: SourceFetchRequest): Promise<SourceFetchResult> {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    const entry = this.corpus.find((c) => c.source.source_id === request.source.source_id)
    if (!entry) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'not_found',
        message: 'unknown source',
      }
    }
    if (entry.body.length === 0) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'empty_body',
        message: 'source has no retrievable bytes',
      }
    }
    const fullBytes = Buffer.from(entry.body, 'utf8')
    const limit = this.maxAdmittedBytes
    const truncated =
      typeof limit === 'number' && limit > 0 && fullBytes.byteLength > limit
    const admittedBytes = truncated ? fullBytes.subarray(0, limit) : fullBytes
    const contentHash = sha256(admittedBytes)
    const revision: SourceRevision = {
      revision_id: issueRevisionId(request.source.source_id, contentHash),
      source_id: request.source.source_id,
      content_hash: contentHash,
      retrieved_at: this.clock.now(),
      extraction_version: 'fake-fetch-1',
      media_type: entry.mediaType,
      completeness: truncated ? 'truncated' : 'complete',
      byte_length_received: admittedBytes.byteLength,
      truncation_reason: truncated ? 'host_byte_limit' : undefined,
    }
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    const observedUrl = entry.source.observed_urls[0] ?? 'https://example.test/unknown'
    let requestedUrl = observedUrl
    let finalUrl = entry.finalUrl ?? requestedUrl
    let repositoryFilePin: { pinned_blob_url: string } | undefined
    if (request.source.kind === 'repository_file') {
      const blobUrl = request.source.observed_urls[0]
      if (!blobUrl) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'not_found',
          message: 'repository_file source has no observed URL',
        }
      }
      const rawDefault = pinnedGithubBlobUrlToRawContentUrl(blobUrl)
      if (!rawDefault) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'policy_denied',
          message: 'repository_file observed URL is not a pinned github blob URL',
        }
      }
      repositoryFilePin = { pinned_blob_url: blobUrl }
      requestedUrl = rawDefault
      if (entry.finalUrl === undefined || parsePinnedGithubBlobUrl(entry.finalUrl)) {
        finalUrl =
          entry.finalUrl && parsePinnedGithubBlobUrl(entry.finalUrl)
            ? pinnedGithubBlobUrlToRawContentUrl(entry.finalUrl) ?? rawDefault
            : rawDefault
      } else {
        finalUrl = entry.finalUrl
      }
    }
    const redirectChain =
      entry.redirectChain ??
      [requestedUrl, finalUrl].filter((url, index, arr) => arr.indexOf(url) === index)
    return {
      operationId: request.operationId,
      status: 'ok',
      admitted: {
        operation_id: request.operationId,
        revision,
        media_type: entry.mediaType,
        provenance: {
          requested_url: requestedUrl,
          final_url: finalUrl,
          redirect_chain: redirectChain,
          ...(repositoryFilePin ? { repository_file_pin: repositoryFilePin } : {}),
        },
        payload: {
          mode: 'inline_bytes',
          bytes_base64: admittedBytes.toString('base64'),
          byte_length: admittedBytes.byteLength,
          content_hash: contentHash,
        },
        truncation: truncated
          ? {
              reason: 'host_byte_limit',
              bytes_received: fullBytes.byteLength,
              bytes_limit: limit!,
            }
          : undefined,
      },
    }
  }
}

interface MissionFence {
  writerGeneration: number
  activePlanRevisionId: string | null
  /** Active terminal fence; cleared only by explicit host resume (prior receipt stays in events). */
  terminalReport: ResearchReportV2 | null
  /** Immutable cancelled/interrupted receipt retained after resume for inspect continuity. */
  retainedTerminalReceipt: ResearchReportV2 | null
}

interface TrackedOperation {
  missionId: string
  attemptId: string
  intent: ExternalOperationIntent
  completion?: ExternalOperationCompletion
  accountingReconciled?: ExternalOperationReconciliation
}

/** JSON-serializable durable snapshot of in-memory store runtime state (M1 persistence). */
export interface InMemoryResearchStoreSnapshot {
  schema_version: 1
  events: ResearchStoreEvent[]
  missions: Array<[string, MissionFence]>
  operations: Array<[string, TrackedOperation]>
}

function operationKey(missionId: string, operationId: string, attemptId: string): string {
  return `${missionId}::${operationId}::${attemptId}`
}

function assertUsageSettlementAttempt(
  attemptId: string,
  usage: { attempt_id: string } | undefined,
  label: string,
): void {
  if (usage === undefined) return
  if (usage.attempt_id !== attemptId) {
    throw new StoreContractError(`${label} usage_settlement attempt mismatch`)
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

export class InMemoryResearchStore implements ResearchStore {
  private readonly events: ResearchStoreEvent[] = []
  private readonly missions = new Map<string, MissionFence>()
  private readonly operations = new Map<string, TrackedOperation>()

  constructor(private readonly clock: FakePortClock = new SystemFakeClock()) {}

  private fence(missionId: string): MissionFence {
    const fence = this.missions.get(missionId)
    if (!fence) throw new StoreContractError(`unknown mission ${missionId}`)
    return fence
  }

  private authority(ctx: MissionWriteContext): 'evidence' | 'usage_reconciliation' {
    return ctx.write_authority ?? 'evidence'
  }

  private requireCtx(ctx: MissionWriteContext, options?: { allowUsageReconciliation?: boolean }): MissionFence {
    const fence = this.fence(ctx.mission_id)
    if (fence.writerGeneration !== ctx.writer_generation) {
      throw new StoreContractError('stale writer generation')
    }
    if (
      fence.activePlanRevisionId !== null &&
      ctx.plan_revision_id !== fence.activePlanRevisionId
    ) {
      throw new StoreContractError('stale plan revision')
    }
    const auth = this.authority(ctx)
    if (fence.terminalReport !== null) {
      if (auth !== 'usage_reconciliation' || !options?.allowUsageReconciliation) {
        throw new StoreContractError('mission terminal fenced')
      }
    } else if (auth === 'usage_reconciliation') {
      throw new StoreContractError('usage reconciliation requires terminal fence')
    }
    return fence
  }

  private requireEvidenceCtx(ctx: MissionWriteContext): MissionFence {
    const fence = this.requireCtx(ctx)
    if (fence.activePlanRevisionId === null) {
      throw new StoreContractError('no active plan revision')
    }
    return fence
  }

  private push(
    missionId: string,
    kind: ResearchStoreEvent['kind'],
    payload: Record<string, unknown>,
  ): ResearchStoreWriteResult {
    const eventId = `evt-${this.events.length + 1}`
    this.events.push({
      eventId,
      missionId,
      kind,
      recordedAt: this.clock.now(),
      payload,
    })
    return { eventId }
  }

  async appendMission(mission: ResearchMissionV2): Promise<ResearchStoreMissionHandle> {
    if (this.missions.has(mission.mission_id)) {
      throw new StoreContractError('duplicate mission creation')
    }
    this.missions.set(mission.mission_id, {
      writerGeneration: 1,
      activePlanRevisionId: null,
      terminalReport: null,
      retainedTerminalReceipt: null,
    })
    this.push(mission.mission_id, 'mission_created', { mission })
    return Promise.resolve({ mission_id: mission.mission_id, writer_generation: 1 })
  }

  async acquireWriterOwnership(
    request: Parameters<ResearchStore['acquireWriterOwnership']>[0],
  ): Promise<ResearchStoreMissionHandle> {
    const parsed = WriterOwnershipAcquireSchema.parse(request)
    const fence = this.fence(parsed.mission_id)
    if (fence.terminalReport !== null) {
      throw new StoreContractError('cannot acquire ownership on terminal mission')
    }
    if (parsed.expected_writer_generation !== fence.writerGeneration) {
      throw new StoreContractError('competing resume rejected')
    }
    fence.writerGeneration += 1
    return Promise.resolve({
      mission_id: parsed.mission_id,
      writer_generation: fence.writerGeneration,
    })
  }

  async resumeResearchContinuation(
    request: Parameters<ResearchStore['resumeResearchContinuation']>[0],
  ): Promise<ResearchStoreMissionHandle> {
    const parsed = ResearchContinuationResumeSchema.parse(request)
    const fence = this.fence(parsed.mission_id)
    if (fence.terminalReport === null) {
      throw new StoreContractError('resume requires active terminal receipt')
    }
    if (!isResumableTerminalState(fence.terminalReport.terminal_state)) {
      throw new StoreContractError('terminal state not resumable')
    }
    if (fence.terminalReport.terminal_state !== parsed.acknowledged_terminal_state) {
      throw new StoreContractError('acknowledged terminal state mismatch')
    }
    if (fence.terminalReport.plan_revision_id !== parsed.acknowledged_plan_revision_id) {
      throw new StoreContractError('acknowledged plan revision mismatch')
    }
    if (parsed.expected_writer_generation !== fence.writerGeneration) {
      throw new StoreContractError('competing resume rejected')
    }
    const retained = fence.terminalReport
    fence.retainedTerminalReceipt = retained
    fence.terminalReport = null
    fence.writerGeneration += 1
    const newGeneration = fence.writerGeneration
    this.push(parsed.mission_id, 'research_continuation_resumed', {
      host_authorization_ref: parsed.host_authorization_ref,
      retained_terminal_receipt: retained,
      prior_writer_generation: parsed.expected_writer_generation,
      writer_generation: newGeneration,
    })
    return Promise.resolve({
      mission_id: parsed.mission_id,
      writer_generation: newGeneration,
    })
  }

  async replaceWriterOwnership(
    ctx: MissionWriteContext,
    rationale: string,
  ): Promise<ResearchStoreMissionHandle> {
    if (!rationale.trim()) throw new StoreContractError('ownership replace requires rationale')
    this.requireEvidenceCtx(ctx)
    const fence = this.fence(ctx.mission_id)
    fence.writerGeneration += 1
    return Promise.resolve({
      mission_id: ctx.mission_id,
      writer_generation: fence.writerGeneration,
    })
  }

  async releaseWriterOwnership(ctx: MissionWriteContext): Promise<void> {
    this.requireEvidenceCtx(ctx)
    const fence = this.fence(ctx.mission_id)
    fence.writerGeneration += 1
    return Promise.resolve()
  }

  /** Test helper — prefer acquireWriterOwnership / replaceWriterOwnership. */
  bumpWriterGeneration(missionId: string): number {
    const fence = this.fence(missionId)
    fence.writerGeneration += 1
    return fence.writerGeneration
  }

  async appendPlanRevision(ctx: MissionWriteContext, plan: PlanRevision): Promise<ResearchStoreWriteResult> {
    const fence = this.fence(ctx.mission_id)
    if (fence.writerGeneration !== ctx.writer_generation) {
      throw new StoreContractError('stale writer generation')
    }
    if (fence.terminalReport !== null) {
      throw new StoreContractError('mission terminal fenced')
    }
    if (plan.mission_id !== ctx.mission_id) {
      throw new StoreContractError('plan mission mismatch')
    }
    if (fence.activePlanRevisionId === null) {
      if (ctx.plan_revision_id !== plan.plan_revision_id) {
        throw new StoreContractError('initial plan context must match proposed plan revision')
      }
    } else {
      if (ctx.plan_revision_id !== fence.activePlanRevisionId) {
        throw new StoreContractError('stale plan revision')
      }
      if (plan.plan_revision_id === fence.activePlanRevisionId) {
        throw new StoreContractError('proposed plan revision must differ from active plan')
      }
    }
    fence.activePlanRevisionId = plan.plan_revision_id
    return Promise.resolve(this.push(ctx.mission_id, 'plan_revised', { plan }))
  }

  async appendSource(ctx: MissionWriteContext, source: SourceRecord): Promise<ResearchStoreWriteResult> {
    this.requireEvidenceCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'source_recorded', { source }))
  }

  async appendSourceRevision(
    ctx: MissionWriteContext,
    revision: SourceRevision,
  ): Promise<ResearchStoreWriteResult> {
    this.requireEvidenceCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'revision_recorded', { revision }))
  }

  async appendPassage(ctx: MissionWriteContext, passage: PassageRecord): Promise<ResearchStoreWriteResult> {
    this.requireEvidenceCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'passage_recorded', { passage }))
  }

  async appendFinding(ctx: MissionWriteContext, finding: FindingRecord): Promise<ResearchStoreWriteResult> {
    this.requireEvidenceCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'finding_recorded', { finding }))
  }

  async appendModelReceipt(
    ctx: MissionWriteContext,
    receipt: ModelRouteReceipt,
  ): Promise<ResearchStoreWriteResult> {
    this.requireEvidenceCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'model_invocation_completed', { receipt }))
  }

  private trackIntent(ctx: MissionWriteContext, intent: ExternalOperationIntent): void {
    if (intent.mission_id !== ctx.mission_id) {
      throw new StoreContractError('operation mission mismatch')
    }
    const key = operationKey(intent.mission_id, intent.operation_id, intent.attempt_id)
    const existing = this.operations.get(key)
    if (existing) {
      if (stableJson(existing.intent) === stableJson(intent)) {
        return
      }
      throw new StoreContractError('operation attempt idempotency conflict')
    }
    this.operations.set(key, { missionId: intent.mission_id, attemptId: intent.attempt_id, intent })
  }

  async appendExternalOperationIntent(
    ctx: MissionWriteContext,
    intent: ExternalOperationIntent,
  ): Promise<ResearchStoreWriteResult> {
    this.requireEvidenceCtx(ctx)
    this.trackIntent(ctx, intent)
    return Promise.resolve(this.push(ctx.mission_id, 'external_operation_intent', { intent }))
  }

  async appendExternalOperationCompleted(
    ctx: MissionWriteContext,
    completion: ExternalOperationCompletion,
  ): Promise<ResearchStoreWriteResult> {
    this.requireEvidenceCtx(ctx)
    if (completion.mission_id !== ctx.mission_id) {
      throw new StoreContractError('completion mission mismatch')
    }
    const key = operationKey(completion.mission_id, completion.operation_id, completion.attempt_id)
    const tracked = this.operations.get(key)
    if (!tracked) {
      throw new StoreContractError('completion without prior intent')
    }
    assertUsageSettlementAttempt(
      completion.attempt_id,
      completion.usage_settlement,
      'completion',
    )
    if (tracked.accountingReconciled) {
      const reconciled = tracked.accountingReconciled
      if (
        completion.settlement === reconciled.resolved_settlement &&
        stableJson(completion.usage_settlement ?? null) ===
          stableJson(reconciled.usage_settlement)
      ) {
        return Promise.resolve({ eventId: `evt-idempotent-${key}` })
      }
      throw new StoreContractError('completion conflicts with settled accounting reconciliation')
    }
    if (tracked.completion) {
      if (stableJson(tracked.completion) === stableJson(completion)) {
        return Promise.resolve({ eventId: `evt-idempotent-${key}` })
      }
      throw new StoreContractError('duplicate operation completion')
    }
    tracked.completion = completion
    return Promise.resolve(
      this.push(ctx.mission_id, 'external_operation_completed', { completion }),
    )
  }

  async appendExternalOperationReconciled(
    ctx: MissionWriteContext,
    reconciliation: ExternalOperationReconciliation,
  ): Promise<ResearchStoreWriteResult> {
    const fence = this.requireCtx(ctx, { allowUsageReconciliation: true })
    const auth = this.authority(ctx)
    if (reconciliation.mission_id !== ctx.mission_id) {
      throw new StoreContractError('reconciliation mission mismatch')
    }
    assertUsageSettlementAttempt(
      reconciliation.attempt_id,
      reconciliation.usage_settlement,
      'reconciliation',
    )
    const key = operationKey(
      reconciliation.mission_id,
      reconciliation.operation_id,
      reconciliation.attempt_id,
    )
    const tracked = this.operations.get(key)
    if (!tracked) {
      throw new StoreContractError('reconciliation without prior intent')
    }

    const lateAccountingOnly =
      auth === 'usage_reconciliation' && fence.terminalReport !== null && !tracked.completion

    if (lateAccountingOnly) {
      if (tracked.accountingReconciled) {
        if (stableJson(tracked.accountingReconciled) === stableJson(reconciliation)) {
          return Promise.resolve({ eventId: `evt-idempotent-${key}` })
        }
        throw new StoreContractError('duplicate accounting reconciliation')
      }
      tracked.accountingReconciled = reconciliation
      return Promise.resolve(
        this.push(ctx.mission_id, 'external_operation_reconciled', { reconciliation }),
      )
    }

    if (!tracked.completion) {
      throw new StoreContractError('reconciliation without prior completion')
    }
    if (tracked.attemptId !== reconciliation.attempt_id) {
      throw new StoreContractError('reconciliation attempt mismatch')
    }
    if (tracked.completion.settlement !== 'uncertain') {
      const alreadyResolved =
        tracked.completion.settlement === reconciliation.resolved_settlement &&
        stableJson(tracked.completion.usage_settlement) ===
          stableJson(reconciliation.usage_settlement)
      if (alreadyResolved) {
        return Promise.resolve({ eventId: `evt-idempotent-${key}` })
      }
      throw new StoreContractError('reconciliation requires uncertain prior settlement')
    }
    if (reconciliation.prior_settlement !== 'uncertain') {
      throw new StoreContractError('reconciliation prior_settlement mismatch')
    }
    tracked.completion = {
      ...tracked.completion,
      settlement: reconciliation.resolved_settlement,
      usage_settlement: reconciliation.usage_settlement,
    }
    return Promise.resolve(
      this.push(ctx.mission_id, 'external_operation_reconciled', { reconciliation }),
    )
  }

  async appendTerminalReport(
    ctx: MissionWriteContext,
    report: ResearchReportV2,
  ): Promise<ResearchStoreWriteResult> {
    const fence = this.requireEvidenceCtx(ctx)
    if (report.mission_id !== ctx.mission_id) {
      throw new StoreContractError('terminal report mission mismatch')
    }
    if (report.plan_revision_id !== ctx.plan_revision_id) {
      throw new StoreContractError('terminal report plan mismatch')
    }
    if (fence.terminalReport !== null) {
      throw new StoreContractError('duplicate terminal report')
    }
    fence.terminalReport = report
    return Promise.resolve(this.push(ctx.mission_id, 'terminal_receipt', { report }))
  }

  readMissionWriteFence(missionId: string): {
    writer_generation: number
    active_plan_revision_id: string | null
    terminal_report: ResearchReportV2 | null
  } {
    const fence = this.fence(missionId)
    return {
      writer_generation: fence.writerGeneration,
      active_plan_revision_id: fence.activePlanRevisionId,
      terminal_report: fence.terminalReport,
    }
  }

  async listEvents(missionId: string): Promise<readonly ResearchStoreEvent[]> {
    return this.events.filter((e) => e.missionId === missionId)
  }

  allEvents(): readonly ResearchStoreEvent[] {
    return this.events
  }

  exportSnapshot(): InMemoryResearchStoreSnapshot {
    return {
      schema_version: 1,
      events: structuredClone(this.events),
      missions: [...this.missions.entries()],
      operations: [...this.operations.entries()],
    }
  }

  static restoreSnapshot(
    snapshot: InMemoryResearchStoreSnapshot,
    clock: FakePortClock = new SystemFakeClock(),
  ): InMemoryResearchStore {
    assertSnapshotIntegrity(snapshot)
    const store = new InMemoryResearchStore(clock)
    store.events.push(...structuredClone(snapshot.events))
    for (const [missionId, fence] of snapshot.missions) {
      store.missions.set(missionId, structuredClone(fence))
    }
    for (const [key, op] of snapshot.operations) {
      store.operations.set(key, structuredClone(op))
    }
    return store
  }
}

/** Minimal HTML adapter for contract tests — extraction stays adapter-owned. */
export function extractPlainTextPassagesFromAdmitted(
  revision: SourceRevision,
  text: string,
): PassageRecord[] {
  const { excerpt, truncated } = boundedExcerpt(text)
  const textHash = sha256(excerpt)
  const passageId = deterministicPassageId(revision.revision_id, textHash)
  const locator = truncated
    ? ({
        kind: 'byte_offset',
        start_offset: 0,
        end_offset: Buffer.byteLength(excerpt, 'utf8'),
      } satisfies PassageRecord['locator'])
    : lineRangeLocatorForText(excerpt)
  const notes = truncated ? ['excerpt_truncated_to_complete_lines'] : undefined
  return [
    {
      passage_id: passageId,
      source_revision_id: revision.revision_id,
      locator,
      text_ref: {
        mode: 'inline',
        text: excerpt,
        text_hash: textHash,
      },
      extraction_notes: notes,
    },
  ]
}

/** @deprecated Use deterministic ids from extractPlainTextPassagesFromAdmitted */
export function fakePassageId(): string {
  return deterministicPassageId('legacy', sha256('legacy'))
}
