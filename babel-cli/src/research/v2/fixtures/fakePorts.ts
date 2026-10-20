import { createHash } from 'node:crypto'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision, ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { ModelRouteReceipt } from '../ports/researchModelPort.js'
import type {
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
} from '../ports/researchModelPort.js'
import type {
  SourceAccessPort,
  SourceReadRequest,
  SourceReadResult,
  SourceSearchRequest,
  SourceSearchResult,
} from '../ports/sourceAccessPort.js'
import type {
  ResearchStore,
  ResearchStoreEvent,
  ResearchStoreWriteResult,
} from '../ports/researchStore.js'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class FakeResearchModelPort implements ResearchModelPort {
  private readonly scriptedOutputs = new Map<string, Record<string, unknown>>()

  scriptOutput(operationId: string, output: Record<string, unknown>): void {
    this.scriptedOutputs.set(operationId, output)
  }

  async invokeStructured<T extends Record<string, unknown>>(
    request: ResearchModelInvocationRequest,
  ): Promise<ResearchModelInvocationResult<T>> {
    if (request.signal.aborted) {
      throw new Error('model invocation cancelled')
    }
    const output = (this.scriptedOutputs.get(request.operationId) ?? {
      kind: request.kind,
      status: 'ok',
    }) as T
    const receipt: ModelRouteReceipt = {
      operation_id: request.operationId,
      backend_key: 'fake-model',
      provider: 'fake',
      provider_model_id: 'fake/structured',
      resolved_at: new Date().toISOString(),
      usage: { cost_status: 'unknown' },
    }
    return { operationId: request.operationId, output, receipt }
  }
}

export interface FakeCorpusSource {
  source: SourceRecord
  body: string
  mediaType: string
}

export class FakeSourceAccessPort implements SourceAccessPort {
  constructor(private readonly corpus: FakeCorpusSource[]) {}

  async search(request: SourceSearchRequest): Promise<SourceSearchResult> {
    if (request.signal.aborted) throw new Error('search cancelled')
    const terms = request.query.toLowerCase().split(/\s+/).filter(Boolean)
    const hits = this.corpus
      .filter((entry) => request.sourceClasses.includes(entry.source.kind))
      .filter((entry) => {
        const hay = `${entry.source.title ?? ''} ${entry.body}`.toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
      .map((entry) => ({
        source: entry.source,
        snippet: entry.body.slice(0, 240),
        completeness: 'snippet' as const,
      }))
    return { operationId: request.operationId, hits }
  }

  async read(request: SourceReadRequest): Promise<SourceReadResult> {
    if (request.signal.aborted) {
      return {
        status: 'failed',
        operationId: request.operationId,
        failureCategory: 'cancelled',
        message: 'read aborted',
      }
    }
    const entry = this.corpus.find((c) => c.source.source_id === request.source.source_id)
    if (!entry) {
      return {
        status: 'failed',
        operationId: request.operationId,
        failureCategory: 'not_found',
        message: 'unknown source',
      }
    }
    const revision: SourceRevision = {
      revision_id: `rev-${request.source.source_id}`,
      source_id: request.source.source_id,
      content_hash: sha256(entry.body),
      retrieved_at: new Date().toISOString(),
      extraction_version: 'fake-1',
      media_type: entry.mediaType,
      completeness: 'complete',
      byte_length_received: Buffer.byteLength(entry.body, 'utf8'),
    }
    const passage: PassageRecord = {
      passage_id: `passage-${request.source.source_id}-1`,
      source_revision_id: revision.revision_id,
      locator: { kind: 'line_range', start: 1, end: 1 },
      text_ref: {
        mode: 'inline',
        text: entry.body.slice(0, 4000),
        text_hash: sha256(entry.body.slice(0, 4000)),
      },
    }
    return {
      status: 'ok',
      operationId: request.operationId,
      revision,
      passages: [passage],
    }
  }
}

export class InMemoryResearchStore implements ResearchStore {
  private readonly events: ResearchStoreEvent[] = []

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
      recordedAt: new Date().toISOString(),
      payload,
    })
    return { eventId }
  }

  appendMission(mission: ResearchMissionV2): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(this.push(mission.mission_id, 'mission_created', { mission }))
  }

  appendPlanRevision(plan: PlanRevision): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(this.push(plan.mission_id, 'plan_revised', { plan }))
  }

  appendSource(source: SourceRecord): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(this.push(source.source_id, 'source_recorded', { source }))
  }

  appendSourceRevision(revision: SourceRevision): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(this.push(revision.source_id, 'revision_recorded', { revision }))
  }

  appendPassage(passage: PassageRecord): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(this.push(passage.passage_id, 'passage_recorded', { passage }))
  }

  appendFinding(finding: FindingRecord): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(this.push(finding.question_id, 'finding_recorded', { finding }))
  }

  appendModelReceipt(receipt: ModelRouteReceipt): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(
      this.push(receipt.operation_id, 'model_invocation_completed', { receipt }),
    )
  }

  appendTerminalReport(report: ResearchReportV2): Promise<ResearchStoreWriteResult> {
    return Promise.resolve(this.push(report.mission_id, 'terminal_receipt', { report }))
  }

  listEvents(missionId: string): Promise<readonly ResearchStoreEvent[]> {
    return Promise.resolve(this.events.filter((e) => e.missionId === missionId))
  }

  /** Test helper: all events in append order. */
  allEvents(): readonly ResearchStoreEvent[] {
    return this.events
  }
}
