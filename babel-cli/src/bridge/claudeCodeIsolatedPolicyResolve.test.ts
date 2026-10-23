import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { EXTERNAL_ADAPTER_PROFILE_IDS } from './harnessAdapterContract.js';
import { buildClaudeCodePolicyProofChildEnv } from './claudeCodeChildEnv.js';
import { CLAUDE_HARNESS_MANIFEST_FILENAME } from './claudeCodeHarnessManifest.js';
import { buildClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';
import { resolveClaudeCodePolicyIsolated } from './claudeCodeIsolatedPolicyResolve.js';

function seedConfigHome(dir: string): void {
  writeFileSync(
    join(dir, CLAUDE_HARNESS_MANIFEST_FILENAME),
    JSON.stringify({ version: 1, credential_refs: {} }),
    'utf8',
  );
}

describe('claudeCodeIsolatedPolicyResolve', () => {
  it('rejects split project_policy_root from launch cwd (fail closed)', async () => {
    const launchCwd = mkdtempSync(join(tmpdir(), 'babel-split-launch-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-split-project-'));
    const configHome = mkdtempSync(join(tmpdir(), 'babel-split-cfg-'));
    seedConfigHome(configHome);
    const spec = buildClaudeCodeLaunchPolicySpec(EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat);
    const proofChildEnv = buildClaudeCodePolicyProofChildEnv({
      configHome,
      providerProfile: EXTERNAL_ADAPTER_PROFILE_IDS.commandCodeGoat,
      launchSpec: spec,
    });
    const result = await resolveClaudeCodePolicyIsolated({
      launchCwd,
      projectPolicyRoot: projectRoot,
      configHome,
      launchSpec: spec,
      proofChildEnv,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail ?? '', /project_policy_root differs/);
  });
});
