/**
 * convergence-integrity.regression-gate.test.ts — RED baseline for policy integrity.
 *
 * Demonstrates the P0 gaps in #86's integrity seam as transplanted:
 *   - GOVERNANCE_PATHS directory entries hash as '<missing>' (readFileSync on a
 *     directory) and can never be flagged as changed.
 *   - decideWithLease() never invokes checkBaseline() — "drift invalidates the
 *     lease" is documented but unenforced on this path.
 *   - apply_patch feeds the diff BODY into isGovernancePath() instead of the
 *     extracted target paths.
 *
 * The fix phase (MERGE_AND_FIX_P0) turns these green: recursive/explicit file
 * fingerprinting with add/delete detection, baseline captured at the proper
 * lifecycle point, drift evaluated before privileged decisions, and apply_patch
 * targets extracted (Babel already has targetPathFromAction machinery).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBaseline, checkBaseline } from './integrity.js';
import { decideWithLease } from './wire.js';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import type { AgentAction } from '../agent/actions.js';

function makeLease(leaseId: string): AutonomyLease {
  return (
    parseLeaseJson(
      JSON.stringify({ version: 2, leaseId, scope: { repository: 'babel', remote: 'origin' } }),
    ) as { ok: true; lease: AutonomyLease }
  ).lease;
}

const lease = makeLease('regression-gate');

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-gov-'));
}

// ─── Self-mutation guard ───────────────────────────────────────────────────

test('P0-1: write_file to a governance path is denied (guard)', () => {
  const root = tmpRoot();
  try {
    const r = decideWithLease(
      { type: 'write_file', path: 'AGENTS.md' } as unknown as AgentAction,
      'workspace_write',
      { lease, baseline: { repoRoot: root, manifest: buildBaseline(root) } },
    );
    assert.equal(r.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-1: apply_patch mutating a governance path is denied', () => {
  const patch = [
    'diff --git a/AGENTS.md b/AGENTS.md',
    'index 1111111..2222222 100644',
    '--- a/AGENTS.md',
    '+++ b/AGENTS.md',
    '@@ -1,3 +1,3 @@',
    '-old governance content',
    '+new governance content',
  ].join('\n');
  const root = tmpRoot();
  try {
  const r = decideWithLease(
    { type: 'apply_patch', patch } as unknown as AgentAction,
    'workspace_write',
    { lease, baseline: { repoRoot: root, manifest: buildBaseline(root) } },
  );
  assert.equal(r.reasonCode, 'DENY_POLICY_SELF_MUTATION');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Baseline fingerprinting ───────────────────────────────────────────────

test('P0-1: a file added inside a governance directory after baseline is detected', () => {
  const root = tmpRoot();
  try {
    const baseline = buildBaseline(root);
    mkdirSync(join(root, 'babel-cli/src/authority'), { recursive: true });
    writeFileSync(join(root, 'babel-cli/src/authority/pdp.ts'), '// added');
    const res = checkBaseline(root, baseline);
    // Today: the directory entry hashes as '<missing>' before AND after → ok:true.
    assert.equal(res.ok, false);
    assert.ok(res.changed.includes('babel-cli/src/authority'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-1: governance-file creation/deletion after baseline is detected', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, '.agents/rules'), { recursive: true });
    const baseline = buildBaseline(root);
    writeFileSync(join(root, '.agents/rules/99-new.md'), '// added rule');
    const res = checkBaseline(root, baseline);
    // Today: .agents/rules hashes as '<missing>' before and after → ok:true.
    assert.equal(res.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Drift enforcement at decision time ────────────────────────────────────

test('P0-1: decideWithLease denies when the baseline has drifted', () => {
  const root = tmpRoot();
  const driftLease = makeLease('regression-drift-1');
  try {
    const baseline = buildBaseline(root);
    // Governance file changes after the session-start snapshot.
    writeFileSync(join(root, '.gitignore'), 'changed after baseline');
    const r = decideWithLease(
      { type: 'write_file', path: 'src/foo.ts' } as unknown as AgentAction,
      'workspace_write',
      { lease: driftLease, baseline: { repoRoot: root, manifest: baseline } },
    );
    assert.equal(r.decision, 'deny');
    assert.equal(r.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Expanded integrity contract (I06–I10) ─────────────────────────────────

test('P0-1: regular file replaced by symlink is detected', (t) => {
  const root = tmpRoot();
  try {
    writeFileSync(join(root, '.gitignore'), 'original');
    const baseline = buildBaseline(root);
    rmSync(join(root, '.gitignore'));
    try {
      symlinkSync('elsewhere', join(root, '.gitignore'));
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    const res = checkBaseline(root, baseline);
    assert.equal(res.ok, false);
    assert.ok(res.changed.includes('.gitignore'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-1: symlink target change is detected', (t) => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, 'babel-cli/src/authority'), { recursive: true });
    try {
      symlinkSync('target-a', join(root, 'babel-cli/src/authority/link'));
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    const baseline = buildBaseline(root);
    rmSync(join(root, 'babel-cli/src/authority/link'));
    symlinkSync('target-b', join(root, 'babel-cli/src/authority/link'));
    const res = checkBaseline(root, baseline);
    assert.equal(res.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-1: governance symlinks are recorded, never followed outside the repo', (t) => {
  const root = tmpRoot();
  const outside = tmpRoot();
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside content');
    mkdirSync(join(root, 'babel-cli/src/authority'), { recursive: true });
    try {
      symlinkSync(outside, join(root, 'babel-cli/src/authority/ext'));
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    const baseline = buildBaseline(root);
    const entry = baseline.entries.find((e) => e.path === 'babel-cli/src/authority/ext');
    assert.ok(entry, 'symlink recorded in the manifest');
    assert.equal(entry!.kind, 'symlink');
    // Content change OUTSIDE the repo must not alter the manifest — the link
    // target string is the fingerprint, and it is never followed.
    writeFileSync(join(outside, 'secret.txt'), 'changed outside');
    const res = checkBaseline(root, baseline);
    assert.equal(res.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('P0-1: new nested directory introduced is detected', () => {
  const root = tmpRoot();
  try {
    mkdirSync(join(root, '.agents/rules'), { recursive: true });
    const baseline = buildBaseline(root);
    mkdirSync(join(root, '.agents/rules/new'), { recursive: true });
    const res = checkBaseline(root, baseline);
    assert.equal(res.ok, false);
    assert.ok(res.changed.includes('.agents/rules/new'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-1: drift permanently invalidates the lease (second decision still denies)', () => {
  const root = tmpRoot();
  const driftLease = makeLease('regression-drift-2');
  try {
    const baseline = buildBaseline(root);
    writeFileSync(join(root, '.gitignore'), 'changed after baseline');
    const ctx = { lease: driftLease, baseline: { repoRoot: root, manifest: baseline } };
    const action = { type: 'write_file', path: 'src/foo.ts' } as unknown as AgentAction;

    const first = decideWithLease(action, 'workspace_write', ctx);
    assert.equal(first.decision, 'deny');
    assert.equal(first.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');

    // Permanent: the lock denies every later decision — one drift event cannot
    // be papered over by a single denied call.
    const second = decideWithLease(action, 'workspace_write', ctx);
    assert.equal(second.decision, 'deny');
    assert.equal(second.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P0-1: lease without a session baseline fails closed', () => {
  const r = decideWithLease(
    { type: 'write_file', path: 'src/foo.ts' } as unknown as AgentAction,
    'workspace_write',
    { lease: makeLease('missing-baseline') },
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.reasonCode, 'DENY_AUTHORITY_CONTEXT_INCOMPLETE');
});

test('P0-1: deleting a previously hashed governance file is detected', () => {
  const root = tmpRoot();
  try {
    writeFileSync(join(root, '.gitignore'), 'keep');
    const baseline = buildBaseline(root);
    rmSync(join(root, '.gitignore'));
    const res = checkBaseline(root, baseline);
    assert.equal(res.ok, false);
    assert.ok(res.changed.includes('.gitignore'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
