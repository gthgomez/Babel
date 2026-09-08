import type { AstraComparisonPacket, ControlledRun, PairValidity } from './contracts.js';
import { LAB_PROVIDER } from './contracts.js';
import { metricDelta, validateNeutralReceipt } from './receipt.js';
import type { OpenCodeGoModel } from './models.js';

export function validateControlledPair(claude: ControlledRun, babel: ControlledRun): PairValidity {
  // Legacy receipt shape checks cannot establish a fair harness comparison.
  // Use comparison-runner.ts for a frozen v2 contract and independent evaluator.
  const reasons: string[] = ['missing_v2_capability_and_verifier_contract'];
  if (claude.fixtureSha !== babel.fixtureSha) reasons.push('fixture_sha_mismatch');
  if (claude.exactModel !== babel.exactModel) reasons.push('model_mismatch');
  if (claude.receipt.PROVIDER !== LAB_PROVIDER || babel.receipt.PROVIDER !== LAB_PROVIDER) reasons.push('provider_mismatch');
  if (claude.receipt.HARNESS !== 'claude-code' || babel.receipt.HARNESS !== 'babel-live') reasons.push('harness_mismatch');
  if (claude.receipt.REQUESTED_MODEL !== claude.exactModel || babel.receipt.REQUESTED_MODEL !== babel.exactModel) reasons.push('requested_model_not_pinned');
  if (claude.receipt.OBSERVED_MODEL !== claude.exactModel) reasons.push('claude_observed_model_not_verified');
  if (babel.receipt.OBSERVED_MODEL !== babel.exactModel) reasons.push('babel_observed_model_not_verified');
  if (claude.receipt.FALLBACK_USED !== false || babel.receipt.FALLBACK_USED !== false) reasons.push('fallback_not_proven_absent');
  if (claude.verifier.deterministic !== true || babel.verifier.deterministic !== true) reasons.push('verifier_not_deterministic');
  if (claude.rawTrajectory.length === 0 || babel.rawTrajectory.length === 0) reasons.push('raw_trajectory_missing');
  if (claude.normalizedTrajectory.length === 0 || babel.normalizedTrajectory.length === 0) reasons.push('normalized_trajectory_missing');
  try { validateNeutralReceipt(claude.receipt); validateNeutralReceipt(babel.receipt); } catch { reasons.push('receipt_invalid'); }
  return reasons.length === 0
    ? { valid: true, code: 'VALID', reasons: [] }
    : { valid: false, code: reasons.includes('fixture_sha_mismatch') || reasons.includes('model_mismatch') ? 'INVALID_CONTROLLED_PAIR' : 'PAIR_INVALID', reasons };
}

export function buildAstraComparisonPacket(task: string, model: OpenCodeGoModel, claude: ControlledRun, babel: ControlledRun): AstraComparisonPacket {
  const pairValidity = validateControlledPair(claude, babel);
  return {
    task,
    fixtureSha: claude.fixtureSha,
    model,
    provider: LAB_PROVIDER,
    claude,
    babel,
    pairedMetricDeltas: {
      wallTime: metricDelta(claude.receipt.WALL_TIME, babel.receipt.WALL_TIME),
      processCount: metricDelta(claude.receipt.PROCESS_COUNT, babel.receipt.PROCESS_COUNT),
      peakWorkingSet: metricDelta(claude.receipt.PEAK_WORKING_SET, babel.receipt.PEAK_WORKING_SET),
      cpuTime: metricDelta(claude.receipt.CPU_TIME, babel.receipt.CPU_TIME),
      inputTokens: metricDelta(claude.receipt.INPUT_TOKENS, babel.receipt.INPUT_TOKENS),
      outputTokens: metricDelta(claude.receipt.OUTPUT_TOKENS, babel.receipt.OUTPUT_TOKENS),
      toolCalls: metricDelta(claude.receipt.TOOL_CALLS, babel.receipt.TOOL_CALLS),
    },
    pairValidity,
  };
}
