import assert from 'node:assert/strict';
import test from 'node:test';

import { preflightRequestedModelPolicy } from './workflowModelPolicy.js';

test('workflow preflight accepts an exact configured provider model id', () => {
  const policy = preflightRequestedModelPolicy('z-ai/glm-5.3-flash', {
    liveOnly: true,
  });

  assert.equal(policy.resolvedBackendKey, 'glm-5.3-flash');
  assert.equal(policy.provider, 'openrouter');
  assert.equal(policy.providerModelId, 'z-ai/glm-5.3-flash');
});

test('workflow preflight preserves configured backend-key resolution', () => {
  const policy = preflightRequestedModelPolicy('deepseek-v4-flash-openrouter', {
    liveOnly: true,
  });

  assert.equal(policy.resolvedBackendKey, 'deepseek-v4-flash-openrouter');
  assert.equal(policy.provider, 'openrouter');
  assert.equal(policy.providerModelId, 'deepseek/deepseek-v4-flash-0731');
});
