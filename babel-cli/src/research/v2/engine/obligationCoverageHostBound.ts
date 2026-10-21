import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanCoverageObligation, QuestionRecord } from '../contracts/plan.js'
import type { PlanObligationCoverageRecord } from '../contracts/planObligationCoverageRecords.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { obligationsForQuestion, passageSupportsObligationCompleteness } from './planCoverageObligations.js'

export type RevisionProvenanceIndex = Map<
  string,
  { source: SourceRecord; revision: SourceRevision }
>

export interface ObligationHostBoundAssessment {
  satisfiesRequiredFacets: boolean
  missingFacets: string[]
  wrongAspectEvidenceOnly: boolean
}

function passageInlineText(passage: PassageRecord): string {
  return passage.text_ref.mode === 'inline' ? passage.text_ref.text : ''
}

function judgmentForObligation(
  records: readonly PlanObligationCoverageRecord[] | undefined,
  obligationId: string,
): PlanObligationCoverageRecord | undefined {
  return records?.find((r) => r.obligation_id === obligationId)
}

function citedPassagesForJudgment(
  finding: FindingRecord,
  passageIds: readonly string[] | undefined,
  passageById: ReadonlyMap<string, PassageRecord>,
): PassageRecord[] {
  const ids = passageIds ?? finding.passage_ids
  return ids.map((id) => passageById.get(id)).filter((p): p is PassageRecord => p !== undefined)
}

function slotMatches(
  passage: PassageRecord,
  obligation: PlanCoverageObligation,
  provenanceIndex: RevisionProvenanceIndex,
): boolean {
  const provenance = provenanceIndex.get(passage.source_revision_id)
  return provenance?.source.coverage_source_slot === obligation.source_slot
}

export function assessObligationCoverageHostBound(
  question: QuestionRecord,
  finding: FindingRecord,
  params: {
    passageById: ReadonlyMap<string, PassageRecord>
    provenanceIndex: RevisionProvenanceIndex
  },
): ObligationHostBoundAssessment {
  const obligations = obligationsForQuestion(question)
  if (obligations.length === 0) {
    return {
      satisfiesRequiredFacets: false,
      missingFacets: [],
      wrongAspectEvidenceOnly: false,
    }
  }

  const missingObligationIds: string[] = []
  let sawWrongAspect = false
  const judgments = finding.plan_obligation_coverage

  for (const obligation of obligations) {
    const judgment = judgmentForObligation(judgments, obligation.obligation_id)
    if (!judgment) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (judgment.status === 'wrong_aspect') {
      sawWrongAspect = true
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (judgment.status === 'unmet') {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (judgment.status !== 'met') {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }

    const supporting = citedPassagesForJudgment(
      finding,
      judgment.supporting_passage_ids,
      params.passageById,
    )
    if (supporting.length === 0) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (!supporting.every((id) => finding.passage_ids.includes(id.passage_id))) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (!supporting.some((p) => slotMatches(p, obligation, params.provenanceIndex))) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    const slotPassages = supporting.filter((p) => slotMatches(p, obligation, params.provenanceIndex))
    const completenessOk = slotPassages.some((p) =>
      passageSupportsObligationCompleteness(passageInlineText(p), obligation, p),
    )
    if (!completenessOk) {
      missingObligationIds.push(obligation.obligation_id)
    }
  }

  return {
    satisfiesRequiredFacets: missingObligationIds.length === 0,
    missingFacets: missingObligationIds,
    wrongAspectEvidenceOnly: sawWrongAspect && missingObligationIds.length > 0,
  }
}
