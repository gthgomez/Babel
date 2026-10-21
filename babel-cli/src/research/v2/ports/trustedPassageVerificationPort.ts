import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRevision } from '../contracts/sources.js'
import type { TrustedPassageVerificationOutcome } from '../contracts/trustedPassageVerification.js'

export interface TrustedPassageVerificationRequest {
  operation_id: string
  attempt_id: string
  passage: PassageRecord
  source_revision: SourceRevision
  admitted_payload: Buffer
  signal: AbortSignal
}

/**
 * Agent A production implementation: cryptographically verifies passage text/hash/locator/source
 * against admitted whole-source bytes. B callers must not reimplement verification logic.
 */
export interface TrustedPassageVerificationPort {
  verifyPassage(request: TrustedPassageVerificationRequest): Promise<TrustedPassageVerificationOutcome>
}
