import type { MissionWriteContext } from '../contracts/common.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'

export type RetrievalExecutionProvenance =
  | { mode: 'offline_injected_access' }
  | { mode: 'governed_network_access' }
  | { mode: 'unknown' }

export interface OfflineRetrievalReportInput {
  mission: ResearchMissionV2
  plan: PlanRevision
  ctx: MissionWriteContext
  passages: readonly PassageRecord[]
  generatedAt: string
  executionProvenance?: RetrievalExecutionProvenance
}

/**
 * Deterministic terminal report from admitted retrieval evidence — no model synthesis.
 * General/web extraction remains on B-owned adapters; this only cites persisted passages.
 */
export function buildOfflineRetrievalReport(input: OfflineRetrievalReportInput): ResearchReportV2 {
  const citationPassageIds = input.passages.map((p) => p.passage_id)
  const leadRef = input.passages[0]?.text_ref
  const excerpt = leadRef?.mode === 'inline' ? leadRef.text : ''
  const answerSummary = excerpt
    ? `Offline retrieval captured ${citationPassageIds.length} passage(s). Lead excerpt: ${excerpt.slice(0, 200)}`
    : `Offline retrieval captured ${citationPassageIds.length} passage(s) for mission ${input.mission.mission_id}.`

  return {
    mission_id: input.mission.mission_id,
    plan_revision_id: input.ctx.plan_revision_id,
    terminal_state: 'partial',
    answer_summary: answerSummary,
    unanswered_questions: input.plan.questions.map((q) => q.question_id),
    coverage_notes:
      'Evidence limited to host-admitted source search/fetch and profile adapter extraction; no model synthesis in this slice.',
    limitations: [
      'offline_retrieval_slice',
      'no_model_synthesis',
      'general_profile_extraction_deferred_to_b_owned_adapters',
      ...(input.executionProvenance?.mode === 'offline_injected_access'
        ? ['execution_used_injected_offline_source_access']
        : []),
      ...(input.executionProvenance?.mode === 'governed_network_access'
        ? ['execution_used_governed_network_source_access']
        : []),
    ],
    source_cutoff: 'retrieval_iteration_complete',
    acceptance_state: 'host_admitted_offline_partial',
    stopping_reason: 'retrieval_and_citation_report_emitted',
    finding_ids: [],
    citation_passage_ids: citationPassageIds,
    generated_at: input.generatedAt,
  }
}
