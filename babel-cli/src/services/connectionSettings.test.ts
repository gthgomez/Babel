import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { updateUserSettings } from '../config/userSettings.js'
import { resolveAskModelPolicyWithLiveGate } from './askAnswer.js'
import { runSmallFixModel } from './smallFixProvider.js'
import { z } from 'zod'
import { runWithPrimaryOnlyFallback } from '../execute.js'

function stageResponse(provider: string, content: string, stream: boolean): Response {
  const message = provider === 'gemini' ? { modelVersion: 'Vendor/ExactCase', candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }] }
    : provider === 'anthropic' ? { model: 'Vendor/ExactCase', content: [{ type: 'text', text: content }], stop_reason: 'end_turn' }
    : { model: 'Vendor/ExactCase', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
  if (!stream) return new Response(JSON.stringify(message))
  const frames = provider === 'gemini' ? [message] : provider === 'anthropic' ? [
    { type: 'message_start', message: { model: 'Vendor/ExactCase', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
  ] : [{ model: 'Vendor/ExactCase', choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + (provider === 'openai' || provider === 'openai-compatible' ? 'data: [DONE]\n\n' : ''))
}

test('connection selectors retain exact model IDs across ask and small-fix production services', async () => {
  const previous = { state: process.env['BABEL_STATE_DIR'], fetch: globalThis.fetch, key: process.env['FIXTURE_ACCOUNT_KEY'] }
  process.env['BABEL_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'babel-service-connection-'))
  process.env['FIXTURE_ACCOUNT_KEY'] = 'fixture-only'
  try {
    updateUserSettings({ schemaVersion: 1, connections: {
      a: { id: 'a', provider: 'openai', apiKeyEnvVar: 'FIXTURE_ACCOUNT_KEY', model: 'Vendor/ExactCase', contextWindow: 16000, maxOutputTokens: 128 },
      b: { id: 'b', provider: 'gemini', apiKeyEnvVar: 'FIXTURE_ACCOUNT_KEY', model: 'Vendor/ExactCase' },
    }, defaults: { connection: 'a' } })
    for (const [id, provider] of [['a', 'openai'], ['b', 'gemini']]) {
      const policy = resolveAskModelPolicyWithLiveGate({ model: `connection/${id}/Vendor/ExactCase` }, true)
      assert.equal(policy?.provider, provider); assert.equal(policy?.providerModelId, 'Vendor/ExactCase'); assert.equal(policy?.connectionId, id)
    }
    let calls = 0
    globalThis.fetch = async (url, init) => {
      calls++; assert.match(String(url), /api.openai.com/)
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-only')
      const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'Vendor/ExactCase')
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify({ schema_version: 1, summary: 'Fixture edit', replacement_content: 'fixture result', confidence: 'high' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }))
    }
    const result = await runSmallFixModel('Return a fixture edit', { appendWaterfallLog: () => {} } as never, { task: 'Fixture edit', model: 'connection/a/Vendor/ExactCase', projectRoot: tmpdir() }, { targetFile: 'fixture.txt' })
    assert.equal(result.modelPolicy?.provider, 'openai'); assert.equal(result.answer.replacement_content, 'fixture result'); assert.equal(calls, 1)
  } finally {
    globalThis.fetch = previous.fetch
    if (previous.state === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous.state
    if (previous.key === undefined) delete process.env['FIXTURE_ACCOUNT_KEY']; else process.env['FIXTURE_ACCOUNT_KEY'] = previous.key
  }
})

test('ordinary live stages and admitted children retain explicit certified connection routes', async () => {
  const before = { state: process.env['BABEL_STATE_DIR'], key: process.env['FIXTURE_STAGE_KEY'], fetch: globalThis.fetch }
  process.env['BABEL_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'babel-live-stage-'))
  process.env['FIXTURE_STAGE_KEY'] = 'fixture-only'
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-live-child-'))
  try {
    const providers = ['openai', 'gemini', 'anthropic', 'openai-compatible'] as const
    updateUserSettings({ connections: Object.fromEntries(providers.map((provider, i) => [`c${i}`, { id: `c${i}`, provider, model: 'Vendor/ExactCase', apiKeyEnvVar: 'FIXTURE_STAGE_KEY', maxOutputTokens: 128, contextWindow: 16384, ...(provider === 'openai-compatible' ? { baseUrl: 'https://inference.example/v1' } : {}) }])), defaults: { budgetUsd: 'unlimited' } })
    let dispatched = 0
    for (const [i, provider] of providers.entries()) {
      globalThis.fetch = async (url, init) => {
        dispatched++
        const content = JSON.stringify({ ok: true })
        return stageResponse(provider, content, String(url).includes(':streamGenerateContent') || JSON.parse(String(init?.body)).stream === true)
      }
      const result = await runWithPrimaryOnlyFallback('Return the fixture object', z.object({ ok: z.boolean() }), { stage: 'planning', model: `connection/c${i}/Vendor/ExactCase`, liveOnly: true })
      assert.equal(result.ok, true)
    }
    assert.equal(dispatched, 4)
    updateUserSettings({ defaults: { budgetUsd: 2 } })
    const { runReadOnlyAgentLoop } = await import('../agent/lanes/readOnlyAgentLoop.js')
    globalThis.fetch = async (_url, init) => { dispatched++; return stageResponse('openai', JSON.stringify({ actions: [{ type: 'finish', summary: 'Fixture completion', verification: [] }] }), JSON.parse(String(init?.body)).stream === true) }
    await runReadOnlyAgentLoop({ verb: 'ask', task: 'Inspect', projectRoot, toolContext: { agentId: 'fixture', runId: 'fixture', babelRoot: projectRoot }, model: 'connection/c0/Vendor/ExactCase', provider: 'live', maxRounds: 1,
      inheritedAllowance: { taskOwnerId: 'stage-child', parentTaskOwnerId: 'stage-parent', remainingCostUsd: 2, costBaselineUsd: 0, maxRounds: 1, deadlineAtMs: null } })
    assert.equal(dispatched, 5)
  } finally {
    globalThis.fetch = before.fetch
    if (before.state === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = before.state
    if (before.key === undefined) delete process.env['FIXTURE_STAGE_KEY']; else process.env['FIXTURE_STAGE_KEY'] = before.key
  }
})
