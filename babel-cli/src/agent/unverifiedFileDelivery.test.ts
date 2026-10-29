import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { resolveCompletionVerificationContext, type GateToolLogEntry } from './completionGatePolicy.js'
import { unverifiedFileDeliveryPaths } from './unverifiedFileDelivery.js'
import { formatPreservedUnverifiedTerminalAnswer } from './preservedUnverifiedTerminal.js'
import { ResponseEvidenceRetry } from './chatResponseEvidence.js'

const root = resolve('fixture-project')
const write: GateToolLogEntry = { tool: 'write_file', target: 'map.md', exit_code: 0, mutation_paths: ['map.md'], effect_status: 'confirmed_change' }
const read: GateToolLogEntry = { tool: 'read_file', target: 'map.md', exit_code: 0 }
const base = () => ({ projectRoot: root, taskClass: 'default' as const,
  verification: resolveCompletionVerificationContext({ taskClass: 'default', task: 'Update map.md', requiredVerifierCommands: [] }),
  shellUnavailable: true, verifierEvidencePresent: false, verifierTampered: false, toolCallLog: [write, read] })

test('unverified retention requires confirmed file changes and later successful same-path readback', () => {
  assert.deepEqual(unverifiedFileDeliveryPaths(base()), ['map.md'])
  for (const log of [[], [read], [read, write], [write], [write, { ...read, exit_code: 1 }], [write, { ...read, target: 'other.md' }], [write, read, write], [{ ...write, effect_status: 'confirmed_no_change' as const }, read], [write, read, { tool: 'sub_agent', target: 'child', effect_status: 'indeterminate' as const }]]) {
    assert.equal(unverifiedFileDeliveryPaths({ ...base(), toolCallLog: log }), null)
  }
})

test('explicit verification contracts and unavailable or failed evidence retain their enforcement', () => {
  for (const verification of [
    resolveCompletionVerificationContext({ taskClass: 'default', task: 'Run tests before completing.' }),
    resolveCompletionVerificationContext({ taskClass: 'default', task: 'Update map.md', requiredVerifierCommands: ['npm test'] }),
    resolveCompletionVerificationContext({ taskClass: 'governance', task: 'Update map.md' }),
  ]) assert.equal(unverifiedFileDeliveryPaths({ ...base(), verification }), null)
  for (const change of [{ shellUnavailable: false }, { verifierEvidencePresent: true }, { verifierTampered: true }, { taskClass: 'governance' as const }]) {
    assert.equal(unverifiedFileDeliveryPaths({ ...base(), ...change }), null)
  }
})

test('retained artifacts cannot acquire outside-root or non-file mutation authority', () => {
  for (const change of [{ mutation_paths: ['../escape'] }, { mutation_paths: [resolve(root, '..', 'escape')] }, { mutation_paths: [] }, { tool: 'run_command' }, { tool: 'sub_agent' }, { error: 'blocked' }]) {
    assert.equal(unverifiedFileDeliveryPaths({ ...base(), toolCallLog: [{ ...write, ...change }, read] }), null)
  }
})

test('failed evidence correction retains a read-back artifact with explicit unverified status', () => {
  const retry = new ResponseEvidenceRetry()
  const unsupported = 'All tests passed.'
  assert.equal(retry.inspect({ answer: unsupported, receipt: null, ledger: [], hasConfirmedMutation: true, turn: 0, maxTurns: 4 })?.kind, 'retry')
  const exhausted = retry.inspect({ answer: unsupported, receipt: null, ledger: [], hasConfirmedMutation: true, turn: 1, maxTurns: 4 })
  assert.equal(exhausted?.kind, 'fail')
  const refs = unverifiedFileDeliveryPaths(base())
  assert.deepEqual(refs, ['map.md'])
  const answer = formatPreservedUnverifiedTerminalAnswer({
    authorityReason: 'UNVERIFIED: required verification was unavailable; task fulfillment is not certified.',
    retainedCandidate: 'The host recorded confirmed changes to: map.md. No authoritative test result is recorded.',
    artifactRefs: refs!,
  })
  assert.match(answer, /UNVERIFIED/)
  assert.match(answer, /map\.md/)
  assert.match(answer, /No authoritative test result is recorded/)
  assert.doesNotMatch(answer, /All tests passed/)
  assert.equal(unverifiedFileDeliveryPaths({ ...base(), toolCallLog: [write] }), null)
})
