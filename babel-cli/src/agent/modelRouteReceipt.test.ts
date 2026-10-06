import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAuxiliaryRouteReceipt,
  buildModelRouteReceipt,
  hashRouteReference,
  validateModelRouteReceipt,
} from './modelRouteReceipt.js';

test('model route receipt binds exact route facts without prompt content', () => {
  const receipt = buildModelRouteReceipt({
    projectRef: hashRouteReference('C:/project'),
    taskRef: hashRouteReference('task text'),
    runRef: 'C:/run/session-1',
    contractRef: 'chat',
    inferenceId: 'inference-1',
    executionStage: 'chat',
    requestedModelSelector: 'glm-5.3-flash',
    normalizedBabelModel: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
    exactModelIdSent: 'z-ai/glm-5.3-flash',
    retryCount: 1,
    substitutionOrFallback: false,
    timestamp: '2026-08-28T00:00:00.000Z',
  });
  validateModelRouteReceipt(receipt);
  assert.equal(receipt.observed_model_id, null);
  assert.equal(JSON.stringify(receipt).includes('task text'), false);
  assert.equal(receipt.receipt_hash.length, 64);
});

test('model route receipt rejects tampering', () => {
  const receipt = buildModelRouteReceipt({
    projectRef: 'project',
    taskRef: 'task',
    runRef: 'run',
    contractRef: 'chat',
    inferenceId: 'inference-1',
    requestedModelSelector: 'glm-5.3-flash',
    normalizedBabelModel: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
    exactModelIdSent: 'z-ai/glm-5.3-flash',
    timestamp: '2026-08-28T00:00:00.000Z',
  });
  const tampered = { ...receipt, exact_model_id_sent: 'other/model' };
  assert.throws(() => validateModelRouteReceipt(tampered), /hash does not match/);
});

test('auxiliary_route_identity_is_receipted', () => {
  const lite = buildAuxiliaryRouteReceipt({
    stage: 'lite',
    projectRef: 'project',
    taskRef: 'task',
    runRef: 'run',
    contractRef: 'lite',
    inferenceId: 'lite-1',
    requestedModelSelector: 'deepseek-v4-flash',
    normalizedBabelModel: 'deepseek-v4-flash',
    provider: 'deepseek',
    exactModelIdSent: 'deepseek-v4-flash',
    observedModelId: null,
    upstreamProvider: null,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    timestamp: '2026-10-06T00:00:00.000Z',
  });
  validateModelRouteReceipt(lite);
  assert.equal(lite.execution_stage, 'lite');
  assert.equal(lite.provider, 'deepseek');
  assert.equal(lite.exact_model_id_sent, 'deepseek-v4-flash');
  assert.equal(lite.observed_model_id, null);

  const synthesis = buildAuxiliaryRouteReceipt({
    stage: 'synthesis',
    projectRef: 'project',
    taskRef: 'task',
    runRef: 'run',
    contractRef: 'synthesis',
    inferenceId: 'synthesis-1',
    requestedModelSelector: 'glm-5.3-flash',
    normalizedBabelModel: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
    exactModelIdSent: 'z-ai/glm-5.3-flash',
    timestamp: '2026-10-06T00:00:00.000Z',
  });
  validateModelRouteReceipt(synthesis);
  assert.equal(synthesis.execution_stage, 'synthesis');
  assert.equal(synthesis.provider, 'openrouter');
  assert.equal(synthesis.exact_model_id_sent, 'z-ai/glm-5.3-flash');

  // An unregistered provider is a typed refusal, never a fabricated identity.
  assert.throws(
    () =>
      buildAuxiliaryRouteReceipt({
        stage: 'lite',
        projectRef: 'project',
        taskRef: 'task',
        runRef: 'run',
        contractRef: 'lite',
        inferenceId: 'lite-2',
        requestedModelSelector: 'x',
        normalizedBabelModel: 'x',
        provider: 'not-a-provider' as never,
        exactModelIdSent: 'x',
      }),
    /registered provider/,
  );
});

test('unknown_accounting_stays_unknown', () => {
  // Explicit unknown observations stay null; they are never coerced to zero.
  const unknown = buildAuxiliaryRouteReceipt({
    stage: 'lite',
    projectRef: 'project',
    taskRef: 'task',
    runRef: 'run',
    contractRef: 'lite',
    inferenceId: 'lite-unknown',
    requestedModelSelector: 'deepseek-v4-flash',
    normalizedBabelModel: 'deepseek-v4-flash',
    provider: 'deepseek',
    exactModelIdSent: 'deepseek-v4-flash',
    observedModelId: null,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    timestamp: '2026-10-06T00:00:00.000Z',
  });
  validateModelRouteReceipt(unknown);
  assert.equal(unknown.prompt_tokens, null);
  assert.equal(unknown.completion_tokens, null);
  assert.equal(unknown.cost_usd, null);
  assert.equal(unknown.observed_model_id, null);

  // When no accounting observation is provided the fields are absent, not zero.
  const unspecified = buildAuxiliaryRouteReceipt({
    stage: 'synthesis',
    projectRef: 'project',
    taskRef: 'task',
    runRef: 'run',
    contractRef: 'synthesis',
    inferenceId: 'synthesis-unspecified',
    requestedModelSelector: 'glm-5.3-flash',
    normalizedBabelModel: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
    exactModelIdSent: 'z-ai/glm-5.3-flash',
    timestamp: '2026-10-06T00:00:00.000Z',
  });
  validateModelRouteReceipt(unspecified);
  assert.equal('prompt_tokens' in unspecified, false);
  assert.equal('cost_usd' in unspecified, false);

  // Zero is a real observed value and is preserved distinctly from unknown.
  const zero = buildAuxiliaryRouteReceipt({
    stage: 'lite',
    projectRef: 'project',
    taskRef: 'task',
    runRef: 'run',
    contractRef: 'lite',
    inferenceId: 'lite-zero',
    requestedModelSelector: 'deepseek-v4-flash',
    normalizedBabelModel: 'deepseek-v4-flash',
    provider: 'deepseek',
    exactModelIdSent: 'deepseek-v4-flash',
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    timestamp: '2026-10-06T00:00:00.000Z',
  });
  validateModelRouteReceipt(zero);
  assert.equal(zero.prompt_tokens, 0);
  assert.equal(zero.completion_tokens, 0);
  assert.equal(zero.cost_usd, 0);
});
