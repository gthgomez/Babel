import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { runCliChatTask } from '../interactive/execution/chatCore.js'
import { globalCostTracker } from '../services/costTracker.js'
import { resolveChatEngineLimits } from '../config/chatEngineLimits.js'
import { initMinimalGitProject, mkExternalRunsDir } from '../testUtils/chatAdmissionFixture.js'

const task = 'Explain fixture.txt without changing it.'
const model = 'glm-5.3-flash'
const endpoint = 'openrouter.ai/api/v1/chat/completions'

function liveHeadlessFixture(t: test.TestContext) {
  const keys = ['BABEL_LIVE', 'BABEL_HEADLESS', 'BABEL_EXECUTION_PROFILE', 'BABEL_RUNS_DIR', 'BABEL_CHAT_MAX_COST'] as const
  const prior = new Map(keys.map((key) => [key, process.env[key]]))
  const priorFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = priorFetch
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env['BABEL_LIVE'] = '1'
  process.env['BABEL_HEADLESS'] = '1'
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  delete process.env['BABEL_CHAT_MAX_COST']
  const root = mkdtempSync(join(tmpdir(), 'babel-unlimited-factory-'))
  initMinimalGitProject(root)
  const runsDir = mkExternalRunsDir('babel-unlimited-factory-runs-')
  process.env['BABEL_RUNS_DIR'] = runsDir
  t.after(() => {
    rmSync(runsDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  const target = join(root, 'fixture.txt')
  writeFileSync(target, 'unchanged\n')
  return { root, target }
}

test('normal runCliChatTask factory: default unlimited grant survives unknown settlement', async (t) => {
  assert.equal(resolveChatEngineLimits().maxCostUsd, Infinity)
  const { root, target } = liveHeadlessFixture(t)
  let engine: ChatEngine | undefined
  let fetchCount = 0
  globalThis.fetch = (async (input, init) => {
    if (!String(input).includes(endpoint)) throw new Error(`unexpected route: ${String(input)}`)
    const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean }
    assert.equal(body.model, 'z-ai/glm-5.3-flash')
    if (body.stream !== true) {
      return Response.json({
        model: body.model,
        choices: [{ message: { content: '{"verdict":"reject","confidence":0.9,"reasons":["verification absent"]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    }
    fetchCount += 1
    if (fetchCount === 1 && engine) {
      const owner = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance.taskOwnerId
      globalCostTracker.recordUnknownCharge('fixture-unpriced-model', {
        taskOwnerId: owner,
        chargeId: 'factory-unknown-charge',
      })
    }
    const delta = fetchCount === 1
      ? {
          tool_calls: [{
            index: 0,
            id: 'factory-read',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: target }),
            },
          }],
        }
      : { content: 'The fixture contains the text unchanged.' }
    return new Response(
      `data: ${JSON.stringify({
        model: body.model,
        choices: [{
          delta,
          finish_reason: fetchCount === 1 ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch

  const result = await runCliChatTask({
    task,
    projectRoot: root,
    model,
    outputFormat: 'json',
    engineFactory: (options) => {
      engine = new ChatEngine(options)
      return engine
    },
  })

  assert.equal(readFileSync(target, 'utf8'), 'unchanged\n')
  assert.equal(fetchCount, 2)
  assert.equal(result.exitCode, 0)
  const answer = result.payload['answer']
  const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer)
  assert.match(answerText, /unchanged/i)
  const budgets = (engine as unknown as { checkBudgets: (skip?: boolean) => { ok: boolean } }).checkBudgets(true)
  assert.equal(budgets.ok, true)
})

test('normal runCliChatTask factory: finite explicit cap blocks unknown pricing', async (t) => {
  const { root, target } = liveHeadlessFixture(t)
  let engine: ChatEngine | undefined
  let streamCount = 0
  globalThis.fetch = (async (input, init) => {
    if (!String(input).includes(endpoint)) throw new Error(`unexpected route: ${String(input)}`)
    const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean }
    if (body.stream !== true) {
      return Response.json({
        model: body.model,
        choices: [{ message: { content: '{"verdict":"reject","confidence":0.9,"reasons":["verification absent"]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
    }
    streamCount += 1
    if (streamCount === 1 && engine) {
      const owner = (engine as unknown as { taskAllowance: { taskOwnerId: string } }).taskAllowance.taskOwnerId
      globalCostTracker.recordUnknownCharge('fixture-unpriced-model', {
        taskOwnerId: owner,
        chargeId: 'finite-unknown-charge',
      })
    }
    const delta = {
      tool_calls: [{
        index: 0,
        id: 'finite-read',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: target }),
        },
      }],
    }
    return new Response(
      `data: ${JSON.stringify({
        model: body.model,
        choices: [{ delta, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof fetch

  await runCliChatTask({
    task,
    projectRoot: root,
    model,
    outputFormat: 'json',
    engineFactory: (options) => {
      engine = new ChatEngine({ ...options, maxCostUsd: 0.75 })
      return engine
    },
  })

  const budgets = (engine as unknown as { checkBudgets: () => { ok: boolean; reason?: string } }).checkBudgets()
  assert.equal(budgets.ok, false)
  assert.match(budgets.reason ?? '', /COST_ACCOUNTING_INCOMPLETE/)
})
