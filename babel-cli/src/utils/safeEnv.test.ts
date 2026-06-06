import assert from 'node:assert/strict';
import test from 'node:test';

import { getSafeEnv } from './safeEnv.js';

test('getSafeEnv strips all configured LLM provider secrets', () => {
  const safe = getSafeEnv({
    DEEPSEEK_API_KEY: 'deepseek',
    DEEPINFRA_TOKEN: 'deepinfra-token',
    DEEPINFRA_API_KEY: 'deepinfra',
    GEMINI_API_KEY: 'gemini',
    GROQ_API_KEY: 'groq',
    ANTHROPIC_API_KEY: 'anthropic',
    OPENAI_API_KEY: 'openai',
    PATH: '/usr/bin',
  });

  assert.equal(safe.DEEPSEEK_API_KEY, undefined);
  assert.equal(safe.DEEPINFRA_TOKEN, undefined);
  assert.equal(safe.DEEPINFRA_API_KEY, undefined);
  assert.equal(safe.GEMINI_API_KEY, undefined);
  assert.equal(safe.GROQ_API_KEY, undefined);
  assert.equal(safe.ANTHROPIC_API_KEY, undefined);
  assert.equal(safe.OPENAI_API_KEY, undefined);
  assert.equal(safe.PATH, '/usr/bin');
});
