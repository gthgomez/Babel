import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';
import { buildClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import { profileChildEnvMarkers } from './claudeCodeProfileCatalog.js';
import { resolveClaudeCodePolicyIsolated } from './claudeCodeIsolatedPolicyResolve.js';
import { resolveSettingsInIsolatedChildEnv } from './claudeCodeIsolatedResolveSubprocess.js';

function seedConfigHome(dir: string): void {
  writeFileSync(
    join(dir, CLAUDE_HARNESS_MANIFEST_FILENAME),
    JSON.stringify({ version: 1, credential_refs: {} }),
    'utf8',
  );
}

describe('claudeCodeIsolatedPolicyResolve', () => {
  it('applies CLAUDE_CONFIG_DIR via isolated child env (not parent process.env)', async () => {
    const launchCwd = mkdtempSync(join(tmpdir(), 'babel-claude-launch-cwd-'));
    const projectRoot = launchCwd;
    const configA = mkdtempSync(join(tmpdir(), 'babel-claude-config-a-'));
    const configB = mkdtempSync(join(tmpdir(), 'babel-claude-config-b-'));
    seedConfigHome(configA);
    seedConfigHome(configB);

    const spec = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    const baseline = {
      ...spec.envSuppressors,
      ...profileChildEnvMarkers(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat),
    };

    const parentConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;

    const resultA = await resolveClaudeCodePolicyIsolated({
      launchCwd,
      projectPolicyRoot: projectRoot,
      configHome: configA,
      launchSpec: spec,
      childEnvBaseline: baseline,
    });
    const resultB = await resolveClaudeCodePolicyIsolated({
      launchCwd,
      projectPolicyRoot: projectRoot,
      configHome: configB,
      launchSpec: spec,
      childEnvBaseline: baseline,
    });

    if (parentConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = parentConfigDir;
    assert.equal(process.env.CLAUDE_CONFIG_DIR, parentConfigDir);

    assert.equal(resultA.ok, true);
    assert.equal(resultB.ok, true);
    assert.ok(resultA.digest);
    assert.ok(resultB.digest);
    assert.notEqual(resultA.digest, resultB.digest, 'digest must bind config HOME path');
  });

  it('resolveSettingsInIsolatedChildEnv does not inherit parent CLAUDE_CONFIG_DIR', async () => {
    const launchCwd = mkdtempSync(join(tmpdir(), 'babel-claude-env-parity-'));
    const configHome = mkdtempSync(join(tmpdir(), 'babel-claude-env-parity-cfg-'));
    seedConfigHome(configHome);
    const spec = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    const childEnv = {
      ...spec.envSuppressors,
      CLAUDE_CONFIG_DIR: configHome,
    };
    const parentBefore = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/tmp/parent-must-not-leak';
    try {
      const resolved = await resolveSettingsInIsolatedChildEnv({
        cwd: launchCwd,
        projectConfigRoot: launchCwd,
        childEnv,
        launchSpec: spec,
      });
      assert.ok(resolved.filtered);
      assert.ok(Array.isArray(resolved.sources));
    } finally {
      if (parentBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = parentBefore;
    }
    assert.equal(process.env.CLAUDE_CONFIG_DIR, parentBefore);
  });
});
