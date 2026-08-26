/** Forward-compatible evidence candidates. These never encode acceptance verdicts. */

import type {
  BdnsCorrelation,
  BdnsEvidenceState,
  BdnsIncident,
  BdnsObservation,
  BdnsObservationKind,
  BdnsSource,
} from './types.js'

export const BDNS_EVIDENCE_CANDIDATE_VERSION = 1 as const

/** Fields BDNS must never emit; acceptance semantics belong to a later campaign. */
export const BDNS_FORBIDDEN_ACCEPTANCE_FIELDS = [
  'claimSatisfied',
  'acceptanceVerdict',
  'requirementMet',
  'requirementId',
  'claimId',
] as const

export type BdnsProducerRole = 'canonical' | 'observer' | 'verifier' | 'implementor'

export type BdnsEvidenceCandidateKind =
  | 'process_fact'
  | 'workspace_fact'
  | 'runtime_fact'
  | 'terminal_fact'
  | 'diagnostic_incident'

export type BdnsPatchVisibility = 'none' | 'candidate_visible' | 'unknown'

export type BdnsImplementationOrigin =
  | 'pre_implementation'
  | 'during_implementation'
  | 'post_implementation'
  | 'unknown'

export type BdnsSemanticAuthority = 'none' | 'diagnostic_only' | 'verifier' | 'acceptance'

export type BdnsEvidenceHealth =
  | 'complete'
  | 'partial'
  | 'truncated'
  | 'dropped'
  | 'source_unavailable'

export interface CanonicalEventMetadata {
  kind: string
  eventId?: string
  seq?: number
  toolCallId?: string
  toolName?: string
  canonicalOutcome?: 'succeeded' | 'failed' | 'cancelled'
  exitCode?: number
}

export interface BdnsEvidenceCandidate {
  schemaVersion: typeof BDNS_EVIDENCE_CANDIDATE_VERSION
  evidenceId: string
  producer: {
    system: string
    role: BdnsProducerRole
  }
  kind: BdnsEvidenceCandidateKind
  correlation: BdnsCorrelation
  origin: BdnsImplementationOrigin
  patchVisibility: BdnsPatchVisibility
  semanticAuthority: BdnsSemanticAuthority
  independence: {
    implementationIndependent: boolean
    observerIndependent: boolean
  }
  evidenceHealth: BdnsEvidenceHealth
  observationSequence?: number
  payload: unknown
}

const PRODUCER_BY_SOURCE: Record<BdnsSource, { system: string; role: BdnsProducerRole }> = {
  canonical: { system: 'babel.session_events', role: 'canonical' },
  process: { system: 'babel.bdns.process_witness', role: 'observer' },
  workspace: { system: 'babel.bdns.workspace_witness', role: 'observer' },
  watcher: { system: 'babel.bdns.workspace_witness', role: 'observer' },
  terminal: { system: 'babel.tui.observe', role: 'observer' },
  otel: { system: 'babel.otel', role: 'observer' },
  persistence: { system: 'babel.bdns.store', role: 'observer' },
  observer: { system: 'babel.bdns.observer', role: 'observer' },
}

/**
 * Project a canonical session event to metadata-only BDNS payload.
 *
 * @param event Session event or already-projected metadata
 * @returns Bounded canonical metadata without task text or tool output
 */
export function projectCanonicalEventMetadata(event: unknown): CanonicalEventMetadata {
  if (!event || typeof event !== 'object') return { kind: 'unknown' }
  const rec = event as Record<string, unknown>
  if (typeof rec.kind === 'string' && rec.event_id === undefined && rec.eventId !== undefined) {
    return {
      kind: rec.kind,
      ...(typeof rec.eventId === 'string' ? { eventId: rec.eventId } : {}),
      ...(typeof rec.seq === 'number' ? { seq: rec.seq } : {}),
      ...(typeof rec.toolCallId === 'string' ? { toolCallId: rec.toolCallId } : {}),
      ...(typeof rec.toolName === 'string' ? { toolName: rec.toolName } : {}),
      ...(rec.canonicalOutcome === 'succeeded' || rec.canonicalOutcome === 'failed' || rec.canonicalOutcome === 'cancelled'
        ? { canonicalOutcome: rec.canonicalOutcome }
        : {}),
      ...(typeof rec.exitCode === 'number' ? { exitCode: rec.exitCode } : {}),
    }
  }
  const kind = typeof rec.kind === 'string' ? rec.kind : 'unknown'
  const toolCallId = typeof rec.tool_call_id === 'string' ? rec.tool_call_id : undefined
  const canonicalOutcome = kind === 'tool_completed'
    ? 'succeeded'
    : kind === 'tool_failed'
      ? 'failed'
      : kind === 'tool_cancelled'
        ? 'cancelled'
        : undefined
  return {
    kind,
    ...(typeof rec.event_id === 'string' ? { eventId: rec.event_id } : {}),
    ...(typeof rec.seq === 'number' ? { seq: rec.seq } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(typeof rec.tool_name === 'string' ? { toolName: rec.tool_name } : {}),
    ...(canonicalOutcome ? { canonicalOutcome } : {}),
    ...(typeof rec.exit_code === 'number' ? { exitCode: rec.exit_code } : {}),
  }
}

/**
 * Convert one observation into an evidence candidate without acceptance semantics.
 *
 * @param observation Bounded BDNS observation
 * @returns Candidate that later acceptance layers may admit or ignore
 */
export function toEvidenceCandidateFromObservation(
  observation: BdnsObservation,
): BdnsEvidenceCandidate {
  const producer = PRODUCER_BY_SOURCE[observation.source]
  const payload = observation.source === 'canonical'
    ? projectCanonicalEventMetadata(observation.payload)
    : observation.payload
  return omitForbiddenAcceptanceFields({
    schemaVersion: 1,
    evidenceId: `obs:${observation.observerSequence}`,
    producer,
    kind: candidateKindForObservation(observation.kind, observation.source),
    correlation: {
      ...observation.correlation,
      ...(isCanonicalMetadata(payload) && payload.toolCallId
        ? { toolCallId: observation.correlation.toolCallId ?? payload.toolCallId }
        : {}),
    },
    origin: 'during_implementation',
    patchVisibility: patchVisibilityFor(observation.source, observation.kind),
    semanticAuthority: 'diagnostic_only',
    independence: {
      implementationIndependent: false,
      observerIndependent: observation.source !== 'canonical',
    },
    evidenceHealth: toEvidenceHealth(observation.evidenceState),
    observationSequence: observation.observerSequence,
    payload,
  })
}

/**
 * Convert one diagnostic incident into an evidence candidate.
 *
 * @param incident Bounded BDNS incident
 * @returns Candidate with no requirement or acceptance verdict
 */
export function toEvidenceCandidateFromIncident(incident: BdnsIncident): BdnsEvidenceCandidate {
  return omitForbiddenAcceptanceFields({
    schemaVersion: 1,
    evidenceId: `inc:${incident.incidentId}`,
    producer: { system: 'babel.bdns.diagnostics', role: 'observer' },
    kind: 'diagnostic_incident',
    correlation: incident.correlation,
    origin: 'during_implementation',
    patchVisibility: 'candidate_visible',
    semanticAuthority: 'diagnostic_only',
    independence: {
      implementationIndependent: false,
      observerIndependent: true,
    },
    evidenceHealth: toEvidenceHealth(incident.evidenceState),
    payload: {
      category: incident.category,
      facts: incident.facts,
      inferences: incident.inferences,
      hypotheses: incident.hypotheses,
      confidence: incident.confidence,
    },
  })
}

/**
 * True when a value carries forbidden acceptance-semantic fields.
 *
 * @param value Candidate or arbitrary payload
 * @returns Whether any acceptance field is present
 */
export function hasForbiddenAcceptanceFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  if (BDNS_FORBIDDEN_ACCEPTANCE_FIELDS.some((field) => field in rec)) return true
  return Object.values(rec).some((item) => item && typeof item === 'object' && hasForbiddenAcceptanceFields(item))
}

function candidateKindForObservation(
  kind: BdnsObservationKind,
  source: BdnsSource,
): BdnsEvidenceCandidateKind {
  if (source === 'process' || kind.startsWith('process_')) return 'process_fact'
  if (source === 'workspace' || source === 'watcher' || kind.startsWith('workspace_')) return 'workspace_fact'
  if (source === 'terminal') return 'terminal_fact'
  if (kind === 'observer_degraded' || kind === 'diagnostic_recorded') return 'diagnostic_incident'
  return 'runtime_fact'
}

function patchVisibilityFor(source: BdnsSource, kind: BdnsObservationKind): BdnsPatchVisibility {
  if (source === 'otel') return 'unknown'
  if (kind === 'canonical_event' || kind.startsWith('process_') || kind.startsWith('workspace_')) {
    return 'candidate_visible'
  }
  return 'unknown'
}

function toEvidenceHealth(state: BdnsEvidenceState): BdnsEvidenceHealth {
  if (state === 'complete' || state === 'partial' || state === 'truncated' || state === 'source_unavailable') {
    return state
  }
  if (state === 'events_dropped') return 'dropped'
  return 'partial'
}

function isCanonicalMetadata(value: unknown): value is CanonicalEventMetadata {
  return Boolean(value && typeof value === 'object' && typeof (value as CanonicalEventMetadata).kind === 'string')
}

function omitForbiddenAcceptanceFields<T extends BdnsEvidenceCandidate>(candidate: T): T {
  const rec = candidate as T & Record<string, unknown>
  for (const field of BDNS_FORBIDDEN_ACCEPTANCE_FIELDS) {
    if (field in rec) delete rec[field]
  }
  return rec
}
