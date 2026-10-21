import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanCoverageObligation, QuestionRecord } from '../contracts/plan.js'
import type { PlanObligationCoverageRecord } from '../contracts/planObligationCoverageRecords.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { obligationsForQuestion } from './planCoverageObligations.js'

export type RevisionProvenanceIndex = Map<
  string,
  { source: SourceRecord; revision: SourceRevision }
>

export interface ObligationHostBoundAssessment {
  satisfiesRequiredFacets: boolean
  missingFacets: string[]
  wrongAspectEvidenceOnly: boolean
}

function judgmentForObligation(
  records: readonly PlanObligationCoverageRecord[] | undefined,
  obligationId: string,
): PlanObligationCoverageRecord | undefined {
  return records?.find((r) => r.obligation_id === obligationId)
}

function resolveSupportingPassages(
  finding: FindingRecord,
  judgment: PlanObligationCoverageRecord,
  passageById: ReadonlyMap<string, PassageRecord>,
): PassageRecord[] {
  const ids = judgment.supporting_passage_ids ?? []
  return ids.map((id) => passageById.get(id)!)
}

function slotMatches(
  passage: PassageRecord,
  obligation: PlanCoverageObligation,
  provenanceIndex: RevisionProvenanceIndex,
): boolean {
  const provenance = provenanceIndex.get(passage.source_revision_id)
  return provenance?.source.coverage_source_slot === obligation.source_slot
}

/** Structural citation completeness for model `met` (identity/availability/truncation — not topic lexicon). */
export function obligationCitationStructuralCompleteness(
  passage: PassageRecord,
  obligation: PlanCoverageObligation,
  provenance?: { source: SourceRecord; revision: SourceRevision },
): boolean {
  if (passage.text_ref.mode !== 'inline') {
    return false
  }
  const passageTruncated =
    passage.extraction_notes?.some(
      (n) => n.startsWith('inline_text_truncated:') || n.startsWith('excerpt_truncated'),
    ) === true
  const revisionTruncated = provenance?.revision.completeness === 'truncated'
  if (obligation.aspect === 'technical_effect' && (passageTruncated || revisionTruncated)) {
    return false
  }
  return passage.text_ref.text.trim().length > 0
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
    if (judgment.status === 'unmet' || judgment.status === 'not_assessed') {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (judgment.status !== 'met') {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }

    const supportingIds = judgment.supporting_passage_ids ?? []
    if (supportingIds.length === 0) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (!supportingIds.every((id) => finding.passage_ids.includes(id))) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    const supporting = resolveSupportingPassages(finding, judgment, params.passageById)
    if (supporting.length !== supportingIds.length) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    if (!supporting.some((p) => slotMatches(p, obligation, params.provenanceIndex))) {
      missingObligationIds.push(obligation.obligation_id)
      continue
    }
    const slotPassages = supporting.filter((p) => slotMatches(p, obligation, params.provenanceIndex))
    const structurallyComplete = slotPassages.some((p) => {
      const provenance = params.provenanceIndex.get(p.source_revision_id)
      return obligationCitationStructuralCompleteness(p, obligation, provenance)
    })
    if (!structurallyComplete) {
      missingObligationIds.push(obligation.obligation_id)
    }
  }

  return {
    satisfiesRequiredFacets: missingObligationIds.length === 0,
    missingFacets: missingObligationIds,
    wrongAspectEvidenceOnly: sawWrongAspect && missingObligationIds.length > 0,
  }
}
