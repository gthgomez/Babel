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
