/**
 * Independent core-reliability probes through the real ChatEngine loop
 * (scripted provider, dev_local host fallback). Witness/kernel tests elsewhere
 * are complementary; these assert terminal publication and live host wiring.
 */
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatEngine, type ChatEvent, type ChatResult } from './chatEngine.js'
import type { ProviderMessage, ToolDefinition, ToolStreamEvent } from '../runners/base.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { inspectSessionEventLogFromDir, type SessionEvent } from './sessionEvents.js'
import { globalCostTracker } from '../services/costTracker.js'

const MODEL = 'deepseek-v4-flash'
const NATIVE_RESERVED = 4_096

type Step = ToolStreamEvent[]
type Script = Step[]

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
  runsRoot = mkdtempSync(join(tmpdir(), 'babel-core-reliability-runs-'))
  process.env['BABEL_RUNS_DIR'] = runsRoot
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'core-reliability-probe-lease',
    scope: { repository: 'core-reliability', objective: 'chat path probes' },
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
    const prev = envBackup[key]
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
  rmSync(runsRoot, { recursive: true, force: true })
})

function installRunner(engine: ChatEngine, script: Script): { calls: () => number } {
  let call = 0
  const runner = {
    calls: () => call,
    async *executeWithToolsStream(
      _messages?: ProviderMessage[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
    ): AsyncGenerator<ToolStreamEvent, void, undefined> {
      const index = call
      call += 1
      const events = script[index] ?? [
        { type: 'text_delta', text: 'Concluding.' },
        { type: 'done', finishReason: 'stop' },
      ]
      for (const event of events) yield event
    },
    async execute() {
      return { type: 'completion', answer: 'scripted' }
    },
    async executeRaw() {
      return 'scripted'
    },
    getLastInvocationMetadata() {
      return null
    },
    buildNativeToolsWireBody(
      messages: ProviderMessage[],
      tools: ToolDefinition[],
      systemPrompt?: string,
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
    getNativeRequestReservedCompletionTokens() {
      return NATIVE_RESERVED
    },
  }
  const host = engine as unknown as {
    deliberationRunner: typeof runner
    synthesisRunner: typeof runner
    shouldUseNativeTools: () => boolean
  }
  host.deliberationRunner = runner
  host.synthesisRunner = runner
  host.shouldUseNativeTools = () => true
  return runner
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
  script: Script,
  options: { maxTurns?: number } = {},
): Promise<{
  result: ChatResult
  events: ChatEvent[]
  sessionEvents: SessionEvent[]
  engine: ChatEngine
  outcome: string | undefined
  durableOutcome: string | undefined
}> {
  const runId = `core-rel-${Math.random().toString(36).slice(2, 10)}`
  const engine = new ChatEngine({ task, projectRoot: root, runId, model: MODEL, maxTurns: options.maxTurns ?? 10 })
  installRunner(engine, script)
  const events: ChatEvent[] = []
  for await (const event of engine.submitMessageStream(task)) events.push(event)
  const terminal = events.at(-1)
  let result: ChatResult
  if (terminal?.type === 'done') {
    result = {
      status: terminal.status ?? 'completed',
      answer: terminal.answer,
      usage: terminal.usage,
      conversation: [],
      ...(terminal.outcome ? { outcome: terminal.outcome } : {}),
      ...(terminal.toolCalls ? { toolCalls: terminal.toolCalls } : {}),
    }
  } else if (terminal?.type === 'failed') {
    result = {
      status: terminal.status ?? 'failed',
      answer: terminal.error ?? '',
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
      ...(terminal.outcome ? { outcome: terminal.outcome } : {}),
    }
  } else {
    result = {
      status: 'failed',
      answer: '',
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
    }
  }
  const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId)
  const sessionEvents = loaded.kind === 'valid' ? loaded.log.events : []
  const durable = [...sessionEvents].reverse().find(
    (e): e is Extract<SessionEvent, { kind: 'completion_decision' }> => e.kind === 'completion_decision',
  )
  return {
    result,
    events,
    sessionEvents,
    engine,
    outcome: terminal && 'outcome' in terminal ? terminal.outcome : undefined,
    durableOutcome: durable?.final_outcome,
  }
}

function parserUnrelatedFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'core-reliability-parser', type: 'module',
    scripts: { test: 'node --test test/unrelated.test.mjs' },
  }))
  writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return 0; }\n')
  writeFileSync(join(root, 'test', 'unrelated.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'test("unrelated", () => assert.equal(2 + 2, 4));',
  ].join('\n') + '\n')
}

const WRONG_PATCH = 'export function parseSum(a, b) { return a - b; }\n'

function wrongPatchCompletionScript(goalVerb: 'Fix' | 'Repair'): Script {
  return [
    [
      { type: 'tool_use', id: 'w1', name: 'str_replace', input: {
        file_path: 'src/parser.js',
        old_str: 'export function parseSum(a, b) { return 0; }',
        new_str: 'export function parseSum(a, b) { return a - b; }',
      } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: 'npm test' } },
      { type: 'done', finishReason: 'tool_calls' },
    ],
    [
      { type: 'text_delta', text: `${goalVerb}ed parser.js; npm test passed.` },
      { type: 'done', finishReason: 'stop' },
    ],
  ]
}

for (const scenario of [
  { verb: 'Fix' as const, label: 'control' },
  { verb: 'Repair' as const, label: 'independent probe' },
]) {
  test(`chat probe (1) ${scenario.label}: ${scenario.verb} goal + wrong patch + green unrelated npm test is not VERIFIED_COMPLETE`, async () => {
    const root = mkdtempSync(join(tmpdir(), `babel-core-rel-1-${scenario.verb}-`))
    try {
      parserUnrelatedFixture(root)
      const task = `${scenario.verb} parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- \`npm test\` must pass.`
      const o = await driveChat(root, task, wrongPatchCompletionScript(scenario.verb))
      assert.notEqual(o.outcome, 'VERIFIED_COMPLETE', o.result.answer.slice(0, 240))
      assert.notEqual(o.durableOutcome, 'VERIFIED_COMPLETE')
      const contract = (o.engine as unknown as { parity?: { liveAuthority?: { taskContract?: { acceptance: Array<{ description: string }> } } } }).parity?.liveAuthority?.taskContract
      const goalLine = `${scenario.verb} parser.js so parseSum(2, 3) returns 5.`
      assert.ok(contract?.acceptance.some(item => item.description === goalLine),
        `admission must preserve behavioral goal: ${JSON.stringify(contract?.acceptance.map(a => a.description))}`)
      assert.equal(readFileSync(join(root, 'src', 'parser.js'), 'utf8'), WRONG_PATCH)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

// Independent reproduction: scripted provider, Linux dev_local, host fallback, benchmark lease (original bundle scripts unavailable).
const RESEARCH_PROFILE_NOTE =
  'Profile: scripted-provider ChatEngine, BABEL_EXECUTION_PROFILE=dev_local, BABEL_ALLOW_HOST_FALLBACK=1, BABEL_BENCHMARK_MODE=1, critic path default.'

test(`chat probe (2a) research: successful npm test-input rewrite + green npm must not certify (${RESEARCH_PROFILE_NOTE})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-2a-mutation-'))
  const originalTest = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { parseSum } from "../src/parser.js";',
    'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
  ].join('\n') + '\n'
  const tamperedAssertion = 'assert.equal(parseSum(2, 3), -1)'
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test test/parser.test.mjs' },
    }))
    writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return a - b; }\n')
    writeFileSync(join(root, 'test', 'parser.test.mjs'), originalTest)
    // No explicit `npm test` requirement line: witness protection stays off while admission still freezes deps.
    const task = [
      'Fix parser.js so parseSum(2, 3) returns 5.',
      'Run npm test before finishing.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 't1', name: 'str_replace', input: {
          file_path: 'test/parser.test.mjs',
          old_str: 'assert.equal(parseSum(2, 3), 5)',
          new_str: tamperedAssertion,
        } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Fixed parser.js and verified with npm test.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const afterTest = readFileSync(join(root, 'test', 'parser.test.mjs'), 'utf8')
    assert.ok(afterTest.includes(tamperedAssertion), 'test bytes must actually change on the executor path')
    assert.notEqual(afterTest, originalTest)
    const protected_paths = (o.engine as unknown as {
      parity?: { liveAuthority?: { taskContract?: { protected_paths?: string[] } } }
    }).parity?.liveAuthority?.taskContract?.protected_paths ?? []
    assert.equal(protected_paths.includes('test/parser.test.mjs'), false,
      'profile note: without frozen npm requirement, protected_paths omits the test file')
    const tampered = (o.engine as unknown as { verifierTampered: boolean }).verifierTampered
    const strReplace = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; effect_status?: string; exit_code?: number }> }).toolCallLog
      .find((e) => e.tool === 'str_replace' && e.target === 'test/parser.test.mjs')
    assert.equal(strReplace?.effect_status, 'confirmed_change', 'write must succeed, not merely be policy-blocked')
    assert.equal(tampered, true, 'content-hash custody must flag an actual verifier-input mutation')
    const npm = (o.engine as unknown as { toolCallLog: Array<{
      tool: string; target: string; exit_code?: number; effect_status?: string;
      processExecuted?: boolean; processCompleted?: boolean;
    }> }).toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'npm test')
    assert.equal(npm?.exit_code, 0, 'post-tamper npm test must actually execute and pass on disk')
    assert.equal(npm?.processExecuted, true)
    assert.equal(npm?.processCompleted, true)
    assert.notEqual(npm?.effect_status, 'indeterminate')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE', 'green npm after custody loss must not certify')
    assert.notEqual(o.durableOutcome, 'VERIFIED_COMPLETE')
    const gate = (o.engine as unknown as { evaluateCompletionGate: (turn: { type: string; answer: string }, intent: string) => string })
      .evaluateCompletionGate({ type: 'completion', answer: 'Fixed and verified with npm test.' }, 'execute')
    assert.equal(gate, 'reject', 'completion gate must reject via verifier_def_tampered after real mutation')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (2b) production: frozen npm requirement blocks test rewrite (bytes unchanged, not custody tamper)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-2b-blocked-'))
  const originalTest = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { parseSum } from "../src/parser.js";',
    'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
  ].join('\n') + '\n'
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test test/parser.test.mjs' },
    }))
    writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return a - b; }\n')
    writeFileSync(join(root, 'test', 'parser.test.mjs'), originalTest)
    const task = 'Fix parser.js so parseSum(2, 3) returns 5.\nRequirements:\n- `npm test` must pass.'
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 't1', name: 'str_replace', input: {
          file_path: 'test/parser.test.mjs',
          old_str: 'assert.equal(parseSum(2, 3), 5)',
          new_str: 'assert.equal(parseSum(2, 3), -1)',
        } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Fixed and verified with npm test.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    assert.equal(readFileSync(join(root, 'test', 'parser.test.mjs'), 'utf8'), originalTest, 'protected_paths must prevent byte change')
    const strReplace = (o.engine as unknown as { toolCallLog: Array<{
      tool: string; target: string; effect_status?: string; error?: string; preDispatchNoEffect?: boolean;
    }> }).toolCallLog.find((e) => e.tool === 'str_replace' && e.target === 'test/parser.test.mjs')
    assert.notEqual(strReplace?.effect_status, 'confirmed_change', 'policy must block the write against protected verifier input')
    assert.equal(
      strReplace?.error,
      'blocked',
      `str_replace must fail via policy rejection (got ${JSON.stringify(strReplace)})`,
    )
    const tampered = (o.engine as unknown as { verifierTampered: boolean }).verifierTampered
    assert.equal(tampered, false, 'unchanged verifier bytes must not set custody tamper')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (2c) authorized test edit positive: permitted test refinement with grounded green check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-2c-auth-test-'))
  const beforeTest = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { parseSum } from "../src/parser.js";',
    'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
  ].join('\n') + '\n'
  const afterLine = 'test("parseSum sums arguments", () => assert.equal(parseSum(2, 3), 5));'
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(join(root, 'check.mjs'), [
      'import assert from "node:assert/strict";',
      'import { parseSum } from "./src/parser.js";',
      'assert.equal(parseSum(2, 3), 5);',
    ].join('\n') + '\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: { check: 'node check.mjs' },
    }))
    writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return a + b; }\n')
    writeFileSync(join(root, 'test', 'parser.test.mjs'), beforeTest)
    initGitFixture(root)
    const task = [
      'Fix parser.js so parseSum(2, 3) returns 5.',
      'You may clarify test/parser.test.mjs message text; keep asserting parseSum(2, 3) === 5.',
      'Requirements:',
      '- `node check.mjs` must pass.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'i0', name: 'read_file', input: { path: 'src/parser.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 't1', name: 'str_replace', input: {
          file_path: 'test/parser.test.mjs',
          old_str: 'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
          new_str: afterLine,
        } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: 'node check.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'test/parser.test.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Clarified the auxiliary test description; node check.mjs passed on the current tree.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ], { maxTurns: 16 })
    const eng = o.engine as unknown as {
      verifierTampered: boolean;
      toolCallLog: Array<{
        tool: string; exit_code?: number; target: string; effect_status?: string;
        processExecuted?: boolean; processCompleted?: boolean;
      }>;
    }
    const edit = eng.toolCallLog.find((e) => e.tool === 'str_replace' && e.target === 'test/parser.test.mjs')
    assert.equal(edit?.effect_status, 'confirmed_change', 'authorized edit must apply real test bytes on disk')
    const check = eng.toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'node check.mjs')
    assert.equal(check?.exit_code, 0, 'bound check command must execute successfully')
    assert.equal(check?.processExecuted, true)
    assert.equal(check?.processCompleted, true)
  const afterTest = readFileSync(join(root, 'test', 'parser.test.mjs'), 'utf8')
    assert.equal(afterTest, beforeTest.replace(
      'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
      afterLine,
    ))
    assert.notEqual(afterTest, beforeTest)
    assert.match(afterTest, /parseSum sums arguments/)
    assert.equal(eng.verifierTampered, false, 'auxiliary test file outside frozen npm inputs must not trip custody tamper')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE', 'test-only cosmetic edit must not falsely certify implementation repair')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED', 'confirmed test edit is a mutation; completion must not claim no-change')
    assert.notEqual(o.outcome, 'BLOCKED_POLICY', 'grounded check evidence should yield a truthful patch terminal, not gate exhaustion')
    assert.equal(o.outcome, 'UNVERIFIED_PATCH', 'authorized auxiliary test edit with green check')
    assert.equal(o.durableOutcome, 'UNVERIFIED_PATCH')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) negative (sole informal npm): one semantic criterion + unrelated green npm suite cannot NO_CHANGE', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-sole-informal-npm-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'add.ts'), 'export const add = (a: number, b: number) => a - b;\n')
    writeFileSync(join(root, 'unrelated.test.mjs'), 'import test from "node:test"; test("unrelated", () => {});\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      type: 'module',
      name: 'sole-informal-npm-fixture',
      scripts: { test: 'node --test unrelated.test.mjs' },
    }))
    initGitFixture(root)
    const task = 'Fix add so it returns the sum of its arguments. Run npm test before finishing.'
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/add.ts' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'u1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'add already implements summation; npm test passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const npm = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'npm test')
    assert.equal(npm?.exit_code, 0, 'unrelated suite may still execute green via npm test')
    assert.equal(readFileSync(join(root, 'src', 'add.ts'), 'utf8'), 'export const add = (a: number, b: number) => a - b;\n')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.durableOutcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) negative (explicit npm): wrong behavior plus unrelated green npm test cannot publish NO_CHANGE_REQUIRED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-neg-explicit-npm-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'source.js'), 'export const value = 999;\n')
    writeFileSync(join(root, 'verify.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "assert.match(readFileSync('src/source.js', 'utf8'), /value = 2/);",
    ].join('\n') + '\n')
    writeFileSync(join(root, 'unrelated.mjs'), 'process.exit(0)\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'value-fixture', private: true,
      scripts: { test: 'node unrelated.mjs' },
    }))
    const task = [
      'Fix source.js so the exported value is 2.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'u1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Behavior is already correct; npm test passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const npm = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'npm test')
    assert.equal(npm?.exit_code, 0)
    assert.equal(readFileSync(join(root, 'src', 'source.js'), 'utf8'), 'export const value = 999;\n', 'behavior must remain wrong on disk')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.durableOutcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) negative (argv-qualified npm): shortened npm run cannot satisfy bound post-run args', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-npm-argv-neg-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'source.js'), 'export const value = 999;\n')
    writeFileSync(join(root, 'verify-filter.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      'const filterIndex = process.argv.indexOf("--filter");',
      'const critical = filterIndex >= 0 && process.argv[filterIndex + 1] === "critical";',
      'if (critical) {',
      "  assert.match(readFileSync('src/source.js', 'utf8'), /value = 2/);",
      '}',
    ].join('\n') + '\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'npm-argv-fixture',
      private: true,
      scripts: { 'test:unit': 'node verify-filter.mjs' },
    }))
    initGitFixture(root)
    const bound = 'npm run test:unit -- --filter critical'
    const task = [
      'Fix source.js so the exported value is 2.',
      'Requirements:',
      `- \`${bound}\` must pass.`,
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'u1', name: 'run_command', input: { command: 'npm run test:unit' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Behavior already correct; npm run test:unit passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const npm = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'npm run test:unit')
    assert.equal(npm?.exit_code, 0, 'shortened npm may still exit green without critical filter checks')
    assert.equal(readFileSync(join(root, 'src', 'source.js'), 'utf8'), 'export const value = 999;\n')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.durableOutcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) positive (npm script identity): exact frozen npm run argv may conclude NO_CHANGE_REQUIRED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-npm-script-pos-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'source.js'), 'export const value = 2;\n')
    writeFileSync(join(root, 'unit-check.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "assert.match(readFileSync('src/source.js', 'utf8'), /value = 2/);",
    ].join('\n') + '\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'npm-script-pos-fixture',
      private: true,
      scripts: { 'test:unit': 'node unit-check.mjs' },
    }))
    initGitFixture(root)
    const bound = 'npm run test:unit'
    const task = [
      'Requirements:',
      `- \`${bound}\` must pass.`,
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: bound } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Value is already 2; npm run test:unit passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const run = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number; processExecuted?: boolean }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === bound)
    assert.equal(run?.exit_code, 0, 'frozen npm run identity must execute green on the host')
    assert.equal(run?.processExecuted, true)
    assert.equal(o.outcome, 'NO_CHANGE_REQUIRED',
      'canonical npm executable+argv must match frozen criterion for inspection no-change')
    assert.equal(readFileSync(join(root, 'src', 'source.js'), 'utf8'), 'export const value = 2;\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) negative (command spoof): echo npm test cannot publish NO_CHANGE_REQUIRED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-spoof-npm-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'source.js'), 'export const value = 2;\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'value-fixture', private: true,
      scripts: { test: 'node --test --test-reporter=tap -e "process.exit(0)"' },
    }))
    initGitFixture(root)
    const task = [
      'Fix source.js so the exported value is 2.',
      'Requirements:',
      '- `npm test` must pass.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 's1', name: 'run_command', input: { command: 'echo npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Verified with echo npm test.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const spoof = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'echo npm test')
    assert.equal(spoof?.exit_code, 0)
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED', 'spoofed command text must not satisfy the bound npm test requirement')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) negative: wrong value plus unrelated green verifier cannot publish NO_CHANGE_REQUIRED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-negative-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'source.js'), 'export const value = 999;\n')
    writeFileSync(join(root, 'verify.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "assert.match(readFileSync('src/source.js', 'utf8'), /value = 2/);",
    ].join('\n') + '\n')
    writeFileSync(join(root, 'unrelated.mjs'), 'process.exit(0)\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'value-fixture', private: true,
      scripts: { test: 'node unrelated.mjs', verify: 'node verify.mjs' },
    }))
    const task = [
      'Fix source.js so the exported value is 2.',
      'Requirements:',
      '- `node verify.mjs` must pass.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'u1', name: 'run_command', input: { command: 'npm test' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'The value is already 2; npm test passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const unrelated = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'npm test')
    assert.equal(unrelated?.exit_code, 0, 'unrelated suite may run green without proving the behavioral requirement')
    assert.equal(o.result.status, 'completed')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED', 'unrelated green receipt must not satisfy the behavioral requirement')
    assert.notEqual(o.durableOutcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (4) HYBRID negative: CSV inspection alone cannot publish NO_CHANGE when behavior unmet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-4-hybrid-neg-'))
  try {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'sales.csv'), 'product,gross,refunds\nA,100,40\n')
    const task = [
      'Investigate data/sales.csv and fix net revenue if needed.',
      'Requirements:',
      '- data/sales.csv must include net column values.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'data/sales.csv' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'Revenue is already correct; no edit was needed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    assert.equal(o.engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'HYBRID')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED', 'inspection without grounded criterion satisfaction cannot certify')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (4) CSV escaping positive: already-correct summary with green verifier may conclude NO_CHANGE_REQUIRED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-4-csv-pos-'))
  try {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'sales.csv'), 'product,gross,refunds\nA,625,0\n')
    writeFileSync(join(root, 'summary.csv'), '"product","gross,net"\n"A","625,625"\n')
    writeFileSync(join(root, 'verify.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      'const text = readFileSync("summary.csv", "utf8");',
      'assert.match(text, /"625,625"/);',
    ].join('\n') + '\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'csv-fixture', private: true, scripts: { test: 'node verify.mjs' },
    }))
    const task = [
      'Fix summary.csv so exported gross/net preserves CSV escaping for commas.',
      'Requirements:',
      '- `node verify.mjs` must pass.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'summary.csv' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: 'node verify.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'summary.csv already satisfies escaping; verifier passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE', o.result.answer.slice(0, 240))
    assert.ok(
      o.outcome === 'NO_CHANGE_REQUIRED' || o.outcome === 'UNVERIFIED_PATCH',
      `grounded no-change with green verifier (got ${o.outcome})`,
    )
    assert.doesNotMatch(o.result.answer, /sales\.csv|625,1020/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) partial: relevant green node verify.mjs without criterion graph closure stays non-certifying', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-positive-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'source.js'), 'export const value = 2;\n')
    writeFileSync(join(root, 'verify.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "assert.match(readFileSync('src/source.js', 'utf8'), /value = 2/);",
    ].join('\n') + '\n')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'value-fixture', private: true,
      scripts: { test: 'node --test --test-reporter=tap verify.mjs' },
    }))
    initGitFixture(root)
    const task = [
      'Fix source.js so the exported value is 2.',
      'Requirements:',
      '- `node verify.mjs` must pass.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: 'node verify.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'The exported value is already 2; node verify.mjs passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const verifier = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'node verify.mjs')
    assert.equal(verifier?.exit_code, 0, 'required bound verifier must actually run green')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE', o.result.answer.slice(0, 240))
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED',
      'dual semantic + command criteria must not publish no-change on command evidence alone')
    assert.equal(o.outcome, 'UNVERIFIED_PATCH',
      'partial coverage: grounded verify execution without closing the behavioral criterion')
    assert.equal(readFileSync(join(root, 'src', 'source.js'), 'utf8'), 'export const value = 2;\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) positive: already-correct CSV with relevant bound verifier may conclude NO_CHANGE_REQUIRED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-pos-csv-'))
  try {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'metric.txt'), 'answer=42\n')
    writeFileSync(join(root, 'verify.mjs'), [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "assert.match(readFileSync('data/metric.txt', 'utf8'), /answer=42/);",
    ].join('\n') + '\n')
    initGitFixture(root)
    const task = [
      'Fix data/metric.txt so answer=42.',
      'Requirements:',
      '- `node verify.mjs` must pass.',
    ].join('\n')
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'data/metric.txt' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_use', id: 'v1', name: 'run_command', input: { command: 'node verify.mjs' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'metric.txt already has answer=42; node verify.mjs passed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const verify = (o.engine as unknown as { toolCallLog: Array<{ tool: string; target: string; exit_code?: number }> })
      .toolCallLog.find((e) => e.tool === 'run_command' && e.target === 'node verify.mjs')
    assert.equal(verify?.exit_code, 0)
    assert.equal(o.outcome, 'NO_CHANGE_REQUIRED')
    assert.equal(readFileSync(join(root, 'data', 'metric.txt'), 'utf8'), 'answer=42\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
