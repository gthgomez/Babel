import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { buildClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import {
  assertClaudeStrictMcpQueryTransportAvailable,
  buildClaudeCodeQueryTransportOptions,
} from './claudeCodeQueryTransportOptions.js';

describe('claudeCodeQueryTransportOptions', () => {
  const admitted = {
    harness_adapter_id: 'claude-code' as const,
    harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
    harness_model_profile: 'mimo-v2.5',
    harness_credential_ref: 'CRED',
    harness_config_root: '/cfg',
    project_policy_root: '/proj',
    trusted_auth_host_env: 'H',
    trusted_auth_child_env: 'ANTHROPIC_API_KEY',
    cwd: '/proj',
    sdk_version: '0.3.304',
    cli_version: '2.1.304',
    cli_executable_path: '/bin/claude',
    policy_digest: 'p',
    admission_digest: 'a'.repeat(64),
  };

  it('requires top-level strictMcpConfig true on launch spec (SDK 0.3.304 query option)', () => {
    const policy = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    assert.equal(policy.strictMcpConfig, true);
    assert.equal(assertClaudeStrictMcpQueryTransportAvailable(policy).ok, true);
    const transport = buildClaudeCodeQueryTransportOptions({ admitted, policy });
    assert.equal(transport.strictMcpConfig, true);
    assert.equal(transport.projectConfigRoot, '/proj');
    assert.equal('strictMcpConfig' in policy.managedSettings, false);
  });

  it('fails closed when strictMcpConfig transport is false', () => {
    const policy = {
      ...buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat),
      strictMcpConfig: false as unknown as true,
    };
    const gate = assertClaudeStrictMcpQueryTransportAvailable(policy);
    assert.equal(gate.ok, false);
  });
});
