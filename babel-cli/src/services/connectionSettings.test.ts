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

test('saved model choices are remembered per connection and project scope', async () => {
  const { selectConnection, selectModel } = await import('./connectionSettings.js')
  const { resolveEffectiveSettings } = await import('../config/userSettings.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']
  const state = mkdtempSync(join(tmpdir(), 'babel-selection-memory-'))
  process.env['BABEL_STATE_DIR'] = state
  try {
    updateUserSettings({ connections: {
      a: { id: 'a', provider: 'openai', model: 'a-original' },
      b: { id: 'b', provider: 'gemini', model: 'b-original' },
    }, defaults: { connection: 'a' } })
    selectModel('a-chosen', { connection: 'a' }, { save: 'user' })
    selectModel('b-chosen', { connection: 'b' }, { save: 'user' })
    assert.equal(selectConnection('a', {}).model, 'a-chosen')
    assert.equal(selectConnection('b', {}).model, 'b-chosen')
    selectModel('a-project', { connection: 'a' }, { save: 'project', projectRoot: join(state, 'project') })
    assert.equal(resolveEffectiveSettings({ env: process.env, projectRoot: join(state, 'project'), session: { connection: 'a' } }).model.value, 'a-project')
    assert.equal(selectConnection('a', {}).model, 'a-chosen')
  } finally {
    if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous
    rmSync(state, { recursive: true, force: true })
  }
})

test('session-only model choices survive switching without changing saved preferences', async () => {
  const { selectConnection, selectModel } = await import('./connectionSettings.js')
  const { readUserSettings } = await import('../config/userSettings.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']; const state = mkdtempSync(join(tmpdir(), 'babel-session-model-'))
  process.env['BABEL_STATE_DIR'] = state
  try {
    updateUserSettings({ connections: { a: { id: 'a', provider: 'openai', model: 'a-default' }, b: { id: 'b', provider: 'gemini', model: 'b-default' } }, defaults: { connection: 'a' } })
    let session = selectModel('a-session', { connection: 'a' })
    session = selectConnection('b', session)
    session = selectModel('b-session', session)
    session = selectConnection('a', session)
    assert.equal(session.model, 'a-session')
    assert.equal(selectConnection('b', session).model, 'b-session')
    assert.equal(readUserSettings().connections['a']?.model, 'a-default')
    assert.equal(readUserSettings().defaults?.model, undefined)
  } finally { if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous; rmSync(state, { recursive: true, force: true }) }
})

test('legacy direct DeepSeek model keys do not migrate to the saved OpenRouter connection', async () => {
  const { resolveChatModelPolicy } = await import('../agent/chatModelPolicy.js')
  const { resolveChatDeliberationRunner } = await import('../agent/chatEngineProviderRuntime.js')
  const { resolveModelByKey } = await import('../modelPolicy.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']; const directKey = process.env['DEEPSEEK_API_KEY']; const routerKey = process.env['OPENROUTER_API_KEY']; const customKey = process.env['FIXTURE_CUSTOM_DIRECT_KEY']; const previousFetch = globalThis.fetch
  const state = mkdtempSync(join(tmpdir(), 'babel-direct-legacy-'))
  process.env['BABEL_STATE_DIR'] = state
  process.env['DEEPSEEK_API_KEY'] = 'sk-synthetic-direct-key'; process.env['OPENROUTER_API_KEY'] = 'synthetic-router-key'; process.env['FIXTURE_CUSTOM_DIRECT_KEY'] = 'sk-synthetic-custom-key'
  try {
    updateUserSettings({ connections: { or: { id: 'or', provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } }, defaults: { connection: 'or' } })
    for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
      const policy = resolveChatModelPolicy({ model }).policy
      assert.equal(policy.provider, 'deepseek'); assert.equal(policy.providerModelId, model)
      const governed = resolveModelByKey({ key: model, liveOnly: true, bindStagesToSelectedModel: true })
      assert.equal(governed.provider, 'deepseek'); assert.ok(governed.stagePolicies.every(stage => stage.primaryProvider === 'deepseek' && stage.primaryProviderModelId === model))
      let calls = 0
      globalThis.fetch = async (url, init) => {
        calls++; assert.match(String(url), /^https:\/\/api\.deepseek\.com\//); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-synthetic-direct-key'); assert.equal(JSON.parse(String(init?.body)).model, model)
        return new Response(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      const runner = resolveChatDeliberationRunner(null, policy); assert.ok(runner.executeWithToolsStream)
      for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'fixture' }], [])) { /* drain */ }
      assert.equal(calls, 1)
      globalThis.fetch = async (url, init) => {
        calls++; assert.match(String(url), /^https:\/\/api\.deepseek\.com\//); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-synthetic-direct-key'); assert.equal(JSON.parse(String(init?.body)).model, model)
        return stageResponse('openai', JSON.stringify({ ok: true }), JSON.parse(String(init?.body)).stream === true)
      }
      const result = await runWithPrimaryOnlyFallback('Return fixture JSON', z.object({ ok: z.boolean() }), { stage: 'planning', model, liveOnly: true })
      assert.equal(result.ok, true); assert.equal(calls, 2)
    }
    updateUserSettings({ connections: { direct: { id: 'direct', provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnvVar: 'FIXTURE_CUSTOM_DIRECT_KEY' } }, defaults: { connection: 'direct' } })
    const custom = resolveChatModelPolicy({ model: 'deepseek-v4-flash' }).policy
    assert.equal(custom.connectionId, 'direct'); assert.equal(custom.apiKeyEnvVar, 'FIXTURE_CUSTOM_DIRECT_KEY')
    let customCalls = 0
    globalThis.fetch = async (_url, init) => {
      customCalls++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-synthetic-custom-key')
      return stageResponse('openai', 'ok', true)
    }
    const customRunner = resolveChatDeliberationRunner(null, custom); assert.ok(customRunner.executeWithToolsStream)
    for await (const _event of customRunner.executeWithToolsStream([{ role: 'user', content: 'fixture' }], [])) { /* drain */ }
    assert.equal(customCalls, 1)
  } finally {
    globalThis.fetch = previousFetch
    for (const [name, value] of Object.entries({ BABEL_STATE_DIR: previous, DEEPSEEK_API_KEY: directKey, OPENROUTER_API_KEY: routerKey, FIXTURE_CUSTOM_DIRECT_KEY: customKey })) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(state, { recursive: true, force: true })
  }
})

test('interactive connection commands restore session model for each connection', async () => {
  const { handleConnectionCommand } = await import('../commands/connectionCommands.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']; const stateDir = mkdtempSync(join(tmpdir(), 'babel-tui-model-'))
  process.env['BABEL_STATE_DIR'] = stateDir
  try {
    updateUserSettings({ connections: { a: { id: 'a', provider: 'openai', model: 'a-default' }, b: { id: 'b', provider: 'gemini', model: 'b-default' } }, defaults: { connection: 'a' } })
    const ctx = { state: { pendingPlanBody: 'retained legacy plan' }, resolveCurrentTarget: () => ({ targetRoot: stateDir }), saveSessionState() {} } as unknown as import('../interactive/context.js').ReplContext
    await handleConnectionCommand(ctx, 'provider', ['use', 'a'])
    await handleConnectionCommand(ctx, 'model', ['use', 'vendor/a-exact'])
    await handleConnectionCommand(ctx, 'provider', ['use', 'b'])
    await handleConnectionCommand(ctx, 'model', ['use', 'vendor/b-exact'])
    await handleConnectionCommand(ctx, 'provider', ['use', 'a'])
    assert.equal(ctx.state.model, 'connection/a/vendor/a-exact')
    assert.equal(ctx.state.resolvedModelId, 'vendor/a-exact')
    await handleConnectionCommand(ctx, 'provider', ['use', 'b'])
    assert.equal(ctx.state.model, 'connection/b/vendor/b-exact')
    assert.equal(ctx.state.pendingPlanBody, 'retained legacy plan')
  } finally { if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous; rmSync(stateDir, { recursive: true, force: true }) }
})

test('slash shortcuts select scoped catalog models and explicit provider routes', async () => {
  const { handleCommand } = await import('../interactive/commands.js')
  const { resolveConnectionModelPolicy } = await import('../config/connectionModelPolicy.js')
  const { resolveChatDeliberationRunner } = await import('../agent/chatEngineProviderRuntime.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']; const previousKey = process.env['FIXTURE_SHORTCUT_KEY']; const previousFetch = globalThis.fetch
  const stateDir = mkdtempSync(join(tmpdir(), 'babel-tui-shortcuts-'))
  process.env['BABEL_STATE_DIR'] = stateDir
  process.env['FIXTURE_SHORTCUT_KEY'] = 'fixture-only'
  try {
    updateUserSettings({ connections: {
      openrouter: { id: 'openrouter', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', apiKeyEnvVar: 'FIXTURE_SHORTCUT_KEY' },
      cc: { id: 'cc', provider: 'command-code', model: 'vendor/cc-model', apiKeyEnvVar: 'FIXTURE_SHORTCUT_KEY' },
    } })
    const ctx = { state: {}, resolveCurrentTarget: () => ({ targetRoot: stateDir }), saveSessionState() {} } as unknown as import('../interactive/context.js').ReplContext
    const assertDispatch = async (endpoint: string, model: string) => {
      let calls = 0
      globalThis.fetch = async (url, init) => {
        calls++; assert.equal(String(url), endpoint); assert.equal(JSON.parse(String(init?.body)).model, model)
        return new Response(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      const policy = resolveConnectionModelPolicy(ctx.state.model); assert.ok(policy)
      const runner = resolveChatDeliberationRunner(null, policy)
      assert.ok(runner.executeWithToolsStream)
      for await (const _event of runner.executeWithToolsStream([{ role: 'user', content: 'fixture' }], [])) { /* drain */ }
      assert.equal(calls, 1)
    }
    await handleCommand(ctx, '/provider openrouter')
    assert.equal(ctx.state.connectionId, 'openrouter')
    await handleCommand(ctx, '/model glm-5.3-flash')
    assert.equal(ctx.state.model, 'connection/openrouter/z-ai/glm-5.3-flash')
    await assertDispatch('https://openrouter.ai/api/v1/chat/completions', 'z-ai/glm-5.3-flash')
    await handleCommand(ctx, '/model openrouter:deepseek-pro')
    assert.equal(ctx.state.model, 'connection/openrouter/deepseek/deepseek-v4-pro')
    await handleCommand(ctx, '/model commandcode:vendor/cc-model')
    assert.equal(ctx.state.model, 'connection/cc/vendor/cc-model')
    await assertDispatch('https://api.commandcode.ai/provider/v1/chat/completions', 'vendor/cc-model')
    updateUserSettings({ connections: { cc2: { id: 'cc2', provider: 'command-code', model: 'vendor/other' } } })
    await handleCommand(ctx, '/model commandcode:vendor/other')
    assert.equal(ctx.state.model, 'connection/cc/vendor/cc-model', 'ambiguous provider must not switch accounts')
    await handleCommand(ctx, '/model unknown-short-name')
    assert.equal(ctx.state.model, 'connection/cc/vendor/cc-model', 'unknown short name must not silently select a model')
  } finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env['FIXTURE_SHORTCUT_KEY']; else process.env['FIXTURE_SHORTCUT_KEY'] = previousKey; if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous; rmSync(stateDir, { recursive: true, force: true }) }
})

test('saving a connection also remembers its active model when switching later', async () => {
  const { selectConnection, selectModel } = await import('./connectionSettings.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']; const state = mkdtempSync(join(tmpdir(), 'babel-save-connection-'))
  process.env['BABEL_STATE_DIR'] = state
  try {
    updateUserSettings({ connections: { a: { id: 'a', provider: 'openai', model: 'a-original' }, b: { id: 'b', provider: 'gemini', model: 'b-original' } }, defaults: { connection: 'a' } })
    const session = selectModel('a-selected', { connection: 'a' })
    selectConnection('a', session, { save: 'user' })
    selectConnection('b', {}, { save: 'user' })
    assert.equal(selectConnection('a', {}).model, 'a-selected')
  } finally { if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous; rmSync(state, { recursive: true, force: true }) }
})

test('OpenRouter catalog lists requested exact targets with source and unverified qualification', async () => {
  const { listConnectionModels } = await import('./connectionSettings.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']; const state = mkdtempSync(join(tmpdir(), 'babel-catalog-'))
  process.env['BABEL_STATE_DIR'] = state
  try {
    updateUserSettings({ connections: { router: { id: 'router', provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } }, defaults: { connection: 'router' } })
    const models = listConnectionModels({}, process.cwd()).models
    for (const id of ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-flash']) {
      const entry = models.find(model => model.id === id)
      assert.ok(entry, `exact model ${id} must be listed`)
      assert.ok(entry.sourceUrl)
      assert.equal(entry.qualification, 'unverified')
    }
    assert.equal(models.find(model => model.id === 'xiaomi/mimo-v2.6-flash')?.nativeToolUse, true)
    assert.equal(models.find(model => model.id === 'deepseek/deepseek-v4.1-flash')?.nativeToolUse, true)
    assert.equal(models.find(model => model.id === 'z-ai/glm-5.3-flash')?.contextWindow, 1048576)
    assert.equal(models.find(model => model.id === 'xiaomi/mimo-v2.6-flash')?.contextWindow, 1050000)
  } finally { if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous; rmSync(state, { recursive: true, force: true }) }
})

test('CommandCode catalog exposes the explicit documented qualification candidates', async () => {
  const { listConnectionModels } = await import('./connectionSettings.js')
  const { rmSync } = await import('node:fs')
  const previous = process.env['BABEL_STATE_DIR']; const state = mkdtempSync(join(tmpdir(), 'babel-commandcode-catalog-'))
  process.env['BABEL_STATE_DIR'] = state
  try {
    updateUserSettings({ connections: { cc: { id: 'cc', provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' } }, defaults: { connection: 'cc' } })
    const models = listConnectionModels({}, process.cwd()).models
    for (const id of ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']) {
      const entry = models.find(model => model.id === id)
      assert.ok(entry, `CommandCode model ${id} must be listed`)
      assert.equal(entry.sourceUrl, 'https://api.commandcode.ai/provider/v1/models')
      assert.equal(entry.qualification, 'unverified')
    }
    const { resolveModelByKey } = await import('../modelPolicy.js')
    const selected = resolveModelByKey({ key: 'connection/cc/z-ai/glm-5.3-flash' })
    assert.equal(selected.provider, 'command-code')
    assert.equal(selected.nativeToolUseUnverified, true)
    assert.equal(selected.waterfall[0]?.nativeToolUseUnverified, true)
    assert.ok(selected.stagePolicies.every(stage => stage.orderedBackends.every(backend => backend.nativeToolUseUnverified === true)))
    const known = resolveModelByKey({ key: 'connection/cc/deepseek/deepseek-v4.1-flash' })
    // The explicit CommandCode deepseek route is admitted with native tools;
    // catalog listing still reports qualification as unverified.
    assert.equal(known.nativeToolUse, true); assert.equal(known.nativeToolUseUnverified, undefined)
    const { resolveConnectionModelPolicy } = await import('../config/connectionModelPolicy.js')
    const explicitKnown = resolveConnectionModelPolicy('connection/cc/z-ai/glm-5.3-flash', { models: { fixture: { provider: 'command-code', model_id: 'z-ai/glm-5.3-flash', tier: 'standard', native_tool_use: true } } })
    assert.equal(explicitKnown?.nativeToolUse, true); assert.equal(explicitKnown?.waterfall[0]?.nativeToolUse, true)
    const conflict = resolveConnectionModelPolicy('connection/cc/z-ai/glm-5.3-flash', { models: { fixture: { provider: 'command-code', model_id: 'z-ai/glm-5.3-flash', tier: 'standard', native_tool_use: true, native_tool_use_unverified: true } } })
    assert.equal(conflict?.nativeToolUse, undefined)
    assert.equal(conflict?.nativeToolUseUnverified, true)
  } finally { if (previous === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = previous; rmSync(state, { recursive: true, force: true }) }
})
