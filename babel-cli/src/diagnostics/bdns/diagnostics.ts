/** Cross-plane BDNS correlation and bounded incident projection. */

import { randomUUID } from 'node:crypto'
import { toSafeBdnsValue } from './serialization.js'
import type { BdnsCorrelation, BdnsFact, BdnsHealth, BdnsIncident, BdnsObservation } from './types.js'
import type { BdnsIncidentCategory, BdnsEvidenceState } from './types.js'

const MAX_OBSERVATIONS = 2_048
const MAX_INCIDENTS = 128

export interface BdnsDiagnosticSummary {
  schemaVersion: 1
  observations: number
  incidents: number
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
  private dropped = 0
  private truncated = 0

  /** Attach one generic observation without making it semantic truth. */
  recordObservation<T>(observation: BdnsObservation<T>): void {
    const safe = { ...observation, payload: toSafeBdnsValue(observation.payload) }
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
      category: health.subscriberFailures > 0 ? 'PERSISTENCE_DEGRADED' : 'OBSERVER_DATA_LOSS',
      correlation,
      facts: [{
        source: 'observer',
        statement: `observer health is ${health.evidenceState}; dropped=${health.dropped}; coalesced=${health.coalesced}`,
        evidenceRefs: ['observer:health'],
      }],
      inferences: ['Some diagnostic evidence is incomplete.'],
      hypotheses: [],
      confidence: 'high',
      evidenceState: health.evidenceState,
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
    return incident
  }
}
