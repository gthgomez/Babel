import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BDNS_FORBIDDEN_ACCEPTANCE_FIELDS,
  hasForbiddenAcceptanceFields,
  projectCanonicalEventMetadata,
  toEvidenceCandidateFromIncident,
  toEvidenceCandidateFromObservation,
} from './evidenceCandidate.js'
import type { BdnsIncident, BdnsObservation } from './types.js'

function observation(payload: unknown): BdnsObservation {
  return {
    schemaVersion: 1,
    observerSequence: 7,
    source: 'canonical',
    kind: 'canonical_event',
    correlation: { sessionId: 'session-1', canonicalEventId: 'evt-1' },
    wallTime: new Date().toISOString(),
    monotonicTimeMs: 1,
    evidenceState: 'complete',
    payload,
  }
}

test('projects canonical events to metadata without task text or acceptance fields', () => {
  const metadata = projectCanonicalEventMetadata({
    kind: 'user_submitted',
    event_id: 'evt-1',
    seq: 4,
    task_preview: 'secret task that must not become acceptance evidence',
    session_id: 'session-1',
  })
  assert.deepEqual(metadata, { kind: 'user_submitted', eventId: 'evt-1', seq: 4 })
  const candidate = toEvidenceCandidateFromObservation(observation({
    kind: 'tool_completed',
    event_id: 'evt-2',
    seq: 8,
    tool_call_id: 'tool-1',
    tool_name: 'shell_exec',
    exit_code: 0,
  }))
  assert.equal(candidate.kind, 'runtime_fact')
  assert.equal(candidate.producer.role, 'canonical')
  assert.equal(candidate.semanticAuthority, 'diagnostic_only')
  assert.equal(candidate.correlation.toolCallId, 'tool-1')
  assert.equal((candidate.payload as { canonicalOutcome?: string }).canonicalOutcome, 'succeeded')
  assert.equal(hasForbiddenAcceptanceFields(candidate), false)
  for (const field of BDNS_FORBIDDEN_ACCEPTANCE_FIELDS) {
    assert.equal(field in candidate, false)
  }
})

test('marks process and workspace facts as observer-independent evidence candidates', () => {
  const processCandidate = toEvidenceCandidateFromObservation({
    ...observation({ executionId: 'p1', exitCode: 1 }),
    source: 'process',
    kind: 'process_exited',
    correlation: { toolCallId: 'tool-1', processExecutionId: 'p1' },
  })
  assert.equal(processCandidate.kind, 'process_fact')
  assert.equal(processCandidate.independence.observerIndependent, true)
  assert.equal(processCandidate.independence.implementationIndependent, false)

  const incident: BdnsIncident = {
    schemaVersion: 1,
    incidentId: 'inc-1',
    category: 'PROCESS_OUTCOME_MISMATCH',
    correlation: { toolCallId: 'tool-1' },
    facts: [],
    inferences: ['disagreement'],
    hypotheses: ['canonical result may be wrong'],
    confidence: 'high',
    evidenceState: 'complete',
    createdAt: new Date().toISOString(),
  }
  const fromIncident = toEvidenceCandidateFromIncident(incident)
  assert.equal(fromIncident.kind, 'diagnostic_incident')
  assert.equal(fromIncident.semanticAuthority, 'diagnostic_only')
  assert.equal(hasForbiddenAcceptanceFields(fromIncident), false)
})
