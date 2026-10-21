import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import {
  buildRevisionProvenanceIndex,
  citedPassageEvidenceSignals,
} from './boundQuestionCoverageFromEvidence.js'
import { obligationsForQuestion } from './planCoverageObligations.js'

export type CitedPassageContent =
  | { passage_id: string; content_status: 'available'; text: string }
  | { passage_id: string; content_status: 'unavailable'; reason: string }

export interface SemanticSupportReviewCoverageRubric {
  coverage_obligations: ReturnType<typeof obligationsForQuestion>
  guidance: string
}

export function coverageRubricForQuestion(question: {
  text: string
  evidence_requirement: string
  coverage_obligations?: import('../contracts/plan.js').QuestionRecord['coverage_obligations']
}): SemanticSupportReviewCoverageRubric {
  const obligations = obligationsForQuestion(question as import('../contracts/plan.js').QuestionRecord)
  let guidance =
    'question_coverage answers requires the assertion to address the bound question_text using cited passages; tangential supported facts do not count as answers.'
  if (obligations.length > 0) {
    guidance +=
      ' When coverage_obligations are present, emit obligation_coverage per obligation_id with status met|unmet|wrong_aspect and supporting_passage_ids from this finding. Ground judgments in cited passage text; host validates slot/passage identity and completeness (not topic keywords). Comparative coverage requires every obligation met for question_coverage answers.'
  } else {
    guidance += ` Plan evidence_requirement (human): ${question.evidence_requirement}`
  }
  return {
    coverage_obligations: obligations,
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
  const questionById = new Map(plan.questions.map((q) => [q.question_id, q]))
  const provenanceIndex =
    options?.sources && options?.sourceRevisions
      ? buildRevisionProvenanceIndex(options.sources, options.sourceRevisions)
      : new Map()

  return {
    findings: findings.map((finding) => {
      const question = questionById.get(finding.question_id)
      if (!question) {
        throw new Error(`finding ${finding.finding_id} references unknown plan question ${finding.question_id}`)
      }
      return {
        finding_id: finding.finding_id,
        question_id: finding.question_id,
        question_text: question.text,
        assertion_text: finding.assertion_text,
        coverage_rubric: coverageRubricForQuestion(question),
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
