import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { OpenRouterApiRunner } from '../runners/openRouterApi.js'
import type { ToolStreamEvent } from '../runners/base.js'
import type { WireProviderMessage } from '../runners/providerMessages.js'
import { globalCostTracker } from '../services/costTracker.js'
import { resolveChatEngineLimits } from '../config/chatEngineLimits.js'
import { computeCriticRepairCostCap } from './chatEngineCriticBudget.js'

test('default task-class limits are monetarily unlimited without env override', () => {
  const previous = process.env['BABEL_CHAT_MAX_COST']
  delete process.env['BABEL_CHAT_MAX_COST']
  try {
    const limits = resolveChatEngineLimits()
    assert.equal(limits.maxCostUsd, Infinity)
    assert.deepEqual(limits.runAllowance?.costAllowance, { kind: 'unlimited' })
  } finally {
    if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST']
    else process.env['BABEL_CHAT_MAX_COST'] = previous
  }
})

test('critic repair does not shrink unlimited parent dollar cap', () => {
  const { capUsd } = computeCriticRepairCostCap({
    spentUsd: 0.5,
    sessionMaxCostUsd: Infinity,
  })
  assert.equal(capUsd, Infinity)
})

test('default unlimited grant tolerates unknown pricing in checkBudgets', () => {
  const limits = resolveChatEngineLimits()
  assert.equal(limits.maxCostUsd, Infinity)
  const engine = new ChatEngine({
    task: 'budget probe',
    projectRoot: mkdtempSync(join(tmpdir(), 'babel-unlimited-probe-')),
    model: 'deepseek-v4-flash',
    maxTurns: 2,
    runtimeMode: 'direct',
  })
  const owner = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance.taskOwnerId
  globalCostTracker.recordUnknownCharge('fixture-unpriced-model', {
    taskOwnerId: owner,
    chargeId: 'probe-unknown-charge',
  })
  const budgets = (engine as unknown as { checkBudgets: (skip?: boolean) => { ok: boolean } }).checkBudgets(true)
  assert.equal(budgets.ok, true)
})

test('native schema corrected repair succeeds under default unlimited grant', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-unlimited-native-'))
  writeFileSync(join(root, 'fixture.txt'), 'ORIGINAL_FIXTURE\n')
  const names = ['BABEL_NATIVE_TOOLS', 'BABEL_TOOL_PROFILE', 'BABEL_COMPACTION', 'BABEL_CHAT_MAX_COST'] as const
  const previous = names.map((name) => [name, process.env[name]] as const)
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['BABEL_COMPACTION'] = 'off'
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  const model = 'z-ai/glm-5.3-flash'
  class Receiver extends OpenRouterApiRunner {
    bodies: Array<{ messages: WireProviderMessage[] }> = []
    constructor() {
      super(model, {}, { explicitCredential: 'fixture-only-no-network', env: {} })
    }
    protected override getRequestMaxRetries() {
      return 1
    }
    protected override getStreamMaxRetries() {
      return 0
    }
    protected override async dispatchFetch(_url: string, init: RequestInit): Promise<Response> {
      this.bodies.push(JSON.parse(String(init.body)))
      const attempt = this.bodies.length
      const malformed = attempt === 1
      const calls = malformed
        ? [
            { id: 'valid-before-rejection', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) },
            { id: 'rejected-call', name: 'str_replace', arguments: JSON.stringify({ file_path: 'fixture.txt', new_str: 'X' }) },
          ]
        : [{ id: 'corrected-call', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) }]
      const delta = {
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }
      const payload = {
        model,
        choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    override async *executeWithToolsStream(
      ...args: Parameters<OpenRouterApiRunner['executeWithToolsStream']>
    ): AsyncGenerator<ToolStreamEvent, void, undefined> {
      yield* super.executeWithToolsStream(...args)
    }
  }
  const runner = new Receiver()
  const engine = new ChatEngine({
    task: 'Explain fixture.txt without editing files.',
    projectRoot: root,
    model,
    providerRunner: runner,
    maxTurns: 5,
    runtimeMode: 'direct',
  })
  const events = []
  for await (const event of engine.submitMessageStream(
    'Explain fixture.txt without editing files.',
    'explain',
  )) events.push(event)
  assert.equal(readFileSync(join(root, 'fixture.txt'), 'utf8'), 'ORIGINAL_FIXTURE\n')
  assert.ok(runner.bodies.length >= 3, `expected repair path, got ${runner.bodies.length} bodies`)
  assert.ok(events.some((event) => event.type === 'tool_complete'))
})

test('finite explicit cap still blocks unknown pricing before paid dispatch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-finite-native-'))
  writeFileSync(join(root, 'fixture.txt'), 'ORIGINAL_FIXTURE\n')
  const names = ['BABEL_NATIVE_TOOLS', 'BABEL_TOOL_PROFILE', 'BABEL_COMPACTION'] as const
  const previous = names.map((name) => [name, process.env[name]] as const)
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_TOOL_PROFILE'] = 'legacy'
  process.env['BABEL_COMPACTION'] = 'off'
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  const model = 'z-ai/glm-5.3-flash'
  let recordUnpricedCharge = () => {}
  class Receiver extends OpenRouterApiRunner {
    constructor() {
      super(model, {}, { explicitCredential: 'fixture-only-no-network', env: {} })
    }
    protected override async dispatchFetch(): Promise<Response> {
      recordUnpricedCharge()
      const calls = [{ id: 'valid-only-call', name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) }]
      const payload = {
        model,
        choices: [{
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: 'tool_calls',
        }],
      }
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
  }
  const engine = new ChatEngine({
    task: 'Explain fixture.txt without editing files.',
    projectRoot: root,
    model,
    providerRunner: new Receiver(),
    maxTurns: 5,
    maxCostUsd: 0.08,
    runtimeMode: 'direct',
  })
  recordUnpricedCharge = () => globalCostTracker.recordUnknownCharge('fixture-unpriced-model', {
    taskOwnerId: (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance.taskOwnerId,
    chargeId: 'fixture-unpriced-charge',
  })
  const events = []
  for await (const event of engine.submitMessageStream(
    'Explain fixture.txt without editing files.',
    'explain',
  )) events.push(event)
  const owner = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance.taskOwnerId
  const summary = globalCostTracker.getTaskSummary(owner)
  assert.ok((summary.unknownChargeCount ?? 0) > 0)
  const budgets = (engine as unknown as { checkBudgets: () => { ok: boolean; reason?: string } }).checkBudgets()
  assert.equal(budgets.ok, false)
  assert.match(budgets.reason ?? '', /COST_ACCOUNTING_INCOMPLETE/)
})
