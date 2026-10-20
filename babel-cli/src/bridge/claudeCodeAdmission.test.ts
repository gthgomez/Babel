import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { evaluateClaudeCodeAdmission } from './claudeCodeAdmission.js';

const TRUSTED_AUTH = {
  trusted_auth_host_env: 'BABEL_TEST_AUTH_HOST',
  trusted_auth_child_env: 'ANTHROPIC_API_KEY',
} as const;

describe('claudeCodeAdmission', () => {
  const verifiedIntegrity = {
    state: 'verified' as const,
    sdkVersion: '0.3.304',
    cliVersion: '2.1.304',
    executablePath: '/opt/claude-agent-sdk-linux-x64/claude',
  };

  it('rejects missing credential ref before any resolver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-admit-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-config-'));
    let resolverCalled = false;
    const result = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'claude-sonnet-5-5',
        harness_credential_ref: '',
        harness_config_root: configRoot,
        project_root: root,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => {
          resolverCalled = true;
          return { ok: true, digest: 'abc' };
        },
      },
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.status === 'rejected' ? result.reason : '', 'credential_ref_missing');
    assert.equal(resolverCalled, false);
  });

  it('rejects unsupported profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-admit-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-config-'));
    const result = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: 'not-a-real-profile',
        harness_model_profile: 'm',
        harness_credential_ref: 'CRED_REF',
        harness_config_root: configRoot,
        project_root: root,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'abc' }),
      },
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.status === 'rejected' ? result.reason : '', 'profile_unsupported');
  });

  it('rejects policy drift evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-admit-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-config-'));
    writeFileSync(join(configRoot, 'settings.placeholder'), '{}');
    const result = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
        harness_model_profile: 'minimax-m3',
        harness_credential_ref: 'CRED_REF',
        harness_config_root: configRoot,
        project_root: root,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({
          ok: false,
          digest: 'deadbeef',
          detail: 'escalating defaultMode',
        }),
      },
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.status === 'rejected' ? result.reason : '', 'policy_unresolved');
  });

  it('rejects resume when admission digest drifts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-admit-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-config-'));
    const result = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'claude-sonnet-5-5',
        harness_credential_ref: 'CRED_REF',
        harness_config_root: configRoot,
        project_root: root,
        harness_native_session_id: 'sess-1',
        resume_expected_digest: 'deadbeef',
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-digest-1' }),
      },
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.status === 'rejected' ? result.reason : '', 'resume_digest_mismatch');
  });

  it('qualifies frozen tuple with digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-admit-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-config-'));
    const result = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'claude-sonnet-5-5',
        harness_credential_ref: 'CRED_REF',
        harness_config_root: configRoot,
        project_root: root,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-digest-1' }),
      },
    );
    assert.equal(result.status, 'qualified');
    if (result.status !== 'qualified') return;
    assert.ok(result.admitted.admission_digest.length === 64);
    assert.equal(result.admitted.harness_config_root, configRoot);
  });
});
