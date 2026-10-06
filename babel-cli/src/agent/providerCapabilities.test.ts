import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCompactionCapsule,
  buildContextBudgetSnapshot,
  formatCompactionCapsule,
  resolveProviderCapabilities,
  resolveProviderCapabilitiesForRoute,
} from './providerCapabilities.js'

test('routed_identity_is_not_inferred', () => {
  // Explicit route input wins over any substring in the model name.
  const routed = resolveProviderCapabilitiesForRoute({
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4-pro',
  })
  assert.equal(routed.provider, 'openrouter')
  assert.equal(routed.modelId, 'deepseek/deepseek-v4-pro')
  // OpenRouter's defaults, not direct DeepSeek's.
  assert.equal(routed.supportsThinking, true)
  assert.equal(routed.thinkingWithTools, 'unknown')

  // A colon in a cloud model ID is not evidence of a local Ollama provider.
  const colon = resolveProviderCapabilitiesForRoute({
    provider: 'openrouter',
    modelId: 'example/model:free',
  })
  assert.equal(colon.provider, 'openrouter')
  assert.notEqual(colon.maxOutputTokens, 4_096)
  assert.equal(colon.supportsToolChoice, true)

  // The compatibility adapter resolves the tuple graph and never infers.
  const compatible = resolveProviderCapabilities('example/model:free')
  assert.notEqual(compatible.maxOutputTokens, 4_096)
  assert.equal(compatible.supportsToolChoice, true)
})

test('compaction_receipt_identity_survives', () => {
  const input = {
    task: 'fix context budget',
    taskAcceptanceId: 'acceptance-42',
    planStep: 'step-2',
    changedPaths: ['src/agent/context-budget.ts'],
    rawObservationRefs: ['obs:deadbeef'],
  }
  const first = buildCompactionCapsule(input)
  const second = buildCompactionCapsule(input)

  assert.equal(first.taskAcceptanceId, 'acceptance-42')
  assert.equal(second.taskAcceptanceId, 'acceptance-42')
  // The controller-owned capsule payload (and therefore its digest identity)
  // is deterministic for the same operational state.
  assert.equal(formatCompactionCapsule(first), formatCompactionCapsule(second))

  // Budget accounting does not mutate or re-own the capsule payload.
  buildContextBudgetSnapshot({
    nextRequestTokens: 10_000,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  })
  assert.equal(formatCompactionCapsule(first), formatCompactionCapsule(buildCompactionCapsule(input)))
})

test('prompt_components_counted_once', () => {
  // `nextRequestTokens` is the total payload; canonical/retrieved breakdown
  // fields are informational and must not be subtracted a second time.
  const snapshot = buildContextBudgetSnapshot({
    nextRequestTokens: 2_000,
    canonicalStateTokens: 500,
    retrievedContextTokens: 300,
    contextWindow: 100_000,
    maxOutputTokens: 8_192,
    requestedOutputTokens: 1_024,
  })
  assert.equal(snapshot.headroom, 100_000 - 1_024 - 4_096 - 1_024 - 2_000)

  // A caller that passes a total excluding the breakdown adds it exactly once.
  const excluded = buildContextBudgetSnapshot({
    nextRequestTokens: 1_200,
    canonicalStateTokens: 500,
    retrievedContextTokens: 300,
    breakdownExcludedFromNextRequest: true,
    contextWindow: 100_000,
    maxOutputTokens: 8_192,
    requestedOutputTokens: 1_024,
  })
  assert.equal(excluded.headroom, snapshot.headroom)
})
