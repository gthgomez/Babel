/**
 * ScoreReceipt construction binding SearchEpisode candidates to the existing
 * verifier kernel (SEARCH_EPISODES_V0 B1). Correctness is a mechanical
 * property of the bound receipts; promotion remains a controller decision.
 */

import type { VerifierReceiptV2 } from '../agent/verifierKernel.js';
import {
  newScoreReceiptId,
  SEARCH_EPISODE_VERSION,
  validateScoreReceipt,
  validateScoreVector,
  type ScoreReceipt,
  type ScoreVector,
} from './types.js';

export interface BuildScoreReceiptInput {
  candidate_id: string;
  verifier_receipts: VerifierReceiptV2[];
  score_vector: ScoreVector;
  evaluator_profile: string;
  evaluated_at?: string | undefined;
}

/**
 * A candidate counts as correct only when every bound verifier receipt
 * exited cleanly and none timed out. Authoritativeness/freshness policy is
 * left to the promotion controller, not assumed here.
 */
export function buildScoreReceipt(input: BuildScoreReceiptInput): ScoreReceipt {
  if (input.verifier_receipts.length === 0) {
    throw new Error('score receipt requires at least one verifier receipt');
  }
  if (
    input.verifier_receipts.some(
      (vr) => typeof vr.receipt_id !== 'string' || vr.receipt_id.length === 0,
    )
  ) {
    throw new Error('verifier receipts must carry non-empty receipt ids');
  }
  const vectorErrors = validateScoreVector(input.score_vector);
  if (vectorErrors.length > 0) {
    throw new Error(`invalid score vector: ${vectorErrors.join('; ')}`);
  }
  if (input.evaluator_profile.length === 0) {
    throw new Error('score receipt requires a non-empty evaluator_profile');
  }
  const allClean = input.verifier_receipts.every(
    (vr) => vr.exit_code === 0 && !vr.timed_out,
  );
  const receipt: ScoreReceipt = {
    schema_version: SEARCH_EPISODE_VERSION,
    receipt_id: newScoreReceiptId(),
    candidate_id: input.candidate_id,
    verifier_receipt_ids: input.verifier_receipts.map((vr) => vr.receipt_id),
    score_vector: input.score_vector,
    correct: allClean,
    evaluated_at: input.evaluated_at ?? new Date().toISOString(),
    evaluator_profile: input.evaluator_profile,
  };
  const errors = validateScoreReceipt(receipt);
  if (errors.length > 0) {
    throw new Error(`invalid score receipt: ${errors.join('; ')}`);
  }
  return receipt;
}
