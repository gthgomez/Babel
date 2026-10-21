import type { FindingRecord } from '../contracts/findings.js'
import type { TrustedPassageVerificationOutcome } from '../contracts/trustedPassageVerification.js'

/**
 * Maps trusted verifier outcomes to durable finding integrity + limitation lines (B binding only).
 */
export function applyTrustedPassageVerificationToFinding(
  finding: FindingRecord,
  outcome: TrustedPassageVerificationOutcome,
): { finding: FindingRecord; limitations: string[] } {
  const limitations: string[] = []
  const tag = `trusted_passage_verification:${outcome.passage_id}:${outcome.status}`
  limitations.push(tag)
  if (outcome.detail) {
    limitations.push(`${tag}:detail:${outcome.detail.slice(0, 120)}`)
  }

  let source_integrity: FindingRecord['source_integrity'] = finding.source_integrity
  if (outcome.status === 'verified_whole_source_complete') {
    source_integrity = 'valid'
  } else if (outcome.status === 'legacy_not_checked') {
    source_integrity = 'not_checked'
  } else if (
    outcome.status === 'mismatch_text' ||
    outcome.status === 'mismatch_hash' ||
    outcome.status === 'mismatch_locator' ||
    outcome.status === 'mismatch_source' ||
    outcome.status === 'mismatch_attempt'
  ) {
    source_integrity = 'invalid'
  } else if (outcome.status === 'truncated_partial') {
    source_integrity = 'not_checked'
    limitations.push(`trusted_passage_verification_partial:${outcome.passage_id}`)
  }

  return {
    finding: { ...finding, source_integrity },
    limitations,
  }
}
