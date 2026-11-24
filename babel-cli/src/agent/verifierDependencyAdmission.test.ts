import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admissionVerifierFreezeCommands } from './verifierDependencyAdmission.js'

test('admission freeze commands dedupe resolved, explicit, and discovered npm test', () => {
  const commands = admissionVerifierFreezeCommands({
    task: 'Fix parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- `npm test` must pass.',
    resolvedVerifierCommands: ['npm test'],
    discoveredTestCommands: ['npm test'],
  })
  assert.deepEqual(commands, ['npm test'])
})

test('verifier dependency admission freezes the separate explicit command for a labeled goal', () => {
  const commands = admissionVerifierFreezeCommands({
    task: 'Objective: Fix the export to include every record.\nRequirements:\n- `npm test` must pass.',
    resolvedVerifierCommands: [],
    discoveredTestCommands: [],
  })
  assert.deepEqual(commands, ['npm test'])
})
