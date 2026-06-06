import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeEnv } from './runtimeEnv.js';

test('validateRuntimeEnv accepts supported Babel startup env vars', () => {
  const parsed = validateRuntimeEnv({
    BABEL_ORCHESTRATOR_VERSION: 'v9',
    BABEL_DRY_RUN: 'true',
    BABEL_DRY_RUN_SOURCE: 'persisted',
    BABEL_LIVE: 'false',
    BABEL_RUNTIME_MODE: 'act',
    BABEL_ENV: 'production',
    BABEL_CLI_TIMEOUT_MS: '120000',
    BABEL_WATERFALL_TIMEOUT_MS: '180000',
    BABEL_DEEPINFRA_TOKENS: '8096',
    BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS: '120000',
    BABEL_DEEPINFRA_REQUEST_MAX_RETRIES: '4',
    BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS: '60000',
    BABEL_DEEPINFRA_STREAM_MAX_RETRIES: '0',
  });

  assert.equal(parsed.BABEL_ORCHESTRATOR_VERSION, 'v9');
  assert.equal(parsed.BABEL_DRY_RUN, 'true');
  assert.equal(parsed.BABEL_DRY_RUN_SOURCE, 'persisted');
  assert.equal(parsed.BABEL_LIVE, 'false');
  assert.equal(parsed.BABEL_RUNTIME_MODE, 'act');
  assert.equal(parsed.BABEL_CLI_TIMEOUT_MS, 120000);
  assert.equal(parsed.BABEL_WATERFALL_TIMEOUT_MS, 180000);
  assert.equal(parsed.BABEL_DEEPINFRA_TOKENS, 8096);
  assert.equal(parsed.BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS, 120000);
  assert.equal(parsed.BABEL_DEEPINFRA_REQUEST_MAX_RETRIES, 4);
  assert.equal(parsed.BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS, 60000);
  assert.equal(parsed.BABEL_DEEPINFRA_STREAM_MAX_RETRIES, 0);
});

test('validateRuntimeEnv rejects invalid numeric values with clear variable names', () => {
  assert.throws(
    () => validateRuntimeEnv({ BABEL_CLI_TIMEOUT_MS: 'abc' }),
    /BABEL_CLI_TIMEOUT_MS/,
  );
});

test('validateRuntimeEnv rejects unsupported orchestrator versions', () => {
  assert.throws(
    () => validateRuntimeEnv({ BABEL_ORCHESTRATOR_VERSION: 'v8' }),
    /BABEL_ORCHESTRATOR_VERSION/,
  );
});
