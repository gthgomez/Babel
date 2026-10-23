import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import {
  claudeAdmittedWithNativeSession,
  computeAdmissionDigest,
  evaluateClaudeCodeAdmission,
} from './claudeCodeAdmission.js';
import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';
import { ensureClaudeCodeThreadAdmissionBound } from './claudeCodeHostBinding.js';
import {
  createClaudeCodeHostLaunchRegistryFromBindings,
  type ClaudeCodeHostProfileBindingV1,
} from './claudeCodeHostLaunchRegistry.js';
import { ClaudeCodeAgentRuntimeRegistry } from './claudeCodeAgentRuntime.js';
import { createProtocolHostState } from '../protocol/client/host.js';
import type { SessionDescriptor } from '../executor/contracts.js';

const verifiedIntegrity = {
  state: 'verified' as const,
  sdkVersion: '0.3.304',
  cliVersion: '2.1.304',
  executablePath: '/opt/claude-agent-sdk-linux-x64/claude',
};

const TRUSTED_AUTH = {
  trusted_auth_host_env: 'BABEL_TEST_AUTH_HOST',
  trusted_auth_child_env: 'ANTHROPIC_API_KEY',
} as const;

function writeHarnessManifest(configRoot: string): void {
  writeFileSync(
    join(configRoot, CLAUDE_HARNESS_MANIFEST_FILENAME),
    JSON.stringify({ version: 1, credential_refs: { CRED: { host_env: 'BABEL_TEST_AUTH_HOST' } } }),
    'utf8',
  );
}

describe('claudeCode native session admission digest', () => {
  it('recomputes admission digest when native session id is attached', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-native-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-native-cfg-'));
    writeHarnessManifest(configRoot);
    const base = {
      harness_adapter_id: 'claude-code' as const,
      harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      harness_model_profile: 'mimo-v2.5',
      harness_credential_ref: 'CRED',
      harness_config_root: configRoot,
      project_policy_root: root,
      trusted_auth_host_env: TRUSTED_AUTH.trusted_auth_host_env,
      trusted_auth_child_env: TRUSTED_AUTH.trusted_auth_child_env,
      cwd: root,
      sdk_version: '0.3.304',
      cli_version: '2.1.304',
      cli_executable_path: '/opt/claude/claude',
      policy_digest: 'abc',
      admission_digest: '',
    };
    const withoutNative = {
      ...base,
      admission_digest: computeAdmissionDigest(base),
    };
    const withNative = claudeAdmittedWithNativeSession(withoutNative, 'native-sess-uuid');
    assert.notEqual(withNative.admission_digest, withoutNative.admission_digest);
    assert.equal(withNative.harness_native_session_id, 'native-sess-uuid');
    const expected = computeAdmissionDigest({
      ...base,
      harness_native_session_id: 'native-sess-uuid',
    });
    assert.equal(withNative.admission_digest, expected);
  });

  it('rejects resume when digest is stale after native id was learned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-resume-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-resume-cfg-'));
    writeHarnessManifest(configRoot);
    const qualified = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'mimo-v2.5',
        harness_credential_ref: 'CRED',
        harness_config_root: configRoot,
        project_root: root,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-1' }),
      },
    );
    assert.equal(qualified.status, 'qualified');
    if (qualified.status !== 'qualified') return;
    const withNative = claudeAdmittedWithNativeSession(qualified.admitted, 'native-sess-uuid');
    const stale = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'mimo-v2.5',
        harness_credential_ref: 'CRED',
        harness_config_root: configRoot,
        project_root: root,
        harness_native_session_id: 'native-sess-uuid',
        resume_expected_digest: qualified.admitted.admission_digest,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-1' }),
      },
    );
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.status === 'rejected' ? stale.reason : '', 'resume_digest_mismatch');

    const fresh = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'mimo-v2.5',
        harness_credential_ref: 'CRED',
        harness_config_root: configRoot,
        project_root: root,
        harness_native_session_id: 'native-sess-uuid',
        resume_expected_digest: withNative.admission_digest,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-1' }),
      },
    );
    assert.equal(fresh.status, 'qualified');
  });

  it('cold-host re-admit succeeds when descriptor carries native id and matching digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-claude-cold-'));
    const configRoot = mkdtempSync(join(tmpdir(), 'babel-claude-cold-cfg-'));
    writeHarnessManifest(configRoot);
    process.env['BABEL_TEST_AUTH_HOST'] = 'token';
    const binding: ClaudeCodeHostProfileBindingV1 = {
      profile_id: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      model: 'mimo-v2.5',
      credential_ref: 'CRED',
      auth_host_env: 'BABEL_TEST_AUTH_HOST',
      auth_child_env: 'ANTHROPIC_API_KEY',
      config_home: configRoot,
    };
    const hostRegistry = createClaudeCodeHostLaunchRegistryFromBindings([binding]);
    const qualified = await evaluateClaudeCodeAdmission(
      {
        harness_adapter_id: 'claude-code',
        harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
        harness_model_profile: 'mimo-v2.5',
        harness_credential_ref: 'CRED',
        harness_config_root: configRoot,
        project_root: root,
        ...TRUSTED_AUTH,
      },
      {
        integrityProbe: async () => verifiedIntegrity,
        resolvePolicyEvidence: async () => ({ ok: true, digest: 'policy-1' }),
      },
    );
    assert.equal(qualified.status, 'qualified');
    if (qualified.status !== 'qualified') return;
    const withNative = claudeAdmittedWithNativeSession(qualified.admitted, 'native-sess-uuid');

    const descriptor: SessionDescriptor = {
      schemaVersion: 1,
      threadId: 'thread-cold-1',
      projectRoot: root,
      mode: 'chat',
      provider: 'claude-code',
      model: 'mimo-v2.5',
      policyProfile: 'default',
      createdAt: new Date().toISOString(),
      kernelVersion: 'executor-kernel-v1',
      contractVersion: 'executor-contract-v1',
      harness_adapter_id: 'claude-code',
      harness_provider_profile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      harness_model_profile: 'mimo-v2.5',
      harness_config_root: configRoot,
      harness_project_policy_root: root,
      harness_credential_ref: 'CRED',
      harness_native_session_id: 'native-sess-uuid',
      harness_admission_digest: withNative.admission_digest,
    };

    const claudeRegistry = new ClaudeCodeAgentRuntimeRegistry();
    const host = createProtocolHostState({
      claudeCodeRegistry: claudeRegistry,
      claudeCodeHostLaunchRegistry: hostRegistry,
      claudeCodeAdmissionDeps: {
        integrityProbe: async () => verifiedIntegrity,
        resolveSettings: async () => ({ ok: true, digest: 'policy-1' }),
      },
    });

    const bound = await ensureClaudeCodeThreadAdmissionBound(host, descriptor);
    assert.ok(!('error' in bound));
    assert.equal(bound.harness_native_session_id, 'native-sess-uuid');
    assert.equal(bound.admission_digest, withNative.admission_digest);
  });
});
