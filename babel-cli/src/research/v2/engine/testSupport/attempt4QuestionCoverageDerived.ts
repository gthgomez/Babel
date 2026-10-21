import type { FindingRecord } from '../../contracts/findings.js'

/**
 * Synthetic post-review overlay for host finalizer tests only — NOT from the live G-L1 attempt4 run.
 * Historical paid-run judgments remain in `general-g-l1-attempt4-evidence-subset.json` unchanged.
 */
const DERIVED_QUESTION_COVERAGE_FINDING_ID = 'finding-d7e08cedb95c3bd486374394'

export function applyAttempt4DerivedQuestionCoverageOverlay(
  findings: readonly FindingRecord[],
): FindingRecord[] {
  return findings.map((finding) => {
    if (finding.finding_id !== DERIVED_QUESTION_COVERAGE_FINDING_ID) {
      return finding
    }
    return {
      ...finding,
      question_coverage: {
        status: 'answers',
        reviewer: 'research-v2-derived-fixture',
        reviewer_version: 'attempt4-question-coverage-overlay/v1',
        rationale:
          'Derived test overlay: models q1 answered for finalizer regression only; not an attempt4 live judgment.',
        reviewed_at: '2026-10-21T10:30:00.000Z',
      },
    }
  })
}
