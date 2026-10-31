import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChatDeliberationRunner, resolveChatSynthesisRunner, resolveChatFallbackRunner } from './chatEngineProviderRuntime.js'
import { resolveModelByKey } from '../modelPolicy.js'
import { ProviderEngine } from '../runners/providerEngine.js'

test('missing Chat selection does not invent a provider or model', () => {
  assert.throws(() => resolveChatDeliberationRunner(null, undefined), /setup|selection|select/i)
  assert.throws(() => resolveChatSynthesisRunner(null, undefined), /setup|selection|select/i)
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
