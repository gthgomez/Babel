import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import {
  bindExecutableVerifiersToTaskAcceptance,
  canonicalCommandFromFrozenVerification,
  commandsMatchForExecutableBinding,
  criterionExplicitlyNamesTrustedCommand,
  frozenVerificationMatchesTrustedCommand,
  explicitCriterionVerifierCommands,
  extractPositiveCommandSuccessCriterion,
  mergeTrustedVerifierCommands,
} from './taskAcceptanceExecutableBinding.js'
import { inferTaskAcceptance, inferTaskAcceptanceV2, inferTaskAcceptanceV3 } from './taskAcceptanceMeaning.js'
import { applyWorkingStateEvent, createWorkingState, formatWorkingStateBlock } from './codingLoop/workingState.js'

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
  const bound = contract.acceptance.find(item => item.verification.verifier_id === 'verifier:npm')
  assert.ok(bound)
  assert.deepEqual(bound!.verification.argv, ['test'])
  assert.equal(contract.user_request, task)
  assert.deepEqual(contract.acceptance_criteria, ['`npm test` must pass.'])
  assert.equal(contract.acceptance.some(item => item.description === 'Fix the parser bug.'), false)
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

test('canonical frozen verification preserves npm argv after run script name', () => {
  const canonical = canonicalCommandFromFrozenVerification({
    executable_id: 'npm',
    argv: ['run', 'test:unit', '--', '--filter', 'critical'],
  })
  assert.equal(canonical, 'npm run test:unit -- --filter critical')
  assert.equal(
    frozenVerificationMatchesTrustedCommand(
      { executable_id: 'npm', argv: ['run', 'test:unit', '--', '--filter', 'critical'] },
      'npm run test:unit',
    ),
    false,
  )
  assert.equal(
    frozenVerificationMatchesTrustedCommand(
      { executable_id: 'npm', argv: ['run', 'test:unit', '--', '--filter', 'critical'] },
      'npm run test:unit -- --filter critical',
    ),
    true,
  )
})

test('canonical frozen verification requires executable_id with argv (no argv-only lossy join)', () => {
  assert.equal(
    canonicalCommandFromFrozenVerification({ argv: ['node', 'verify.mjs'] }),
    null,
  )
  const canonical = canonicalCommandFromFrozenVerification({
    executable_id: 'node',
    argv: ['verify.mjs', '--mode', 'strict'],
  })
  assert.equal(canonical, 'node verify.mjs --mode strict')
  assert.equal(
    frozenVerificationMatchesTrustedCommand(
      { executable_id: 'node', argv: ['verify.mjs', '--mode', 'strict'] },
      'node verify.mjs',
    ),
    false,
  )
})

test('quoted argument whitespace is not collapsed into a false argv match', () => {
  const withDoubleSpace = 'node --test "test  files/foo.test.mjs"'
  const withSingleSpace = 'node --test "test files/foo.test.mjs"'
  assert.equal(commandsMatchForExecutableBinding(withDoubleSpace, withSingleSpace), false)
  assert.equal(
    frozenVerificationMatchesTrustedCommand(
      { executable_id: 'node', argv: ['--test', 'test  files/foo.test.mjs'] },
      withSingleSpace,
    ),
    false,
  )
  assert.equal(
    frozenVerificationMatchesTrustedCommand(
      { executable_id: 'node', argv: ['--test', 'test  files/foo.test.mjs'] },
      withDoubleSpace,
    ),
    true,
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

test('a criterion binds only to its own explicit exact verifier designation', () => {
  const command = 'node --test test/parser.test.mjs'
  const linkedCriterion = `Fix parser.js so parseSum(2, 3) returns 5; verified by: \`${command}\` must pass.`
  const meaning = inferTaskAcceptanceV3(`Requirements:\n- ${linkedCriterion}`)
  assert.equal(meaning.unresolved, false)
  assert.equal(meaning.sources[0]?.status, 'explicit')
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: [command],
    defaultWorkingDirectory: '.',
  })
  assert.deepEqual(bound.criteria[0]?.verification.argv, ['--test', 'test/parser.test.mjs'])
  assert.equal(bound.criteria[0]?.verification.verifier_id, 'verifier:node')
  assert.equal(bound.provenance.some(item => item.ref.startsWith('babel:criterion-verifier-link:v1:')), true)
})

test('a verifier named in a separate requirement cannot bind the behavioral goal', () => {
  const task = [
    'Fix parser.js so parseSum(2, 3) returns 5.',
    'Requirements:',
    '- `npm test` must pass.',
  ].join('\n')
  const bound = resolveLiveSessionAuthority({
    mode: 'chat', task, projectRoot: '/tmp/project', projectTestCommands: ['npm test'],
  }).taskContract
  const goal = bound.acceptance.find(item => item.description === 'Fix parser.js so parseSum(2, 3) returns 5.')
  const genericTest = bound.acceptance.find(item => item.description === '`npm test` must pass.')
  assert.ok(goal)
  assert.ok(genericTest)
  assert.ok(goal!.verification.verifier_id.startsWith('meaning:'), 'unrelated test remains unable to prove the goal')
  assert.deepEqual(genericTest!.verification.argv, ['test'])
})

test('verifier binding preserves exact whitespace inside string literals', () => {
  const task = [
    "Fix parser.js so echo('A  B') returns 'A  B'.",
    'Requirements:',
    "- Fix parser.js so echo('A B') returns 'A B'; verified by: `node --test test/parser.test.mjs` must pass.",
  ].join('\n')
  const meaning = inferTaskAcceptanceV3(task)
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: ['node --test test/parser.test.mjs'],
    defaultWorkingDirectory: '.',
  })
  const exactLiteralGoal = bound.criteria.find(item => item.description.includes("echo('A  B')"))
  const singleSpaceRequirement = bound.criteria.find(item => item.description.includes("echo('A B')"))
  assert.ok(exactLiteralGoal && singleSpaceRequirement)
  assert.ok(exactLiteralGoal.verification.verifier_id.startsWith('meaning:'), 'single-space verifier cannot certify a two-space literal')
  assert.equal(singleSpaceRequirement.verification.verifier_id, 'verifier:node')
})

test('verifier binding preserves exact whitespace inside regex literals', () => {
  const task = [
    'Fix parser.js so accepts(/A  B/) returns true.',
    'Requirements:',
    '- Fix parser.js so accepts(/A B/) returns true; verified by: `node --test test/parser.test.mjs` must pass.',
  ].join('\n')
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptanceV3(task),
    trustedVerifierCommands: ['node --test test/parser.test.mjs'],
    defaultWorkingDirectory: '.',
  })
  const exactLiteralGoal = bound.criteria.find(item => item.description.includes('accepts(/A  B/)'))
  const singleSpaceRequirement = bound.criteria.find(item => item.description.includes('accepts(/A B/)'))
  assert.ok(exactLiteralGoal && singleSpaceRequirement)
  assert.ok(exactLiteralGoal.verification.verifier_id.startsWith('meaning:'), 'single-space regex verifier cannot certify a two-space regex goal')
  assert.equal(singleSpaceRequirement.verification.verifier_id, 'verifier:node')
})

test('criterion verifier-link syntax does not change archived v2 meaning', () => {
  const task = [
    'Requirements:',
    '- parseSum(2, 3) returns 5; verified by: `node --test test/parser.test.mjs` must pass.',
  ].join('\n')
  const meaning = inferTaskAcceptanceV2(task)
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: ['node --test test/parser.test.mjs'],
  })
  assert.ok(bound.criteria[0]!.verification.verifier_id.startsWith('meaning:'))
})

test('a verifier designation outside the trusted command set stays unbound', () => {
  const meaning = inferTaskAcceptance([
    'Requirements:',
    '- parseSum(2, 3) returns 5; verified by: `node --test test/parser.test.mjs` must pass.',
  ].join('\n'))
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: ['npm test'],
  })
  assert.ok(bound.criteria[0]!.verification.verifier_id.startsWith('meaning:'))
})

test('conflicting verifier links for the same behavior do not bind the goal', () => {
  const behavior = 'Fix parser.js so parseSum(2, 3) returns 5'
  const task = [
    `${behavior}.`,
    'Requirements:',
    `- ${behavior}; verified by: \`npm test\` must pass.`,
    `- ${behavior}; verified by: \`node --test test/parser.test.mjs\` must pass.`,
  ].join('\n')
  const commands = ['npm test', 'node --test test/parser.test.mjs']
  const bound = resolveLiveSessionAuthority({
    mode: 'chat', task, projectRoot: '/tmp/project', projectTestCommands: commands,
  }).taskContract
  const behaviorCriteria = bound.acceptance.filter(item => item.description.startsWith(behavior))
  assert.ok(behaviorCriteria.length >= 2)
  assert.ok(behaviorCriteria.every(item => item.verification.verifier_id.startsWith('meaning:')))
})

test('an untrusted conflicting verifier declaration also keeps the behavior unbound', () => {
  const behavior = 'Fix parser.js so parseSum(2, 3) returns 5'
  const task = [
    `${behavior}.`,
    'Requirements:',
    `- ${behavior}; verified by: \`npm test\` must pass.`,
    `- ${behavior}; verified by: \`node --test test/parser.test.mjs\` must pass.`,
  ].join('\n')
  const bound = resolveLiveSessionAuthority({
    mode: 'chat', task, projectRoot: '/tmp/project', projectTestCommands: ['npm test'],
  }).taskContract
  const behaviorCriteria = bound.acceptance.filter(item => item.description.startsWith(behavior))
  assert.ok(behaviorCriteria.length >= 2)
  assert.ok(behaviorCriteria.every(item => item.verification.verifier_id.startsWith('meaning:')))
})

test('ambiguous, negated, or trailing verifier clauses stay unbound', () => {
  const cases = [
    'parseSum(2, 3) returns 5; verified by: `npm test` must pass or `node --test test/parser.test.mjs` must pass.',
    'parseSum(2, 3) returns 5; verified by: `npm test` must fail.',
    'parseSum(2, 3) returns 5; verified by: `npm test` must pass and the UI must change.',
  ]
  for (const statement of cases) {
    const meaning = inferTaskAcceptance(`Requirements:\n- ${statement}`)
    const bound = bindExecutableVerifiersToTaskAcceptance({
      meaning,
      trustedVerifierCommands: ['npm test', 'node --test test/parser.test.mjs'],
    })
    assert.ok(bound.criteria[0]!.verification.verifier_id.startsWith('meaning:'), statement)
  }
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

test('green verifier guidance distinguishes explicit executable checks from inferred semantic meaning', t => {
  const verifierResult = applyWorkingStateEvent(createWorkingState('Normalize decimal separators.'), {
    type: 'verifier', identity: 'npm test', exitCode: 0, summary: '2/2 tests passed',
  })
  const explicit = resolveLiveSessionAuthority({
    mode: 'chat', task: 'Requirements:\n- `npm test` passes.', projectRoot: null, executionScope: { kind: 'conversation' },
    projectTestCommands: ['npm test'],
  }).taskContract
  const explicitReview = formatWorkingStateBlock(verifierResult, explicit)
  assert.match(explicitReview, /source: explicit/)
  assert.match(explicitReview, /verifier_binding: exact_executable/)
  assert.match(explicitReview, /executable_id: "npm"/)
  assert.match(explicitReview, /argv: \["test"\]/)
  assert.match(explicitReview, /environment_policy: "host-process"/)
  assert.match(explicitReview, /criterion_evidence_status: awaiting_host_evaluation/)
  assert.match(explicitReview, /proof_plan: run_or_review_the_exact_frozen_verifier/)
  assert.match(explicitReview, /proof_plan_authority: advisory_only/)
  assert.doesNotMatch(explicitReview, /working_directory:/,
    'an absent frozen cwd stays absent in the advisory contract projection')

  const spacedCommand = 'node --test "test files/foo.test.mjs"'
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-explicit-node-check-'))
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }))
  mkdirSync(join(projectRoot, 'test files'), { recursive: true })
  writeFileSync(join(projectRoot, 'test files', 'foo.test.mjs'), 'assert.ok(true)\n')
  const spaced = resolveLiveSessionAuthority({
    mode: 'chat', task: `Requirements:\n- \`${spacedCommand}\` passes.`, projectRoot,
    projectTestCommands: [spacedCommand],
  }).taskContract
  const spacedReview = formatWorkingStateBlock(verifierResult, spaced)
  assert.match(spacedReview, /argv: \["--test","test files\/foo\.test\.mjs"\]/,
    'argument boundaries and paths containing spaces are preserved')
  assert.match(spacedReview, /command_hash: "[0-9a-f]{64}"/)
  assert.match(spacedReview, /working_directory: "\."/)

  const semanticTask = 'Normalize decimal separators and preserve the original scale.'
  const semantic = resolveLiveSessionAuthority({
    mode: 'chat', task: semanticTask, projectRoot: null, executionScope: { kind: 'conversation' },
    projectTestCommands: ['npm test'],
  }).taskContract
  const semanticReview = formatWorkingStateBlock(verifierResult, semantic)
  assert.match(semanticReview, /source: inferred/)
  assert.match(semanticReview, /verifier_binding: none/)
  assert.match(semanticReview, /keep making safe progress/)
  assert.match(semanticReview, /Do not mark the requirement satisfied/)
  assert.match(semanticReview, /proof_plan: propose_a_focused_check_for_this_requirement/)
  assert.match(semanticReview, /proof_plan_basis: \{"requirement":"Normalize decimal separators and preserve the original scale\.","strategy":.*"verifier_id":"meaning:/)
  assert.match(semanticReview, /proof_plan_authority: advisory_only/)
  assert.match(semanticReview, /2\/2 tests passed/)
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

test('criterion link matching preserves behavior-literal case', () => {
  const command = 'node --test parser.test.mjs'
  const task = [
    "Fix parser.js so echo('ABC') returns 'ABC'.",
    'Requirements:',
    `- Fix parser.js so echo('abc') returns 'abc'; verified by: \`${command}\` must pass.`,
  ].join('\n')
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptanceV3(task),
    trustedVerifierCommands: [command],
    defaultWorkingDirectory: '.',
  })
  const uppercaseGoal = bound.criteria.find(item => item.description === "Fix parser.js so echo('ABC') returns 'ABC'.")!
  const lowercaseRequirement = bound.criteria.find(item => item.description.includes("echo('abc')"))!
  assert.ok(uppercaseGoal.verification.verifier_id.startsWith('meaning:'))
  assert.ok(lowercaseRequirement.verification.verifier_id.startsWith('verifier:'))
})

test('bare node --test cannot bind an acceptance criterion without a frozen input set', () => {
  const task = [
    'Fix parser.js so parseSum(2, 3) returns 5.',
    'Requirements:',
    '- parseSum(2, 3) returns 5; verified by: `node --test` must pass.',
  ].join('\n')
  const meaning = inferTaskAcceptanceV3(task)
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning,
    trustedVerifierCommands: ['node --test'],
    defaultWorkingDirectory: '.',
  })
  assert.equal(bound.criteria.some(item => !item.verification.verifier_id.startsWith('meaning:')), false)
  assert.deepEqual(explicitCriterionVerifierCommands(meaning), [])
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
