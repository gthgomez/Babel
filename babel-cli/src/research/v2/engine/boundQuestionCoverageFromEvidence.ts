import type { FindingRecord } from '../contracts/findings.js'
import { QuestionCoverageStatusSchema } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision, QuestionRecord } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import type { z } from 'zod'
import {
  assessPlanCoverageObligations,
  buildCitedPassageProvenance,
  obligationsForQuestion,
  passageSupportsAudienceIntent,
  passageSupportsTechnicalEffect,
} from './planCoverageObligations.js'

type QuestionCoverageStatus = z.infer<typeof QuestionCoverageStatusSchema>

const HOST_COVERAGE_REVIEWER = 'research-v2-bound-question-coverage'
const HOST_COVERAGE_REVIEWER_VERSION = '0.2.0-plan-obligations'

export function buildRevisionProvenanceIndex(
  sources: readonly SourceRecord[],
  revisions: readonly SourceRevision[],
): Map<string, { source: SourceRecord; revision: SourceRevision }> {
  const sourceById = new Map(sources.map((s) => [s.source_id, s]))
  const index = new Map<string, { source: SourceRecord; revision: SourceRevision }>()
  for (const revision of revisions) {
    const source = sourceById.get(revision.source_id)
    if (!source) continue
    index.set(revision.revision_id, { source, revision })
  }
  return index
}

/** Neutral passage signals for model review input (no vendor/topic routing). */
export function citedPassageEvidenceSignals(
  passage: PassageRecord,
  provenance?: { source: SourceRecord; revision: SourceRevision },
) {
  const text = passage.text_ref.mode === 'inline' ? passage.text_ref.text : ''
  const passage_truncated =
    passage.extraction_notes?.some(
      (n) => n.startsWith('inline_text_truncated:') || n.startsWith('excerpt_truncated'),
    ) === true
  const primaryUrl = provenance?.source.observed_urls[0]
  let web_domain: string | undefined
  try {
    web_domain = primaryUrl ? new URL(primaryUrl).hostname : undefined
  } catch {
    web_domain = undefined
  }
  return {
    passage_id: passage.passage_id,
    source_revision_id: passage.source_revision_id,
    coverage_source_slot: provenance?.source.coverage_source_slot,
    web_domain,
    revision_completeness: provenance?.revision.completeness,
    passage_truncated,
    supports_max_age_or_ttl_semantics: passageSupportsTechnicalEffect(text, 'max_age_or_ttl_semantics'),
    supports_audience_intent: passageSupportsAudienceIntent(text),
    mentions_cache_control_header_only:
      /\bcache-control\b/i.test(text) &&
      !passageSupportsTechnicalEffect(text, 'max_age_or_ttl_semantics'),
  }
}

export interface BoundCoverageAssessment {
  satisfiesRequiredFacets: boolean
  missingFacets: string[]
  wrongAspectEvidenceOnly: boolean
}

export function assessBoundQuestionCoverageFromAdmittedEvidence(
  question: QuestionRecord,
  citedProvenance: ReturnType<typeof buildCitedPassageProvenance>,
): BoundCoverageAssessment {
  const obligations = obligationsForQuestion(question)
  if (obligations.length === 0) {
    return {
      satisfiesRequiredFacets: true,
      missingFacets: [],
      wrongAspectEvidenceOnly: false,
    }
  }
  const assessment = assessPlanCoverageObligations(obligations, citedProvenance)
  return {
    satisfiesRequiredFacets: assessment.satisfiesAllObligations,
    missingFacets: assessment.missingObligationIds,
    wrongAspectEvidenceOnly: assessment.wrongAspectOnly,
  }
}

function downgradeCoverageStatus(
  modelStatus: Exclude<QuestionCoverageStatus, 'not_assessed'>,
  assessment: BoundCoverageAssessment,
): QuestionCoverageStatus {
  if (modelStatus !== 'answers') {
    return modelStatus
  }
  if (assessment.satisfiesRequiredFacets) {
    return 'answers'
  }
  if (assessment.wrongAspectEvidenceOnly) {
    return 'tangential'
  }
  return 'partial'
}

/**
 * Host-side bound on model `question_coverage`: never upgrades; downgrades `answers` when cited
 * passages do not satisfy explicit plan `coverage_obligations` per source slot and aspect.
 */
export function enforceBoundQuestionCoverageOnFindings(
  findings: readonly FindingRecord[],
  params: {
    plan: PlanRevision
    passages: readonly PassageRecord[]
    sources: readonly SourceRecord[]
    sourceRevisions: readonly SourceRevision[]
    reviewedAt: string
  },
): FindingRecord[] {
  const questionById = new Map(params.plan.questions.map((q) => [q.question_id, q]))
  const passageById = new Map(params.passages.map((p) => [p.passage_id, p]))
  const provenanceIndex = buildRevisionProvenanceIndex(params.sources, params.sourceRevisions)

  return findings.map((finding) => {
    const question = questionById.get(finding.question_id)
    if (!question) {
      return finding
    }
    const modelCoverage = finding.question_coverage?.status ?? 'not_assessed'
    if (modelCoverage === 'not_assessed') {
      return finding
    }
    const obligations = obligationsForQuestion(question)
    if (obligations.length === 0) {
      return finding
    }
    if (finding.semantic_support?.status !== 'supported') {
      return finding
    }

    const citedProvenance = buildCitedPassageProvenance(
      finding.passage_ids,
      passageById,
      provenanceIndex,
    )
    const assessment = assessBoundQuestionCoverageFromAdmittedEvidence(question, citedProvenance)
    const boundStatus = downgradeCoverageStatus(modelCoverage, assessment)
    if (boundStatus === modelCoverage) {
      return finding
    }

    const missing = assessment.missingFacets.join(',')
    const hostRationale = `Host bound-question coverage: downgraded model "${modelCoverage}" to "${boundStatus}" because admitted citations lack obligation(s): ${missing}.`
    const priorRationale = finding.question_coverage?.rationale ?? ''
    return {
      ...finding,
      question_coverage: {
        status: boundStatus,
        reviewer: HOST_COVERAGE_REVIEWER,
        reviewer_version: HOST_COVERAGE_REVIEWER_VERSION,
        rationale: `${priorRationale} ${hostRationale}`.trim(),
        reviewed_at: params.reviewedAt,
      },
      revised_at: params.reviewedAt,
    }
  })
}
