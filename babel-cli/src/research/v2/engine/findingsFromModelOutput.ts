import { createHash } from 'node:crypto'
import type { FindingRecord } from '../contracts/findings.js'
import {
  ExtractFindingsOutputSchema,
  SemanticSupportReviewOutputSchema,
} from '../contracts/modelOutputs.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { enforceBoundQuestionCoverageOnFindings } from './boundQuestionCoverageFromEvidence.js'

function findingId(operationId: string, index: number): string {
  return `finding-${createHash('sha256').update(`${operationId}:${index}`).digest('hex').slice(0, 24)}`
}

function assertExtractFindingQuestionId(
  questionId: string,
  planQuestionIds: ReadonlySet<string>,
): string {
  if (!planQuestionIds.has(questionId)) {
    throw new Error(`model cited unknown question_id ${questionId}`)
  }
  return questionId
}

/**
 * Maps extract_findings model output to FindingRecords.
 * Backward compatibility: extracts without question_id fail Zod parse; there is no plan.questions[0] fallback.
 */
export function findingsFromExtractModelOutput(params: {
  operationId: string
  modelOutput: Record<string, unknown>
  plan: PlanRevision
  passages: readonly PassageRecord[]
  createdAt: string
}): FindingRecord[] {
  const parsed = ExtractFindingsOutputSchema.parse(params.modelOutput)
  if (params.plan.questions.length === 0) {
    throw new Error('plan has no questions for finding binding')
  }
  const planQuestionIds = new Set(params.plan.questions.map((q) => q.question_id))
  const passageIds = new Set(params.passages.map((p) => p.passage_id))
  return parsed.findings.map((raw, index) => {
    for (const pid of raw.passage_ids) {
      if (!passageIds.has(pid)) {
        throw new Error(`model cited unknown passage_id ${pid}`)
      }
    }
    return {
      finding_id: findingId(params.operationId, index),
      question_id: assertExtractFindingQuestionId(raw.question_id, planQuestionIds),
      assertion_text: raw.assertion_text,
      assertion_kind: raw.assertion_kind,
      passage_ids: raw.passage_ids,
      source_integrity: 'not_checked',
      created_at: params.createdAt,
    }
  })
}

const SEMANTIC_REVIEWER = 'research-v2-semantic-review'
const SEMANTIC_REVIEWER_VERSION = '0.1.0-offline'
const QUESTION_COVERAGE_REVIEWER = SEMANTIC_REVIEWER
const QUESTION_COVERAGE_REVIEWER_VERSION = '0.1.0-question-coverage'

export interface SemanticSupportReviewContext {
  plan: PlanRevision
  passages: readonly PassageRecord[]
  sources: readonly SourceRecord[]
  sourceRevisions: readonly SourceRevision[]
}

export function applySemanticSupportReview(
  findings: FindingRecord[],
  modelOutput: Record<string, unknown>,
  reviewedAt: string,
  context?: SemanticSupportReviewContext,
): FindingRecord[] {
  const parsed = SemanticSupportReviewOutputSchema.parse(modelOutput)
  const byId = new Map(findings.map((f) => [f.finding_id, { ...f }]))
  const judgedIds = new Set<string>()
  for (const judgment of parsed.judgments) {
    const finding = byId.get(judgment.finding_id)
    if (!finding) {
      throw new Error(`semantic review references unknown finding ${judgment.finding_id}`)
    }
    judgedIds.add(judgment.finding_id)
    finding.semantic_support = {
      status: judgment.status,
      reviewer: SEMANTIC_REVIEWER,
      reviewer_version: SEMANTIC_REVIEWER_VERSION,
      rationale: judgment.rationale,
      reviewed_at: reviewedAt,
    }
    finding.question_coverage = {
      status: judgment.question_coverage,
      reviewer: QUESTION_COVERAGE_REVIEWER,
      reviewer_version: QUESTION_COVERAGE_REVIEWER_VERSION,
      rationale: judgment.rationale,
      reviewed_at: reviewedAt,
    }
    if (judgment.obligation_coverage) {
      finding.plan_obligation_coverage = judgment.obligation_coverage.map((entry) => ({
        obligation_id: entry.obligation_id,
        status: entry.status,
        ...(entry.supporting_passage_ids
          ? { supporting_passage_ids: entry.supporting_passage_ids }
          : {}),
      }))
    }
    finding.revised_at = reviewedAt
    if (judgment.status === 'contradicted') {
      finding.conflicting_finding_ids = finding.conflicting_finding_ids ?? []
    }
  }
  for (const finding of byId.values()) {
    if (judgedIds.has(finding.finding_id)) continue
    finding.semantic_support = {
      status: 'not_checked',
      reviewer: SEMANTIC_REVIEWER,
      reviewer_version: SEMANTIC_REVIEWER_VERSION,
      rationale: 'semantic review omitted an explicit judgment for this finding',
      reviewed_at: reviewedAt,
    }
    finding.question_coverage = {
      status: 'not_assessed',
      reviewer: QUESTION_COVERAGE_REVIEWER,
      reviewer_version: QUESTION_COVERAGE_REVIEWER_VERSION,
      rationale: 'semantic review omitted question coverage for this finding',
      reviewed_at: reviewedAt,
    }
    finding.revised_at = reviewedAt
  }
  const reviewed = [...byId.values()]
  if (!context) {
    return reviewed
  }
  return enforceBoundQuestionCoverageOnFindings(reviewed, {
    plan: context.plan,
    passages: context.passages,
    sources: context.sources,
    sourceRevisions: context.sourceRevisions,
    reviewedAt,
  })
}
