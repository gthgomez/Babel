import type { PlanCoverageObligation } from '../contracts/plan.js'
import type { PlanObligationCoverageRecord } from '../contracts/planObligationCoverageRecords.js'
import {
  allowedObligationIdsFromPlan,
  integrityIssueToResponseViolation,
  obligationRowIntegrityIssueStrings,
  passageIdIntegrityIssueStrings,
} from './obligationCoverageJudgmentIntegrity.js'

export type ObligationCoverageResponseViolation =
  | 'unknown_obligation_id'
  | 'duplicate_obligation_id'
  | 'absent_passage_id'
  | 'foreign_passage_id'
  | 'missing_supporting_passage_ids'
  | 'obligation_coverage_omitted'

export interface RawObligationCoverageJudgment {
  obligation_id: string
  status: 'met' | 'unmet' | 'wrong_aspect'
  supporting_passage_ids?: string[]
}

export type ValidateObligationCoverageResponseResult =
  | { valid: true; records: PlanObligationCoverageRecord[] }
  | { valid: false; violation: ObligationCoverageResponseViolation; detail: string }

/**
 * Validates model `obligation_coverage` before any passage-id filtering or persistence.
 * Unknown or duplicate obligation ids and absent/foreign passage references fail closed.
 */
export function validateSemanticObligationCoverageResponse(
  rawEntries: readonly RawObligationCoverageJudgment[] | undefined,
  params: {
    planObligations: readonly PlanCoverageObligation[]
    findingPassageIds: readonly string[]
    admittedPassageIds: ReadonlySet<string>
  },
): ValidateObligationCoverageResponseResult {
  if (!rawEntries || rawEntries.length === 0) {
    if (params.planObligations.length === 0) {
      return { valid: true, records: [] }
    }
    return {
      valid: false,
      violation: 'obligation_coverage_omitted',
      detail: 'obligation_coverage omitted for question with coverage_obligations',
    }
  }

  const allowedObligationIds = allowedObligationIdsFromPlan(params.planObligations)
  const seenObligationIds = new Set<string>()
  const records: PlanObligationCoverageRecord[] = []

  for (const entry of rawEntries) {
    const rowIssues = obligationRowIntegrityIssueStrings(
      entry.obligation_id,
      allowedObligationIds,
      seenObligationIds,
    )
    if (rowIssues.length > 0) {
      const issue = rowIssues[0]!
      return {
        valid: false,
        violation: integrityIssueToResponseViolation(issue),
        detail: issue,
      }
    }

    const supporting = entry.supporting_passage_ids
    if (entry.status === 'met' && (!supporting || supporting.length === 0)) {
      return {
        valid: false,
        violation: 'missing_supporting_passage_ids',
        detail: `missing_supporting_passage_ids:${entry.obligation_id}`,
      }
    }
    if (supporting && supporting.length > 0) {
      const passageIssues = passageIdIntegrityIssueStrings(
        params.findingPassageIds,
        supporting,
        (passageId) => params.admittedPassageIds.has(passageId),
      )
      if (passageIssues.length > 0) {
        const issue = passageIssues[0]!
        return {
          valid: false,
          violation: integrityIssueToResponseViolation(issue),
          detail: issue,
        }
      }
    }

    records.push({
      obligation_id: entry.obligation_id,
      status: entry.status,
      ...(entry.supporting_passage_ids
        ? { supporting_passage_ids: [...entry.supporting_passage_ids] }
        : {}),
    })
  }

  return { valid: true, records }
}

export function conservativeQuestionCoverageAfterObligationResponseViolation(
  modelQuestionCoverage: 'answers' | 'partial' | 'tangential' | 'none',
  violation: ObligationCoverageResponseViolation,
): 'answers' | 'partial' | 'tangential' | 'none' {
  if (modelQuestionCoverage === 'answers') {
    return 'partial'
  }
  return modelQuestionCoverage
}
