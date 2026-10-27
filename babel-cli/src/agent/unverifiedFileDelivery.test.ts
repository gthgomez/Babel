import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { resolveCompletionVerificationContext, type GateToolLogEntry } from './completionGatePolicy.js'
import { unverifiedFileDeliveryPaths } from './unverifiedFileDelivery.js'

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
  for (const change of [{ shellUnavailable: false }, { verifierEvidencePresent: true }, { verifierTampered: true }, { taskClass: 'general_swe' as const }]) {
    assert.equal(unverifiedFileDeliveryPaths({ ...base(), ...change }), null)
  }
})

test('retained artifacts cannot acquire outside-root or non-file mutation authority', () => {
  for (const change of [{ mutation_paths: ['../escape'] }, { mutation_paths: [resolve(root, '..', 'escape')] }, { mutation_paths: [] }, { tool: 'run_command' }, { tool: 'sub_agent' }, { error: 'blocked' }]) {
    assert.equal(unverifiedFileDeliveryPaths({ ...base(), toolCallLog: [{ ...write, ...change }, read] }), null)
  }
})
