import type { MissionWriteContext } from '../contracts/common.js'
import type { FindingRecord } from '../contracts/findings.js'
import type {
  ExternalOperationCompletion,
  ExternalOperationIntent,
  ExternalOperationReconciliation,
} from '../contracts/operations.js'
import type { PlanRevision, ResearchReportV2 } from '../contracts/plan.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { ModelRouteReceipt } from './researchModelPort.js'

export type ResearchStoreEventKind =
  | 'mission_created'
  | 'plan_revised'
  | 'source_recorded'
  | 'revision_recorded'
  | 'passage_recorded'
  | 'finding_recorded'
  | 'model_invocation_completed'
  | 'external_operation_intent'
  | 'external_operation_completed'
  | 'external_operation_reconciled'
  | 'terminal_receipt'

export interface ResearchStoreEvent {
  eventId: string
  missionId: string
  kind: ResearchStoreEventKind
  recordedAt: string
  payload: Record<string, unknown>
}

export interface ResearchStoreWriteResult {
  eventId: string
}

export interface ResearchStoreMissionHandle {
  mission_id: string
  writer_generation: number
}

export interface ResearchStore {
  appendMission(mission: ResearchMissionV2): Promise<ResearchStoreMissionHandle>
  appendPlanRevision(
    ctx: MissionWriteContext,
    plan: PlanRevision,
  ): Promise<ResearchStoreWriteResult>
  appendSource(ctx: MissionWriteContext, source: SourceRecord): Promise<ResearchStoreWriteResult>
  appendSourceRevision(
    ctx: MissionWriteContext,
    revision: SourceRevision,
  ): Promise<ResearchStoreWriteResult>
  appendPassage(ctx: MissionWriteContext, passage: PassageRecord): Promise<ResearchStoreWriteResult>
  appendFinding(ctx: MissionWriteContext, finding: FindingRecord): Promise<ResearchStoreWriteResult>
  appendModelReceipt(
    ctx: MissionWriteContext,
    receipt: ModelRouteReceipt,
  ): Promise<ResearchStoreWriteResult>
  appendExternalOperationIntent(
    ctx: MissionWriteContext,
    intent: ExternalOperationIntent,
  ): Promise<ResearchStoreWriteResult>
  appendExternalOperationCompleted(
    ctx: MissionWriteContext,
    completion: ExternalOperationCompletion,
  ): Promise<ResearchStoreWriteResult>
  appendExternalOperationReconciled(
    ctx: MissionWriteContext,
    reconciliation: ExternalOperationReconciliation,
  ): Promise<ResearchStoreWriteResult>
  appendTerminalReport(
    ctx: MissionWriteContext,
    report: ResearchReportV2,
  ): Promise<ResearchStoreWriteResult>
  listEvents(missionId: string): Promise<readonly ResearchStoreEvent[]>
}
