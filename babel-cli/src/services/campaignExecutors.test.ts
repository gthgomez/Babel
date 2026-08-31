import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBabelCliChatHeadlessArmExecutor,
} from './campaignExecutors.js';
import {
  LIVE_OPENROUTER_MODEL_ID,
} from '../modelPolicy.js';

const baseRequest = {
  arm: 'babel_enforce' as const,
  workspaceRoot: '',
  prompt: '',
  model: LIVE_OPENROUTER_MODEL_ID,
  provider: 'live' as const,
  timeoutMs: 1,
  cliEntry: '',
  spawnCwd: '',
};

test('GLM campaign preflight requires OpenRouter rather than accepting DeepSeek', async () => {
  const executor = createBabelCliChatHeadlessArmExecutor();

  const deepSeekOnly = await executor.preflight?.({
    ...baseRequest,
    env: { DEEPSEEK_API_KEY: 'synthetic-deepseek-key' },
  });
  assert.equal(deepSeekOnly?.ready, false);
  assert.deepEqual(deepSeekOnly?.missingCredentials, ['OPENROUTER_API_KEY']);

  const openRouter = await executor.preflight?.({
    ...baseRequest,
    env: { OPENROUTER_API_KEY: 'fixture-router-key' },
  });
  assert.deepEqual(openRouter, { ready: true });
});

test('campaign live preflight rejects unknown routes instead of falling through to direct credentials', async () => {
  const executor = createBabelCliChatHeadlessArmExecutor();
  const result = await executor.preflight?.({
    ...baseRequest,
    model: 'qwen3',
    env: {
      DEEPSEEK_API_KEY: 'synthetic-deepseek-key',
      DEEPINFRA_API_KEY: 'synthetic-deepinfra-key',
    },
  });
  assert.equal(result?.ready, false);
  assert.equal(result?.signature, 'policy:unapproved_live_route');
  assert.match(result?.reason ?? '', /OpenRouter DeepSeek/);
});
