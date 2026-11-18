/**
 * W01 (#522) end-to-end and decision-level controls for the intent/admission
 * seam. Scripted provider, dev_local host fallback: no paid provider call.
 *
 * Positive verifier journeys spawn a real test runner; the sandbox's
 * process-group settlement can abort a spawn under load, which is unrelated to
 * the decision under test. The deterministic controls below therefore assert
 * binding/dispatch directly, and only negative journeys (where a failed spawn
 * cannot certify anything) consume the real chat loop.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatEngine, type ChatEvent } from './chatEngine.js'
import type { ProviderMessage, ToolDefinition, ToolStreamEvent } from '../runners/base.js'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import { createCriterionCompletionServiceV1 } from '../authority/criterionCompletion.js'
import { resolveAcceptedReadOnlyTerminal } from './chatEngineMutatingNoChangeTerminal.js'
import type { GateToolLogEntry } from './completionGatePolicy.js'
import { publicApiPreservationViolation } from './publicApiPreservation.js'

const MODEL = 'deepseek-v4-flash'
const NATIVE_RESERVED = 4_096
const envHooks = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_LIVE',
] as const

let envBackup: Record<string, string | undefined> = {}
let runsRoot = ''

before(() => {
  envBackup = Object.fromEntries(envHooks.map(key => [key, process.env[key]]))
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-w01-journey-runs-'))
  process.env['BABEL_RUNS_DIR'] = runsRoot
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'w01-task-intent-journey',
    scope: { repository: 'w01', objective: 'task intent and witness binding' },
    allowedCapabilities: [
      'inspect_repository',
      'run_local_command',
      'run_tests',
      'edit_task_files',
      'run_arbitrary_code',
    ],
  })
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  process.env['BABEL_LIVE'] = '1'
})

after(() => {
  for (const key of envHooks) {
    const previous = envBackup[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  rmSync(runsRoot, { recursive: true, force: true })
})

function installRunner(engine: ChatEngine, script: ToolStreamEvent[][]): void {
  let call = 0
  const runner = {
    async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      const index = call
      call += 1
      const events = script[index] ?? [
        { type: 'text_delta', text: 'Concluding.' },
        { type: 'done', finishReason: 'stop' },
      ]
      for (const event of events) yield event
    },
    async execute() { return { type: 'completion', answer: 'scripted' } },
    async executeRaw() { return 'scripted' },
    getLastInvocationMetadata() { return null },
    buildNativeToolsWireBody(
      messages: ProviderMessage[],
      tools: ToolDefinition[],
      _systemPrompt?: string,
      options: { stream?: boolean; toolChoice?: 'auto' | 'required' } = {},
    ): string {
      return JSON.stringify({
        model: MODEL,
        stream: options.stream ?? true,
        max_tokens: NATIVE_RESERVED,
        temperature: 0,
        tools,
        tool_choice: options.toolChoice ?? 'auto',
        messages,
      })
    },
    getNativeRequestReservedCompletionTokens() { return NATIVE_RESERVED },
  }
  const host = engine as unknown as {
    deliberationRunner: typeof runner
    synthesisRunner: typeof runner
    shouldUseNativeTools: () => boolean
  }
  host.deliberationRunner = runner
  host.synthesisRunner = runner
  host.shouldUseNativeTools = () => true
}

function initGitFixture(root: string): void {
  for (const args of [
    ['init', '--quiet'],
    ['config', 'core.autocrlf', 'false'],
    ['config', 'user.email', 'fixture@example.test'],
    ['config', 'user.name', 'fixture'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

async function driveChat(
  root: string,
  task: string,
  script: ToolStreamEvent[][],
  options: { requiredVerifierCommands?: string[] } = {},
): Promise<{ outcome: string | undefined; answer: string; engine: ChatEngine }> {
  const runId = `w01-journey-${Math.random().toString(36).slice(2, 10)}`
  const engine = new ChatEngine({
    task,
    projectRoot: root,
    runId,
    model: MODEL,
    maxTurns: 12,
    ...(options.requiredVerifierCommands
      ? { requiredVerifierCommands: options.requiredVerifierCommands }
      : {}),
  })
  installRunner(engine, script)
  const events: ChatEvent[] = []
  for await (const event of engine.submitMessageStream(task)) events.push(event)
  const terminal = events.at(-1) as
    | { type: 'done' | 'failed'; outcome?: string; answer?: string; error?: string }
    | undefined
  return {
    outcome: terminal?.outcome,
    answer: terminal && 'answer' in terminal ? (terminal.answer ?? '') : (terminal?.error ?? ''),
    engine,
  }
}

const RELEVANT_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'import { parseSum } from "../src/parser.js";',
  'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
  '',
].join('\n')

const UNRELATED_TEST = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  'test("unrelated", () => assert.equal(2 + 2, 4));',
  '',
].join('\n')

const GOAL = 'Fix parser.js so parseSum(2, 3) returns 5.'
const VERIFIER = 'node --test --test-force-exit --experimental-test-isolation=none test/parser.test.mjs'

function parserFixture(opts: { parser: string; test: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-w01-journey-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'w01-journey',
    private: true,
    type: 'module',
  }))
  writeFileSync(join(root, 'src', 'parser.js'), opts.parser)
  writeFileSync(join(root, 'test', 'parser.test.mjs'), opts.test)
  initGitFixture(root)
  return root
}

test('TF-04 journey: unrelated green suite never certifies a wrong patch', async t => {
  const root = parserFixture({
    parser: 'export function parseSum(a, b) { return 0; }\n',
    test: UNRELATED_TEST,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const o = await driveChat(root, GOAL, [
    [{ type: 'tool_use', id: 'r0', name: 'read_file', input: { path: 'src/parser.js' } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 't1', name: 'str_replace', input: {
      file_path: 'src/parser.js',
      old_str: 'export function parseSum(a, b) { return 0; }',
      new_str: 'export function parseSum(a, b) { return a - b; }',
    } }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 'v1', name: 'run_command', input: { command: VERIFIER } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text_delta', text: 'Fixed parser; the test command passed.' },
      { type: 'done', finishReason: 'stop' }],
  ], { requiredVerifierCommands: [VERIFIER] })
  assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
  assert.equal(readFileSync(join(root, 'src', 'parser.js'), 'utf8'),
    'export function parseSum(a, b) { return a - b; }\n')
})

test('TF-07 journey: scoped preservation constraint cannot turn an untested repair into already-correct', async t => {
  const root = parserFixture({
    parser: 'export function parseSum(a, b) { return a - b; }\n',
    test: RELEVANT_TEST,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const task = [
    GOAL,
    'Do not change public APIs.',
    'Requirements:',
    `- \`${VERIFIER}\` must pass.`,
  ].join('\n')
  const o = await driveChat(root, task, [
    [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/parser.js' } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text_delta', text: 'parseSum is already implemented; no change is required.' },
      { type: 'done', finishReason: 'stop' }],
  ])
  assert.equal(o.outcome, 'BLOCKED_POLICY', o.answer.slice(0, 400))
  assert.equal(readFileSync(join(root, 'src', 'parser.js'), 'utf8'),
    'export function parseSum(a, b) { return a - b; }\n',
    'the wrong behavior stays on disk because it was never proven correct')
})

test('TF-12 decision: a relevant frozen green command closes inspection-only no-change', t => {
  const root = parserFixture({
    parser: 'export function parseSum(a, b) { return a + b; }\n',
    test: RELEVANT_TEST,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const contract = resolveLiveSessionAuthority({
    mode: 'chat',
    task: GOAL,
    projectRoot: root,
    projectTestCommands: [VERIFIER],
    verifierRequirements: [VERIFIER],
  }).taskContract
  const goal = contract.acceptance.find(item => item.description === GOAL)
  assert.equal(goal?.verification.verifier_id, 'verifier:node')

  const runId = 'w01-tf12-decision'
  const service = createCriterionCompletionServiceV1(() => ({
    contract,
    runId,
    projectRoot: root,
  }))
  const toolCallLog: GateToolLogEntry[] = [
    { tool: 'read_file', target: 'src/parser.js', detail: '49 B', exit_code: 0 },
    { tool: 'run_command', target: VERIFIER, exit_code: 0, effect_status: 'confirmed_no_change' },
  ]
  const allowed = resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog,
    criterionCompletion: service,
    buildCriterionRefresh: () => ({ criterionChatReceipts: [], candidate_sha: null, has_mutation: false }),
  })
  assert.equal(allowed, true,
    'the goal is command-bound and the exact frozen command ran green on the inspected tree')

  const unrelated = resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: [
      toolCallLog[0]!,
      { tool: 'run_command', target: 'node --test test/unrelated.test.mjs', exit_code: 0, effect_status: 'confirmed_no_change' },
    ],
    criterionCompletion: service,
    buildCriterionRefresh: () => ({ criterionChatReceipts: [], candidate_sha: null, has_mutation: false }),
  })
  assert.equal(unrelated, false,
    'an unrelated green command cannot close the behavioral requirement')
})

test('TF-16 journey: unverified patch names the missing evidence and a next action', async t => {
  const root = parserFixture({
    parser: 'export function parseSum(a, b) { return 0; }\n',
    test: UNRELATED_TEST,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const o = await driveChat(root, GOAL, [
    [{ type: 'tool_use', id: 'r0', name: 'read_file', input: { path: 'src/parser.js' } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 't1', name: 'str_replace', input: {
      file_path: 'src/parser.js',
      old_str: 'export function parseSum(a, b) { return 0; }',
      new_str: 'export function parseSum(a, b) { return a + b; }',
    } }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text_delta', text: 'parseSum now returns the sum.' },
      { type: 'done', finishReason: 'stop' }],
  ])
  assert.ok(
    o.outcome === 'UNVERIFIED_PATCH' || o.outcome === 'BLOCKED_POLICY',
    `correct patch without adequate witness stays visible and non-certified (got ${o.outcome})`,
  )
  assert.match(o.answer, /Fix parser\.js so parseSum\(2, 3\) returns 5\./,
    'the unverified report names the requirement that remains open')
  assert.match(o.answer, /required evidence:/,
    'the unverified report says which evidence would complete certification')
  assert.match(o.answer, /exact test command|frozen verifier/,
    'the next action is concrete, not just "not verified"')
})

test('P1-1 journey: a weak non-exercising test never certifies a wrong patch', async t => {
  const weak = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { parseSum } from "../src/parser.js";',
    '// TODO: parseSum(2, 3) should return 5',
    'test("unrelated arithmetic", () => assert.equal(2 + 3, 5));',
    '',
  ].join('\n')
  const root = parserFixture({ parser: 'export function parseSum(a, b) { return 0; }\n', test: weak })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const o = await driveChat(root, GOAL, [
    [{ type: 'tool_use', id: 'r0', name: 'read_file', input: { path: 'src/parser.js' } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 't1', name: 'str_replace', input: {
      file_path: 'src/parser.js',
      old_str: 'export function parseSum(a, b) { return 0; }',
      new_str: 'export function parseSum(a, b) { return a * b; }',
    } }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 'v1', name: 'run_command', input: { command: VERIFIER } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text_delta', text: 'Fixed parser; tests pass.' }, { type: 'done', finishReason: 'stop' }],
  ], { requiredVerifierCommands: [VERIFIER] })
  assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
  assert.equal(readFileSync(join(root, 'src', 'parser.js'), 'utf8'),
    'export function parseSum(a, b) { return a * b; }\n')
})

test('P1-2 journey: a public-surface rename is recorded as a preservation violation', async t => {
  const root = parserFixture({
    parser: 'export function parseSum(a, b) { return a - b; }\nexport function parseMinus(a, b) { return a - b; }\n',
    test: RELEVANT_TEST,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const task = [
    GOAL,
    'Do not change public APIs.',
    'Requirements:',
    `- \`${VERIFIER}\` must pass.`,
  ].join('\n')
  const o = await driveChat(root, task, [
    [{ type: 'tool_use', id: 'r0', name: 'read_file', input: { path: 'src/parser.js' } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 't1', name: 'str_replace', input: {
      file_path: 'src/parser.js',
      old_str: 'export function parseMinus(a, b) { return a - b; }',
      new_str: 'export function subtract(a, b) { return a - b; }',
    } }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 'v1', name: 'run_command', input: { command: VERIFIER } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text_delta', text: 'Refactored the parser and tests pass.' }, { type: 'done', finishReason: 'stop' }],
  ], { requiredVerifierCommands: [VERIFIER] })
  const contract = (o.engine as unknown as {
    parity?: { liveAuthority?: { taskContract?: { provenance: { records: Parameters<typeof publicApiPreservationViolation>[0]['records'] } } } }
  }).parity?.liveAuthority?.taskContract
  assert.ok(contract)
  assert.match(publicApiPreservationViolation({ records: contract.provenance.records, projectRoot: root }) ?? '',
    /public API surface changed/)
  assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
})

test('P3-3 journey: a relevance-bound verifier input cannot be rewritten', async t => {
  const root = parserFixture({
    parser: 'export function parseSum(a, b) { return a + b; }\n',
    test: RELEVANT_TEST,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const o = await driveChat(root, GOAL, [
    [{ type: 'tool_use', id: 'r0', name: 'read_file', input: { path: 'src/parser.js' } },
      { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'tool_use', id: 'e1', name: 'str_replace', input: {
      file_path: 'test/parser.test.mjs',
      old_str: 'assert.equal(parseSum(2, 3), 5)',
      new_str: 'assert.equal(parseSum(2, 3), -1)',
    } }, { type: 'done', finishReason: 'tool_calls' }],
    [{ type: 'text_delta', text: 'Adjusted the test.' }, { type: 'done', finishReason: 'stop' }],
  ], { requiredVerifierCommands: [VERIFIER] })
  const edit = (o.engine as unknown as {
    toolCallLog: Array<{ tool: string; target: string; error?: string; effect_status?: string }>
  }).toolCallLog.find(entry => entry.tool === 'str_replace' && entry.target === 'test/parser.test.mjs')
  assert.equal(edit?.error, 'blocked')
  assert.equal(readFileSync(join(root, 'test', 'parser.test.mjs'), 'utf8'), RELEVANT_TEST)
  assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
})

for (const shadow of [
  { name: 'uninitialized let', lines: ['let five;', 'five = 6;'] },
  { name: 'destructured let', lines: ['let { five } = { five: 6 };'] },
] as const) {
  test(`P1 journey: ${shadow.name} shadow never certifies a wrong patch`, async t => {
    const root = parserFixture({
      parser: 'export function parseSum(a, b) { return 0; }\n',
      test: [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { parseSum } from "../src/parser.js";',
        'const five = 5;',
        'test("shadow", () => {',
        ...shadow.lines.map(line => `  ${line}`),
        '  assert.equal(parseSum(2, 3), five);',
        '});',
        '',
      ].join('\n'),
    })
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const o = await driveChat(root, GOAL, [
      [{ type: 'tool_use', id: 'r0', name: 'read_file', input: { path: 'src/parser.js' } },
        { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_use', id: 't1', name: 'str_replace', input: {
        file_path: 'src/parser.js',
        old_str: 'export function parseSum(a, b) { return 0; }',
        new_str: 'export function parseSum(a, b) { return a * b; }',
      } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_use', id: 'v1', name: 'run_command', input: { command: VERIFIER } },
        { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text_delta', text: 'Fixed parser; tests pass.' }, { type: 'done', finishReason: 'stop' }],
    ], { requiredVerifierCommands: [VERIFIER] })
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
    assert.equal(readFileSync(join(root, 'src', 'parser.js'), 'utf8'),
      'export function parseSum(a, b) { return a * b; }\n')
  })
}
