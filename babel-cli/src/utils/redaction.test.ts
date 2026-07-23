import assert from 'node:assert/strict';
import test from 'node:test';

import type { EnterprisePolicy } from '../config/enterprisePolicy.js';
import { redactEvidenceValue, redactSecrets } from './redaction.js';

const TEST_POLICY: EnterprisePolicy = {
  schema_version: 1,
  allowed_tools: [],
  disallowed_tools: [],
  allowed_mcp_servers: [],
  disallowed_mcp_servers: [],
  network_allowlist: [],
  model_policy: {
    allowed_backends: [],
    disallowed_backends: [],
    require_explicit_opt_in: [],
  },
  plugin_policy: {
    allowed_plugins: [],
    disallowed_plugins: [],
  },
  redaction: {
    enabled: true,
    extra_patterns: ['CUSTOM-SECRET-[0-9]+'],
  },
  telemetry: {},
};

test('redactSecrets masks common provider environment assignments', () => {
  const text =
    'DEEPSEEK_API_KEY=deepseek-secret DEEPINFRA_API_KEY=abc123 OPENAI_API_KEY="sk-live-value" safe=value';
  const redacted = redactSecrets(text, TEST_POLICY);

  assert.match(redacted, /DEEPSEEK_API_KEY= \[REDACTED\]/);
  assert.match(redacted, /DEEPINFRA_API_KEY= \[REDACTED\]/);
  assert.match(redacted, /OPENAI_API_KEY= \[REDACTED\]/);
  assert.match(redacted, /safe=value/);
  assert.doesNotMatch(redacted, /deepseek-secret/);
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /sk-live-value/);
});

test('redactSecrets masks bearer tokens and extra enterprise patterns', () => {
  const redacted = redactSecrets(
    'Authorization: Bearer abc.def.ghi and CUSTOM-SECRET-12345',
    TEST_POLICY,
  );

  assert.doesNotMatch(redacted, /abc\.def\.ghi/);
  assert.doesNotMatch(redacted, /CUSTOM-SECRET-12345/);
  assert.match(redacted, /\[REDACTED\]/);
});

test('redactEvidenceValue recursively masks secret-bearing fields', () => {
  const redacted = redactEvidenceValue(
    {
      ok: true,
      nested: {
        api_key: 'deepinfra-secret',
        access_token: 'access-secret',
        promptTokens: 123,
        totalTokens: 456,
        output: 'password: swordfish',
      },
    },
    TEST_POLICY,
  );

  assert.deepEqual(redacted, {
    ok: true,
    nested: {
      api_key: '[REDACTED]',
      access_token: '[REDACTED]',
      promptTokens: 123,
      totalTokens: 456,
      output: 'password: [REDACTED]',
    },
  });
});
