import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  evaluateMcpServerPolicy,
  evaluateModelBackendPolicy,
  evaluateNetworkHostPolicy,
  evaluatePluginPolicy,
  evaluateTelemetryPolicy,
  evaluateToolPolicy,
  formatEnterprisePolicyDecision,
  loadEnterprisePolicy,
  type EnterprisePolicy,
} from './enterprisePolicy.js';

function withPolicyEnv<T>(policyPath: string | undefined, fn: () => T): T {
  const previous = {
    explicit: process.env['BABEL_ENTERPRISE_POLICY_PATH'],
    user: process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'],
    admin: process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'],
    babelRoot: process.env['BABEL_ROOT'],
    userProfile: process.env['USERPROFILE'],
    home: process.env['HOME'],
  };

  if (policyPath) {
    process.env['BABEL_ENTERPRISE_POLICY_PATH'] = policyPath;
    process.env['BABEL_ROOT'] = dirname(policyPath);
  } else {
    delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
  }
  process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = join(
    tmpdir(),
    'babel-missing-user-policy.json',
  );
  delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
  delete process.env['USERPROFILE'];
  delete process.env['HOME'];

  try {
    return fn();
  } finally {
    if (previous.explicit === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_PATH'] = previous.explicit;
    if (previous.user === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_USER_PATH'] = previous.user;
    if (previous.admin === undefined) delete process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'];
    else process.env['BABEL_ENTERPRISE_POLICY_ADMIN_PATH'] = previous.admin;
    if (previous.babelRoot === undefined) delete process.env['BABEL_ROOT'];
    else process.env['BABEL_ROOT'] = previous.babelRoot;
    if (previous.userProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = previous.userProfile;
    if (previous.home === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previous.home;
  }
}

test('loadEnterprisePolicy uses permissive redacting defaults when no files exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-policy-root-'));

  const result = withPolicyEnv(undefined, () => loadEnterprisePolicy(root));

  assert.equal(result.loaded, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.policy.redaction.enabled, true);
  assert.deepEqual(result.policy.allowed_tools, []);
  assert.deepEqual(result.policy.network_allowlist, []);
});

test('loadEnterprisePolicy merges explicit policy controls', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-policy-root-'));
  const policyPath = join(root, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      policy_name: 'test enterprise',
      allowed_tools: ['file_read', 'web_fetch'],
      disallowed_tools: ['shell_exec'],
      allowed_mcp_servers: ['github'],
      network_allowlist: ['example.com', '*.example.org'],
      redaction: {
        enabled: true,
        extra_patterns: ['CUSTOM-[0-9]+'],
      },
    }),
    'utf8',
  );

  const result = withPolicyEnv(policyPath, () => loadEnterprisePolicy(root));

  assert.equal(result.loaded, true);
  assert.equal(result.policy.policy_name, 'test enterprise');
  assert.deepEqual(result.policy.allowed_tools, ['file_read', 'web_fetch']);
  assert.deepEqual(result.policy.disallowed_tools, ['shell_exec']);
  assert.deepEqual(result.policy.allowed_mcp_servers, ['github']);
  assert.deepEqual(result.policy.network_allowlist, ['example.com', '*.example.org']);
  assert.deepEqual(result.policy.redaction.extra_patterns, ['CUSTOM-[0-9]+']);
});

test('enterprise policy decisions are deny-first and allowlist aware', () => {
  const policy: EnterprisePolicy = {
    schema_version: 1,
    allowed_tools: ['file_read'],
    disallowed_tools: ['file_write'],
    allowed_mcp_servers: ['github'],
    disallowed_mcp_servers: ['sqlite'],
    network_allowlist: ['example.com', '*.example.org'],
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
      extra_patterns: [],
    },
    telemetry: {},
  };

  assert.equal(evaluateToolPolicy('file_write', policy).allowed, false);
  assert.equal(evaluateToolPolicy('shell_exec', policy).allowed, false);
  assert.equal(evaluateToolPolicy('file_read', policy).allowed, true);
  assert.equal(evaluateMcpServerPolicy('sqlite', policy).allowed, false);
  assert.equal(evaluateMcpServerPolicy('github', policy).allowed, true);
  assert.equal(evaluateMcpServerPolicy('postgres', policy).allowed, false);
  assert.equal(evaluateNetworkHostPolicy('api.example.org', policy).allowed, true);
  assert.equal(evaluateNetworkHostPolicy('evil.test', policy).allowed, false);
});

test('enterprise policy denials include source and fix hints', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-policy-root-'));
  const policyPath = join(root, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      allowed_tools: ['file_read'],
      allowed_mcp_servers: ['github'],
      network_allowlist: ['example.com'],
      model_policy: {
        allowed_backends: ['deepinfra'],
      },
      plugin_policy: {
        allowed_plugins: ['sample-readonly'],
        max_trust_level: 'read_only',
      },
      telemetry: {
        opt_in: false,
      },
    }),
    'utf8',
  );

  withPolicyEnv(policyPath, () => {
    const toolDecision = evaluateToolPolicy('shell_exec');
    assert.equal(toolDecision.allowed, false);
    assert.equal(toolDecision.policy_source, `explicit:${policyPath}`);
    assert.match(toolDecision.fix_hint ?? '', /allowed_tools/);
    assert.match(formatEnterprisePolicyDecision(toolDecision), /source: explicit:/);
    assert.match(formatEnterprisePolicyDecision(toolDecision), /fix:/);

    const mcpDecision = evaluateMcpServerPolicy('sqlite');
    assert.equal(mcpDecision.allowed, false);
    assert.match(mcpDecision.fix_hint ?? '', /allowed_mcp_servers/);

    const networkDecision = evaluateNetworkHostPolicy('api.example.org');
    assert.equal(networkDecision.allowed, false);
    assert.match(networkDecision.fix_hint ?? '', /network_allowlist/);

    const modelDecision = evaluateModelBackendPolicy({
      backendKey: 'openai-gpt',
      provider: 'openai',
      providerModelId: 'gpt-5.4',
    });
    assert.equal(modelDecision.allowed, false);
    assert.match(modelDecision.fix_hint ?? '', /allowed_backends/);

    const pluginDecision = evaluatePluginPolicy('sample-format-hook', 'local_mutating');
    assert.equal(pluginDecision.allowed, false);
    assert.match(pluginDecision.fix_hint ?? '', /allowed_plugins/);

    const telemetryDecision = evaluateTelemetryPolicy();
    assert.equal(telemetryDecision.allowed, false);
    assert.match(telemetryDecision.fix_hint ?? '', /telemetry\.opt_in/);
  });
});

test('enterprise policy enforcement fails closed when a configured policy is malformed', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-policy-root-'));
  const policyPath = join(root, 'broken-policy.json');
  writeFileSync(policyPath, '{ "schema_version": 2 }', 'utf8');

  const decision = withPolicyEnv(policyPath, () => evaluateToolPolicy('file_read'));

  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /enterprise policy failed to load/);
  assert.equal(decision.policy_source, `explicit:${policyPath}`);
  assert.match(decision.fix_hint ?? '', /malformed enterprise policy/);
});
