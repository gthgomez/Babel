#!/usr/bin/env node
// Deterministic tests for trust-ceremony tooling and stale-state invalidation.
//
// Covers (mission Phase 19): head/base/digest/path/PR/repository mutations and
// expiry each reject a prior manifest; the valid manifest is accepted; digest
// computations replicate the base-rooted gate's exact semantics.
//
// Offline: builds a disposable git repository for digest vectors. No network.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  computeNumstatDigest,
  computeProtectedDiffDigest,
  parseProtectedPaths,
  validateStaleness,
} from '../trust-ceremony.mjs';
import { createHash } from 'node:crypto';

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push(`${name} => ${error.message}`);
    console.log(`FAIL ${name}`);
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const NOW = '2026-09-05T10:00:00.000Z';

// ── Digest semantics match the base-rooted gate ──────────────────────────────
check('numstat digest replicates Get-AgentNumstatDigest', () => {
  // Reference implementation: invariant sort, join \n, sha256.
  function reference(lines) {
    return createHash('sha256').update([...lines].sort().join('\n'), 'utf8').digest('hex');
  }
  const lines = ['3\t1\tsrc/b.ts', '10\t0\tsrc/a.ts', '2\t2\tconfig/x.json'];
  assert.equal(computeNumstatDigest(lines), reference(lines));
  assert.equal(computeNumstatDigest([...lines].reverse()), computeNumstatDigest(lines), 'input ordering must not matter (digest sorts first)');
});

check('protected diff digest replicates Get-AgentProtectedDiffDigest', () => {
  function reference(entries) {
    return createHash('sha256').update([...entries].sort().join('\n'), 'utf8').digest('hex');
  }
  const entries = ['config/x.json\t' + 'a'.repeat(40), 'scripts/agent-pr-gate.ps1\t' + 'b'.repeat(40)];
  assert.equal(computeProtectedDiffDigest(entries), reference(entries));
});

check('parseProtectedPaths extracts the gate list', () => {
  const gateScript = [
    '$something = @(',
    "  'unrelated'",
    ')',
    '$protectedTrustRootPaths = @(',
    "  'config/independent-review-keys.json',",
    "  'scripts/agent-pr-gate.ps1',",
    "  'scripts/agent-git-common.psm1'",
    ')',
  ].join('\n');
  assert.deepEqual(parseProtectedPaths(gateScript), [
    'config/independent-review-keys.json',
    'scripts/agent-git-common.psm1',
    'scripts/agent-pr-gate.ps1',
  ]);
});

// ── Real git repo: end-to-end digest over an actual diff ─────────────────────
const dir = mkdtempSync(join(tmpdir(), 'trust-ceremony-test-'));
try {
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'independent-review-keys.json'), '{"schema_version":1,"keys":{}}\n');
  writeFileSync(join(dir, 'src.ts'), 'export const a = 0;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  const baseSha = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'src.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'config', 'independent-review-keys.json'), '{"schema_version":1,"keys":{"k":"PEM"}}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'head');
  const headSha = git(dir, 'rev-parse', 'HEAD');

  const changedProtected = 'config/independent-review-keys.json';
  const blob = git(dir, 'rev-parse', `${headSha}:${changedProtected}`);
  const expectedDigest = computeProtectedDiffDigest([`${changedProtected}\t${blob}`]);

  const manifest = buildManifest({
    repository: 'gthgomez/Babel',
    prNumber: 144,
    prState: 'OPEN',
    baseSha,
    headSha,
    builderIdentity: 'codex-implementation',
    protectedPaths: [changedProtected],
    protectedDiffDigest: expectedDigest,
    fullDiffNumstatDigest: computeNumstatDigest(git(dir, 'diff', '--numstat', `${baseSha}...${headSha}`).split('\n').filter((l) => l.trim())),
    nowIso: NOW,
  });

  check('manifest carries required ceremony fields', () => {
    assert.equal(manifest.schema_version, MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.kind, 'trust_root_upgrade_ceremony_manifest_v1');
    assert.equal(manifest.repository, 'gthgomez/Babel');
    assert.equal(manifest.pr_number, 144);
    assert.equal(manifest.base_sha, baseSha);
    assert.equal(manifest.head_sha, headSha);
    assert.equal(manifest.builder_identity, 'codex-implementation');
    assert.deepEqual(manifest.protected_paths, [changedProtected]);
    assert.equal(manifest.protected_diff_digest, expectedDigest);
    assert.equal(manifest.review_receipt_required, true);
    assert.equal(manifest.supervisor_authorization_required, true);
    assert.ok(Date.parse(manifest.expires_at) > Date.parse(manifest.generated_at));
  });

  const live = {
    repository: 'gthgomez/Babel',
    prNumber: 144,
    prState: 'OPEN',
    baseSha,
    headSha,
    protectedPaths: [changedProtected],
    protectedDiffDigest: expectedDigest,
  };

  check('valid exact manifest is accepted', () => {
    assert.deepEqual(validateStaleness(manifest, live), []);
  });

  check('head change after review is rejected', () => {
    // The digest is a separate binding: a head move alone flags head_sha_changed
    // (and any real head move that touches protected files also changes the
    // digest, which the next case covers).
    const reasons = validateStaleness(manifest, { ...live, headSha: '4'.repeat(40) });
    assert.deepEqual(reasons, ['head_sha_changed']);
  });

  check('base change after authorization is rejected', () => {
    const reasons = validateStaleness(manifest, { ...live, baseSha: '5'.repeat(40) });
    assert.deepEqual(reasons, ['base_sha_changed']);
  });

  check('protected file added to the set is rejected', () => {
    const reasons = validateStaleness(manifest, { ...live, protectedPaths: [changedProtected, 'scripts/agent-pr-gate.ps1'] });
    assert.deepEqual(reasons, ['protected_path_set_changed']);
  });

  check('protected diff change with same file list is rejected', () => {
    const reasons = validateStaleness(manifest, { ...live, protectedDiffDigest: 'f'.repeat(64) });
    assert.deepEqual(reasons, ['protected_diff_changed']);
  });

  check('PR number change is rejected', () => {
    const reasons = validateStaleness(manifest, { ...live, prNumber: 999 });
    assert.deepEqual(reasons, ['pr_number_changed']);
  });

  check('repository change is rejected', () => {
    const reasons = validateStaleness(manifest, { ...live, repository: 'other/repo' });
    assert.deepEqual(reasons, ['repository_mismatch']);
  });

  check('expired manifest is rejected', () => {
    const expired = { ...manifest, expires_at: '2026-09-05T09:00:00.000Z' };
    const reasons = validateStaleness(expired, live);
    assert.deepEqual(reasons, ['manifest_expired']);
  });

  check('closed PR is rejected', () => {
    const reasons = validateStaleness(manifest, { ...live, prState: 'CLOSED' });
    assert.deepEqual(reasons, ['pr_not_open']);
  });

  check('receipt from a prior head never validates against the new candidate', () => {
    // A receipt binds head_sha; the manifest comparison must treat the old
    // head binding as stale so downstream signing refuses to proceed.
    const staleReceipt = { ...manifest, head_sha: baseSha };
    const reasons = validateStaleness(staleReceipt, live);
    assert.ok(reasons.includes('head_sha_changed'));
  });

  check('schema version drift is rejected', () => {
    const drifted = { ...manifest, schema_version: 2 };
    const reasons = validateStaleness(drifted, live);
    assert.deepEqual(reasons, ['schema_version_changed']);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log('');
  console.log(`TRUST_CEREMONY_TEST_FAIL (${failures.length}):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('');
console.log('TRUST_CEREMONY_TEST_PASS');
