import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveChatDeliberationRunner, resolveChatSynthesisRunner, resolveChatFallbackRunner } from './chatEngineProviderRuntime.js'
import { resolveChatModelPolicy } from './chatModelPolicy.js'
import { ChatEngine } from './chatEngine.js'
import { resolveModelByKey } from '../modelPolicy.js'
import { ProviderEngine } from '../runners/providerEngine.js'

test('missing Chat selection does not invent a provider or model', () => {
  assert.throws(() => resolveChatDeliberationRunner(null, undefined), /setup|selection|select/i)
  assert.throws(() => resolveChatSynthesisRunner(null, undefined), /setup|selection|select/i)
})

test('model-free ChatEngine construction is allowed while model selection stays required', () => {
  const envKeys = ['BABEL_DESKTOP_PROVIDER', 'BABEL_DESKTOP_MODEL_ROUTE', 'BABEL_OFFLINE', 'BABEL_ROOT']
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]))
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-provider-selection-'))
  try {
    for (const key of envKeys) delete process.env[key]
    assert.throws(() => resolveChatModelPolicy({}), /SETUP_REQUIRED: No model connection is selected/)
    assert.doesNotThrow(() => new ChatEngine({ task: 'inspect without inference', projectRoot }))
    assert.throws(() => resolveChatDeliberationRunner(null, undefined), /SETUP_REQUIRED: No model connection is selected/)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('Chat deliberation and synthesis use the canonical engine for the exact policy route', () => {
  const policy = resolveModelByKey({ key: 'deepseek-v4-flash-openrouter' })
  const deliberation = resolveChatDeliberationRunner(null, policy)
  const synthesis = resolveChatSynthesisRunner(null, policy)
  assert.equal(deliberation instanceof ProviderEngine, true)
  assert.equal(synthesis instanceof ProviderEngine, true)
  assert.equal((deliberation as ProviderEngine).provider, policy.provider)
  assert.equal((deliberation as ProviderEngine).modelId, policy.providerModelId)
})

test('an unconfigured fallback never guesses a credentialed provider', () => {
  assert.equal(resolveChatFallbackRunner(null, {}, undefined), null)
})
