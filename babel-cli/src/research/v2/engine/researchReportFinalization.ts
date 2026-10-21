import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import { MissionTerminalStateSchema, type PlanRevision } from '../contracts/plan.js'
import type { z } from 'zod'

type MissionTerminalState = z.infer<typeof MissionTerminalStateSchema>
import type { SourceRevision } from '../contracts/sources.js'
import type { UnknownValue } from '../contracts/common.js'

function supportStatus(finding: FindingRecord): FindingRecord['semantic_support'] | undefined {
  return finding.semantic_support
}

export function questionIdsWithSupportedFindings(
  findings: readonly FindingRecord[],
): Set<string> {
  const supported = new Set<string>()
  for (const finding of findings) {
    if (supportStatus(finding)?.status === 'supported') {
      supported.add(finding.question_id)
    }
  }
  return supported
}

/** Plan questions lacking at least one semantically supported finding (ignores plan.status). */
export function deriveUnansweredPlanQuestionIds(
  plan: PlanRevision,
  findings: readonly FindingRecord[],
): string[] {
  const answered = questionIdsWithSupportedFindings(findings)
  return plan.questions
    .map((q) => q.question_id)
    .filter((questionId) => !answered.has(questionId))
}

export function deriveSourceCutoffFromRevisions(
  revisions: readonly SourceRevision[],
): UnknownValue {
  if (revisions.length === 0) return 'unknown'
  let latest = revisions[0]!.retrieved_at
  for (const revision of revisions) {
    if (revision.retrieved_at > latest) {
      latest = revision.retrieved_at
    }
  }
  return latest
}

export function deriveAcquisitionEvidenceLimitations(params: {
  sourceRevisions: readonly SourceRevision[]
  passages: readonly PassageRecord[]
}): string[] {
  const limitations: string[] = []
  for (const revision of params.sourceRevisions) {
    if (revision.completeness === 'truncated') {
      const bytes = revision.byte_length_received ?? 'unknown'
      const reason = revision.truncation_reason ?? 'unknown'
      limitations.push(
        `source_revision_truncated:${reason}:bytes_received=${bytes}:retrieved_at=${revision.retrieved_at}`,
      )
    }
  }
  let truncatedPassageCount = 0
  for (const passage of params.passages) {
    if (
      passage.extraction_notes?.some((note) => note.startsWith('inline_text_truncated:')) === true
    ) {
      truncatedPassageCount += 1
    }
  }
  if (truncatedPassageCount > 0) {
    limitations.push(
      `passage_inline_text_truncated:${truncatedPassageCount}_of_${params.passages.length}`,
    )
  }
  const sectionPassages = params.passages.filter((p) => p.locator.kind === 'section')
  if (sectionPassages.length > 0 && truncatedPassageCount > 0) {
    limitations.push(
      'static_html_extraction_incomplete:truncated_section_text_does_not_prove_full_page_coverage',
    )
  }
  return limitations
}

export function deriveTerminalState(params: {
  unansweredQuestionIds: readonly string[]
  acquisitionLimitations: readonly string[]
  hasSemanticInsufficient: boolean
  hasSemanticContradiction: boolean
  hasSemanticNotChecked: boolean
}): MissionTerminalState {
  if (
    params.unansweredQuestionIds.length > 0 ||
    params.acquisitionLimitations.length > 0 ||
    params.hasSemanticInsufficient ||
    params.hasSemanticContradiction ||
    params.hasSemanticNotChecked
  ) {
    return 'partial'
  }
  return 'complete'
}

export function deriveSinglePassStoppingReason(params: {
  unansweredQuestionIds: readonly string[]
  acquisitionLimitations: readonly string[]
  hasSemanticInsufficient: boolean
  hasSemanticContradiction: boolean
  hasSemanticNotChecked: boolean
}): string {
  const parts: string[] = ['single_pass_host_finalization']
  if (params.unansweredQuestionIds.length > 0) {
    parts.push(`unanswered_plan_questions=${params.unansweredQuestionIds.length}`)
  }
  if (params.acquisitionLimitations.length > 0) {
    parts.push('acquisition_or_extraction_limits_recorded')
  }
  if (params.hasSemanticInsufficient) parts.push('semantic_support_insufficient')
  if (params.hasSemanticContradiction) parts.push('semantic_support_contradicted')
  if (params.hasSemanticNotChecked) parts.push('semantic_support_not_checked')
  if (parts.length === 1) {
    return 'single_pass_evidence_complete'
  }
  return parts.join(';')
}
