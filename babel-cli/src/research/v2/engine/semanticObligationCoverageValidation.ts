import type { PlanCoverageObligation } from '../contracts/plan.js'
import type { PlanObligationCoverageRecord } from '../contracts/planObligationCoverageRecords.js'

export type ObligationCoverageResponseViolation =
  | 'unknown_obligation_id'
  | 'duplicate_obligation_id'
  | 'unknown_passage_id'
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

  const allowedObligationIds = new Set(params.planObligations.map((o) => o.obligation_id))
  const findingPassageSet = new Set(params.findingPassageIds)
  const seenObligationIds = new Set<string>()
  const records: PlanObligationCoverageRecord[] = []

  for (const entry of rawEntries) {
    if (seenObligationIds.has(entry.obligation_id)) {
      return {
        valid: false,
        violation: 'duplicate_obligation_id',
        detail: `duplicate obligation_id ${entry.obligation_id}`,
      }
    }
    seenObligationIds.add(entry.obligation_id)

    if (!allowedObligationIds.has(entry.obligation_id)) {
      return {
        valid: false,
        violation: 'unknown_obligation_id',
        detail: `unknown obligation_id ${entry.obligation_id}`,
      }
    }

    if (entry.status === 'met') {
      const supporting = entry.supporting_passage_ids
      if (!supporting || supporting.length === 0) {
        return {
          valid: false,
          violation: 'missing_supporting_passage_ids',
          detail: `obligation_id ${entry.obligation_id} met requires supporting_passage_ids`,
        }
      }
      for (const passageId of supporting) {
        if (!params.admittedPassageIds.has(passageId)) {
          return {
            valid: false,
            violation: 'unknown_passage_id',
            detail: `unknown passage_id ${passageId} for obligation_id ${entry.obligation_id}`,
          }
        }
        if (!findingPassageSet.has(passageId)) {
          return {
            valid: false,
            violation: 'foreign_passage_id',
            detail: `passage_id ${passageId} not cited on finding for obligation_id ${entry.obligation_id}`,
          }
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
