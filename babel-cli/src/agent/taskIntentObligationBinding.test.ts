/**
 * W01 (#522): an inferred behavioral goal may bind a discovered verifier only
 * when its own text, the verifier input contents, and the frozen input set
 * establish relevance; unfrozen or unrelated evidence stays fail-closed.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import {
  admissionVerifierFreezeCommands,
  contractVerifierCommands,
  seedChatVerifierDependencyHashes,
} from './verifierDependencyAdmission.js'
import { contractMeaningVerifierCommands } from './taskAcceptanceExecutableBinding.js'
import { chatReceiptMatchesRequirement } from '../authority/criterionVerifierDispatch.js'

function parserProject(input: {
  testFile: string
  testSource: string
  extraScripts?: Record<string, string>
  secondTestFile?: string
  secondTestSource?: string
}): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-w01-relevance-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return a - b; }\nexport function parseMinus(a, b) { return a - b; }\n')
  writeFileSync(join(root, 'test', input.testFile), input.testSource)
  if (input.secondTestFile && input.secondTestSource) {
    writeFileSync(join(root, 'test', input.secondTestFile), input.secondTestSource)
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'w01-relevance',
    private: true,
    type: 'module',
    scripts: {
      test: `node --test test/${input.testFile}`,
      ...(input.extraScripts ?? {}),
    },
  }))
  return root
}

const RELEVANT_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { parseSum } from "../src/parser.js";',
  'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
].join('\n') + '\n'

const UNRELATED_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'test("unrelated", () => assert.equal(2 + 2, 4));',
].join('\n') + '\n'

const TASK = 'Fix parser.js so parseSum(2, 3) returns 5.'

test('TF-03: a relevant frozen project verifier binds the inferred behavioral goal', t => {
  const root = parserProject({ testFile: 'parser.test.mjs', testSource: RELEVANT_TEST })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: TASK,
    projectRoot: root,
    projectTestCommands: ['npm test'],
  }).taskContract
  const goal = contract.acceptance.find(item => item.description === TASK)
  assert.ok(goal)
  assert.equal(goal.verification.verifier_id, 'verifier:npm')
  assert.deepEqual(goal.verification.argv, ['test'])
  assert.equal(goal.type, 'unit_test')
  assert.ok(contract.protected_paths.includes('test/parser.test.mjs'),
    'the verifier input must be frozen before the candidate can edit it')
  assert.ok(contract.protected_paths.includes('package.json'))
})

test('TF-04: an unrelated green suite does not bind the behavioral goal', t => {
  const root = parserProject({ testFile: 'unrelated.test.mjs', testSource: UNRELATED_TEST })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: TASK,
    projectRoot: root,
    projectTestCommands: ['npm test'],
  }).taskContract
  const goal = contract.acceptance.find(item => item.description === TASK)
  assert.ok(goal)
  assert.ok(goal.verification.verifier_id.startsWith('meaning:'),
    'a suite that does not exercise parseSum cannot prove the goal')
})

test('TF-04: a same-named test that does not reference the goal stays unbound', t => {
  const root = parserProject({
    testFile: 'parser.test.mjs',
    testSource: [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { parseMinus } from "../src/parser.js";',
      'test("minus", () => assert.equal(parseMinus(2, 3), -1));',
    ].join('\n') + '\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: TASK,
    projectRoot: root,
    projectTestCommands: ['npm test'],
  }).taskContract
  const goal = contract.acceptance.find(item => item.description === TASK)
  assert.ok(goal?.verification.verifier_id.startsWith('meaning:'))
})

test('TF-04: ambiguous relevant verifiers stay unbound', t => {
  const root = parserProject({
    testFile: 'parser.test.mjs',
    testSource: RELEVANT_TEST,
    extraScripts: { verify: 'node --test test/parser-extra.test.mjs' },
    secondTestFile: 'parser-extra.test.mjs',
    secondTestSource: RELEVANT_TEST,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: TASK,
    projectRoot: root,
    projectTestCommands: ['npm test', 'npm run verify'],
  }).taskContract
  const goal = contract.acceptance.find(item => item.description === TASK)
  assert.ok(goal?.verification.verifier_id.startsWith('meaning:'))
})

test('TF-27: an admitted witness is seeded into the tamper guard even without discovery', t => {
  const root = parserProject({ testFile: 'parser.test.mjs', testSource: RELEVANT_TEST })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: TASK,
    projectRoot: root,
    projectTestCommands: ['npm test'],
  }).taskContract
  const bound = contractVerifierCommands(contract.acceptance)
  assert.deepEqual(bound, ['npm test'])
  assert.deepEqual(admissionVerifierFreezeCommands({
    task: TASK,
    resolvedVerifierCommands: [],
    discoveredTestCommands: [],
  }), [])
  const hashes = new Map<string, string>()
  const unfrozen = seedChatVerifierDependencyHashes({
    task: TASK,
    projectRoot: root,
    hashes,
    resolvedVerifierCommands: [],
    discoveredTestCommands: [],
    meaningVerifierCommands: contractMeaningVerifierCommands(contract.acceptance),
  })
  assert.equal(unfrozen, false)
  assert.ok(hashes.has('test/parser.test.mjs'),
    'the witness input is watched for tampering from admission')
  assert.ok([...hashes.keys()].includes('package.json'))
})

test('TF-03 dispatch: only the bound command receipt covers the inferred goal', t => {
  const root = parserProject({ testFile: 'parser.test.mjs', testSource: RELEVANT_TEST })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: TASK,
    projectRoot: root,
    projectTestCommands: ['npm test'],
  }).taskContract
  const goal = contract.acceptance.find(item => item.description === TASK)!
  assert.equal(goal.verification.verifier_id, 'verifier:npm')
  const receipt = {
    verifierId: 'verifier:npm',
    verifier_id: 'verifier:npm',
    command: 'npm test',
    argv: ['npm', 'test'],
    summary: '# tests 1\n# fail 0',
    exit_code: 0,
    stale: false,
    working_directory: '.',
    environment_policy: 'host-process',
  }
  assert.equal(chatReceiptMatchesRequirement(receipt, goal), true,
    'a current green run of the relevance-bound command proves the goal')
  const unrelated = {
    ...receipt,
    verifierId: 'verifier:node',
    verifier_id: 'verifier:node',
    command: 'node --test test/unrelated.test.mjs',
    argv: ['node', '--test', 'test/unrelated.test.mjs'],
  }
  assert.equal(chatReceiptMatchesRequirement(unrelated, goal), false,
    'a different green command cannot dispatch to the behavioral requirement')
})

test('P1-1: weak inputs never bind the behavioral goal', t => {
  const weakSources = [
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { parseSum } from "../src/parser.js";',
      '// TODO: parseSum(2, 3) should return 5',
      'test("unrelated arithmetic", () => assert.equal(2 + 3, 5));',
    ].join('\n') + '\n',
    [
      'import test from "node:test";',
      'test.skip("parseSum(2, 3) returns 5", () => {',
      '  // parseSum(2, 3) returns 5',
      '});',
    ].join('\n') + '\n',
    [
      'import test from "node:test";',
      'describe.skip("parser", () => {',
      '  test("sum", () => assert.equal(parseSum(2, 3), 5));',
      '});',
    ].join('\n') + '\n',
    [
      'import test from "node:test";',
      'test("negated", () => assert.notEqual(parseSum(2, 3), 5));',
    ].join('\n') + '\n',
    [
      'import test from "node:test";',
      'test("parseSum(2, 3) returns 5", () => { assert.ok(true); });',
    ].join('\n') + '\n',
    [
      'import test from "node:test";',
      '// assert.equal(parseSum(2, 3), 5);',
      'test("comment only", () => {});',
    ].join('\n') + '\n',
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'const dead = () => assert.equal(parseSum(2, 3), 5);',
      'test("does not exercise the goal", () => assert.ok(true));',
    ].join('\n') + '\n',
  ]
  for (const [index, testSource] of weakSources.entries()) {
    const root = parserProject({ testFile: 'parser.test.mjs', testSource })
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const contract = resolveLiveSessionAuthority({
      mode: 'chat',
      task: TASK,
      projectRoot: root,
      projectTestCommands: ['npm test'],
    }).taskContract
    const goal = contract.acceptance.find(item => item.description === TASK)
    assert.ok(goal?.verification.verifier_id.startsWith('meaning:'),
      `weak evidence case ${index} must not bind the goal`)
  }
})

test('P1-1: a real assertion still binds the behavioral goal', t => {
  const root = parserProject({ testFile: 'parser.test.mjs', testSource: RELEVANT_TEST })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: TASK,
    projectRoot: root,
    projectTestCommands: ['npm test'],
  }).taskContract
  const goal = contract.acceptance.find(item => item.description === TASK)
  assert.equal(goal?.verification.verifier_id, 'verifier:npm')
})

test('P3-1: a bound verifier whose inputs cannot be frozen fails closed', t => {
  const root = parserProject({ testFile: 'parser.test.mjs', testSource: RELEVANT_TEST })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const packagePath = join(root, 'package.json')
  writeFileSync(packagePath, JSON.stringify({
    name: 'w01-relevance',
    private: true,
    type: 'module',
    scripts: { test: 'node --test test/*.test.mjs' },
  }))
  const hashes = new Map<string, string>()
  const unfrozen = seedChatVerifierDependencyHashes({
    task: TASK,
    projectRoot: root,
    hashes,
    resolvedVerifierCommands: [],
    discoveredTestCommands: [],
    meaningVerifierCommands: ['npm test'],
  })
  assert.equal(unfrozen, true,
    'a glob script hides the executed test file and must not certify')
  assert.equal(hashes.has('test/parser.test.mjs'), false)
  assert.equal(hashes.has('package.json'), true, 'package.json alone is not sufficient evidence')

  const explicit = parserProject({ testFile: 'parser.test.mjs', testSource: RELEVANT_TEST })
  t.after(() => rmSync(explicit, { recursive: true, force: true }))
  const command = 'node --test test/parser.test.mjs'
  const frozen = new Map<string, string>()
  assert.equal(seedChatVerifierDependencyHashes({
    task: TASK,
    projectRoot: explicit,
    hashes: frozen,
    resolvedVerifierCommands: [],
    discoveredTestCommands: [],
    meaningVerifierCommands: [command],
  }), false)
  assert.equal(frozen.has('test/parser.test.mjs'), true)
})

test('P1 no-call goal: HTML result must match the exact literal in an assertion', t => {
  const htmlGoal = 'Fix parser.js so output is <pre>A  B</pre>.'
  const matching = parserProject({
    testFile: 'parser.test.mjs',
    testSource: [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { render } from "../src/parser.js";',
      'test("render preserves pre content", () => assert.equal(render("A  B"), "<pre>A  B</pre>"));',
      '',
    ].join('\n'),
  })
  t.after(() => rmSync(matching, { recursive: true, force: true }))
  const bound = resolveLiveSessionAuthority({
    mode: 'chat', task: htmlGoal, projectRoot: matching, projectTestCommands: ['npm test'],
  }).taskContract.acceptance.find(item => item.description === htmlGoal)
  assert.equal(bound?.verification.verifier_id, 'verifier:npm')

  const singleSpace = parserProject({
    testFile: 'parser.test.mjs',
    testSource: [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { render } from "../src/parser.js";',
      'test("render preserves pre content", () => assert.equal(render("A B"), "<pre>A B</pre>"));',
      '',
    ].join('\n'),
  })
  t.after(() => rmSync(singleSpace, { recursive: true, force: true }))
  const unbound = resolveLiveSessionAuthority({
    mode: 'chat', task: htmlGoal, projectRoot: singleSpace, projectTestCommands: ['npm test'],
  }).taskContract.acceptance.find(item => item.description === htmlGoal)
  assert.ok(unbound?.verification.verifier_id.startsWith('meaning:'),
    'a single-space witness or a title containing "pre" cannot bind a double-space goal')
})

test('P1 dead guard: a falsy literal block is not assertion evidence', t => {
  for (const guard of ['if (false)', 'if (0)', 'while (false)']) {
    const root = parserProject({
      testFile: 'parser.test.mjs',
      testSource: [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'test("looks like a check", () => {',
        `  ${guard} { assert.equal(parseSum(2, 3), 5); }`,
        '});',
        '',
      ].join('\n'),
    })
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const goal = resolveLiveSessionAuthority({
      mode: 'chat', task: TASK, projectRoot: root, projectTestCommands: ['npm test'],
    }).taskContract.acceptance.find(item => item.description === TASK)
    assert.ok(goal?.verification.verifier_id.startsWith('meaning:'), guard)
  }
})

test('P1 over-tightening: const and computed expected values still bind', t => {
  const sources = [
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { parseSum } from "../src/parser.js";',
      'const five = 5;',
      'test("sum", () => assert.equal(parseSum(2, 3), five));',
      '',
    ].join('\n'),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { parseSum } from "../src/parser.js";',
      'test("sum", () => assert.equal(parseSum(2, 3), 2 + 3));',
      '',
    ].join('\n'),
  ]
  for (const [index, testSource] of sources.entries()) {
    const root = parserProject({ testFile: 'parser.test.mjs', testSource })
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const goal = resolveLiveSessionAuthority({
      mode: 'chat', task: TASK, projectRoot: root, projectTestCommands: ['npm test'],
    }).taskContract.acceptance.find(item => item.description === TASK)
    assert.equal(goal?.verification.verifier_id, 'verifier:npm', `literal idiom ${index}`)
  }
})
