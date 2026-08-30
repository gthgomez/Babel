import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
