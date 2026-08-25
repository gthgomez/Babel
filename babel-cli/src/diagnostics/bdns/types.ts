/** Stable BDNS observation, evidence, and diagnostic contracts. */

export const BDNS_SCHEMA_VERSION = 1 as const

export type BdnsEvidenceState =
  | 'complete'
  | 'partial'
  | 'truncated'
  | 'events_dropped'
  | 'observer_failed'
  | 'source_unavailable'

export type BdnsSource =
  | 'canonical'
  | 'process'
  | 'workspace'
  | 'watcher'
  | 'terminal'
  | 'otel'
  | 'persistence'
  | 'observer'

export type BdnsObservationKind =
  | 'canonical_event'
  | 'process_requested'
  | 'process_started'
  | 'process_exited'
  | 'process_failed_to_start'
  | 'process_cancel_requested'
  | 'process_killed'
  | 'process_timeout'
  | 'workspace_declared'
  | 'workspace_receipt'
  | 'workspace_watcher_signal'
  | 'workspace_reconciled'
  | 'observer_degraded'
  | 'diagnostic_recorded'

export interface BdnsCorrelation {
  sessionId?: string
  turnId?: string
  toolCallId?: string
  canonicalEventId?: string
  processExecutionId?: string
  workspaceTransactionId?: string
  traceId?: string
  spanId?: string
}

export interface BdnsObservation<TPayload = unknown> {
  schemaVersion: typeof BDNS_SCHEMA_VERSION
  observerSequence: number
  source: BdnsSource
  kind: BdnsObservationKind
  correlation: BdnsCorrelation
  wallTime: string
  monotonicTimeMs: number
  evidenceState: BdnsEvidenceState
  payload: TPayload
}

export type BdnsIncidentCategory =
  | 'PROCESS_OUTCOME_MISMATCH'
  | 'UNDECLARED_WORKSPACE_MUTATION'
  | 'MISSING_EXPECTED_MUTATION'
  | 'OBSERVER_DATA_LOSS'
  | 'EVENT_SEQUENCE_ANOMALY'
  | 'PERSISTENCE_DEGRADED'
  | 'TOOL_LIFECYCLE_INCOMPLETE'
  | 'TERMINAL_OUTPUT_ANOMALY'

export type BdnsConfidence = 'unknown' | 'low' | 'medium' | 'high'

export interface BdnsFact {
  source: BdnsSource
  statement: string
  observationSequence?: number
  evidenceRefs: string[]
}

export interface BdnsIncident {
  schemaVersion: typeof BDNS_SCHEMA_VERSION
  incidentId: string
  category: BdnsIncidentCategory
  correlation: BdnsCorrelation
  facts: BdnsFact[]
  inferences: string[]
  hypotheses: string[]
  confidence: BdnsConfidence
  evidenceState: BdnsEvidenceState
  createdAt: string
}

export interface BdnsHealth {
  evidenceState: BdnsEvidenceState
  published: number
  delivered: number
  dropped: number
  coalesced: number
  subscriberFailures: number
  lastError?: string
}
