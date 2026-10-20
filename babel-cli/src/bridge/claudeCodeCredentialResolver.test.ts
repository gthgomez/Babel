import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { evaluateClaudeCodeAdmission } from './claudeCodeAdmission.js';
import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';
import {
  ClaudeCodeCredentialResolutionError,
  resolveClaudeCodeHarnessCredentialEnv,
} from './claudeCodeCredentialResolver.js';

const TRUSTED_AUTH = {
  trusted_auth_host_env: 'BABEL_TEST_ANTHROPIC_KEY',
  trusted_auth_child_env: 'ANTHROPIC_API_KEY',
} as const;

describe('claudeCodeCredentialResolver', () => {
  const verifiedIntegrity = {
    state: 'verified' as const,
    sdkVersion: '0.3.304',
    cliVersion: '2.1.304',
    executablePath: '/opt/claude-agent-sdk-linux-x64/claude',
  };

  it('rejects unknown credential ref before reading host secrets for admission paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-cred-admit-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-cred-cfg-'));
    writeFileSync(
      join(configRoot, CLAUDE_HARNESS_MANIFEST_FILENAME),
      JSON.stringify({ version: 1, credential_refs: {} }),
      'utf8',
    );
    let resolverCalled = false;
    const admission = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'claude-sonnet-5-5',
        harness_credential_ref: 'MISSING_REF',
        harness_config_root: configRoot,
        project_root: root,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy' }),
      },
    );
    assert.equal(admission.status, 'qualified');
    if (admission.status !== 'qualified') return;
    assert.throws(
      () => resolveClaudeCodeHarnessCredentialEnv('MISSING_REF', admission.admitted, {}),
      ClaudeCodeCredentialResolutionError,
    );
    resolverCalled = true;
    assert.equal(resolverCalled, true);
  });

  it('resolves configured host env into child env map', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-cred-admit-2-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-cred-cfg-2-'));
    writeFileSync(
      join(configRoot, CLAUDE_HARNESS_MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        credential_refs: {
          TEST_CRED: { host_env: 'BABEL_TEST_ANTHROPIC_KEY' },
        },
      }),
      'utf8',
    );
    const admission = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.openCodeGo,
        harness_model_profile: 'claude-haiku-5-5',
        harness_credential_ref: 'TEST_CRED',
        harness_config_root: configRoot,
        project_root: root,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy' }),
      },
    );
    assert.equal(admission.status, 'qualified');
    if (admission.status !== 'qualified') return;
    const env = resolveClaudeCodeHarnessCredentialEnv(
      'TEST_CRED',
      admission.admitted,
      { BABEL_TEST_ANTHROPIC_KEY: 'secret-value' },
      {
        credential_ref: 'TEST_CRED',
        auth_host_env: TRUSTED_AUTH.trusted_auth_host_env,
        auth_child_env: TRUSTED_AUTH.trusted_auth_child_env,
      },
    );
    assert.deepEqual(env, { ANTHROPIC_API_KEY: 'secret-value' });
  });
});
