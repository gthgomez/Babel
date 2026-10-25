/**
 * P1 — J08-class answer loss at turn cap: production ChatEngine + OpenRouterApiRunner,
 * mocked HTTP transport only (dispatchFetch). No benchmark lease, admission priming,
 * or session admission store overrides.
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

const J08_TASK =
  'Compute net revenue from 数据/sales.csv and create 数据/summary.csv with product, gross, refunds and net. Explain the total.'
const J08_MARKER = 'J08_PRESERVED_NET_200_EXPLANATION'
const SUMMARY_CSV = [
  'product,gross,refunds,net',
  'A,100,20,130',
  'B,80,10,70',
  'TOTAL,,,200',
  '',
].join('\n')

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
  'BABEL_DIFF_CRITIC',
  'BABEL_COMPACTION',
  'BABEL_NATIVE_TOOLS',
  'BABEL_TOOL_PROFILE',
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
      `${J08_MARKER} Product A net revenue is 130, product B net is 70, and total net is 200.`,
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

test('J08: turn-cap verifier_missing preserves substantive answer via UNVERIFIED terminal', async t => {
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
  process.env['BABEL_DIFF_CRITIC'] = '0'
  process.env['BABEL_COMPACTION'] = 'off'
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

  const events = await collectStream(engine.submitMessageStream(J08_TASK))
  const terminal = terminalEvent(events)

  assert.equal(terminal.type, 'done', 'must use nonverified terminal path, not streamFailed turn-limit loss')
  assert.equal(terminal.type === 'done' ? terminal.outcome : undefined, 'UNVERIFIED_PATCH')
  assert.notEqual(terminal.type === 'done' ? terminal.outcome : undefined, 'VERIFIED_COMPLETE')

  const answer = terminal.type === 'done' ? terminal.answer : ''
  assert.match(answer, /Turn limit reached/i)
  assert.match(answer, /verifier|COMPLETION_GATE_REJECTED/i)
  assert.match(answer, /UNVERIFIED retained candidate/i)
  assert.match(answer, new RegExp(J08_MARKER))
  assert.doesNotMatch(answer, /^Turn limit exceeded\./)
  assert.doesNotMatch(answer, /VERIFIED_COMPLETE/i)

  assert.equal(readFileSync(join(projectRoot, '数据', 'summary.csv'), 'utf8'), SUMMARY_CSV)
})
