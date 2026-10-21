import type { FindingRecord } from '../contracts/findings.js'
import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { SynthesizeReportOutputSchema } from '../contracts/modelOutputs.js'

export function buildSynthesizedResearchReport(params: {
  mission: ResearchMissionV2
  plan: PlanRevision
  ctx: MissionWriteContext
  findings: readonly FindingRecord[]
  modelOutput: Record<string, unknown>
  generatedAt: string
}): ResearchReportV2 {
  const synthesis = SynthesizeReportOutputSchema.parse(params.modelOutput)
  const citationPassageIds = [
    ...new Set(params.findings.flatMap((f) => f.passage_ids)),
  ]
  const findingIds = params.findings.map((f) => f.finding_id)
  const hasContradiction = params.findings.some((f) => f.semantic_support?.status === 'contradicted')
  const hasInsufficient = params.findings.some((f) => f.semantic_support?.status === 'insufficient')
  const unanswered = params.plan.questions
    .filter((q) => q.status === 'open' || q.status === 'partially_answered')
    .map((q) => q.question_id)

  const terminalState =
    hasContradiction || hasInsufficient || unanswered.length > 0 ? 'partial' : 'partial'

  return {
    mission_id: params.mission.mission_id,
    plan_revision_id: params.ctx.plan_revision_id,
    terminal_state: terminalState,
    answer_summary: synthesis.answer_summary,
    unanswered_questions: unanswered.length > 0 ? unanswered : params.plan.questions.map((q) => q.question_id),
    coverage_notes:
      'Synthesis from admitted retrieval, model extract/review, and cited passages; incomplete outcomes preserved.',
    limitations: [
      ...(hasInsufficient ? ['semantic_support_insufficient'] : []),
      ...(hasContradiction ? ['semantic_support_contradicted'] : []),
      'offline_or_governed_sources_only',
    ],
    source_cutoff: synthesis.stopping_reason,
    acceptance_state: 'host_admitted_model_synthesis',
    stopping_reason: synthesis.stopping_reason,
    finding_ids: findingIds,
    citation_passage_ids: citationPassageIds,
    generated_at: params.generatedAt,
  }
}
