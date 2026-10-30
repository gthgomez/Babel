import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEPSEEK_PRICING_SOURCE_URL,
  assertSupportedDeepSeekModel,
  estimateProviderUsageCost,
  getDeepInfraPricingEntries,
  getModelPricing,
  getModelPricingByModelId,
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

test('prices an incomplete cache split at the full prompt rate instead of omitting prompt tokens', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    promptTokens: 1000,
    completionTokens: 0,
    promptCacheMissTokens: 600,
  });

  assert.equal(estimate.precision, 'conservative');
  assert.match(estimate.warning ?? '', /do not cover the total prompt/i);
  assert.ok(Math.abs((estimate.inputCostUsd ?? -1) - 0.00014) < 1e-12);
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? -1) - 0.00014) < 1e-12);
});

test('keeps total cost unknown when cache counts have no prompt total', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    completionTokens: 2000,
    promptCacheHitTokens: 400,
    promptCacheMissTokens: 600,
  });

  assert.equal(estimate.precision, 'unknown');
  assert.equal(estimate.inputCostUsd, null);
  assert.ok(Math.abs((estimate.outputCostUsd ?? -1) - 0.00056) < 1e-12);
  assert.equal(estimate.estimatedCostUsd, null);
  assert.match(estimate.warning ?? '', /total prompt token count/i);
});

test('estimates current OpenRouter DeepSeek Flash conservatively when cache billing is unknown', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4.1-flash-1017',
    promptTokens: 1000,
    completionTokens: 2000,
  });

  assert.equal(estimate.precision, 'conservative');
  assert.match(estimate.warning ?? '', /highest listed OpenRouter endpoint rates/i);
  assert.equal(estimate.inputCostPer1M, 0.33);
  assert.equal(estimate.outputCostPer1M, 1.32);
  assert.equal(estimate.pricingSourceUrl, 'https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017');
  assert.equal(estimate.pricingVerifiedAt, '2026-10-30');
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? -1) - 0.00297) < 1e-12);
});

test('keeps cached-input OpenRouter estimates conservative without a pinned cache rate', () => {
  const estimate = estimateProviderUsageCost({
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4.1-flash-1017',
    promptTokens: 1000,
    completionTokens: 2000,
    promptCacheHitTokens: 400,
    promptCacheMissTokens: 600,
  });

  assert.equal(estimate.precision, 'conservative');
  assert.match(estimate.warning ?? '', /cache.*rate|cache.*discount/i);
  assert.ok(Math.abs((estimate.estimatedCostUsd ?? -1) - 0.00297) < 1e-12);
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
