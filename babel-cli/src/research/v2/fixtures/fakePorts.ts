import { createHash, randomBytes } from 'node:crypto'
import type { MissionWriteContext } from '../contracts/common.js'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision, ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
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

function lineRangeLocator(body: string): PassageRecord['locator'] {
  const lines = body.split('\n')
  const end = Math.max(1, lines.length)
  return { kind: 'line_range', start_line: 1, end_line: end }
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
    const attemptId = `attempt-${request.operationId}`
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
    const bytes = Buffer.from(entry.body, 'utf8')
    const contentHash = sha256(bytes)
    const revision: SourceRevision = {
      revision_id: issueRevisionId(request.source.source_id, contentHash),
      source_id: request.source.source_id,
      content_hash: contentHash,
      retrieved_at: this.clock.now(),
      extraction_version: 'fake-fetch-1',
      media_type: entry.mediaType,
      completeness: 'complete',
      byte_length_received: bytes.byteLength,
    }
    const requestedUrl = entry.source.observed_urls[0] ?? 'https://example.test/unknown'
    return {
      operationId: request.operationId,
      status: 'ok',
      admitted: {
        operation_id: request.operationId,
        revision,
        media_type: entry.mediaType,
        provenance: {
          requested_url: requestedUrl,
          final_url: entry.finalUrl ?? requestedUrl,
          redirect_chain: entry.redirectChain ?? [requestedUrl],
        },
        payload: {
          mode: 'inline_bytes',
          bytes_base64: bytes.toString('base64'),
          byte_length: bytes.byteLength,
          content_hash: contentHash,
        },
      },
    }
  }
}

export class InMemoryResearchStore implements ResearchStore {
  private readonly events: ResearchStoreEvent[] = []
  private readonly generations = new Map<string, number>()
  private readonly completedOperations = new Set<string>()

  constructor(private readonly clock: FakePortClock = new SystemFakeClock()) {}

  private requireCtx(ctx: MissionWriteContext): void {
    const current = this.generations.get(ctx.mission_id)
    if (current === undefined) {
      throw new StoreContractError(`unknown mission ${ctx.mission_id}`)
    }
    if (current !== ctx.writer_generation) {
      throw new StoreContractError('stale writer generation')
    }
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

  appendMission(mission: ResearchMissionV2): Promise<ResearchStoreMissionHandle> {
    this.generations.set(mission.mission_id, 0)
    this.push(mission.mission_id, 'mission_created', { mission })
    return Promise.resolve({ mission_id: mission.mission_id, writer_generation: 0 })
  }

  bumpWriterGeneration(missionId: string): number {
    const next = (this.generations.get(missionId) ?? 0) + 1
    this.generations.set(missionId, next)
    return next
  }

  appendPlanRevision(ctx: MissionWriteContext, plan: PlanRevision): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'plan_revised', { plan }))
  }

  appendSource(ctx: MissionWriteContext, source: SourceRecord): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'source_recorded', { source }))
  }

  appendSourceRevision(
    ctx: MissionWriteContext,
    revision: SourceRevision,
  ): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'revision_recorded', { revision }))
  }

  appendPassage(ctx: MissionWriteContext, passage: PassageRecord): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'passage_recorded', { passage }))
  }

  appendFinding(ctx: MissionWriteContext, finding: FindingRecord): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'finding_recorded', { finding }))
  }

  appendModelReceipt(
    ctx: MissionWriteContext,
    receipt: ModelRouteReceipt,
  ): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'model_invocation_completed', { receipt }))
  }

  appendExternalOperationIntent(
    ctx: MissionWriteContext,
    intent: ExternalOperationIntent,
  ): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'external_operation_intent', { intent }))
  }

  appendExternalOperationCompleted(
    ctx: MissionWriteContext,
    completion: ExternalOperationCompletion,
  ): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    if (this.completedOperations.has(completion.operation_id)) {
      throw new StoreContractError('duplicate operation completion')
    }
    this.completedOperations.add(completion.operation_id)
    return Promise.resolve(
      this.push(ctx.mission_id, 'external_operation_completed', { completion }),
    )
  }

  appendExternalOperationReconciled(
    ctx: MissionWriteContext,
    reconciliation: ExternalOperationReconciliation,
  ): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(
      this.push(ctx.mission_id, 'external_operation_reconciled', { reconciliation }),
    )
  }

  appendTerminalReport(
    ctx: MissionWriteContext,
    report: ResearchReportV2,
  ): Promise<ResearchStoreWriteResult> {
    this.requireCtx(ctx)
    return Promise.resolve(this.push(ctx.mission_id, 'terminal_receipt', { report }))
  }

  listEvents(missionId: string): Promise<readonly ResearchStoreEvent[]> {
    return Promise.resolve(this.events.filter((e) => e.missionId === missionId))
  }

  allEvents(): readonly ResearchStoreEvent[] {
    return this.events
  }
}

/** Minimal HTML adapter for contract tests — extraction stays adapter-owned. */
export function extractPlainTextPassagesFromAdmitted(
  revision: SourceRevision,
  text: string,
  issuePassageId: () => string,
): PassageRecord[] {
  const excerpt = text.slice(0, 4000)
  return [
    {
      passage_id: issuePassageId(),
      source_revision_id: revision.revision_id,
      locator: lineRangeLocator(text),
      text_ref: {
        mode: 'inline',
        text: excerpt,
        text_hash: sha256(excerpt),
      },
    },
  ]
}

export function fakePassageId(): string {
  return `passage-${randomBytes(4).toString('hex')}`
}
