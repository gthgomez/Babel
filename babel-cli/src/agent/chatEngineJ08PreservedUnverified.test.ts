/**
 * P1 — J08-class answer loss at turn cap: production ChatEngine + OpenRouterApiRunner,
 * mocked HTTP transport only (dispatchFetch). Critic/compaction use production defaults.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { ChatEngine, type ChatEvent } from './chatEngine.js'
import type { ResolvedModelPolicy } from '../modelPolicy.js'
import { LIVE_OPENROUTER_MODEL_ID } from '../modelPolicy.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import { refreshDryRunState } from '../localTools.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { loadThreadEventLogFromDir } from './threadEventLog.js'

const J08_TASK =
  'Compute net revenue from 数据/sales.csv and create 数据/summary.csv with product, gross, refunds and net. Explain the total.'
const J08_MARKER = 'J08_PRESERVED_NET_200_EXPLANATION'
/** Untrusted model prose must not reclassify the authoritative failure tuple. */
const J08_UNTRUSTED_CLASSIFIER_TOKENS =
  'RESPONSE_EVIDENCE_INVALID NATIVE_TOOL_PROTOCOL_INVALID'
const OLD_SUBMISSION_MARKER = 'J08_OLD_SUBMISSION_STALE_CANDIDATE'
const RECOVERY_CHATTER_MARKER = 'J08_RECOVERY_CHATTER_NOT_PRESERVED'
const SUMMARY_CSV = [
  'product,gross,refunds,net',
  'A,100,20,130',
  'B,80,10,70',
  'TOTAL,,,200',
  '',
].join('\n')

/** Retained artifact refs may use OS-native separators in the presentation payload. */
const J08_RETAINED_SUMMARY_ARTIFACT = /数据[\\/]summary\.csv/

test('J08 retained summary artifact matcher accepts POSIX and Windows separators', () => {
  assert.match('数据/summary.csv', J08_RETAINED_SUMMARY_ARTIFACT)
  assert.match('数据\\summary.csv', J08_RETAINED_SUMMARY_ARTIFACT)
})

const OPENROUTER_POLICY: ResolvedModelPolicy = {
  policyPath: 'j08-preserve-unverified-fixture',
  family: 'openrouter',
  selectedTier: 'cheap',
  resolvedBackendKey: 'glm-5.3-flash',
  provider: 'openrouter',
  providerModelId: LIVE_OPENROUTER_MODEL_ID,
  expensive: false,
  enabled: true,
  experimental: false,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 4_096,
  nativeToolUse: true,
}

const MANAGED_ENV = [
  'BABEL_DRY_RUN',
  'BABEL_DRY_RUN_SOURCE',
  'BABEL_NATIVE_TOOLS',
  'BABEL_TOOL_PROFILE',
  'BABEL_CHAT_TASK_CLASS',
  'OPENROUTER_API_KEY',
] as const

function git(projectRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(projectRoot, 'no-global-gitconfig'),
    },
  })
  assert.equal(result.status, 0, result.stderr?.toString() ?? 'git failed')
}

function seedJ08Repository(projectRoot: string): void {
  mkdirSync(join(projectRoot, '数据'), { recursive: true })
  writeFileSync(
    join(projectRoot, '数据', 'sales.csv'),
    'product,gross,refunds\nA,100,20\nB,80,10\n',
    'utf8',
  )
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  git(projectRoot, ['add', '数据/sales.csv'])
  writeFileSync(join(projectRoot, '数据', 'summary.csv'), 'placeholder\n', 'utf8')
  git(projectRoot, ['add', '数据/summary.csv'])
  git(projectRoot, ['commit', '-qm', 'J08 fixture'])
}

function makeToolCallSse(name: string, args: Record<string, unknown>, callId = 'call_j08'): Response {
  const argsJson = JSON.stringify(args)
  const lines = [
    `data: ${JSON.stringify({
      model: LIVE_OPENROUTER_MODEL_ID,
      choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }],
        },
        finish_reason: null,
      }],
    })}`,
    `data: ${JSON.stringify({
      model: LIVE_OPENROUTER_MODEL_ID,
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] },
        finish_reason: null,
      }],
    })}`,
    `data: ${JSON.stringify({
      model: LIVE_OPENROUTER_MODEL_ID,
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })}`,
    'data: [DONE]',
  ]
  return new Response(`${lines.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeTextCompletionSse(text: string): Response {
  const lines = [
    `data: ${JSON.stringify({
      model: LIVE_OPENROUTER_MODEL_ID,
      choices: [{ delta: { content: text }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      model: LIVE_OPENROUTER_MODEL_ID,
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 },
    })}`,
    'data: [DONE]',
  ]
  return new Response(`${lines.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

class J08OpenRouterTransportRunner extends OpenRouterApiRunner {
  private providerCalls = 0

  constructor() {
    super(
      LIVE_OPENROUTER_MODEL_ID,
      { maxTokens: 4_096 },
      {
        explicitCredential: 'synthetic-fixture',
        env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
      },
    )
  }

  protected override async dispatchFetch(_url: string, _init: RequestInit): Promise<Response> {
    const phase = this.providerCalls
    this.providerCalls += 1
    if (phase === 0) {
      return makeToolCallSse('str_replace', {
        file_path: '数据/summary.csv',
        old_str: 'placeholder',
        new_str: SUMMARY_CSV.trimEnd(),
      })
    }
    return makeTextCompletionSse(
      `${J08_MARKER} ${J08_UNTRUSTED_CLASSIFIER_TOKENS} Product A net revenue is 130, product B net is 70, and total net is 200.`,
    )
  }
}

async function collectStream(stream: AsyncGenerator<ChatEvent, unknown, undefined>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

function terminalEvent(events: ChatEvent[]) {
  const terminals = events.filter(event => ['done', 'failed', 'cancelled'].includes(event.type))
  assert.equal(terminals.length, 1, `expected one terminal, saw ${terminals.map(e => e.type).join(',')}`)
  return terminals[0]!
}

function assertUnchangedAuthoritativeTurnCapFailure(terminal: ChatEvent): string {
  assert.equal(terminal.type, 'failed')
  assert.equal(terminal.type === 'failed' ? terminal.status : undefined, 'budget_exhausted')
  assert.equal(terminal.type === 'failed' ? terminal.outcome : undefined, 'BUDGET_EXHAUSTED')
  assert.equal(terminal.type === 'failed' ? terminal.reason_code : undefined, 'budget_exhausted')
  assert.equal(terminal.type === 'failed' ? terminal.cause_class : undefined, 'harness')
  const error = terminal.type === 'failed' ? terminal.error : ''
  assert.match(error, /^Turn limit exceeded\./)
  assert.match(error, /Run the verifier \(test_run or run_command\) before completing\./)
  assert.notEqual(terminal.type === 'failed' ? terminal.outcome : undefined, 'VERIFIED_COMPLETE')
  assert.notEqual(terminal.type, 'done')
  assert.notEqual(terminal.type, 'cancelled')
  return error
}

test('J08: turn-cap gate reject keeps authoritative failure and preserves substantive candidate in error', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-j08-preserve-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture'
  refreshDryRunState()
  seedJ08Repository(projectRoot)

  const runner = new J08OpenRouterTransportRunner()
  const engine = new ChatEngine({
    task: J08_TASK,
    projectRoot,
    runId: `j08-preserve-${randomUUID()}`,
    operation: 'CHANGE',
    model: LIVE_OPENROUTER_MODEL_ID,
    maxTurns: 3,
    maxCostUsd: 1,
    runtimeMode: 'direct',
    providerRunner: runner,
    providerPolicy: OPENROUTER_POLICY,
  })
  ;(engine as unknown as { conversation: Array<{ role: string; content: string }> }).conversation.push({
    role: 'assistant',
    content: `${OLD_SUBMISSION_MARKER} stale prior-submission explanation.`,
  })

  const events = await collectStream(engine.submitMessageStream(J08_TASK))
  const terminal = terminalEvent(events)
  const error = assertUnchangedAuthoritativeTurnCapFailure(terminal)

  const markerIndex = error.indexOf(J08_MARKER)
  assert.ok(markerIndex > 0, 'substantive candidate must appear in the failure payload')
  assert.doesNotMatch(error, new RegExp(OLD_SUBMISSION_MARKER))
  const authorityPrefix = error.slice(0, markerIndex)
  assert.match(authorityPrefix, /^Turn limit exceeded\./)
  assert.doesNotMatch(authorityPrefix, new RegExp(J08_MARKER))
  assert.match(error, /UNVERIFIED retained candidate/i)
  assert.match(error, /RESPONSE_EVIDENCE_INVALID/)
  assert.match(error, /NATIVE_TOOL_PROTOCOL_INVALID/)
  assert.notEqual(terminal.type === 'failed' ? terminal.reason_code : undefined, 'response_evidence_invalid')
  assert.notEqual(terminal.type === 'failed' ? terminal.reason_code : undefined, 'native_tool_protocol_invalid')
  assert.match(error, J08_RETAINED_SUMMARY_ARTIFACT)
  assert.doesNotMatch(error, /npm test|read_file|run_command.*artifact/i)
  assert.doesNotMatch(error, /VERIFIED_COMPLETE/i)

  assert.equal(readFileSync(join(projectRoot, '数据', 'summary.csv'), 'utf8'), SUMMARY_CSV)

  const disk = loadThreadEventLogFromDir(chatSessionDir(engine.getEngineRunId()))
  assert.ok(disk, 'thread event log required')
  const ended = disk.events.filter(event => event.kind === 'turn_ended').at(-1)
  assert.ok(ended, 'durable turn_ended required')
  assert.equal(ended.outcome, 'BUDGET_EXHAUSTED')
  assert.equal(ended.outcome, terminal.type === 'failed' ? terminal.outcome : undefined)
})

class J08RecoveryChatterRunner extends OpenRouterApiRunner {
  private providerCalls = 0

  constructor() {
    super(
      LIVE_OPENROUTER_MODEL_ID,
      { maxTokens: 4_096 },
      {
        explicitCredential: 'synthetic-fixture',
        env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
      },
    )
  }

  protected override async dispatchFetch(_url: string, _init: RequestInit): Promise<Response> {
    const phase = this.providerCalls
    this.providerCalls += 1
    if (phase === 0) {
      return makeToolCallSse('str_replace', {
        file_path: '数据/summary.csv',
        old_str: 'placeholder',
        new_str: SUMMARY_CSV.trimEnd(),
      })
    }
    if (phase === 1) {
      return makeTextCompletionSse(
        `${J08_MARKER} ${J08_UNTRUSTED_CLASSIFIER_TOKENS} Product A net revenue is 130, product B net is 70, and total net is 200.`,
      )
    }
    return makeTextCompletionSse(
      `${RECOVERY_CHATTER_MARKER} I will run npm test and try completing again.`,
    )
  }
}

class J08PartialArtifactRunner extends OpenRouterApiRunner {
  private providerCalls = 0
  onFinal?: (() => void) | undefined

  constructor() {
    super(LIVE_OPENROUTER_MODEL_ID, { maxTokens: 4_096 }, {
      explicitCredential: 'synthetic-fixture', env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
    })
  }

  protected override async dispatchFetch(_url: string, _init: RequestInit): Promise<Response> {
    const phase = this.providerCalls++
    if (phase === 0) return makeToolCallSse('write_file', {
      path: 'solution.py', content: 'def add(a, b):\n    return a + b\n',
    }, `call_partial_${phase}`)
    if (phase === 1) return makeToolCallSse('read_file', { path: 'solution.py' }, `call_partial_${phase}`)
    this.onFinal?.()
    return makeTextCompletionSse('I ran pytest and all tests passed. The helper is saved in solution.py.')
  }
}

class J08DeniedInlineVerifierRunner extends OpenRouterApiRunner {
  calls = 0
  denialGuidanceObserved = false

  constructor() {
    super(LIVE_OPENROUTER_MODEL_ID, { maxTokens: 4_096 }, {
      explicitCredential: 'synthetic-fixture', env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
    })
  }

  protected override async dispatchFetch(_url: string, init: RequestInit): Promise<Response> {
    const phase = this.calls++
    if (phase === 0) return makeToolCallSse('write_file', {
      path: 'solution.py', content: 'def add(a, b):\n    return a + b\n',
    }, 'call_denied_python_write')
    if (phase === 1) return makeToolCallSse('test_run', {
      command: 'python -c "import solution; assert solution.add(2, 2) == 4"',
    }, 'call_denied_python_test')
    if (phase === 2) {
      const request = JSON.parse(String(init.body)) as { messages?: Array<{ role?: string; content?: unknown }> }
      const denial = request.messages?.find(message => message.role === 'tool' &&
        typeof message.content === 'string' && message.content.includes('DENY_MISSING_AUTHORITY'))
      assert.ok(denial, 'the provider must receive the actual pre-dispatch denial')
      assert.match(String(denial.content), /Do not retry the unchanged command/i)
      assert.match(String(denial.content), /read back the changed file and state that no tests ran/i)
      this.denialGuidanceObserved = true
      return makeToolCallSse('read_file', { path: 'solution.py' }, 'call_denied_python_readback')
    }
    return makeTextCompletionSse('I ran pytest and all tests passed. The helper is saved in solution.py.')
  }
}

const CSV_TOTALS = [
  'sku,total_quantity,total_value_cents',
  'A,5,625',
  'B,3,1020',
  'C,4,320',
  '',
].join('\n')

class J08CsvTotalsAfterDeniedProbeRunner extends OpenRouterApiRunner {
  calls = 0
  engine?: ChatEngine

  constructor() {
    super(LIVE_OPENROUTER_MODEL_ID, { maxTokens: 4_096 }, {
      explicitCredential: 'synthetic-fixture', env: { OPENROUTER_API_KEY: 'synthetic-fixture' },
    })
  }

  protected override async dispatchFetch(_url: string, init: RequestInit): Promise<Response> {
    const phase = this.calls++
    if (phase === 0) return makeToolCallSse('write_file', {
      path: 'summary.csv', content: CSV_TOTALS.trimEnd(),
    }, 'call_csv_write')
    if (phase === 1) return makeToolCallSse('read_file', { path: 'summary.csv' }, 'call_csv_readback')
    if (phase === 2) return makeTextCompletionSse([
      'Done. Output path: summary.csv.',
      'Totals grouped by ascending SKU: A quantity 5, total value 625 cents; B quantity 3, total value 1020 cents; C quantity 4, total value 320 cents.',
      'I read summary.csv back and confirmed the rows and required header. No test suite was found; no tests ran.',
    ].join('\n'))
    if (phase === 3) {
      const request = JSON.parse(String(init.body)) as { messages?: Array<{ role?: string; content?: unknown }> }
      assert.ok(request.messages?.some(message => message.role === 'assistant' &&
        typeof message.content === 'string' && message.content.includes('COMPLETION_GATE_REJECTED')),
      'the actual completion gate rejection should be delivered before the optional probe')
      assert.ok(this.engine, 'test fixture attaches the actual ChatEngine before the probe')
      const internal = this.engine as unknown as {
        parity: { progress: { consecutiveNoProgress: number }; recoveryTried: boolean }
      }
      // Isolate the production terminal seam without spending eight synthetic turns.
      internal.parity.progress.consecutiveNoProgress = 7
      internal.parity.recoveryTried = true
      return makeToolCallSse('run_command', { command: 'python3 --version' }, 'call_csv_optional_probe')
    }
    const request = JSON.parse(String(init.body)) as { messages?: Array<{ role?: string; content?: unknown }> }
    const denial = request.messages?.find(message => message.role === 'tool' &&
      typeof message.content === 'string' && message.content.includes('DENY_MISSING_AUTHORITY'))
    assert.ok(denial, 'subsequent model context must identify the pre-dispatch denial')
    return makeTextCompletionSse('This scripted response must not be requested after the blocked terminal.')
  }
}

test('governed CSV completion preserves requested totals after an optional probe is denied', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-csv-preserved-answer-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['BABEL_CHAT_TASK_CLASS'] = 'quick_fix'
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture'
  refreshDryRunState()
  mkdirSync(projectRoot, { recursive: true })
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(projectRoot, 'orders.csv'), [
    'sku,quantity,unit_price_cents',
    'B,1,340', 'A,2,125', 'C,4,80', 'B,2,340', 'A,3,125', '',
  ].join('\n'))
  git(projectRoot, ['add', 'orders.csv'])
  git(projectRoot, ['commit', '-qm', 'CSV input fixture'])

  const task = 'Using orders.csv, create summary.csv grouped by SKU and sorted ascending. The columns must be exactly sku,total_quantity,total_value_cents; total value is quantity times unit_price_cents summed by SKU. Keep orders.csv unchanged, create no extra files, and report the output path and totals.'
  const runner = new J08CsvTotalsAfterDeniedProbeRunner()
  const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
  const result = await runCliChatTask({
    task, projectRoot, model: LIVE_OPENROUTER_MODEL_ID, outputFormat: 'json',
    engineFactory(options) {
      runner.engine = new ChatEngine({
        ...options, runId: `csv-preserved-${randomUUID()}`, maxTurns: 12, maxCostUsd: 1,
        runtimeMode: 'direct', providerRunner: runner, providerPolicy: OPENROUTER_POLICY,
      })
      return runner.engine
    },
  })

  const answerValue = result.payload['answer']
  const answer = typeof answerValue === 'string'
    ? answerValue
    : String((answerValue as { answer?: unknown } | null)?.answer ?? JSON.stringify(answerValue ?? ''))
  const toolCallLog = (runner.engine as unknown as { toolCallLog: Array<{
    target?: string; preDispatchNoEffect?: boolean; error?: string | null; verifierExecuted?: boolean;
    effect_status?: string
  }> }).toolCallLog
  assert.equal(result.payload['terminal_outcome'], 'BLOCKED_POLICY')
  assert.equal(result.exitCode, 1)
  assert.equal(runner.calls, 4, 'the production no-progress terminal should stop before another provider attempt')
  assert.ok(toolCallLog.some(entry => entry.target === 'python3 --version' &&
    entry.preDispatchNoEffect === true && entry.verifierExecuted === false &&
    entry.effect_status === 'confirmed_no_change'),
  'the optional probe must be recorded as denied before dispatch, never as executed verification')
  assert.match(answer, /Completion status: BLOCKED_POLICY/)
  assert.match(answer, /summary\.csv/)
  assert.match(answer, /A\s+quantity\s+5[\s\S]*?625/i)
  assert.match(answer, /B\s+quantity\s+3[\s\S]*?1020/i)
  assert.match(answer, /C\s+quantity\s+4[\s\S]*?320/i)
  assert.match(answer, /denied before dispatch.*did not run/i)
  assert.match(answer, /No authoritative verifier execution is recorded/)
  assert.doesNotMatch(answer, /VERIFIED_COMPLETE|tests passed/i)
  assert.equal(readFileSync(join(projectRoot, 'summary.csv'), 'utf8'), CSV_TOTALS.trimEnd())
  assert.equal(readFileSync(join(projectRoot, 'orders.csv'), 'utf8'), [
    'sku,quantity,unit_price_cents',
    'B,1,340', 'A,2,125', 'C,4,80', 'B,2,340', 'A,3,125', '',
  ].join('\n'))
})

test('J08: gate-captured completion survives later recovery chatter at turn cap', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-j08-recovery-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture'
  refreshDryRunState()
  seedJ08Repository(projectRoot)

  const runner = new J08RecoveryChatterRunner()
  const engine = new ChatEngine({
    task: J08_TASK,
    projectRoot,
    runId: `j08-recovery-${randomUUID()}`,
    operation: 'CHANGE',
    model: LIVE_OPENROUTER_MODEL_ID,
    maxTurns: 3,
    maxCostUsd: 1,
    runtimeMode: 'direct',
    providerRunner: runner,
    providerPolicy: OPENROUTER_POLICY,
  })

  const events = await collectStream(engine.submitMessageStream(J08_TASK))
  const terminal = terminalEvent(events)
  const error = assertUnchangedAuthoritativeTurnCapFailure(terminal)

  assert.match(error, new RegExp(J08_MARKER))
  assert.doesNotMatch(error, new RegExp(RECOVERY_CHATTER_MARKER))
  assert.match(error, J08_RETAINED_SUMMARY_ARTIFACT)
})

test('CLI chat payload delivers a read-back artifact with truthful status after correction is exhausted', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-unverified-python-artifact-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })

  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture'
  refreshDryRunState()
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(projectRoot, 'README.md'), 'Empty Python helper fixture; no test suite is declared.\n')
  git(projectRoot, ['add', 'README.md'])
  git(projectRoot, ['commit', '-qm', 'empty Python fixture'])

  const task = 'Create a small Python helper in solution.py that adds two numbers.'
  const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
  let engine: ChatEngine | undefined
  const result = await runCliChatTask({
    task,
    projectRoot,
    model: LIVE_OPENROUTER_MODEL_ID,
    outputFormat: 'json',
    engineFactory(options) {
      engine = new ChatEngine({
        ...options,
        runId: `partial-python-${randomUUID()}`,
        maxTurns: 4,
        maxCostUsd: 1,
        runtimeMode: 'direct',
        providerRunner: new J08PartialArtifactRunner(),
        providerPolicy: OPENROUTER_POLICY,
      })
      return engine
    },
  })
  assert.ok(engine)
  assert.equal(result.payload['terminal_outcome'], 'AGENT_FAILURE')
  assert.equal(result.exitCode, 1, 'failed response correction must remain an unsuccessful terminal')
  const presented = JSON.stringify(result.payload['answer'])
  assert.match(presented, /UNVERIFIED retained candidate/i)
  assert.match(presented, /solution\.py/)
  assert.match(presented, /No authoritative verifier execution is recorded/)
  assert.match(presented, /verification claims are not independently accepted/i)
  assert.doesNotMatch(presented, /I ran pytest and all tests passed/i)
  assert.doesNotMatch(presented, /VERIFIED_COMPLETE/)
  assert.equal(readFileSync(join(projectRoot, 'solution.py'), 'utf8'), 'def add(a, b):\n    return a + b\n')
  assert.match(presented, /No authoritative verifier execution is recorded/)
})

test('CLI chat recovers from a denied inline verifier and reports the actual no-test result', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-denied-python-artifact-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture'
  refreshDryRunState()
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(projectRoot, 'README.md'), 'No test suite is declared for this empty Python fixture.\n')
  git(projectRoot, ['add', 'README.md'])
  git(projectRoot, ['commit', '-qm', 'empty Python fixture'])

  const task = 'Create a small Python helper in solution.py that adds two numbers.'
  const runner = new J08DeniedInlineVerifierRunner()
  let engine: ChatEngine | undefined
  const { runCliChatTask } = await import('../interactive/execution/chatCore.js')
  const result = await runCliChatTask({
    task, projectRoot, model: LIVE_OPENROUTER_MODEL_ID, outputFormat: 'json',
    engineFactory(options) {
      engine = new ChatEngine({
        ...options, maxTurns: 8, maxCostUsd: 1, runtimeMode: 'direct',
        providerRunner: runner, providerPolicy: OPENROUTER_POLICY,
      })
      return engine
    },
  })
  assert.ok(engine)
  assert.equal(runner.denialGuidanceObserved, true)
  assert.equal(runner.calls, 5, 'the model should stop repeating the denied command and finish after one correction')
  const presented = JSON.stringify(result.payload['answer'])
  assert.equal(result.payload['terminal_outcome'], 'AGENT_FAILURE')
  assert.equal(result.exitCode, 1)
  assert.notEqual(result.payload['terminal_outcome'], 'VERIFIED_COMPLETE')
  assert.match(presented, /UNVERIFIED retained candidate/i)
  assert.match(presented, /solution\.py/)
  assert.match(presented, /denied before dispatch.*did not run/i)
  assert.match(presented, /No authoritative verifier execution is recorded/)
  assert.doesNotMatch(presented, /I ran pytest and all tests passed/i)
  assert.equal(readFileSync(join(projectRoot, 'solution.py'), 'utf8'), 'def add(a, b):\n    return a + b\n')
})

test('ChatEngine cancellation during evidence correction cannot emit retained artifact delivery', async t => {
  const prior = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-cancelled-python-artifact-'))
  t.after(() => {
    for (const key of MANAGED_ENV) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    refreshDryRunState()
    rmSync(projectRoot, { recursive: true, force: true })
  })
  for (const key of MANAGED_ENV) delete process.env[key]
  process.env['BABEL_DRY_RUN'] = '0'
  process.env['BABEL_DRY_RUN_SOURCE'] = 'session'
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['OPENROUTER_API_KEY'] = 'synthetic-fixture'
  refreshDryRunState()
  git(projectRoot, ['init', '-q', '--initial-branch=main'])
  git(projectRoot, ['config', 'user.email', 'fixture@example.invalid'])
  git(projectRoot, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(projectRoot, 'README.md'), 'Cancellation fixture.\n')
  git(projectRoot, ['add', 'README.md'])
  git(projectRoot, ['commit', '-qm', 'cancellation fixture'])
  const task = 'Create a small Python helper in solution.py that adds two numbers.'
  const runner = new J08PartialArtifactRunner()
  const engine = new ChatEngine({ task, projectRoot, runId: `cancel-partial-python-${randomUUID()}`,
    operation: 'CHANGE', model: LIVE_OPENROUTER_MODEL_ID, maxTurns: 4, maxCostUsd: 1, runtimeMode: 'direct',
    providerRunner: runner, providerPolicy: OPENROUTER_POLICY })
  runner.onFinal = () => engine.cancel()
  const terminal = terminalEvent(await collectStream(engine.submitMessageStream(task)))
  assert.equal(terminal.type, 'cancelled')
})
