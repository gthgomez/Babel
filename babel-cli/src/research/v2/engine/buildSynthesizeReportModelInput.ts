import type { FindingRecord } from '../contracts/findings.js'

export function buildSynthesizeReportModelInput(findings: readonly FindingRecord[]): {
  findings: Array<{
    finding_id: string
    question_id: string
    assertion_text: string
    semantic_support: NonNullable<FindingRecord['semantic_support']>['status'] | 'not_checked'
    question_coverage: NonNullable<FindingRecord['question_coverage']>['status'] | 'not_assessed'
  }>
} {
  return {
    findings: findings.map((finding) => ({
      finding_id: finding.finding_id,
      question_id: finding.question_id,
      assertion_text: finding.assertion_text,
      semantic_support: finding.semantic_support?.status ?? 'not_checked',
      question_coverage: finding.question_coverage?.status ?? 'not_assessed',
    })),
  }
}
