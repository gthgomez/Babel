import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { QuestionRecord } from '../contracts/plan.js'
import type { PlanObligationCoverageRecord } from '../contracts/planObligationCoverageRecords.js'
import { obligationsForQuestion } from './planCoverageObligations.js'

/**
 * Validate model `obligation_coverage` before host assessment silently drops unknown passages
 * or picks the first of duplicate obligation_id rows.
 */
export function collectObligationCoverageJudgmentIntegrityIssues(
  question: QuestionRecord,
  finding: FindingRecord,
  passageById: ReadonlyMap<string, PassageRecord>,
): string[] {
  const issues: string[] = []
  const allowedObligationIds = new Set(
    obligationsForQuestion(question).map((o) => o.obligation_id),
  )
  const records = finding.plan_obligation_coverage ?? []
  const seenObligationIds = new Set<string>()

  for (const record of records) {
    if (seenObligationIds.has(record.obligation_id)) {
      issues.push(`duplicate_obligation_id:${record.obligation_id}`)
    }
    seenObligationIds.add(record.obligation_id)
    if (!allowedObligationIds.has(record.obligation_id)) {
      issues.push(`unknown_obligation_id:${record.obligation_id}`)
    }
    issues.push(...passageIdIntegrityIssues(finding, record, passageById))
  }

  return issues
}

function passageIdIntegrityIssues(
  finding: FindingRecord,
  record: PlanObligationCoverageRecord,
  passageById: ReadonlyMap<string, PassageRecord>,
): string[] {
  const ids = record.supporting_passage_ids ?? []
  if (ids.length === 0) {
    return []
  }
  const issues: string[] = []
  for (const passageId of ids) {
    if (!passageById.has(passageId)) {
      issues.push(`absent_passage_id:${passageId}`)
      continue
    }
    if (!finding.passage_ids.includes(passageId)) {
      issues.push(`foreign_passage_id:${passageId}`)
    }
  }
  return issues
}
