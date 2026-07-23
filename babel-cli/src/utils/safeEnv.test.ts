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

test('getSafeEnv preserves known-safe BABEL_* config variables', () => {
  const safe = getSafeEnv({
    BABEL_ROOT: '/opt/babel',
    BABEL_PROJECT_ROOT: '/var/tmp/project',
    BABEL_DRY_RUN: 'true',
    BABEL_LIVE: 'false',
    BABEL_EXECUTION_PROFILE: 'safe_repo',
    BABEL_SESSION_ID: 'session-123',
    BABEL_RUNS_DIR: '/tmp/runs',
    BABEL_STRICT_ENV: 'true',
    BABEL_MCP_TIMEOUT_MS: '30000',
    BABEL_BENCHMARK_DOCKER_IMAGE: 'example/task:latest',
    BABEL_BENCHMARK_DOCKER_EXTRA_ARGS: '--read-only',
    PATH: '/usr/bin',
  });

  assert.equal(safe.BABEL_ROOT, '/opt/babel');
  assert.equal(safe.BABEL_PROJECT_ROOT, '/var/tmp/project');
  assert.equal(safe.BABEL_DRY_RUN, 'true');
  assert.equal(safe.BABEL_LIVE, 'false');
  assert.equal(safe.BABEL_EXECUTION_PROFILE, 'safe_repo');
  assert.equal(safe.BABEL_SESSION_ID, 'session-123');
  assert.equal(safe.BABEL_RUNS_DIR, '/tmp/runs');
  assert.equal(safe.BABEL_STRICT_ENV, 'true');
  assert.equal(safe.BABEL_MCP_TIMEOUT_MS, '30000');
  assert.equal(safe.BABEL_BENCHMARK_DOCKER_IMAGE, 'example/task:latest');
  assert.equal(safe.BABEL_BENCHMARK_DOCKER_EXTRA_ARGS, '--read-only');
  assert.equal(safe.PATH, '/usr/bin');
});

test('getSafeEnv strips unknown BABEL_* variables (potential secrets)', () => {
  const safe = getSafeEnv({
    BABEL_API_KEY: 'api-key-fixture-should-be-stripped',
    BABEL_DEEPSEEK_KEY: 'deepseek-secret',
    BABEL_TEST_SECRET_KEY: 'test-secret',
    BABEL_MADE_UP_VAR: 'some-value',
    BABEL_ROOT: '/opt/babel', // known-safe, should survive
    PATH: '/usr/bin',
  });

  assert.equal(safe.BABEL_API_KEY, undefined);
  assert.equal(safe.BABEL_DEEPSEEK_KEY, undefined);
  assert.equal(safe.BABEL_TEST_SECRET_KEY, undefined);
  assert.equal(safe.BABEL_MADE_UP_VAR, undefined);
  assert.equal(safe.BABEL_ROOT, '/opt/babel'); // known-safe preserved
  assert.equal(safe.PATH, '/usr/bin');
});

test('getSafeEnv strips mix of known-safe and unknown BABEL_* plus provider secrets', () => {
  const safe = getSafeEnv({
    BABEL_PROJECT_ROOT: '/project',
    BABEL_UNKNOWN_SECRET: 'should-not-leak',
    DEEPINFRA_API_KEY: 'infra-key',
    ANTHROPIC_API_KEY: 'anthro-key',
    BABEL_TOKEN_BUDGET: '500000',
    BABEL_RANDOM_TOKEN: 'random-secret',
    HOME: '/var/tmp/user',
    NODE_ENV: 'production',
  });

  assert.equal(safe.BABEL_PROJECT_ROOT, '/project');
  assert.equal(safe.BABEL_TOKEN_BUDGET, '500000');
  assert.equal(safe.BABEL_UNKNOWN_SECRET, undefined);
  assert.equal(safe.BABEL_RANDOM_TOKEN, undefined);
  assert.equal(safe.DEEPINFRA_API_KEY, undefined);
  assert.equal(safe.ANTHROPIC_API_KEY, undefined);
  assert.equal(safe.HOME, '/var/tmp/user');
  assert.equal(safe.NODE_ENV, 'production');
});
