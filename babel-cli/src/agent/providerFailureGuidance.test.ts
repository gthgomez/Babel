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
  try {
    globalThis.fetch = async () => new Response('fixture rejection', { status: 401 })
    const policy = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' })
    engine = new ChatEngine({ task: 'Explain README', projectRoot: root, providerPolicy: { ...policy, provider: 'gemini', providerModelId: 'fixture-model' }, providerRunner: new GeminiApiRunner({ env: {}, explicitCredential: 'fixture-only', modelId: 'fixture-model', maxTokens: 64 }) })
    const failures: unknown[] = []
    for await (const event of engine.submitMessageStream('Explain README')) if (event.type === 'failed') failures.push(event)

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
