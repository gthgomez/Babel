import type { FindingRecord } from '../contracts/findings.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'

function isSemanticallySupported(finding: FindingRecord): boolean {
  return finding.semantic_support?.status === 'supported'
}

/**
 * Plan questions with at least one semantically supported finding bound to that exact question_id.
 * Does not infer coverage for sibling plan questions from findings lumped on plan.questions[0].
 */
export function planQuestionIdsWithExplicitSupportedCoverage(
  plan: PlanRevision,
  findings: readonly FindingRecord[],
): string[] {
  const planIds = new Set(plan.questions.map((q) => q.question_id))
  const covered = new Set<string>()
  for (const finding of findings) {
    if (!isSemanticallySupported(finding)) continue
    if (planIds.has(finding.question_id)) {
      covered.add(finding.question_id)
    }
  }
  return plan.questions.map((q) => q.question_id).filter((id) => covered.has(id))
}

/**
 * True when every supported finding is bound only to plan.questions[0] (findingsFromExtractModelOutput default).
 */
export function isExtractDefaultFirstQuestionLump(
  plan: PlanRevision,
  findings: readonly FindingRecord[],
): boolean {
  const firstQuestionId = plan.questions[0]?.question_id
  if (!firstQuestionId) {
    return false
  }
  const supported = findings.filter(isSemanticallySupported)
  if (supported.length === 0) {
    return false
  }
  return supported.every((f) => f.question_id === firstQuestionId)
}

/**
 * Plan questions that must remain unresolved for reporting: never auto-close all plan items from
 * a lump of supported findings on plan.questions[0] only.
 */
export function derivePreservedUnresolvedPlanQuestionIds(
  plan: PlanRevision,
  findings: readonly FindingRecord[],
): string[] {
  const allQuestionIds = plan.questions.map((q) => q.question_id)
  if (isExtractDefaultFirstQuestionLump(plan, findings)) {
    return allQuestionIds
  }
  const explicitlyCovered = new Set(planQuestionIdsWithExplicitSupportedCoverage(plan, findings))
  return allQuestionIds.filter((id) => !explicitlyCovered.has(id))
}

export function buildTruncatedSourceDisclosureLimitations(
  revisions: readonly SourceRevision[],
): string[] {
  const out: string[] = []
  for (const rev of revisions) {
    if (rev.completeness !== 'truncated') continue
    const reason = rev.truncation_reason ?? 'unknown'
    const bytes = rev.byte_length_received ?? 'unknown'
    out.push(
      `source_truncated:${rev.revision_id}:reason=${reason}:bytes_received=${bytes}:content_hash=${rev.content_hash}`,
    )
  }
  return out
}

export function buildSourceFreshnessLimitations(
  sources: readonly SourceRecord[],
  revisions: readonly SourceRevision[],
): string[] {
  const sourceById = new Map(sources.map((s) => [s.source_id, s]))
  return revisions.map((rev) => {
    const source = sourceById.get(rev.source_id)
    const key = source?.canonical_key ?? rev.source_id
    return `source_freshness:${key}:retrieved_at=${rev.retrieved_at}:content_hash=${rev.content_hash}:completeness=${rev.completeness}`
  })
}

/** Host-owned retrieval cutoff metadata; must not echo model synthesis stopping prose. */
export function buildHostSourceCutoff(revisions: readonly SourceRevision[]): string {
  if (revisions.length === 0) {
    return 'no_admitted_source_revisions'
  }
  const latest = [...revisions].sort((a, b) => a.retrieved_at.localeCompare(b.retrieved_at)).at(-1)!
  const truncated = revisions.some((r) => r.completeness === 'truncated')
  return truncated
    ? `admitted_sources_truncated; latest_retrieved_at=${latest.retrieved_at}; latest_content_hash=${latest.content_hash}`
    : `admitted_sources_complete; latest_retrieved_at=${latest.retrieved_at}; latest_content_hash=${latest.content_hash}`
}

export function buildHostStoppingReason(params: {
  unansweredQuestionIds: readonly string[]
  revisions: readonly SourceRevision[]
}): string {
  const truncated = params.revisions.some((r) => r.completeness === 'truncated')
  if (truncated) {
    return 'host_finalized_with_truncated_admitted_sources'
  }
  if (params.unansweredQuestionIds.length > 0) {
    return 'host_finalized_with_unanswered_plan_questions'
  }
  return 'host_finalized_all_plan_questions_evidence_backed'
}
