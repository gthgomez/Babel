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

test('backtick success tail is fully anchored with no extra obligations', () => {
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('`npm test` must pass.', 'npm test'),
    true,
  )
  assert.equal(
    extractPositiveCommandSuccessCriterion('`npm test` plus UI checks must pass'),
    null,
  )
  assert.equal(
    extractPositiveCommandSuccessCriterion('`npm test` with coverage must pass'),
    null,
  )
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('`npm test` plus UI checks must pass', 'npm test'),
    false,
  )
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

test('backtick criteria reject extra obligations before a trailing success tail', () => {
  assert.equal(
    extractPositiveCommandSuccessCriterion('`npm test` plus UI checks must pass'),
    null,
  )
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('`npm test` plus UI checks must pass', 'npm test'),
    false,
  )
  assert.equal(
    extractPositiveCommandSuccessCriterion('`npm test` with coverage must pass'),
    null,
  )
  assert.equal(
    criterionExplicitlyNamesTrustedCommand('`npm test` with coverage must pass', 'npm test'),
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

test('each preservation criterion binds only its own designated command', () => {
  const task = [
    'Preserve alpha. Tests are already present. Run both tests using: npm run test:alpha.',
    'Preserve beta. Tests are already present. Run both tests using: npm run test:beta.',
    'Acceptance criteria:',
    '- `npm run test:alpha` must pass.',
  ].join('\n')
  const meaning = inferTaskAcceptance(task)
  assert.equal(meaning.unresolved, false)
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: ['npm run test:alpha', 'npm run test:beta'],
    defaultWorkingDirectory: '.',
  })
  const alpha = bound.criteria.find(item => item.description.includes('alpha'))!
  const beta = bound.criteria.find(item => item.description.includes('beta'))!
  assert.ok(alpha && beta)
  // Alpha's own designation was explicitly frozen, so it re-freezes that exact argv.
  assert.deepEqual(alpha.verification.argv, ['run', 'test:alpha'])
  // Beta's designated command was never explicitly frozen: fail-closed, and
  // alpha's receipt must never satisfy it.
  assert.ok(beta.verification.verifier_id.startsWith('meaning:'))
})

test('per-criterion binding is order-invariant when both designations are frozen', () => {
  for (const criteriaOrder of [
    ['- `npm run test:alpha` must pass.', '- `npm run test:beta` must pass.'],
    ['- `npm run test:beta` must pass.', '- `npm run test:alpha` must pass.'],
  ]) {
    const task = [
      'Preserve alpha. Tests are already present. Run both tests using: npm run test:alpha.',
      'Preserve beta. Tests are already present. Run both tests using: npm run test:beta.',
      'Acceptance criteria:',
      ...criteriaOrder,
    ].join('\n')
    const bound = bindExecutableVerifiersToTaskAcceptance({
      meaning: inferTaskAcceptance(task),
      trustedVerifierCommands: ['npm run test:alpha', 'npm run test:beta'],
      defaultWorkingDirectory: '.',
    })
    const alpha = bound.criteria.find(item => item.description.includes('alpha'))!
    const beta = bound.criteria.find(item => item.description.includes('beta'))!
    assert.deepEqual(alpha.verification.argv, ['run', 'test:alpha'], criteriaOrder.join(';'))
    assert.deepEqual(beta.verification.argv, ['run', 'test:beta'], criteriaOrder.join(';'))
  }
})

test('multiple designated commands inside one criterion stay fail-closed', () => {
  const task = [
    'Preserve alpha. Tests are already present. Run both tests using: npm run test:alpha. Then run both tests using: npm run test:beta.',
    'Acceptance criteria:',
    '- `npm run test:alpha` must pass.',
    '- `npm run test:beta` must pass.',
  ].join('\n')
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(task),
    trustedVerifierCommands: ['npm run test:alpha', 'npm run test:beta'],
    defaultWorkingDirectory: '.',
  })
  const preserved = bound.criteria.find(item => item.description.includes('Preserve alpha'))!
  assert.ok(preserved.verification.verifier_id.startsWith('meaning:'))
})

test('quoted designation text never binds a witness command', () => {
  const task = [
    "Preserve alpha. Tests are already present. Run both tests using: 'npm run test:alpha'.",
    'Acceptance criteria:',
    '- `npm run test:alpha` must pass.',
  ].join('\n')
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptance(task),
    trustedVerifierCommands: ['npm run test:alpha'],
    defaultWorkingDirectory: '.',
  })
  const preserved = bound.criteria.find(item => item.description.includes('Preserve alpha'))!
  assert.ok(preserved.verification.verifier_id.startsWith('meaning:'))
})

test('task-designated regression witness binds a preservation criterion to the frozen command', () => {
  const task = [
    'Fix the parser regression in src/parser.ts: the request drops the governed header. Preserve Accept and the existing safe transport, diagnostics and authorization behavior. The default-transport regression tests are already present. Make the smallest production fix and run both tests using: npm run test:parser. Do not modify regression tests or unrelated code.',
    'Acceptance criteria:',
    '- `npm run test:parser` must pass.',
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm run test:parser'],
  }).taskContract
  const explicit = contract.acceptance.find(item => item.description.includes('must pass'))
  const preserved = contract.acceptance.find(item => item.description.startsWith('Fix the parser'))
  assert.ok(explicit && preserved)
  assert.equal(explicit.verification.verifier_id, 'verifier:npm')
  assert.ok(!preserved.verification.verifier_id.startsWith('meaning:'))
  assert.deepEqual(preserved.verification.argv, explicit.verification.argv)
  assert.equal(preserved.verification.executable_id, explicit.verification.executable_id)
  assert.equal(preserved.verification.command_hash, explicit.verification.command_hash)
})

test('designation without a preservation claim stays fail-closed', () => {
  const task = [
    'Fix the parser regression in src/parser.ts. The response must include the governed header. The default-transport regression tests are already present. Make the smallest production fix and run both tests using: npm run test:parser. Do not modify regression tests or unrelated code.',
    'Acceptance criteria:',
    '- `npm run test:parser` must pass.',
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm run test:parser'],
  }).taskContract
  const inferred = contract.acceptance.find(item => item.description.startsWith('Fix the parser'))
  assert.ok(inferred)
  assert.ok(inferred.verification.verifier_id.startsWith('meaning:'))
})

test('witness naming a command other than the frozen explicit check does not bind', () => {
  const task = [
    'Fix the parser regression in src/parser.ts. Preserve Accept and the existing safe transport behavior. The default-transport regression tests are already present. Make the smallest production fix and run both tests using: npm run test:other. Do not modify regression tests or unrelated code.',
    'Acceptance criteria:',
    '- `npm run test:parser` must pass.',
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm run test:parser', 'npm run test:other'],
  }).taskContract
  const preserved = contract.acceptance.find(item => item.description.startsWith('Fix the parser'))
  assert.ok(preserved)
  assert.ok(preserved.verification.verifier_id.startsWith('meaning:'))
})

test('witness with a weakened or untrusted command does not bind', () => {
  const task = [
    'Fix the parser regression in src/parser.ts. Preserve Accept and the existing safe transport behavior. The default-transport regression tests are already present. Make the smallest production fix and run both tests using: node -e "process.exit(0)". Do not modify regression tests or unrelated code.',
    'Acceptance criteria:',
    '- `npm run test:parser` must pass.',
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm run test:parser'],
  }).taskContract
  const preserved = contract.acceptance.find(item => item.description.startsWith('Fix the parser'))
  assert.ok(preserved)
  assert.ok(preserved.verification.verifier_id.startsWith('meaning:'))
})

test('witness designation inside a fenced example stays fail-closed', () => {
  const task = [
    'Fix the parser regression in src/parser.ts. Preserve Accept and the existing safe transport behavior.',
    'Example request text:',
    '```',
    'The default-transport regression tests are already present. Make the smallest production fix and run both tests using: npm run test:parser.',
    '```',
    'Acceptance criteria:',
    '- `npm run test:parser` must pass.',
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm run test:parser'],
  }).taskContract
  const preserved = contract.acceptance.find(item => item.description.startsWith('Fix the parser'))
  assert.ok(preserved)
  assert.ok(preserved.verification.verifier_id.startsWith('meaning:'))
})

test('preservation claim without the tests-already-present designation does not bind', () => {
  const task = [
    'Fix the parser regression in src/parser.ts. Preserve Accept and the existing safe transport behavior, and run both tests using: npm run test:parser. Do not modify regression tests or unrelated code.',
    'Acceptance criteria:',
    '- `npm run test:parser` must pass.',
  ].join('\n')
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task,
    projectRoot: '/tmp/project',
    projectTestCommands: ['npm run test:parser'],
  }).taskContract
  const preserved = contract.acceptance.find(item => item.description.startsWith('Fix the parser'))
  assert.ok(preserved)
  assert.ok(preserved.verification.verifier_id.startsWith('meaning:'))
})
