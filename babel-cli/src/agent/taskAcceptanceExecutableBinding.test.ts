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
import { inferTaskAcceptance, inferTaskAcceptanceV2, inferTaskAcceptanceV3, inferTaskAcceptanceV4 } from './taskAcceptanceMeaning.js'
import { nodePointExecuted, POINT_TARGET_PREFIX, retainCurrentPointReceipts } from './pointVerifierWitness.js'
import { taskProhibitsCommand } from './taskCommandProhibitions.js'
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

test('a numeric point binds only to an exact assertion in the admitted Node test entry', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-point-witness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'discount.js'), 'export const computeDiscount = amount => amount / 10\n')
  const assertPoint = 'assert.equal(discount(100), 10)'
  const testFile = (body: string) => [
    'import test from "node:test"',
    'import assert from "node:assert/strict"',
    'import {computeDiscount as discount} from "./discount.js"',
    body,
  ].join('\n')
  const checks = [
    ['quoted entry', 'node --test "discount check.test.mjs"', `test("point", () => ${assertPoint})`, true],
    ['direct', 'node --test discount.test.mjs', `test("point", () => ${assertPoint})`, true],
    ['wrong argument', 'node --test discount.test.mjs', 'test("other", () => assert.equal(discount(101), 10))', false],
    ['wrong expected type', 'node --test discount.test.mjs', 'test("other", () => assert.equal(discount(100), "10"))', false],
    ['unrelated assertion', 'node --test discount.test.mjs', 'test("other", () => assert.equal(10, 10))', false],
    ['skipped', 'node --test discount.test.mjs', `test.skip("point", () => ${assertPoint})`, false],
    ['shadowed', 'node --test discount.test.mjs', `test("point", (discount) => ${assertPoint})`, false],
    ['duplicate case name', 'node --test discount.test.mjs',
      `test("point", () => ${assertPoint}); test("point", () => assert.equal(10, 10))`, false],
    ['unregistered', 'node --test discount.test.mjs', `const example = () => ${assertPoint}`, false],
    ['filtered', 'node --test --test-name-pattern=other discount.test.mjs', `test("point", () => ${assertPoint})`, false],
    ['different entry', 'node --test other.test.mjs', `test("point", () => ${assertPoint})`, false],
    ['compound script', 'echo node --test discount.test.mjs', `test("point", () => ${assertPoint})`, false],
  ] as const
  writeFileSync(join(root, 'other.test.mjs'), 'import test from "node:test"; test("other", () => {});\n')
  for (const [label, script, body, binds] of checks) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: script } }))
    const inputFile = label === 'quoted entry' ? 'discount check.test.mjs' : 'discount.test.mjs'
    writeFileSync(join(root, inputFile), testFile(body))
    for (const goal of [
      'Fix computeDiscount so it returns 10 for a total of 100.',
      'We need computeDiscount to return 10 for a total of 100.',
      'We need computeDiscount to return 10 for a total of 100. Implement this change.',
      'Goal: We need the `computeDiscount` function to return 10 when the total is 100.',
    ]) {
      const task = `${goal}\nRequirements:\n- npm test must pass.`
      const { taskContract } = resolveLiveSessionAuthority({
        mode: 'chat', task, projectRoot: root, projectTestCommands: ['npm test'],
      })
      const [behavior, command] = taskContract.acceptance
      assert.equal(taskContract.user_request, task)
      assert.equal(taskContract.acceptance.length, 2, `${label}: ${goal}`)
      assert.ok(behavior)
      assert.match(behavior.description, /computeDiscount/)
      assert.equal(behavior.verification.executable_id, binds ? 'npm' : undefined, label)
      assert.equal(command?.verification.executable_id, 'npm', label)
      if (binds) {
        assert.ok(taskContract.protected_paths.includes(inputFile))
        assert.ok(behavior.verification.target?.startsWith(POINT_TARGET_PREFIX))
      }
    }
    if (label === 'quoted entry') rmSync(join(root, inputFile))
  }

  const goal = 'We need computeDiscount to return 10 for a total of 100.'
  const contract = (task: string) => resolveLiveSessionAuthority({
    mode: 'chat', task, projectRoot: root, projectTestCommands: ['npm test'],
  }).taskContract
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test discount.test.mjs' } }))
  writeFileSync(join(root, 'discount.test.mjs'), testFile(`test("point", () => ${assertPoint})`))
  assert.equal(contract(goal).acceptance[0]?.verification.executable_id, 'npm')
  const linked = 'Requirements:\n- Fix computeDiscount so it returns 10 for a total of 100; verified by: npm test must pass.\n- npm test must pass.'
  assert.ok(contract(linked).acceptance[0]?.verification.target?.startsWith(POINT_TARGET_PREFIX))
  assert.equal(contract(linked).acceptance[1]?.verification.target, undefined)
  writeFileSync(join(root, 'discount.test.mjs'), testFile('test("other", () => assert.equal(1, 1))'))
  assert.equal(contract(linked).acceptance[0]?.verification.executable_id, undefined)
  assert.equal(contract(linked).acceptance[1]?.verification.executable_id, 'npm')
  writeFileSync(join(root, 'discount.test.mjs'), testFile(`test("point", () => ${assertPoint})`))
  assert.equal(contract(`${goal}\nDo not run npm.`).acceptance[0]?.verification.executable_id, undefined)
  assert.deepEqual(contract(`${goal}\nDo not run npm.`).verifier_requirements, [])
  writeFileSync(join(root, '.npmrc'), '# fixture configuration\n')
  assert.equal(contract(goal).acceptance[0]?.verification.executable_id, undefined)
  rmSync(join(root, '.npmrc'))
  writeFileSync(join(root, 'example.mjs'), 'export function computeDiscount() { return 5; }\n')
  assert.equal(contract(goal).acceptance[0]?.verification.executable_id, undefined)
  assert.equal(contract('Fix example.mjs so computeDiscount(100) returns 10.').acceptance[0]?.verification.executable_id, undefined)
  rmSync(join(root, 'example.mjs'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module', exports: './production.mjs', scripts: { test: 'node --test discount.test.mjs' },
  }))
  writeFileSync(join(root, 'production.mjs'), 'export default function (total) { return total * 0.05; }\n')
  assert.equal(contract(goal).acceptance[0]?.verification.executable_id, undefined)
})

test('task command restrictions are exact and do not turn quoted evidence into a denial', () => {
  const active = ['Repair the parser. Do not run `npm test`.']
  assert.equal(taskProhibitsCommand(active, 'npm run test'), true)
  assert.equal(taskProhibitsCommand(active, 'node --test other.mjs'), false)
  assert.equal(taskProhibitsCommand(['Please don’t run npm. Repair the parser.'], 'npm test'), true)
  assert.equal(taskProhibitsCommand(['The log said "Skipped. Do not run npm." Repair the parser.'], 'npm test'), false)
  assert.equal(taskProhibitsCommand(['Do not run npm or yarn.'], 'npm test'), true)
  assert.equal(taskProhibitsCommand(['Do not run npm or yarn.'], 'yarn test'), true)
  assert.equal(taskProhibitsCommand(['You must not run npm.'], 'npm test'), true)
  assert.equal(taskProhibitsCommand(['Do not run npm during this task.'], 'npm test'), true)
  assert.equal(taskProhibitsCommand(['Do not run npm and do not run yarn.'], 'yarn test'), true)
  assert.equal(taskProhibitsCommand(['Do not run `npm test` or `yarn build`.'], 'yarn test'), false)
  assert.equal(taskProhibitsCommand(['Do not edit files or run any tests or shell commands.'], 'node file.mjs'), true)
  assert.equal(taskProhibitsCommand(['The issue said "Do not run npm".'], 'npm test'), false)
})

test('a point needs the complete frozen runner report and newer same-scope checks supersede it', () => {
  const witness = { entry: 'node --test point.test.mjs', npmScript: false, testNames: ['discount point'] }
  const summary = (prefix: string) => [
    'tests 1', 'suites 0', 'pass 1', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0', 'duration_ms 10.9',
  ].map(line => `${prefix} ${line}`).join('\n')
  const tap = `TAP version 13\nok 1 - discount point\n1..1\n${summary('#')}\n`
  const spec = `✔ discount point (3.245ms)\n${summary('ℹ')}\n`
  assert.equal(nodePointExecuted(tap, witness), true)
  assert.equal(nodePointExecuted(spec, witness), true)
  assert.equal(nodePointExecuted(`\n> project@1.0.0 test\n> ${witness.entry}\n\n${spec}`, { ...witness, npmScript: true }), true)
  assert.equal(nodePointExecuted(`\n> project@1.0.0 test\n> node --test other.test.mjs\n\n${spec}`, { ...witness, npmScript: true }), false)
  assert.equal(nodePointExecuted(`${tap}\n✔ other (1ms)\n${summary('ℹ')}`, witness), false)
  for (const result of ['ok 1 - other', 'ok 1 - discount point # SKIP', 'not ok 1 - discount point', '# ok 1 - discount point']) {
    assert.equal(nodePointExecuted(tap.replace('ok 1 - discount point', result), witness), false)
  }
  const green = { command: 'npm test', exit_code: 0, summary: 'pass', target: POINT_TARGET_PREFIX + 'frozen',
    order: { sessionId: 'current', seq: 3 }, working_directory: '.', environment_policy: 'host-process' }
  const later = { command: 'npm  test', exit_code: 0, summary: 'different test passed',
    order: { sessionId: 'current', seq: 4 }, working_directory: '.', environment_policy: 'host-process' }
  assert.deepEqual(retainCurrentPointReceipts([green, later]), [later])
  assert.deepEqual(retainCurrentPointReceipts([{ ...green, target: 'node-test-point:v1:legacy' }]), [])
  assert.deepEqual(retainCurrentPointReceipts([green, { ...later, working_directory: 'other' }]),
    [green, { ...later, working_directory: 'other' }])
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

test('a frozen single-case verifier cannot cover a broader arithmetic goal', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-arithmetic-criterion-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test math.test.mjs' } }))
  writeFileSync(join(root, 'math.js'), 'export const add = (a, b) => 5\n')
  writeFileSync(join(root, 'math.test.mjs'), [
    'import test from "node:test"',
    'import assert from "node:assert/strict"',
    'import { add } from "./math.js"',
    'test("one case", () => assert.equal(add(2, 3), 5))',
  ].join('\n'))
  for (const [goal, verifier] of [
    ['Fix math.js so add(2, 3) returns 5.', /^verifier:npm$/],
    ['Fix math.js so add returns the correct sum for any two integers, for example add(2, 3) returns 5.', /^meaning:/],
    ['Fix math.js so addition works for all signed integers, e.g. add(2, 3) returns 5.', /^meaning:/],
    ['Fix math.js so add returns the sum of its two operands for all integer inputs, e.g. add(2, 3) returns 5.', /^meaning:/],
    ['Fix math.js so add always returns the sum of its two inputs, e.g. add(2, 3) returns 5.', /^meaning:/],
  ] as const) {
    const { taskContract } = resolveLiveSessionAuthority({
      mode: 'chat', task: `${goal}\nRequirements: npm test must pass`, projectRoot: root,
      projectTestCommands: ['npm test'], verifierRequirements: ['npm test'],
    })
    const [behavior, testCommand] = taskContract.acceptance
    assert.equal(behavior?.description, goal)
    assert.match(behavior!.verification.verifier_id, verifier)
    assert.equal(testCommand?.verification.verifier_id, 'verifier:npm')
  }
})

test('v4 binds equivalent labeled verifier links without rewriting their source text', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-labeled-criterion-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test exporter.test.mjs' } }))
  writeFileSync(join(root, 'exporter.mjs'), 'export const exportRows = rows => [...rows]\n')
  writeFileSync(join(root, 'exporter.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { exportRows } from "./exporter.mjs";',
    'test("exports every record", () => assert.deepEqual(exportRows([1, 2]), [1, 2]));',
  ].join('\n') + '\n')
  const behavior = 'Fix the export to include every record'
  for (const prefix of ['Goal: ', '**Goal:** ', 'Objective: ', '']) {
    const criterion = `${prefix}${behavior}; verified by: \`npm test\` must pass.`
    const task = `Goal: ${behavior}.\r\nRequirements:\r\n- ${criterion}`
    const contract = resolveLiveSessionAuthority({
      mode: 'chat', task, projectRoot: root, projectTestCommands: ['npm test'],
    }).taskContract
    assert.deepEqual(contract.acceptance_criteria, [`${behavior}.`, criterion])
    assert.deepEqual(contract.acceptance.map(item => item.verification.verifier_id), ['verifier:npm', 'verifier:npm'])
    assert.ok(contract.acceptance.every(item => item.verification.argv?.join(' ') === 'test'))
  }
})

test('v4 binds every equivalent explicit verifier link and retains both source spans', () => {
  const behavior = 'Fix the export to include every record'
  const link = `${behavior}; verified by: npm test must pass.`
  const bullets = [`- Goal: ${link}`, `- Objective: ${link}`]
  const task = [`Goal: ${behavior}.`, 'Requirements:', ...bullets].join('\r\n')
  const meaning = inferTaskAcceptanceV4(task)
  const bound = bindExecutableVerifiersToTaskAcceptance({
    meaning, trustedVerifierCommands: ['npm test'],
  })
  assert.deepEqual(bound.criteria.slice(1).map(item => `- ${item.description}`), bullets)
  assert.deepEqual(bound.sources.slice(1).map(source => task.slice(source.start, source.end)), bullets)
  assert.deepEqual(bound.criteria.map(item => item.verification.argv), [['test'], ['test'], ['test']])
})

test('labeled verifier comparisons are v4-only and keep distinct literals unbound', () => {
  const behavior = "Fix parser.js so echo('A  B') returns 'A  B'"
  const task = (linked: string) =>
    `${behavior}.\nRequirements:\n- Goal: ${linked}; verified by: \`npm test\` must pass.`
  const bound = (meaning: ReturnType<typeof inferTaskAcceptance>) => bindExecutableVerifiersToTaskAcceptance({
    meaning, trustedVerifierCommands: ['npm test'],
  }).criteria
  assert.match(bound(inferTaskAcceptanceV3(task(behavior)))[0]!.verification.verifier_id, /^meaning:/)
  assert.equal(bound(inferTaskAcceptanceV4(task(behavior)))[0]!.verification.verifier_id, 'verifier:npm')
  for (const variant of [behavior.replaceAll('A  B', 'A B'), behavior.replaceAll('A  B', 'a  b')]) {
    const [goal, link] = bound(inferTaskAcceptanceV4(task(variant)))
    assert.match(goal!.verification.verifier_id, /^meaning:/)
    assert.equal(link!.verification.verifier_id, 'verifier:npm')
  }
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

test('v4 keeps equivalent labels with conflicting verifier commands unbound', () => {
  const behavior = 'Fix the export to include every record'
  const task = [
    `Goal: ${behavior}.`,
    'Requirements:',
    `- Goal: ${behavior}; verified by: npm test must pass.`,
    `- Objective: ${behavior}; verified by: npm run test:export must pass.`,
  ].join('\n')
  const { criteria } = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptanceV4(task),
    trustedVerifierCommands: ['npm test', 'npm run test:export'],
  })
  assert.equal(criteria.length, 3)
  assert.ok(criteria.every(item => item.verification.verifier_id.startsWith('meaning:')))
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
