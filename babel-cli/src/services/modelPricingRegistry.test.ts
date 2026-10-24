import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEPSEEK_PRICING_SOURCE_URL,
  assertSupportedDeepSeekModel,
  estimateProviderUsageCost,
  getDeepInfraPricingEntries,
  getModelPricing,
  getModelPricingByModelId,
  CAMPAIGN_PRICING_VERIFIED_AT,
  COMMANDCODE_PRICING_SOURCE_URL,
} from './modelPricingRegistry.js';

test('Go 4.1 uses its published peak usage rates and keeps the billing estimate conservative', () => {
  const estimate = estimateProviderUsageCost({ provider: 'opencode-go', modelId: 'deepseek-v4.1-flash',
    promptTokens: 1000, completionTokens: 2000, promptCacheHitTokens: 400, promptCacheMissTokens: 600 });
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? -1) - 0.0025824) < 1e-12);
  assert.equal(estimate.precision, 'conservative');
  assert.equal(estimate.pricingSourceUrl, 'https://dev.opencode.ai/docs/go/');
  assert.equal(estimate.pricingVerifiedAt, '2026-10-04');
  assert.match(estimate.warning ?? '', /peak.*usage.*billing/i);
  assert.equal(getModelPricing('deepseek', 'deepseek-v4.1-flash'), null);
});

test('prices direct DeepSeek usage exactly when cache split tokens are reported', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    promptTokens: 1000,
    completionTokens: 2000,
    promptCacheHitTokens: 400,
    promptCacheMissTokens: 600,
  });

  assert.equal(estimate.precision, 'exact');
  assert.equal(estimate.pricingSourceUrl, DEEPSEEK_PRICING_SOURCE_URL);
  assert.equal(estimate.inputCacheHitCostPer1M, 0.0028);
  assert.equal(estimate.inputCacheMissCostPer1M, 0.14);
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? 0) - 0.00064512) < 1e-12);
});

test('marks cache-discounted models conservative when cache split tokens are absent', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'deepinfra',
    modelId: 'stepfun-ai/Step-3.5-Flash',
    promptTokens: 1000,
    completionTokens: 500,
  });

  assert.equal(estimate.precision, 'conservative');
  assert.match(estimate.warning ?? '', /cache discounts/i);
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? 0) - 0.00024) < 1e-12);
});

test('returns unknown pricing for unregistered provider models', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'deepinfra',
    modelId: 'missing/model',
    promptTokens: 1000,
    completionTokens: 1000,
  });

  assert.equal(estimate.precision, 'unknown');
  assert.equal(estimate.estimatedCostUsd, null);
  assert.match(estimate.warning ?? '', /No pinned pricing/);
});

test('exposes only supported direct DeepSeek model ids', () => {
  assert.equal(assertSupportedDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.throws(() => assertSupportedDeepSeekModel('deepseek-chat'), /Unsupported DeepSeek model/);
  assert.equal(getModelPricing('deepseek', 'deepseek-chat'), null);
  assert.equal(getModelPricing(undefined, 'deepseek-v4-flash'), null);
  assert.equal(getModelPricing('deepseek', undefined), null);
  assert.equal(getModelPricingByModelId('deepseek-v4-flash')?.provider, 'deepseek');
  assert.equal(getModelPricingByModelId('missing/model'), null);
  assert.ok(getDeepInfraPricingEntries().length >= 1);
});

test('prices output-only usage exactly for known models', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'deepinfra',
    modelId: 'Qwen/Qwen3-32B',
    completionTokens: 2000,
  });

  assert.equal(estimate.precision, 'exact');
  assert.equal(estimate.inputCostUsd, null);
  assert.ok(Math.abs((estimate.outputCostUsd ?? 0) - 0.00056) < 1e-12);
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? 0) - 0.00056) < 1e-12);
});

test('every two-provider campaign route has a pinned pricing entry', () => {
  const routes: Array<[string, string]> = [
    ['openrouter', 'deepseek/deepseek-v4.1-flash-1017'],
    ['openrouter', 'z-ai/glm-5.3-flash'],
    ['openrouter', 'xiaomi/mimo-v2.6-flash'],
    ['openrouter', 'openai/gpt-6-luna'],
    ['openrouter', 'anthropic/claude-haiku-5.5'],
    ['commandcode', 'deepseek/deepseek-v4.1-flash'],
    ['commandcode', 'z-ai/glm-5.3-flash'],
    ['commandcode', 'xiaomi/mimo-v2.6-flash'],
    ['commandcode', 'gpt-6-luna'],
    ['commandcode', 'claude-haiku-5-5'],
  ];
  for (const [provider, modelId] of routes) {
    const pricing = getModelPricing(provider, modelId);
    assert.ok(pricing, `missing pricing entry for ${provider}:${modelId}`);
    assert.equal(pricing.verifiedAt, CAMPAIGN_PRICING_VERIFIED_AT);
    assert.ok(pricing.inputCostPer1M > 0 && pricing.outputCostPer1M > 0);
  }
});

test('campaign DeepSeek ceilings use peak rates and stay conservative', () => {
  const openrouter = estimateProviderUsageCost({
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4.1-flash-1017',
    promptTokens: 1_000_000,
    completionTokens: 0,
  });
  assert.equal(openrouter.precision, 'conservative');
  assert.ok(Math.abs((openrouter.estimatedCostUsd ?? 0) - 0.3) < 1e-12);
  assert.match(openrouter.warning ?? '', /peak/i);

  const commandcode = estimateProviderUsageCost({
    provider: 'commandcode',
    modelId: 'deepseek/deepseek-v4.1-flash',
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 1_000_000,
  });
  assert.equal(commandcode.precision, 'conservative');
  assert.ok(Math.abs((commandcode.estimatedCostUsd ?? 0) - 1.5) < 1e-12);
});

test('commandcode tariff estimate is distinguishable from an exact provider invoice', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'commandcode',
    modelId: 'claude-haiku-5-5',
    promptTokens: 1000,
    completionTokens: 1000,
  });
  assert.equal(estimate.pricingSourceUrl, COMMANDCODE_PRICING_SOURCE_URL);
  // Tariff math is exact multiplication but the billing basis is an estimate,
  // never a provider-reported charge.
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? 0) - 0.0006) < 1e-12);
  // Cache discounts may apply but the cache split was not reported.
  assert.equal(estimate.precision, 'conservative');
  assert.ok(estimate.pricingVerifiedAt !== null);
});

test('refreshed GLM OpenRouter evidence replaces the stale August rates', () => {
  const pricing = getModelPricing('openrouter', 'z-ai/glm-5.3-flash');
  assert.ok(pricing);
  assert.equal(pricing.inputCostPer1M, 0.15);
  assert.equal(pricing.outputCostPer1M, 0.5);
  assert.equal(pricing.verifiedAt, CAMPAIGN_PRICING_VERIFIED_AT);
});
