// ─── Trusted review authority construction — TRUSTED SERVICE ONLY ────────────
//
// This module constructs production signing authority (it accepts private key
// material). It must NEVER be imported by builder-facing code: builders request
// review, receive verdicts/attestations/receipts, and ask the base-rooted
// verifier for status — they do not hold keys or instantiate authorities.
//
// Enforcement: `src/services/reviewCustody.test.ts` fails if any builder-facing
// module imports this file or references the authority-construction symbols.
// Run this module only inside a trusted service process (see
// `.agents/rules/10-independent-review-policy.md`).

import { createIndependentReviewAuthorityV1 } from '../evidence/independentReview.js';
import type { TrustedReviewAuthority } from './trustedReviewIssuer.js';

/** Create a file-backed supervisor authority. Trusted service process only. */
export function createFileBackedTrustedReviewAuthority(input: Parameters<typeof createIndependentReviewAuthorityV1>[0]): TrustedReviewAuthority {
  return createIndependentReviewAuthorityV1(input);
}
