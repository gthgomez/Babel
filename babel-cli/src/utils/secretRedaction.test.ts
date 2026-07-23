import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSecrets, redactSecretsDeep, containsSecrets } from './secretRedaction.js';

// Fixtures must exercise redaction patterns without looking like live provider keys
// (GitHub push protection blocks realistic sk- tokens).

const FAKE_SK = 'sk-your_XXXXXXXXXXXXXXXXXXXX';
const FAKE_ENV_VALUE = 'fixture_secret_value_for_redaction_tests_only';

test('redactSecrets masks sk- prefixed API keys', () => {
  const input = FAKE_SK;
  const result = redactSecrets(input);
  assert.ok(!result.includes('UNITTEST_ONLY_FAKE_KEY_XXXXXX'));
  assert.ok(result.includes('_REDACTED_'));
});

test('redactSecrets masks inline env assignments', () => {
  const input = `DEEPSEEK_API_KEY=${FAKE_ENV_VALUE}`;
  const result = redactSecrets(input);
  assert.ok(!result.includes(FAKE_ENV_VALUE));
  assert.ok(result.includes('_REDACTED_'));
});

test('redactSecrets masks PowerShell inline env assignments', () => {
  const input = '$env:DEEPINFRA_API_KEY = "oqXgx_fake_test_key_for_unit_tests_only"';
  const result = redactSecrets(input);
  assert.ok(!result.includes('oqXgx_fake_test_key_for_unit_tests_only'));
  assert.ok(result.includes('_REDACTED_'));
});

test('redactSecrets preserves non-secret text', () => {
  const input = 'npx tsx scripts/live_cli_reliability_matrix.ts --profile fast';
  assert.equal(redactSecrets(input), input);
});

test('redactSecrets handles empty string', () => {
  assert.equal(redactSecrets(''), '');
});

test('redactSecrets masks mixed secrets in command string', () => {
  const input = `$env:DEEPSEEK_API_KEY = "${FAKE_ENV_VALUE}"; npx tsx script.ts`;
  const result = redactSecrets(input);
  assert.ok(!result.includes(FAKE_ENV_VALUE));
  assert.ok(result.includes('_REDACTED_'));
  assert.ok(result.includes('npx tsx script.ts'));
});

test('containsSecrets detects API key patterns', () => {
  assert.equal(containsSecrets(FAKE_SK), true);
  assert.equal(containsSecrets('DEEPSEEK_API_KEY=abc123'), true);
  assert.equal(containsSecrets('normal text without secrets'), false);
});

test('redactSecretsDeep handles nested objects', () => {
  const input = {
    command: 'node --env-file=.env dist/index.js',
    env: { DEEPSEEK_API_KEY: FAKE_ENV_VALUE },
    nested: { value: '$env:DEEPINFRA_API_KEY = "oqXgxdeadbeefdeadbeefdeadbeefdeadbeef"' },
  };
  const result = redactSecretsDeep(input);
  assert.ok(!JSON.stringify(result).includes(FAKE_ENV_VALUE));
  assert.ok(!JSON.stringify(result).includes('oqXgxdeadbeef'));
  assert.ok((result as typeof input).command === input.command);
});
