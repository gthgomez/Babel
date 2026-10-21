import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'

export type CitedPassageContent =
  | { passage_id: string; content_status: 'available'; text: string }
  | { passage_id: string; content_status: 'unavailable'; reason: string }

export function buildSemanticSupportReviewInput(
  findings: readonly FindingRecord[],
  passages: readonly PassageRecord[],
): {
  findings: Array<{
    finding_id: string
    assertion_text: string
    cited_passages: CitedPassageContent[]
  }>
} {
  const passageById = new Map(passages.map((p) => [p.passage_id, p]))
  return {
    findings: findings.map((finding) => ({
      finding_id: finding.finding_id,
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
    })),
  }
}
