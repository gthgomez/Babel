/**
 * confidenceGate.ts — Stage 1 Routing Confidence Gate
 *
 * Helpers for the three-band routing confidence policy.
 *
 * Bands (thresholds configurable via env vars):
 *   high   >= HIGH_THRESHOLD  (default 0.80) — accept as-is
 *   medium  [MED_THRESHOLD, HIGH_THRESHOLD)  — downgrade pipeline_mode direct → verified
 *   low    <  MED_THRESHOLD  (default 0.60)  — run validator pass; proceed with warning if still low
 *
 * Gate is enabled via BABEL_ROUTING_CONFIDENCE_ENABLE=true.
 * When disabled, the pipeline logs a passive warning for confidence < HIGH_THRESHOLD.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfidenceBand  = 'high' | 'medium' | 'low';
export type RoutingAction   = 'accepted' | 'downgraded' | 'validated' | 'validator_still_low';

// ─── Threshold helpers ────────────────────────────────────────────────────────

function readEnvFloat(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function readEnvInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Returns true when BABEL_ROUTING_CONFIDENCE_ENABLE=true. */
export function isConfidenceGateEnabled(): boolean {
  return process.env['BABEL_ROUTING_CONFIDENCE_ENABLE'] === 'true';
}

/** High-band threshold (default 0.80). Read at call time so tests can patch env. */
export function getHighThreshold(): number {
  return readEnvFloat('BABEL_ROUTING_CONFIDENCE_HIGH', 0.80);
}

/** Medium-band lower bound (default 0.60). Read at call time so tests can patch env. */
export function getMediumThreshold(): number {
  return readEnvFloat('BABEL_ROUTING_CONFIDENCE_MEDIUM', 0.60);
}

/**
 * Validator tier index (0-based). Controls which tier the bounded validator
 * pass starts at. Default: 1 (skip tier 0, start at tier 1).
 */
export function getValidatorTierIndex(): number {
  return readEnvInt('BABEL_ROUTING_CONFIDENCE_VALIDATOR_TIER_INDEX', 1);
}

// ─── Band classification ──────────────────────────────────────────────────────

/**
 * Classifies a confidence score into one of three bands.
 *
 * Uses thresholds from env vars at call time, so tests can override them.
 */
export function getRoutingConfidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= getHighThreshold()) return 'high';
  if (confidence >= getMediumThreshold()) return 'medium';
  return 'low';
}
