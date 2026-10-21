import { createHash } from 'node:crypto'
import type { FindingRecord } from '../contracts/findings.js'
import {
  ExtractFindingsOutputSchema,
  SemanticSupportReviewOutputSchema,
} from '../contracts/modelOutputs.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { PassageRecord } from '../contracts/passages.js'

function findingId(operationId: string, index: number): string {
  return `finding-${createHash('sha256').update(`${operationId}:${index}`).digest('hex').slice(0, 24)}`
}

export function findingsFromExtractModelOutput(params: {
  operationId: string
  modelOutput: Record<string, unknown>
  plan: PlanRevision
  passages: readonly PassageRecord[]
  createdAt: string
}): FindingRecord[] {
  const parsed = ExtractFindingsOutputSchema.parse(params.modelOutput)
  const defaultQuestionId = params.plan.questions[0]?.question_id
  if (!defaultQuestionId) {
    throw new Error('plan has no questions for finding binding')
  }
  const passageIds = new Set(params.passages.map((p) => p.passage_id))
  return parsed.findings.map((raw, index) => {
    for (const pid of raw.passage_ids) {
      if (!passageIds.has(pid)) {
        throw new Error(`model cited unknown passage_id ${pid}`)
      }
    }
    return {
      finding_id: findingId(params.operationId, index),
      question_id: defaultQuestionId,
      assertion_text: raw.assertion_text,
      assertion_kind: raw.assertion_kind,
      passage_ids: raw.passage_ids,
      source_integrity: 'not_checked',
      created_at: params.createdAt,
    }
  })
}

export function applySemanticSupportReview(
  findings: FindingRecord[],
  modelOutput: Record<string, unknown>,
  reviewedAt: string,
): FindingRecord[] {
  const parsed = SemanticSupportReviewOutputSchema.parse(modelOutput)
  const byId = new Map(findings.map((f) => [f.finding_id, f]))
  for (const judgment of parsed.judgments) {
    const finding = byId.get(judgment.finding_id)
    if (!finding) {
      throw new Error(`semantic review references unknown finding ${judgment.finding_id}`)
    }
    finding.semantic_support = {
      status: judgment.status,
      reviewer: 'research-v2-semantic-review',
      reviewer_version: '0.1.0-offline',
      rationale: judgment.rationale,
      reviewed_at: reviewedAt,
    }
    if (judgment.status === 'contradicted') {
      finding.conflicting_finding_ids = finding.conflicting_finding_ids ?? []
    }
  }
  return [...byId.values()]
}
