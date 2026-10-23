import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { buildClaudeCodePolicyProofChildEnv } from './claudeCodeChildEnv.js';
import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';
import {
  assertClaudeResolveSettingsRootParity,
  verifyClaudeManagedPolicySources,
} from './claudeCodePolicyLaunchGates.js';
import { buildClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import { resolveClaudeCodePolicyIsolated } from './claudeCodeIsolatedPolicyResolve.js';
import { resolveSettingsInIsolatedChildEnv } from './claudeCodeIsolatedResolveSubprocess.js';
import { loadClaudeAgentSdkPin } from './claudeCodeSdkPin.js';

function seedConfigHome(dir: string): void {
  writeFileSync(
    join(dir, CLAUDE_HARNESS_MANIFEST_FILENAME),
    JSON.stringify({ version: 1, credential_refs: {} }),
    'utf8',
  );
}

describe('claudeCode SDK 0.3.304 policy semantics (pinned)', () => {
  it('managed source omits strictMcpConfig while launch spec pins it (regression)', async () => {
    assert.equal(loadClaudeAgentSdkPin().sdkVersion, '0.3.304');
    const launchCwd = mkdtempSync(join(tmpdir(), 'babel-strict-mcp-'));
    const configHome = mkdtempSync(join(tmpdir(), 'babel-strict-mcp-cfg-'));
    seedConfigHome(configHome);
    const spec = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    const proofChildEnv = buildClaudeCodePolicyProofChildEnv({
      configHome,
      providerProfile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      launchSpec: spec,
    });
    const resolved = await resolveSettingsInIsolatedChildEnv({
      cwd: launchCwd,
      projectConfigRoot: launchCwd,
      childEnv: proofChildEnv,
      launchSpec: spec,
    });
    const managed = resolved.sources.find((s) => s.source === 'managed');
    assert.ok(managed);
    assert.equal(managed.settings.strictMcpConfig, undefined);
    assert.equal(spec.managedSettings.strictMcpConfig, true);
    const check = verifyClaudeManagedPolicySources({
      sources: resolved.sources,
      filtered: resolved.filtered,
      launchSpec: spec,
    });
    assert.equal(check.ok, true);
  });

  it('rejects effective strictMcpConfig false even when managed source omits the key', () => {
    const spec = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    const check = verifyClaudeManagedPolicySources({
      sources: [
        {
          source: 'managed',
          settings: {
            disableClaudeAiConnectors: true,
            sandbox: { enabled: true },
          },
        },
      ],
      filtered: {
        disableClaudeAiConnectors: true,
        sandbox: { enabled: true },
        strictMcpConfig: false,
      },
      launchSpec: spec,
    });
    assert.equal(check.ok, false);
    if (check.ok) return;
    assert.match(check.detail, /strictMcpConfig is false/);
  });

  it('fails closed when project_policy_root differs from launch cwd with settingSources=[]', () => {
    const launch = mkdtempSync(join(tmpdir(), 'babel-root-launch-'));
    const project = mkdtempSync(join(tmpdir(), 'babel-root-project-'));
    const gate = assertClaudeResolveSettingsRootParity({
      launchCwd: launch,
      projectPolicyRoot: project,
      settingSources: [],
    });
    assert.equal(gate.ok, false);
  });

  it('stable managed source identity for identical resolve inputs', async () => {
    const launchCwd = mkdtempSync(join(tmpdir(), 'babel-src-id-'));
    const configHome = mkdtempSync(join(tmpdir(), 'babel-src-id-cfg-'));
    seedConfigHome(configHome);
    const spec = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    const proofChildEnv = buildClaudeCodePolicyProofChildEnv({
      configHome,
      providerProfile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      launchSpec: spec,
    });
    const input = {
      launchCwd,
      projectPolicyRoot: launchCwd,
      configHome,
      launchSpec: spec,
      proofChildEnv,
    };
    const a = await resolveClaudeCodePolicyIsolated(input);
    const b = await resolveClaudeCodePolicyIsolated(input);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.sourceHashes, b.sourceHashes);
    assert.equal(a.digest, b.digest);
  });

  it('proof child env includes allowlisted host path keys when present', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'babel-proof-env-'));
    seedConfigHome(configHome);
    const spec = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    const env = buildClaudeCodePolicyProofChildEnv({
      configHome,
      providerProfile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      launchSpec: spec,
      hostEnv: { HOME: '/home/test', PATH: '/bin', ANTHROPIC_API_KEY: 'must-strip' },
    });
    assert.equal(env.CLAUDE_CONFIG_DIR, realpathSync(configHome));
    assert.equal(env.HOME, '/home/test');
    assert.equal(env.PATH, '/bin');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});
