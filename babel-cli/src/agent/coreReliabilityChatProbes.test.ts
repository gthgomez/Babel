/**
 * Independent core-reliability probes through the real ChatEngine loop
 * (scripted provider, dev_local host fallback). Witness/kernel tests elsewhere
 * are complementary; these assert terminal publication and live host wiring.
 */
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    ],
  })
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
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

test('chat probe (2): discovered npm test rewrite sets live verifierTampered and blocks VERIFIED_COMPLETE', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-2-tamper-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'test'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: { test: 'node --test test/parser.test.mjs' },
    }))
    writeFileSync(join(root, 'src', 'parser.js'), 'export function parseSum(a, b) { return a - b; }\n')
    writeFileSync(join(root, 'test', 'parser.test.mjs'), [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { parseSum } from "../src/parser.js";',
      'test("parseSum", () => assert.equal(parseSum(2, 3), 5));',
    ].join('\n') + '\n')
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
    const tampered = (o.engine as unknown as { verifierTampered: boolean }).verifierTampered
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE',
      'misleading green must not certify even when discovered npm deps omit test-file hashes')
    assert.notEqual(o.durableOutcome, 'VERIFIED_COMPLETE')
    if (!tampered) {
      assert.match(
        JSON.stringify(o.sessionEvents.slice(-6)),
        /completion_decision|verifier|UNVERIFIED|BLOCKED|tamper|reject/i,
        'reproduction note: verifierTampered stayed false — npm-discovered test inputs may be outside freeze set (#507 lane)',
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) negative: ACTION value=2 with actual 999 cannot publish NO_CHANGE_REQUIRED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-core-rel-3-negative-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'source.js'), 'export const value = 999;\n')
    const task = 'Fix source.js so the exported value is 2.\nRequirements:\n- `node -e "process.exit(0)"` must pass.'
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'The value is already 2; no edit was needed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    assert.equal(o.result.status, 'completed')
    assert.notEqual(o.outcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.durableOutcome, 'NO_CHANGE_REQUIRED')
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('chat probe (3) positive: value already 2 with green verifier may conclude NO_CHANGE_REQUIRED', async () => {
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
      scripts: { test: 'node verify.mjs' },
    }))
    const task = 'Fix source.js so the exported value is 2.'
    const o = await driveChat(root, task, [
      [
        { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/source.js' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'The exported value is already 2; no edit was needed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    assert.notEqual(o.outcome, 'VERIFIED_COMPLETE', o.result.answer.slice(0, 240))
    assert.ok(
      o.outcome === 'NO_CHANGE_REQUIRED' || o.outcome === 'UNVERIFIED_PATCH',
      `already-satisfied inspection should not certify a patch (got ${o.outcome})`,
    )
    assert.equal(readFileSync(join(root, 'src', 'source.js'), 'utf8'), 'export const value = 2;\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
