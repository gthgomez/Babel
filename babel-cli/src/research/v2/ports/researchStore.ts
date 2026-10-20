import type { FindingRecord } from '../contracts/findings.js'
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

/**
 * Atomic record/event writes and deterministic resume reconstruction.
 * Single mission-writer ownership enforced by host.
 */
export interface ResearchStore {
  appendMission(mission: ResearchMissionV2): Promise<ResearchStoreWriteResult>
  appendPlanRevision(plan: PlanRevision): Promise<ResearchStoreWriteResult>
  appendSource(source: SourceRecord): Promise<ResearchStoreWriteResult>
  appendSourceRevision(revision: SourceRevision): Promise<ResearchStoreWriteResult>
  appendPassage(passage: PassageRecord): Promise<ResearchStoreWriteResult>
  appendFinding(finding: FindingRecord): Promise<ResearchStoreWriteResult>
  appendModelReceipt(receipt: ModelRouteReceipt): Promise<ResearchStoreWriteResult>
  appendTerminalReport(report: ResearchReportV2): Promise<ResearchStoreWriteResult>
  listEvents(missionId: string): Promise<readonly ResearchStoreEvent[]>
}
