/**
 * Shared evaluation claim types for canary, episode projection, and promotion.
 */

export const EVIDENCE_SCOPES = [
  'DETERMINISTIC_UNIT',
  'FIXTURE_REPLAY',
  'MOCK_ORCHESTRATION',
  'LIVE_SMOKE',
  'LIVE_MODEL_CANARY',
  'LIVE_MODEL_CAUSAL',
  'EXTERNAL_BENCHMARK',
  'SEALED_HOLDOUT',
] as const
export type EvidenceScope = (typeof EVIDENCE_SCOPES)[number]

export const SNAPSHOT_PIN_STRENGTHS = [
  'immutable',
  'provider_versioned',
  'mutable_alias',
  'unknown',
] as const
export type SnapshotPinStrength = (typeof SNAPSHOT_PIN_STRENGTHS)[number]

export interface ModelControl {
  requested_model: string
  resolved_model_if_reported: string | null
  provider: string
  request_id: string | null
  timestamp: string
  snapshot_pin_strength: SnapshotPinStrength
}

export const STREAM_COMPLETENESS = ['complete', 'partial', 'missing', 'present'] as const
export type StreamCompleteness = (typeof STREAM_COMPLETENESS)[number]

export interface EvidenceCompleteness {
  session_events: StreamCompleteness
  episode_events: StreamCompleteness
  verifier_receipt: StreamCompleteness
  hidden_grade: StreamCompleteness
}

export type DiagnosisConfidence = 'full' | 'partial' | 'none'

export const LIVE_SUCCESS_SCOPES: ReadonlySet<EvidenceScope> = new Set([
  'LIVE_MODEL_CANARY',
  'LIVE_MODEL_CAUSAL',
  'SEALED_HOLDOUT',
])

/** Live coding-success aggregations may only include these scopes. */
export function isLiveSuccessScope(scope: EvidenceScope): boolean {
  return LIVE_SUCCESS_SCOPES.has(scope)
}
