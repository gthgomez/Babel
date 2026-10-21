import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanCoverageObligation, QuestionRecord } from '../contracts/plan.js'
import type { PlanObligationCoverageRecord } from '../contracts/planObligationCoverageRecords.js'
import { obligationsForQuestion } from './planCoverageObligations.js'

export type ObligationCoverageIntegrityIssue =
  | `duplicate_obligation_id:${string}`
  | `unknown_obligation_id:${string}`
  | `absent_passage_id:${string}`
  | `foreign_passage_id:${string}`

export function passageIdIntegrityIssueStrings(
  findingPassageIds: readonly string[],
  supportingIds: readonly string[],
  isAdmitted: (passageId: string) => boolean,
): ObligationCoverageIntegrityIssue[] {
  const issues: ObligationCoverageIntegrityIssue[] = []
  for (const passageId of supportingIds) {
    if (!isAdmitted(passageId)) {
      issues.push(`absent_passage_id:${passageId}`)
      continue
    }
    if (!findingPassageIds.includes(passageId)) {
      issues.push(`foreign_passage_id:${passageId}`)
    }
  }
  return issues
}

export function obligationRowIntegrityIssueStrings(
  obligationId: string,
  allowedObligationIds: ReadonlySet<string>,
  seenObligationIds: Set<string>,
): ObligationCoverageIntegrityIssue[] {
  const issues: ObligationCoverageIntegrityIssue[] = []
  if (seenObligationIds.has(obligationId)) {
    issues.push(`duplicate_obligation_id:${obligationId}`)
  }
  seenObligationIds.add(obligationId)
  if (!allowedObligationIds.has(obligationId)) {
    issues.push(`unknown_obligation_id:${obligationId}`)
  }
  return issues
}

export function integrityIssueToResponseViolation(
  issue: ObligationCoverageIntegrityIssue,
): 'duplicate_obligation_id' | 'unknown_obligation_id' | 'absent_passage_id' | 'foreign_passage_id' {
  const prefix = issue.split(':')[0]
  if (
    prefix === 'duplicate_obligation_id' ||
    prefix === 'unknown_obligation_id' ||
    prefix === 'absent_passage_id' ||
    prefix === 'foreign_passage_id'
  ) {
    return prefix
  }
  throw new Error(`unexpected integrity issue ${issue}`)
}

/**
 * Validate persisted `plan_obligation_coverage` before host assessment silently drops
 * unknown passages or picks the first of duplicate obligation_id rows.
 */
export function collectObligationCoverageJudgmentIntegrityIssues(
  question: QuestionRecord,
  finding: FindingRecord,
  passageById: ReadonlyMap<string, PassageRecord>,
): string[] {
  const allowedObligationIds = new Set(
    obligationsForQuestion(question).map((o) => o.obligation_id),
  )
  return collectObligationCoverageRecordIntegrityIssues(
    finding.plan_obligation_coverage ?? [],
    {
      allowedObligationIds,
      findingPassageIds: finding.passage_ids,
      isAdmitted: (passageId) => passageById.has(passageId),
    },
  )
}

export function collectObligationCoverageRecordIntegrityIssues(
  records: readonly PlanObligationCoverageRecord[],
  params: {
    allowedObligationIds: ReadonlySet<string>
    findingPassageIds: readonly string[]
    isAdmitted: (passageId: string) => boolean
  },
): string[] {
  const issues: string[] = []
  const seenObligationIds = new Set<string>()

  for (const record of records) {
    issues.push(
      ...obligationRowIntegrityIssueStrings(
        record.obligation_id,
        params.allowedObligationIds,
        seenObligationIds,
      ),
    )
    const supporting = record.supporting_passage_ids ?? []
    if (supporting.length > 0) {
      issues.push(
        ...passageIdIntegrityIssueStrings(
          params.findingPassageIds,
          supporting,
          params.isAdmitted,
        ),
      )
    }
  }

  return issues
}

export function allowedObligationIdsFromPlan(
  planObligations: readonly PlanCoverageObligation[],
): Set<string> {
  return new Set(planObligations.map((o) => o.obligation_id))
}
