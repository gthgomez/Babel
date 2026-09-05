#!/usr/bin/env node
// Deterministic tests for trust-ceremony tooling and stale-state invalidation.
//
// Covers: head/base/digest/path/PR/repository mutations and expiry each reject
// a prior manifest; the valid manifest is accepted; digest computations
// replicate the base-rooted gate's exact semantics; and the target-branch
// binding matrix (schema v2) — a trust-root ceremony cannot pass while the
// target branch advanced past the candidate base, when the candidate does not
// contain the target head, or when the target moved after a review or
// authorization artifact was issued.
//
// Offline: builds a disposable git repository for digest and ancestry vectors.
// No network.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  EXPECTED_BASE_REF,
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  computeNumstatDigest,
  computeProtectedDiffDigest,
  parseProtectedPaths,
  resolveAncestry,
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
const REPO = 'gthgomez/Babel';

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
  git(dir, 'checkout', '-q', '-b', 'candidate');
  writeFileSync(join(dir, 'src.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'config', 'independent-review-keys.json'), '{"schema_version":1,"keys":{"k":"PEM"}}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'head');
  const headSha = git(dir, 'rev-parse', 'HEAD');
  // Target-branch advancement after the candidate forked: main moves to a
  // commit the candidate does NOT contain (the exact #144/#145 drift shape).
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'unrelated.txt'), 'target moved on\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'main advance');
  const advancedTargetSha = git(dir, 'rev-parse', 'HEAD');
  // The same candidate rebased onto the advanced target: identical file
  // content changes, but now containing the target head as an ancestor.
  git(dir, 'checkout', '-q', '-b', 'rebased', advancedTargetSha);
  writeFileSync(join(dir, 'src.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'config', 'independent-review-keys.json'), '{"schema_version":1,"keys":{"k":"PEM"}}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'rebased candidate');
  const rebasedSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');

  const changedProtected = 'config/independent-review-keys.json';
  const blob = git(dir, 'rev-parse', `${headSha}:${changedProtected}`);
  const expectedDigest = computeProtectedDiffDigest([`${changedProtected}\t${blob}`]);
  const numstatDigest = computeNumstatDigest(
    git(dir, 'diff', '--numstat', `${baseSha}...${headSha}`).split('\n').filter((l) => l.trim()),
  );

  // Generation-time target binding: the manifest records the live target head
  // as of generation. For the original candidate that is `baseSha` (main had
  // not advanced yet); the target head TODAY is `advancedTargetSha`.
  const generationTargetHead = baseSha;
  const currentTargetHead = advancedTargetSha;

  const manifest = buildManifest({
    repository: REPO,
    prNumber: 144,
    prState: 'OPEN',
    baseRef: EXPECTED_BASE_REF,
    baseSha,
    targetRefHeadSha: generationTargetHead,
    mergeBaseSha: git(dir, 'merge-base', baseSha, headSha),
    headSha,
    builderIdentity: 'codex-implementation',
    protectedPaths: [changedProtected],
    protectedDiffDigest: expectedDigest,
    fullDiffNumstatDigest: numstatDigest,
    nowIso: NOW,
  });

  check('manifest carries required ceremony fields', () => {
    assert.equal(manifest.schema_version, MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.kind, 'trust_root_upgrade_ceremony_manifest_v1');
    assert.equal(manifest.repository, REPO);
    assert.equal(manifest.pr_number, 144);
    assert.equal(manifest.base_ref, 'main');
    assert.equal(manifest.base_sha, baseSha);
    assert.equal(manifest.target_ref_head_sha, generationTargetHead);
    assert.equal(manifest.merge_base_sha, baseSha);
    assert.equal(manifest.head_sha, headSha);
    assert.equal(manifest.builder_identity, 'codex-implementation');
    assert.deepEqual(manifest.protected_paths, [changedProtected]);
    assert.equal(manifest.protected_diff_digest, expectedDigest);
    assert.equal(manifest.review_receipt_required, true);
    assert.equal(manifest.supervisor_authorization_required, true);
    assert.ok(Date.parse(manifest.expires_at) > Date.parse(manifest.generated_at));
  });

  check('buildManifest refuses to emit a manifest without target binding', () => {
    assert.throws(() => buildManifest({
      repository: REPO, prNumber: 144, prState: 'OPEN', baseSha, headSha,
      protectedPaths: [], protectedDiffDigest: expectedDigest, fullDiffNumstatDigest: numstatDigest, nowIso: NOW,
    }), /base_ref is required/);
    assert.throws(() => buildManifest({
      repository: REPO, prNumber: 144, prState: 'OPEN', baseRef: EXPECTED_BASE_REF, baseSha, headSha,
      protectedPaths: [], protectedDiffDigest: expectedDigest, fullDiffNumstatDigest: numstatDigest, nowIso: NOW,
    }), /target_ref_head_sha is required/);
    assert.throws(() => buildManifest({
      repository: REPO, prNumber: 144, prState: 'OPEN', baseRef: EXPECTED_BASE_REF, baseSha, headSha,
      targetRefHeadSha: baseSha,
      protectedPaths: [], protectedDiffDigest: expectedDigest, fullDiffNumstatDigest: numstatDigest, nowIso: NOW,
    }), /merge_base_sha is required/);
  });

  function liveNow(overrides = {}) {
    return {
      repository: REPO,
      prNumber: 144,
      prState: 'OPEN',
      baseRefName: 'main',
      baseSha,
      targetRefHeadSha: generationTargetHead,
      targetHeadIsAncestorOfCandidate: true,
      headSha,
      protectedPaths: [changedProtected],
      protectedDiffDigest: expectedDigest,
      ...overrides,
    };
  }

  check('valid exact manifest is accepted', () => {
    assert.deepEqual(validateStaleness(manifest, liveNow()), []);
  });

  check('head change after review is rejected', () => {
    // The digest is a separate binding: a head move alone flags head_sha_changed
    // (and any real head move that touches protected files also changes the
    // digest, which the next case covers).
    const reasons = validateStaleness(manifest, liveNow({ headSha: '4'.repeat(40) }));
    assert.deepEqual(reasons, ['head_sha_changed']);
  });

  check('base change after authorization is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({ baseSha: '5'.repeat(40) }));
    assert.deepEqual(reasons, ['base_sha_changed']);
  });

  check('protected file added to the set is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({ protectedPaths: [changedProtected, 'scripts/agent-pr-gate.ps1'] }));
    assert.deepEqual(reasons, ['protected_path_set_changed']);
  });

  check('protected diff change with same file list is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({ protectedDiffDigest: 'f'.repeat(64) }));
    assert.deepEqual(reasons, ['protected_diff_changed']);
  });

  check('PR number change is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({ prNumber: 999 }));
    assert.deepEqual(reasons, ['pr_number_changed']);
  });

  check('repository change is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({ repository: 'other/repo' }));
    assert.deepEqual(reasons, ['repository_mismatch']);
  });

  check('expired manifest is rejected', () => {
    const expired = { ...manifest, expires_at: '2026-09-05T09:00:00.000Z' };
    const reasons = validateStaleness(expired, liveNow());
    assert.deepEqual(reasons, ['manifest_expired']);
  });

  check('closed PR is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({ prState: 'CLOSED' }));
    assert.deepEqual(reasons, ['pr_not_open']);
  });

  check('receipt from a prior head never validates against the new candidate', () => {
    // A receipt binds head_sha; the manifest comparison must treat the old
    // head binding as stale so downstream signing refuses to proceed.
    const staleReceipt = { ...manifest, head_sha: baseSha };
    const reasons = validateStaleness(staleReceipt, liveNow());
    assert.ok(reasons.includes('head_sha_changed'));
  });

  check('schema version drift is rejected', () => {
    const drifted = { ...manifest, schema_version: 99 };
    const reasons = validateStaleness(drifted, liveNow());
    assert.deepEqual(reasons, ['schema_version_changed']);
  });

  // ── Target-branch binding matrix (schema v2) ───────────────────────────────
  check('current target == manifest target == candidate ancestor is accepted', () => {
    const reasons = validateStaleness(manifest, liveNow({ targetRefHeadSha: generationTargetHead }));
    assert.deepEqual(reasons, []);
  });

  check('target branch advancing after manifest generation is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({
      targetRefHeadSha: currentTargetHead,
      targetHeadIsAncestorOfCandidate: false,
    }));
    assert.deepEqual(reasons, [
      'target_branch_advanced',
      'pr_base_not_current_target',
      'candidate_not_based_on_current_target',
    ]);
  });

  check('#144/#145 scenario: PR object retains old base while target advances — rejected', () => {
    // The exact production drift: the PR object's recorded base.sha still
    // equals the manifest's base_sha (GitHub never updates it), so every
    // legacy coordinate matches — but refs/heads/main moved and the candidate
    // does not contain the new target head. This must FAIL even though the
    // pre-v2 tool reported PASS on identical data.
    const reasons = validateStaleness(manifest, liveNow({
      baseSha, // PR object base unchanged (historical snapshot)
      targetRefHeadSha: currentTargetHead, // live refs/heads/main advanced
      targetHeadIsAncestorOfCandidate: false,
    }));
    assert.deepEqual(reasons, [
      'target_branch_advanced',
      'pr_base_not_current_target',
      'candidate_not_based_on_current_target',
    ]);
  });

  check('manifest whose recorded base is not the current target is rejected (invariant B)', () => {
    // A manifest generated while the candidate was NOT ceremony-ready (base
    // T0, target already T1) must never pass a later preflight even after the
    // candidate is rebased onto T1 and every per-coordinate comparison
    // matches: the recorded base itself is not the current target head.
    const notReadyManifest = buildManifest({
      repository: REPO,
      prNumber: 144,
      prState: 'OPEN',
      baseRef: EXPECTED_BASE_REF,
      baseSha, // stale recorded base
      targetRefHeadSha: currentTargetHead,
      mergeBaseSha: currentTargetHead,
      headSha: rebasedSha, // candidate contains the target head
      builderIdentity: 'codex-implementation',
      protectedPaths: [changedProtected],
      protectedDiffDigest: expectedDigest,
      fullDiffNumstatDigest: numstatDigest,
      nowIso: NOW,
    });
    const reasons = validateStaleness(notReadyManifest, liveNow({
      headSha: rebasedSha,
      targetRefHeadSha: currentTargetHead,
      targetHeadIsAncestorOfCandidate: true,
    }));
    assert.deepEqual(reasons, ['pr_base_not_current_target']);
  });

  check('pre-v2 manifest matching PR metadata exactly is still rejected', () => {
    // A legacy (schema v1) manifest reproduces the old false-PASS input; the
    // strengthened validator fails it closed on the missing target binding.
    const legacy = {
      schema_version: 1,
      kind: 'trust_root_upgrade_ceremony_manifest_v1',
      repository: REPO,
      pr_number: 144,
      base_sha: baseSha,
      head_sha: headSha,
      builder_identity: 'codex-implementation',
      protected_paths: [changedProtected],
      protected_diff_digest: expectedDigest,
      generated_at: NOW,
      expires_at: '2026-09-06T10:00:00.000Z',
      review_receipt_required: true,
      supervisor_authorization_required: true,
    };
    const reasons = validateStaleness(legacy, liveNow());
    assert.deepEqual(reasons, ['schema_version_changed', 'missing_target_binding']);
  });

  check('candidate rebased onto current target passes with a regenerated manifest', () => {
    const rebasedDigest = expectedDigest; // identical protected blobs
    const rebasedManifest = buildManifest({
      repository: REPO,
      prNumber: 144,
      prState: 'OPEN',
      baseRef: EXPECTED_BASE_REF,
      baseSha: currentTargetHead, // refreshed PR base == current target head
      targetRefHeadSha: currentTargetHead,
      mergeBaseSha: git(dir, 'merge-base', currentTargetHead, rebasedSha),
      headSha: rebasedSha,
      builderIdentity: 'codex-implementation',
      protectedPaths: [changedProtected],
      protectedDiffDigest: rebasedDigest,
      fullDiffNumstatDigest: computeNumstatDigest(
        git(dir, 'diff', '--numstat', `${currentTargetHead}...${rebasedSha}`).split('\n').filter((l) => l.trim()),
      ),
      nowIso: NOW,
    });
    const reasons = validateStaleness(rebasedManifest, liveNow({
      baseSha: currentTargetHead,
      targetRefHeadSha: currentTargetHead,
      headSha: rebasedSha,
      protectedDiffDigest: rebasedDigest,
    }));
    assert.deepEqual(reasons, []);
  });

  check('candidate not containing the target head is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({
      targetHeadIsAncestorOfCandidate: false,
    }));
    assert.deepEqual(reasons, ['candidate_not_based_on_current_target']);
  });

  check('undeterminable ancestry fails closed', () => {
    const reasons = validateStaleness(manifest, liveNow({
      targetHeadIsAncestorOfCandidate: undefined,
    }));
    assert.deepEqual(reasons, ['candidate_not_based_on_current_target']);
  });

  check('PR retargeted away from the protected branch is rejected', () => {
    const reasons = validateStaleness(manifest, liveNow({ baseRefName: 'release' }));
    assert.deepEqual(reasons, ['base_ref_mismatch', 'target_ref_changed']);
  });

  check('target branch advancing after a review artifact is issued voids the artifact', () => {
    const reasons = validateStaleness(manifest, liveNow({
      targetRefHeadSha: currentTargetHead,
      targetHeadIsAncestorOfCandidate: true,
      artifactTargetHeadSha: generationTargetHead,
      stage: 'review',
    }));
    assert.deepEqual(reasons, [
      'target_branch_advanced',
      'pr_base_not_current_target',
      'target_head_changed_after_review',
    ]);
  });

  check('target branch advancing after supervisor authorization voids the authorization', () => {
    const reasons = validateStaleness(manifest, liveNow({
      targetRefHeadSha: currentTargetHead,
      targetHeadIsAncestorOfCandidate: true,
      artifactTargetHeadSha: generationTargetHead,
      stage: 'authorization',
    }));
    assert.deepEqual(reasons, [
      'target_branch_advanced',
      'pr_base_not_current_target',
      'target_head_changed_after_authorization',
    ]);
  });

  check('artifact stage binding with an unchanged target head is accepted', () => {
    const reasons = validateStaleness(manifest, liveNow({
      artifactTargetHeadSha: generationTargetHead,
      stage: 'authorization',
    }));
    assert.deepEqual(reasons, []);
  });

  // ── Ancestry resolution semantics ───────────────────────────────────────────
  check('resolveAncestry: local git answers definitively', () => {
    assert.equal(resolveAncestry(REPO, baseSha, headSha, {
      runGit: (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }) && 0,
    }), true, 'base is an ancestor of the candidate head');
    assert.equal(resolveAncestry(REPO, advancedTargetSha, headSha, {
      runGit: () => 1,
    }), false, 'exit 1 is a definitive not-an-ancestor answer');
  });

  check('resolveAncestry: missing local objects fall back to the compare API', () => {
    const calls = [];
    const fetchCompare = (repo, base, head) => {
      calls.push({ repo, base, head });
      return { status: 'ahead' };
    };
    assert.equal(resolveAncestry(REPO, 'a'.repeat(40), 'b'.repeat(40), { runGit: () => 128, fetchCompare }), true);
    assert.equal(resolveAncestry(REPO, 'a'.repeat(40), 'b'.repeat(40), {
      runGit: () => 128,
      fetchCompare: () => ({ status: 'diverged' }),
    }), false);
    assert.equal(resolveAncestry(REPO, 'a'.repeat(40), 'b'.repeat(40), {
      runGit: () => 128,
      fetchCompare: () => ({ status: 'identical' }),
    }), true);
    assert.deepEqual(calls[0], { repo: REPO, base: 'a'.repeat(40), head: 'b'.repeat(40) });
  });

  // ── Offline CLI mode pins the fail-closed ancestry default ──────────────────
  check('offline CLI mode fails closed when ancestry is not explicitly stated', () => {
    const manifestPath = join(dir, 'manifest-offline.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const toolPath = fileURLToPath(new URL('../trust-ceremony.mjs', import.meta.url));
    const run = (extraArgs) => {
      try {
        const out = execFileSync('node', [toolPath, 'validate-staleness', '--manifest', manifestPath, ...extraArgs], { encoding: 'utf8' });
        return { code: 0, out };
      } catch (error) {
        return { code: error.status, out: String(error.stdout ?? '') };
      }
    };
    // Offline coordinates without --expect-ancestry: ancestry is unknown →
    // fail closed with the deterministic reason (never a silent pass).
    const omitted = run(['--expect-base', manifest.base_sha, '--expect-head', manifest.head_sha]);
    assert.equal(omitted.code, 1, 'omitted --expect-ancestry must not pass');
    assert.match(omitted.out, /candidate_not_based_on_current_target/);
    // A lone --expect-ancestry selects offline mode (all other coordinates
    // default from the manifest) and must not fall through to the live path.
    const explicit = run(['--expect-ancestry', 'true']);
    assert.equal(explicit.code, 0);
    assert.match(explicit.out, /CEREMONY_MANIFEST_CURRENT/);
    const falseExplicit = run(['--expect-ancestry', 'false']);
    assert.equal(falseExplicit.code, 1);
    assert.match(falseExplicit.out, /candidate_not_based_on_current_target/);
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
