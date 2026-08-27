import assert from 'node:assert/strict'
import test from 'node:test'
import { BdnsDiagnostics } from './diagnostics.js'

test('creates a contradiction incident without overwriting canonical truth', () => {
  const diagnostics = new BdnsDiagnostics()
  const incident = diagnostics.reconcileProcessOutcome({
    correlation: { sessionId: 'session-1', toolCallId: 'tool-1' },
    canonicalOutcome: 'succeeded',
    processExitCode: 1,
    processObservationSequence: 2,
  })
  assert.equal(incident?.category, 'PROCESS_OUTCOME_MISMATCH')
  assert.equal(incident?.confidence, 'high')
  assert.equal(incident?.facts[0]?.source, 'canonical')
  assert.match(incident?.hypotheses[0] ?? '', /canonical tool result/)
})

test('keeps insufficient process evidence unknown', () => {
  const diagnostics = new BdnsDiagnostics()
  const incident = diagnostics.reconcileProcessOutcome({
    correlation: { sessionId: 'session-1' },
    canonicalOutcome: 'unknown',
    processExitCode: null,
  })
  assert.equal(incident, null)
  assert.equal(diagnostics.summary().evidenceState, 'complete')
})

test('detects undeclared workspace changes and labels partial evidence', () => {
  const diagnostics = new BdnsDiagnostics()
  const incident = diagnostics.reconcileWorkspace({
    correlation: { sessionId: 'session-1' },
    unexpectedChangedPaths: ['secret.txt'],
    missingExpectedPaths: [],
    evidenceState: 'truncated',
  })
  assert.equal(incident?.category, 'UNDECLARED_WORKSPACE_MUTATION')
  assert.equal(diagnostics.summary().evidenceState, 'partial')
})

test('classifies subscriber failure as observer data loss, not persistence failure', () => {
  const diagnostics = new BdnsDiagnostics()
  const incident = diagnostics.recordHealth({
    evidenceState: 'observer_failed',
    published: 1,
    delivered: 0,
    dropped: 0,
    coalesced: 0,
    subscriberFailures: 1,
    lastError: 'observer exploded',
  })
  assert.equal(incident?.category, 'OBSERVER_DATA_LOSS')
  const persistence = diagnostics.recordPersistenceDegraded({}, 'disk unavailable')
  assert.equal(persistence?.category, 'PERSISTENCE_DEGRADED')
})

test('pairs independent process and canonical facts into evidence candidates without acceptance verdicts', () => {
  const diagnostics = new BdnsDiagnostics()
  diagnostics.recordObservation({
    schemaVersion: 1,
    observerSequence: 1,
    source: 'process',
    kind: 'process_exited',
    correlation: { sessionId: 'session-1', toolCallId: 'tool-1' },
    wallTime: new Date().toISOString(),
    monotonicTimeMs: 1,
    evidenceState: 'complete',
    payload: { exitCode: 1, executionId: 'p1' },
  })
  const incident = diagnostics.recordObservation({
    schemaVersion: 1,
    observerSequence: 2,
    source: 'canonical',
    kind: 'canonical_event',
    correlation: { sessionId: 'session-1', canonicalEventId: 'evt-1' },
    wallTime: new Date().toISOString(),
    monotonicTimeMs: 2,
    evidenceState: 'complete',
    payload: {
      kind: 'tool_completed',
      event_id: 'evt-1',
      seq: 9,
      tool_call_id: 'tool-1',
      tool_name: 'shell_exec',
      exit_code: 0,
    },
  })
  assert.equal(incident?.category, 'PROCESS_OUTCOME_MISMATCH')
  const summary = diagnostics.summary()
  assert.ok(summary.evidenceCandidates.length >= 2)
  assert.equal(summary.evidenceCandidates.every((candidate) => candidate.semanticAuthority === 'diagnostic_only'), true)
  assert.equal(summary.evidenceCandidates.some((candidate) => 'claimSatisfied' in candidate || 'acceptanceVerdict' in candidate), false)
})
