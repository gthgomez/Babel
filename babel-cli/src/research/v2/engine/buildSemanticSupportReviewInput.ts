import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'

export type CitedPassageContent =
  | { passage_id: string; content_status: 'available'; text: string }
  | { passage_id: string; content_status: 'unavailable'; reason: string }

export function buildSemanticSupportReviewInput(
  findings: readonly FindingRecord[],
  passages: readonly PassageRecord[],
  plan: PlanRevision,
): {
  findings: Array<{
    finding_id: string
    question_id: string
    question_text: string
    assertion_text: string
    cited_passages: CitedPassageContent[]
  }>
} {
  const passageById = new Map(passages.map((p) => [p.passage_id, p]))
  const questionTextById = new Map(plan.questions.map((q) => [q.question_id, q.text]))
  return {
    findings: findings.map((finding) => {
      const questionText = questionTextById.get(finding.question_id)
      if (!questionText) {
        throw new Error(`finding ${finding.finding_id} references unknown plan question ${finding.question_id}`)
      }
      return {
        finding_id: finding.finding_id,
        question_id: finding.question_id,
        question_text: questionText,
        assertion_text: finding.assertion_text,
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
          return {
            passage_id: passageId,
            content_status: 'available',
            text: passage.text_ref.text,
          }
        }),
      }
    }),
  }
}
