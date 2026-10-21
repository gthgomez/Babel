import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import {
  buildRevisionProvenanceIndex,
  citedPassageEvidenceSignals,
  inferQuestionCoverageProfile,
  type QuestionCoverageAspect,
} from './boundQuestionCoverageFromEvidence.js'

export type CitedPassageContent =
  | { passage_id: string; content_status: 'available'; text: string }
  | { passage_id: string; content_status: 'unavailable'; reason: string }

export interface SemanticSupportReviewCoverageRubric {
  question_aspect: QuestionCoverageAspect
  cross_source_comparison: boolean
  required_source_classes: Array<'mdn' | 'cloudflare' | 'other'>
  guidance: string
}

export function coverageRubricForQuestion(
  questionText: string,
  evidenceRequirement?: string,
): SemanticSupportReviewCoverageRubric {
  const profile = inferQuestionCoverageProfile(questionText, evidenceRequirement)
  let guidance =
    'question_coverage answers requires the assertion to address the bound question_text using cited passages; tangential supported facts do not count as answers.'
  if (profile.crossSourceComparison && profile.aspect === 'cache_control_max_age') {
    guidance +=
      ' For cross-source max-age/cache-control comparisons, each compared source class (MDN vs Cloudflare) needs its own relevant admitted excerpt mentioning max-age/Cache-Control/TTL — a truncated overview without that content is partial, not answers.'
  }
  if (profile.aspect === 'audience_browser_vs_edge') {
    guidance +=
      ' Audience/intent questions are not answered by cache-directive semantics alone: distinguish who each document is written for (browser vs edge/CDN) from which directives apply; supported cache-only excerpts are tangential or partial.'
  }
  return {
    question_aspect: profile.aspect,
    cross_source_comparison: profile.crossSourceComparison,
    required_source_classes: profile.requiredSourceClasses,
    guidance,
  }
}

export function buildSemanticSupportReviewInput(
  findings: readonly FindingRecord[],
  passages: readonly PassageRecord[],
  plan: PlanRevision,
  options?: {
    sources?: readonly SourceRecord[]
    sourceRevisions?: readonly SourceRevision[]
  },
): {
  findings: Array<{
    finding_id: string
    question_id: string
    question_text: string
    assertion_text: string
    coverage_rubric: SemanticSupportReviewCoverageRubric
    cited_passages: Array<
      CitedPassageContent & {
        evidence_signals?: ReturnType<typeof citedPassageEvidenceSignals>
      }
    >
  }>
} {
  const passageById = new Map(passages.map((p) => [p.passage_id, p]))
  const questionTextById = new Map(plan.questions.map((q) => [q.question_id, q.text]))
  const questionRequirementById = new Map(
    plan.questions.map((q) => [q.question_id, q.evidence_requirement]),
  )
  const provenanceIndex =
    options?.sources && options?.sourceRevisions
      ? buildRevisionProvenanceIndex(options.sources, options.sourceRevisions)
      : new Map()

  return {
    findings: findings.map((finding) => {
      const questionText = questionTextById.get(finding.question_id)
      if (!questionText) {
        throw new Error(`finding ${finding.finding_id} references unknown plan question ${finding.question_id}`)
      }
      const evidenceRequirement = questionRequirementById.get(finding.question_id)
      return {
        finding_id: finding.finding_id,
        question_id: finding.question_id,
        question_text: questionText,
        assertion_text: finding.assertion_text,
        coverage_rubric: coverageRubricForQuestion(questionText, evidenceRequirement),
        cited_passages: finding.passage_ids.map((passageId) => {
          const passage = passageById.get(passageId)
          if (!passage) {
            return {
              passage_id: passageId,
              content_status: 'unavailable',
              reason: 'passage not present in admitted store',
            }
          }
          if (passage.text_ref.mode !== 'inline') {
            return {
              passage_id: passageId,
              content_status: 'unavailable',
              reason: `passage text_ref mode ${passage.text_ref.mode} is not inline for semantic review`,
            }
          }
          const provenance = provenanceIndex.get(passage.source_revision_id)
          return {
            passage_id: passageId,
            content_status: 'available',
            text: passage.text_ref.text,
            evidence_signals: citedPassageEvidenceSignals(passage, provenance),
          }
        }),
      }
    }),
  }
}
