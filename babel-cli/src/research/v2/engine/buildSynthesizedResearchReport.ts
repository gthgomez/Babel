import type { FindingRecord } from '../contracts/findings.js'
import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { SynthesizeReportOutputSchema } from '../contracts/modelOutputs.js'

function supportStatus(finding: FindingRecord): FindingRecord['semantic_support'] | undefined {
  return finding.semantic_support
}

export interface VerifiedReportAssertion {
  finding_id: string
  assertion_text: string
  passage_ids: readonly string[]
}

export function buildVerifiedReportAssertions(
  findings: readonly FindingRecord[],
): VerifiedReportAssertion[] {
  return findings
    .filter((f) => supportStatus(f)?.status === 'supported')
    .map((f) => ({
      finding_id: f.finding_id,
      assertion_text: f.assertion_text,
      passage_ids: f.passage_ids,
    }))
}

export function buildCitationQualifiedAnswerSummary(
  assertions: readonly VerifiedReportAssertion[],
): string {
  if (assertions.length === 0) {
    return 'No semantically supported findings to assert as mission facts.'
  }
  return assertions
    .map(
      (a) =>
        `[supported:${a.finding_id}] ${a.assertion_text} (passages: ${a.passage_ids.join(',')})`,
    )
    .join(' ')
}

export function buildSynthesizedResearchReport(params: {
  mission: ResearchMissionV2
  plan: PlanRevision
  ctx: MissionWriteContext
  findings: readonly FindingRecord[]
  modelOutput: Record<string, unknown>
  generatedAt: string
}): ResearchReportV2 {
  const synthesis = SynthesizeReportOutputSchema.parse(params.modelOutput)
  const verifiedAssertions = buildVerifiedReportAssertions(params.findings)
  const supportedFindingIds = verifiedAssertions.map((a) => a.finding_id)
  const citationPassageIds = [...new Set(verifiedAssertions.flatMap((a) => a.passage_ids))]
  const hasContradiction = params.findings.some((f) => supportStatus(f)?.status === 'contradicted')
  const hasInsufficient = params.findings.some((f) => supportStatus(f)?.status === 'insufficient')
  const hasNotChecked = params.findings.some(
    (f) => (supportStatus(f)?.status ?? 'not_checked') === 'not_checked',
  )
  const unanswered = params.plan.questions
    .filter((q) => q.status === 'open' || q.status === 'partially_answered')
    .map((q) => q.question_id)

  const unverifiedModelSynthesis = synthesis.answer_summary.trim()

  return {
    mission_id: params.mission.mission_id,
    plan_revision_id: params.ctx.plan_revision_id,
    terminal_state: 'partial',
    answer_summary: buildCitationQualifiedAnswerSummary(verifiedAssertions),
    unanswered_questions: unanswered.length > 0 ? unanswered : params.plan.questions.map((q) => q.question_id),
    coverage_notes:
      'answer_summary lists only semantically supported findings with explicit finding_id bindings; free-form model synthesis is not treated as verified fact.',
    limitations: [
      ...(hasInsufficient ? ['semantic_support_insufficient'] : []),
      ...(hasContradiction ? ['semantic_support_contradicted'] : []),
      ...(hasNotChecked ? ['semantic_support_not_checked'] : []),
      ...(supportedFindingIds.length < params.findings.length ? ['report_excludes_unsupported_findings'] : []),
      ...(unverifiedModelSynthesis
        ? [`unverified_model_synthesis_excluded: ${unverifiedModelSynthesis.slice(0, 240)}`]
        : []),
      'offline_or_governed_sources_only',
    ],
    source_cutoff: synthesis.stopping_reason,
    acceptance_state: 'host_admitted_model_synthesis',
    stopping_reason: synthesis.stopping_reason,
    finding_ids: supportedFindingIds,
    citation_passage_ids: citationPassageIds,
    generated_at: params.generatedAt,
  }
}
