import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import {
  bindExecutableVerifiersToTaskAcceptance,
  commandsMatchForExecutableBinding,
  criterionExplicitlyNamesTrustedCommand,
  extractPositiveCommandSuccessCriterion,
  mergeTrustedVerifierCommands,
} from './taskAcceptanceExecutableBinding.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'

test('plain-text npm test passes binds with suffix-anchored grammar', () => {
  assert.equal(criterionExplicitlyNamesTrustedCommand('npm test passes.', 'npm test'), true)
  assert.equal(criterionExplicitlyNamesTrustedCommand('npm test must pass', 'npm test'), true)
})

test('binds a clearly accepted positive command-success criterion with exact argv', () => {
  const task = [
    'Fix the parser bug.',
    'Requirements:',
    '- `npm test` must pass.',
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm test'],
  }).taskContract
  assert.equal(contract.acceptance.length, 1)
  assert.equal(contract.acceptance[0]!.verification.verifier_id, 'verifier:npm')
  assert.deepEqual(contract.acceptance[0]!.verification.argv, ['test'])
})

test('negated command-success assertions do not bind', () => {
  assert.equal(extractPositiveCommandSuccessCriterion('npm test must FAIL for invalid input'), null)
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('npm test must FAIL for invalid input', 'npm test'),
    false,
  )
})

test('compound obligations do not bind on command mention alone', () => {
  assert.equal(
    criterionExplicitlyNamesTrustedCommand(
      'npm test must pass AND UI show new button',
      'npm test',
    ),
    false,
  )
})

test('coverage argv weakening does not bind to trusted npm test', () => {
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('npm test -- --coverage passes', 'npm test'),
    false,
  )
  assert.equal(commandsMatchForExecutableBinding('npm test -- --coverage', 'npm test'), false)
})

test('script-prefix alias does not bind to npm test', () => {
  assert.equal(commandsMatchForExecutableBinding('npm run test', 'npm test'), false)
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('npm run test must pass', 'npm test'),
    false,
  )
})

test('substring command mention without positive-success grammar does not bind', () => {
  assert.equal(extractPositiveCommandSuccessCriterion('parser tests must pass'), null)
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('fix the parser and run tests', 'npm test'),
    false,
  )
})

test('vague acceptance prose does not bind to a discovered project test command', () => {
  const meaning = inferTaskAcceptance([
    'Fix the parser.',
    'Requirements:',
    '- The project test suite passes.',
  ].join('\n'))
  assert.equal(meaning.unresolved, false)
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: ['npm test'],
    defaultWorkingDirectory: '.',
  })
  assert.ok(bound.criteria[0]!.verification.verifier_id.startsWith('meaning:'))
})

test('inferred-only acceptance stays meaning-bound without trusted executable commands', () => {
  const meaning = inferTaskAcceptance('The startup must succeed without Docker.')
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: mergeTrustedVerifierCommands({ projectTestCommands: ['npm test'] }),
    defaultWorkingDirectory: '.',
  })
  assert.ok(bound.criteria[0]!.verification.verifier_id.startsWith('meaning:'))
})

test('unresolved acceptance is not upgraded by trusted verifiers alone', () => {
  const meaning = inferTaskAcceptance('Investigate why parser_test fails and fix it.')
  assert.equal(meaning.unresolved, true)
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: ['npm test'],
    defaultWorkingDirectory: '.',
  })
  assert.equal(bound.criteria[0]!.verification.verifier_id.startsWith('meaning:'), true)
})
