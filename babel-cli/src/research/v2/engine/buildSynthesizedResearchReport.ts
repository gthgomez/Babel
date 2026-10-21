import type { FindingRecord } from '../contracts/findings.js'
import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { SynthesizeReportOutputSchema } from '../contracts/modelOutputs.js'

function supportStatus(finding: FindingRecord): FindingRecord['semantic_support'] | undefined {
  return finding.semantic_support
}

export function buildCitationQualifiedAnswerSummary(
  findings: readonly FindingRecord[],
  modelAnswerSummary: string,
): string {
  const lines: string[] = []
  for (const finding of findings) {
    const status = supportStatus(finding)?.status ?? 'not_checked'
    const cites = finding.passage_ids.join(',')
    if (status === 'supported') {
      lines.push(`[supported:${finding.finding_id}] ${finding.assertion_text} (passages: ${cites})`)
      continue
    }
    if (status === 'contradicted') {
      lines.push(
        `[contradicted:${finding.finding_id}] ${finding.assertion_text} — not asserted as mission fact (passages: ${cites})`,
      )
      continue
    }
    if (status === 'insufficient') {
      lines.push(
        `[insufficient:${finding.finding_id}] ${finding.assertion_text} — evidence does not fully support this claim (passages: ${cites})`,
      )
      continue
    }
    lines.push(
      `[not_checked:${finding.finding_id}] ${finding.assertion_text} — semantic review did not establish support (passages: ${cites})`,
    )
  }
  const allSupported = findings.length > 0 && findings.every((f) => supportStatus(f)?.status === 'supported')
  if (allSupported && modelAnswerSummary.trim()) {
    lines.push(`Synthesis: ${modelAnswerSummary}`)
  } else if (modelAnswerSummary.trim()) {
    lines.push(
      `Model synthesis (qualified; not all findings supported): ${modelAnswerSummary}`,
    )
  }
  return lines.join(' ')
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
  const supportedFindingIds = params.findings
    .filter((f) => supportStatus(f)?.status === 'supported')
    .map((f) => f.finding_id)
  const citationPassageIds = [
    ...new Set(
      params.findings
        .filter((f) => supportStatus(f)?.status === 'supported')
        .flatMap((f) => f.passage_ids),
    ),
  ]
  const findingIds = supportedFindingIds.length > 0 ? supportedFindingIds : params.findings.map((f) => f.finding_id)
  const hasContradiction = params.findings.some((f) => supportStatus(f)?.status === 'contradicted')
  const hasInsufficient = params.findings.some((f) => supportStatus(f)?.status === 'insufficient')
  const hasNotChecked = params.findings.some((f) => (supportStatus(f)?.status ?? 'not_checked') === 'not_checked')
  const unanswered = params.plan.questions
    .filter((q) => q.status === 'open' || q.status === 'partially_answered')
    .map((q) => q.question_id)

  const terminalState = 'partial'

  return {
    mission_id: params.mission.mission_id,
    plan_revision_id: params.ctx.plan_revision_id,
    terminal_state: terminalState,
    answer_summary: buildCitationQualifiedAnswerSummary(params.findings, synthesis.answer_summary),
    unanswered_questions: unanswered.length > 0 ? unanswered : params.plan.questions.map((q) => q.question_id),
    coverage_notes:
      'Report assertions are bound to reviewed findings and cited passages; unsupported or contradicted claims are explicitly qualified.',
    limitations: [
      ...(hasInsufficient ? ['semantic_support_insufficient'] : []),
      ...(hasContradiction ? ['semantic_support_contradicted'] : []),
      ...(hasNotChecked ? ['semantic_support_not_checked'] : []),
      ...(supportedFindingIds.length < params.findings.length ? ['report_excludes_unsupported_findings'] : []),
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
