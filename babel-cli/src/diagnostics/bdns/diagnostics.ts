/** Cross-plane BDNS correlation and bounded incident projection. */

import { randomUUID } from 'node:crypto'
import {
  projectCanonicalEventMetadata,
  toEvidenceCandidateFromIncident,
  toEvidenceCandidateFromObservation,
  type BdnsEvidenceCandidate,
  type CanonicalEventMetadata,
} from './evidenceCandidate.js'
import { toSafeBdnsValue } from './serialization.js'
import type { BdnsCorrelation, BdnsFact, BdnsHealth, BdnsIncident, BdnsObservation } from './types.js'
import type { BdnsIncidentCategory, BdnsEvidenceState } from './types.js'

const MAX_OBSERVATIONS = 2_048
const MAX_INCIDENTS = 128
const MAX_CANDIDATES = 512
const MAX_PAIRINGS = 256

export interface BdnsDiagnosticSummary {
  schemaVersion: 1
  observations: number
  incidents: number
  evidenceCandidates: BdnsEvidenceCandidate[]
  evidenceState: BdnsEvidenceState
  facts: BdnsFact[]
  hypotheses: string[]
  contradictions: number
  dropped: number
  truncated: number
}

export interface ProcessOutcomeReconciliationInput {
  correlation: BdnsCorrelation
  canonicalOutcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  processExitCode: number | null
  processEvidenceState?: BdnsEvidenceState
  processObservationSequence?: number
  processEvidenceRef?: string
}

/**
 * Keep facts and interpretation separate while correlating independent
 * observation planes. This class has no execution or mutation authority.
 */
export class BdnsDiagnostics {
  private readonly observations: BdnsObservation[] = []
  private readonly incidents: BdnsIncident[] = []
  private readonly facts: BdnsFact[] = []
  private readonly hypotheses: string[] = []
  private readonly candidates: BdnsEvidenceCandidate[] = []
  private readonly processByToolCall = new Map<string, { exitCode: number | null; evidenceState: BdnsEvidenceState; sequence?: number }>()
  private readonly canonicalByToolCall = new Map<string, { outcome: ProcessOutcomeReconciliationInput['canonicalOutcome'] }>()
  private readonly reconciledToolCalls = new Set<string>()
  private dropped = 0
  private truncated = 0

  /**
   * Attach one observation as a fact/candidate without making it semantic truth.
   *
   * @param observation Bounded observation envelope
   * @returns Incident created by cross-plane pairing, if any
   */
  recordObservation<T>(observation: BdnsObservation<T>): BdnsIncident | null {
    const payload = observation.source === 'canonical'
      ? projectCanonicalEventMetadata(observation.payload)
      : toSafeBdnsValue(observation.payload)
    const safe = { ...observation, payload }
    this.observations.push(safe)
    if (this.observations.length > MAX_OBSERVATIONS) {
      this.observations.shift()
      this.dropped += 1
    }
    if (observation.evidenceState === 'truncated') this.truncated += 1
    this.facts.push({
      source: observation.source,
      statement: `${observation.kind} was observed`,
      observationSequence: observation.observerSequence,
      evidenceRefs: [`observation:${observation.observerSequence}`],
    })
    if (this.facts.length > MAX_OBSERVATIONS) this.facts.shift()
    this.pushCandidate(toEvidenceCandidateFromObservation(safe))
    return this.maybeReconcileProcessOutcome(safe)
  }

  /** Reconcile canonical and process outcomes without overwriting either. */
  reconcileProcessOutcome(input: ProcessOutcomeReconciliationInput): BdnsIncident | null {
    const processEvidenceState = input.processEvidenceState ?? 'complete'
    const processSucceeded = input.processExitCode === 0
    const canonicalSucceeded = input.canonicalOutcome === 'succeeded'
    const known = input.canonicalOutcome !== 'unknown' && input.processExitCode !== null
    if (!known || processSucceeded === canonicalSucceeded) return null
    return this.addIncident({
      category: 'PROCESS_OUTCOME_MISMATCH',
      correlation: input.correlation,
      facts: [
        {
          source: 'canonical',
          statement: `canonical outcome was ${input.canonicalOutcome}`,
          evidenceRefs: ['canonical:tool-outcome'],
        },
        {
          source: 'process',
          statement: `correlated process exited with code ${String(input.processExitCode)}`,
          ...(input.processObservationSequence === undefined ? {} : { observationSequence: input.processObservationSequence }),
          evidenceRefs: [input.processEvidenceRef ?? 'process:exit'],
        },
      ],
      inferences: ['The independent process witness disagrees with the canonical tool outcome.'],
      hypotheses: [
        'The canonical tool result may have been promoted after an unsuccessful subprocess.',
      ],
      confidence: processEvidenceState === 'complete' ? 'high' : 'medium',
      evidenceState: processEvidenceState,
    })
  }

  /** Project workspace reconciliation findings into bounded incidents. */
  reconcileWorkspace(input: {
    correlation: BdnsCorrelation
    unexpectedChangedPaths: readonly string[]
    missingExpectedPaths: readonly string[]
    evidenceState: BdnsEvidenceState
    evidenceRefs?: readonly string[]
  }): BdnsIncident | null {
    const category: BdnsIncidentCategory | null = input.unexpectedChangedPaths.length > 0
      ? 'UNDECLARED_WORKSPACE_MUTATION'
      : input.missingExpectedPaths.length > 0
        ? 'MISSING_EXPECTED_MUTATION'
        : null
    if (!category) return null
    const paths = input.unexpectedChangedPaths.length > 0 ? input.unexpectedChangedPaths : input.missingExpectedPaths
    return this.addIncident({
      category,
      correlation: input.correlation,
      facts: [{
        source: 'workspace',
        statement: `${category === 'UNDECLARED_WORKSPACE_MUTATION' ? 'unexpected' : 'expected'} paths: ${paths.join(', ')}`,
        evidenceRefs: [...(input.evidenceRefs ?? ['workspace:reconciliation'])],
      }],
      inferences: ['Targeted workspace evidence disagrees with declared mutation intent.'],
      hypotheses: [],
      confidence: input.evidenceState === 'complete' ? 'high' : 'medium',
      evidenceState: input.evidenceState,
    })
  }

  /** Record explicit observer degradation without recursive publication. */
  recordHealth(health: BdnsHealth, correlation: BdnsCorrelation = {}): BdnsIncident | null {
    this.dropped += health.dropped
    if (health.evidenceState === 'complete') return null
    return this.addIncident({
      category: 'OBSERVER_DATA_LOSS',
      correlation,
      facts: [{
        source: 'observer',
        statement: `observer health is ${health.evidenceState}; dropped=${health.dropped}; coalesced=${health.coalesced}; subscriberFailures=${health.subscriberFailures}`,
        evidenceRefs: ['observer:health'],
      }],
      inferences: ['Some diagnostic evidence is incomplete.'],
      hypotheses: [],
      confidence: 'high',
      evidenceState: health.evidenceState,
    })
  }

  /** Record persistence-store degradation separately from observer failure. */
  recordPersistenceDegraded(correlation: BdnsCorrelation = {}, detail?: string): BdnsIncident | null {
    return this.addIncident({
      category: 'PERSISTENCE_DEGRADED',
      correlation,
      facts: [{
        source: 'persistence',
        statement: detail ?? 'diagnostic store reported persistence_degraded',
        evidenceRefs: ['persistence:health'],
      }],
      inferences: ['Durable diagnostic evidence may be incomplete.'],
      hypotheses: [],
      confidence: 'high',
      evidenceState: 'partial',
    })
  }

  /** Return a bounded, machine-readable diagnostic summary. */
  summary(): BdnsDiagnosticSummary {
    const evidenceState: BdnsEvidenceState = this.incidents.some((incident) => incident.evidenceState === 'observer_failed')
      ? 'observer_failed'
      : this.dropped > 0 || this.truncated > 0 || this.incidents.some((incident) => incident.evidenceState !== 'complete')
        ? 'partial'
        : 'complete'
    return {
      schemaVersion: 1,
      observations: this.observations.length,
      incidents: this.incidents.length,
      evidenceCandidates: this.candidates.slice(-64),
      evidenceState,
      facts: this.facts.slice(-64),
      hypotheses: this.hypotheses.slice(-32),
      contradictions: this.incidents.filter((incident) => incident.category === 'PROCESS_OUTCOME_MISMATCH').length,
      dropped: this.dropped,
      truncated: this.truncated,
    }
  }

  listIncidents(): BdnsIncident[] {
    return this.incidents.map((incident) => ({
      ...incident,
      facts: incident.facts.map((fact) => ({ ...fact, evidenceRefs: [...fact.evidenceRefs] })),
      inferences: [...incident.inferences],
      hypotheses: [...incident.hypotheses],
    }))
  }

  private addIncident(input: Omit<BdnsIncident, 'schemaVersion' | 'incidentId' | 'createdAt'>): BdnsIncident {
    const incident: BdnsIncident = {
      schemaVersion: 1,
      incidentId: `inc-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      ...input,
    }
    this.incidents.push(incident)
    if (this.incidents.length > MAX_INCIDENTS) this.incidents.shift()
    this.hypotheses.push(...incident.hypotheses)
    this.pushCandidate(toEvidenceCandidateFromIncident(incident))
    return incident
  }

  private pushCandidate(candidate: BdnsEvidenceCandidate): void {
    this.candidates.push(candidate)
    if (this.candidates.length > MAX_CANDIDATES) this.candidates.shift()
  }

  private maybeReconcileProcessOutcome(observation: BdnsObservation): BdnsIncident | null {
    const toolCallId = observation.correlation.toolCallId
      ?? (isCanonicalMetadata(observation.payload) ? observation.payload.toolCallId : undefined)
    if (!toolCallId) return null
    this.rememberProcessFact(observation, toolCallId)
    this.rememberCanonicalFact(observation, toolCallId)
    if (this.reconciledToolCalls.has(toolCallId)) return null
    const processFact = this.processByToolCall.get(toolCallId)
    const canonicalFact = this.canonicalByToolCall.get(toolCallId)
    if (!processFact || !canonicalFact) return null
    this.reconciledToolCalls.add(toolCallId)
    return this.reconcileProcessOutcome({
      correlation: { ...observation.correlation, toolCallId },
      canonicalOutcome: canonicalFact.outcome,
      processExitCode: processFact.exitCode,
      processEvidenceState: processFact.evidenceState,
      ...(processFact.sequence === undefined ? {} : { processObservationSequence: processFact.sequence }),
      processEvidenceRef: `observation:${String(processFact.sequence ?? observation.observerSequence)}`,
    })
  }

  private rememberProcessFact(observation: BdnsObservation, toolCallId: string): void {
    if (observation.source !== 'process') return
    const payload = observation.payload && typeof observation.payload === 'object'
      ? observation.payload as { exitCode?: number | null }
      : {}
    const exitCode = observation.kind === 'process_failed_to_start'
      ? 1
      : observation.kind === 'process_timeout' || observation.kind === 'process_killed'
        ? 1
        : observation.kind === 'process_exited'
          ? (payload.exitCode ?? null)
          : undefined
    if (exitCode === undefined) return
    this.processByToolCall.set(toolCallId, {
      exitCode,
      evidenceState: observation.evidenceState,
      sequence: observation.observerSequence,
    })
    trimMap(this.processByToolCall, MAX_PAIRINGS)
  }

  private rememberCanonicalFact(observation: BdnsObservation, toolCallId: string): void {
    if (observation.source !== 'canonical') return
    const metadata = isCanonicalMetadata(observation.payload)
      ? observation.payload
      : projectCanonicalEventMetadata(observation.payload)
    if (!metadata.canonicalOutcome) return
    this.canonicalByToolCall.set(toolCallId, { outcome: metadata.canonicalOutcome })
    trimMap(this.canonicalByToolCall, MAX_PAIRINGS)
  }
}

function isCanonicalMetadata(value: unknown): value is CanonicalEventMetadata {
  return Boolean(value && typeof value === 'object' && typeof (value as CanonicalEventMetadata).kind === 'string')
}

function trimMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const first = map.keys().next().value
    if (first === undefined) return
    map.delete(first)
  }
}
