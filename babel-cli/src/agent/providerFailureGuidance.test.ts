import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFailureText } from './chatFailureClassification.js'
import { terminalReasonFromFailureText, terminalReasonGuidance } from './chatTerminalReason.js'

test('missing credentials are actionable setup blockers rather than unknown failure', () => {
  const error = '[provider:openai] OPENAI_API_KEY is not set.'
  assert.equal(classifyFailureText(error), 'BLOCKED_EXTERNAL')
  const reason = terminalReasonFromFailureText(error)
  assert.equal(reason?.detail, 'credential_missing')
  assert.match(terminalReasonGuidance(reason!.code, reason?.detail).nextActions.join(' '), /setup/i)
  assert.doesNotMatch(terminalReasonGuidance(reason!.code, reason?.detail).nextActions.join(' '), /retry/i)
})

test('authentication and rate limits have different recovery guidance', () => {
  const auth = terminalReasonFromFailureText('[gemini] HTTP 401 (fixture)')!
  const rate = terminalReasonFromFailureText('[anthropic] HTTP 429 (fixture)')!
  assert.equal(auth.detail, 'authentication')
  assert.equal(rate.detail, 'rate_limit')
  assert.notDeepEqual(terminalReasonGuidance(auth.code, auth.detail), terminalReasonGuidance(rate.code, rate.detail))
})


test('authentication detail survives an actual Chat failure and durable terminal projection', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { GeminiApiRunner } = await import('../runners/geminiApi.js')
  const { resolveModelByKey } = await import('../modelPolicy.js')
  const { projectTurnViewStateFromSessionEvents, renderProjectedReviewCard } = await import('../interactive/projection/turnViewProjector.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-auth-projection-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile')
  let engine: InstanceType<typeof ChatEngine> | undefined
  let calls = 0
  try {
    globalThis.fetch = async () => { calls++; return new Response('fixture rejection', { status: 401 }) }
    const policy = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: { ...policy, provider: 'gemini', providerModelId: 'fixture-model' }, providerRunner: new GeminiApiRunner({ env: {}, explicitCredential: 'fixture-only', modelId: 'fixture-model', maxTokens: 64 }) })
    const failures: unknown[] = []
    for await (const event of engine.submitMessageStream('Explain README')) if (event.type === 'failed') failures.push(event)
    assert.equal(calls, 1, 'authentication rejection must stop all subsequent inference')

    const view = projectTurnViewStateFromSessionEvents(engine.getParityRuntime().sessionEvents.events)
    assert.equal(view.reviewCard.reasonDetail, 'authentication', JSON.stringify({ errors: failures.map(value => (value as { error?: string }).error) }))
    assert.match(renderProjectedReviewCard(view).body, /authentication|credential/i)
    assert.doesNotMatch(renderProjectedReviewCard(view).body, /Next\s+Retry/)
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    if (prior.runs === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = prior.runs
    if (prior.state === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = prior.state
  }
})

for (const provider of ['openrouter', 'command-code', 'deepseek'] as const) for (const mode of ['native', 'text', 'legacy'] as const) for (const status of [401, 403]) test(`${provider} ${mode} Chat stops after a ${status} without another request`, async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js')
  const { CommandCodeApiRunner } = await import('../runners/commandCodeApi.js')
  const { DeepSeekApiRunner } = await import('../runners/deepSeekApi.js')
  const { resolveModelByKey } = await import('../modelPolicy.js')
  const { projectTurnViewStateFromSessionEvents, renderProjectedReviewCard } = await import('../interactive/projection/turnViewProjector.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-auth-native-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'], native: process.env['BABEL_NATIVE_TOOLS'], profile: process.env['BABEL_TOOL_PROFILE'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile')
  process.env['BABEL_NATIVE_TOOLS'] = mode === 'native' ? 'enabled' : 'disabled'; process.env['BABEL_TOOL_PROFILE'] = mode
  let engine: InstanceType<typeof ChatEngine> | undefined; let calls = 0
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: status === 403 ? 'model_not_allowed' : 'invalid_api_key', message: 'SYNTHETIC_PRIVATE_ERROR_BODY' } }), { status }) }
    const discoveredPolicy = resolveModelByKey({ key: provider === 'command-code' ? 'command-code/deepseek-v4.1-flash' : 'deepseek-v4-flash-openrouter' })
    const { nativeToolUseUnverified: _unverified, ...knownCapability } = discoveredPolicy
    // Native cases simulate a supported model to exercise the fatal-auth
    // protocol; the live CommandCode capability remains unqualified.
    const basePolicy = mode === 'native' ? { ...knownCapability, nativeToolUse: true } : discoveredPolicy
    const policy = provider === 'deepseek' ? { ...basePolicy, provider: 'deepseek' as const, providerModelId: 'deepseek-v4-flash' } : basePolicy
    const runner = provider === 'openrouter' ? new OpenRouterApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' }) : provider === 'command-code' ? new CommandCodeApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' }) : new DeepSeekApiRunner(policy.providerModelId, { env: {}, explicitCredential: 'sk-synthetic-fixture' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner })
    const failures: unknown[] = []
    for await (const event of engine.submitMessageStream('Explain README')) if (event.type === 'failed') failures.push(event)
    assert.equal(calls, 1, 'authentication rejection must stop all subsequent inference')
    assert.equal(failures.length, 1)
    if (status === 403) assert.match(JSON.stringify(failures), /model_not_allowed/)
    assert.doesNotMatch(JSON.stringify(failures), /SYNTHETIC_PRIVATE_ERROR_BODY/)
    const view = projectTurnViewStateFromSessionEvents(engine.getParityRuntime().sessionEvents.events)
    assert.equal(view.reviewCard.reasonDetail, status === 401 ? 'authentication' : 'authorization')
    assert.doesNotMatch(renderProjectedReviewCard(view).body, /Next\s+Retry/)
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    if (prior.runs === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = prior.runs
    if (prior.state === undefined) delete process.env['BABEL_STATE_DIR']; else process.env['BABEL_STATE_DIR'] = prior.state
    if (prior.native === undefined) delete process.env['BABEL_NATIVE_TOOLS']; else process.env['BABEL_NATIVE_TOOLS'] = prior.native
    if (prior.profile === undefined) delete process.env['BABEL_TOOL_PROFILE']; else process.env['BABEL_TOOL_PROFILE'] = prior.profile
    rmSync(root, { recursive: true, force: true })
  }
})

test('unrecognized provider error codes cannot inject private text into terminal errors', async () => {
  const { ProviderHttpError } = await import('../runners/providerHttpError.js')
  const error = new ProviderHttpError('openrouter', 'fixture', 403, 'response', null, 'HTTP 403', 'SYNTHETIC_PRIVATE_CODE')
  assert.equal(error.apiErrorCode, null)
  assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_CODE/)
})

test('provider error bodies and unknown codes do not enter durable Chat evidence', async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js'); const { resolveModelByKey } = await import('../modelPolicy.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-provider-trace-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'], native: process.env['BABEL_NATIVE_TOOLS'], profile: process.env['BABEL_TOOL_PROFILE'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile'); process.env['BABEL_NATIVE_TOOLS'] = 'enabled'; process.env['BABEL_TOOL_PROFILE'] = 'native'
  let engine: InstanceType<typeof ChatEngine> | undefined; let calls = 0
  try {
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code: 'SYNTHETIC_CODE_CANARY', message: 'SYNTHETIC_TRACE_CANARY' } }), { status: 401, headers: { 'x-request-id': 'Bearer SYNTHETIC_REQUEST_SECRET' } }) }
    const policy = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' }); const runner = new OpenRouterApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner })
    for await (const _event of engine.submitMessageStream('Explain README')) { /* drain */ }
    assert.equal(calls, 1)
    const scan = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) scan(path); else if (entry.isFile() && /\.(?:json|jsonl|txt|md|log)$/i.test(entry.name)) { const bytes = readFileSync(path, 'utf8'); for (const marker of ['SYNTHETIC_CODE_CANARY', 'SYNTHETIC_TRACE_CANARY', 'SYNTHETIC_REQUEST_SECRET']) assert.equal(bytes.includes(marker), false, `${marker} in ${entry.name}`) } } }
    scan(join(root, 'runs'))
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    for (const [name, value] of Object.entries({ BABEL_RUNS_DIR: prior.runs, BABEL_STATE_DIR: prior.state, BABEL_NATIVE_TOOLS: prior.native, BABEL_TOOL_PROFILE: prior.profile })) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(root, { recursive: true, force: true })
  }
})

test('fatal authentication after malformed native output never enters schema repair', async t => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js'); const { resolveModelByKey } = await import('../modelPolicy.js'); const { ProviderHttpError } = await import('../runners/providerHttpError.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-auth-after-malformed-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'], native: process.env['BABEL_NATIVE_TOOLS'], profile: process.env['BABEL_TOOL_PROFILE'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile'); process.env['BABEL_NATIVE_TOOLS'] = 'enabled'; process.env['BABEL_TOOL_PROFILE'] = 'native'
  let engine: InstanceType<typeof ChatEngine> | undefined; let calls = 0
  try {
    globalThis.fetch = async () => { throw new Error('Unexpected network request') }
    const policy = { ...resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' }), nativeToolUse: true }
    const runner = new OpenRouterApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' })
    t.mock.method(runner, 'executeWithToolsStream', async function* () {
      calls++
      yield { type: 'error' as const, message: 'bad arguments', malformedToolArguments: { callId: 'call-1', name: 'file_read', finishReason: 'tool_calls', idWasNormalized: false } }
      yield { type: 'error' as const, message: 'HTTP 401', failure: new ProviderHttpError('openrouter', policy.providerModelId, 401, 'stream_retry', null, 'HTTP 401') }
    })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner })
    const events = []
    for await (const event of engine.submitMessageStream('Explain README')) events.push(event)
    assert.equal(calls, 1); assert.match(JSON.stringify(events), /authentication|HTTP 401/i)
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    for (const [name, value] of Object.entries({ BABEL_RUNS_DIR: prior.runs, BABEL_STATE_DIR: prior.state, BABEL_NATIVE_TOOLS: prior.native, BABEL_TOOL_PROFILE: prior.profile })) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(root, { recursive: true, force: true })
  }
})

test('explicit native-tool request for an unsupported model is rejected before transport', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js'); const { resolveModelByKey } = await import('../modelPolicy.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-tool-capability-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'], native: process.env['BABEL_NATIVE_TOOLS'], profile: process.env['BABEL_TOOL_PROFILE'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile'); process.env['BABEL_NATIVE_TOOLS'] = 'enabled'; process.env['BABEL_TOOL_PROFILE'] = 'native'
  let engine: InstanceType<typeof ChatEngine> | undefined; let calls = 0
  try {
    globalThis.fetch = async () => { calls++; return new Response('{}', { status: 401 }) }
    const policy = { ...resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' }), nativeToolUse: false }
    const runner = new OpenRouterApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner })
    const events = []
    for await (const event of engine.submitMessageStream('Explain README')) events.push(event)
    assert.equal(calls, 0, 'unsupported native tools must not reach the provider')
    assert.match(JSON.stringify(events), /unsupported.*native|native.*unsupported/i)
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    for (const [name, value] of Object.entries({ BABEL_RUNS_DIR: prior.runs, BABEL_STATE_DIR: prior.state, BABEL_NATIVE_TOOLS: prior.native, BABEL_TOOL_PROFILE: prior.profile })) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(root, { recursive: true, force: true })
  }
})

test('unverified native tools use text fallback and explicit native mode stops before transport', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js'); const { resolveModelByKey } = await import('../modelPolicy.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-unknown-capability-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'], native: process.env['BABEL_NATIVE_TOOLS'], profile: process.env['BABEL_TOOL_PROFILE'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile'); process.env['BABEL_NATIVE_TOOLS'] = 'enabled'; delete process.env['BABEL_TOOL_PROFILE']
  let engine: InstanceType<typeof ChatEngine> | undefined; let calls = 0
  try {
    globalThis.fetch = async (_url, init) => { calls++; assert.equal(JSON.parse(String(init?.body)).tools, undefined); return new Response('{}', { status: 401 }) }
    const { nativeToolUse: _nativeToolUse, ...basePolicy } = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' })
    const policy = { ...basePolicy, nativeToolUseUnverified: true }
    const runner = new OpenRouterApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner })
    for await (const _event of engine.submitMessageStream('Explain README')) { /* drain */ }
    assert.equal(calls, 1); engine.closeAdmissionStore(); engine = undefined
    process.env['BABEL_TOOL_PROFILE'] = 'native'
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner })
    const events = []
    for await (const event of engine.submitMessageStream('Explain README')) events.push(event)
    assert.equal(calls, 1); assert.match(JSON.stringify(events), /native tool.*unverified/i)
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    for (const [name, value] of Object.entries({ BABEL_RUNS_DIR: prior.runs, BABEL_STATE_DIR: prior.state, BABEL_NATIVE_TOOLS: prior.native, BABEL_TOOL_PROFILE: prior.profile })) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(root, { recursive: true, force: true })
  }
})

test('unsupported native tools use the text profile when no native profile is requested', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js'); const { resolveModelByKey } = await import('../modelPolicy.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-text-capability-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'], native: process.env['BABEL_NATIVE_TOOLS'], profile: process.env['BABEL_TOOL_PROFILE'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile'); process.env['BABEL_NATIVE_TOOLS'] = 'enabled'; delete process.env['BABEL_TOOL_PROFILE']
  let engine: InstanceType<typeof ChatEngine> | undefined; let calls = 0
  try {
    globalThis.fetch = async (_url, init) => { calls++; assert.equal(JSON.parse(String(init?.body)).tools, undefined); return new Response('{}', { status: 401 }) }
    const policy = { ...resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' }), nativeToolUse: false }
    const runner = new OpenRouterApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner })
    for await (const _event of engine.submitMessageStream('Explain README')) { /* drain */ }
    assert.equal(calls, 1)
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    for (const [name, value] of Object.entries({ BABEL_RUNS_DIR: prior.runs, BABEL_STATE_DIR: prior.state, BABEL_NATIVE_TOOLS: prior.native, BABEL_TOOL_PROFILE: prior.profile })) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(root, { recursive: true, force: true })
  }
})

test('repeated malformed text tool calls cannot become a successful completion', async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const { ChatEngine } = await import('./chatEngine.js'); const { OpenRouterApiRunner } = await import('../runners/openRouterApi.js'); const { resolveModelByKey } = await import('../modelPolicy.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-malformed-tool-')); writeFileSync(join(root, 'README.md'), 'Fixture')
  const prior = { fetch: globalThis.fetch, runs: process.env['BABEL_RUNS_DIR'], state: process.env['BABEL_STATE_DIR'], native: process.env['BABEL_NATIVE_TOOLS'], profile: process.env['BABEL_TOOL_PROFILE'] }
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs'); process.env['BABEL_STATE_DIR'] = join(root, 'profile'); process.env['BABEL_NATIVE_TOOLS'] = 'disabled'; process.env['BABEL_TOOL_PROFILE'] = 'text'
  let engine: InstanceType<typeof ChatEngine> | undefined; let calls = 0
  try {
    globalThis.fetch = async () => { calls++; return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '[TOOL:unknown_tool]\nparam: value' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) }
    const policy = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' })
    const runner = new OpenRouterApiRunner(policy.providerModelId, {}, { env: {}, explicitCredential: 'fixture-only' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: policy, providerRunner: runner, maxTurns: 4 })
    const events = []
    for await (const event of engine.submitMessageStream('Explain README')) events.push(event)
    assert.ok(calls <= 2, 'malformed retry must remain bounded')
    assert.equal(events.at(-1)?.type, 'failed')
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'Fixture')
  } finally {
    engine?.closeAdmissionStore(); globalThis.fetch = prior.fetch
    for (const [name, value] of Object.entries({ BABEL_RUNS_DIR: prior.runs, BABEL_STATE_DIR: prior.state, BABEL_NATIVE_TOOLS: prior.native, BABEL_TOOL_PROFILE: prior.profile })) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(root, { recursive: true, force: true })
  }
})
