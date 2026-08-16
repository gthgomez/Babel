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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBaseline, checkBaseline } from './integrity.js';
import { decideWithLease } from './wire.js';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import type { AgentAction } from '../agent/actions.js';

const lease = (
  parseLeaseJson(
    JSON.stringify({ version: 2, leaseId: 'regression-gate', scope: { repository: 'babel', remote: 'origin' } }),
  ) as { ok: true; lease: AutonomyLease }
).lease;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-gov-'));
}

// ─── Self-mutation guard ───────────────────────────────────────────────────

test('P0-1: write_file to a governance path is denied (guard)', () => {
  const r = decideWithLease(
    { type: 'write_file', path: 'AGENTS.md' } as unknown as AgentAction,
    'workspace_write',
    { lease },
  );
  assert.equal(r.reasonCode, 'DENY_POLICY_SELF_MUTATION');
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
  const r = decideWithLease(
    { type: 'apply_patch', patch } as unknown as AgentAction,
    'workspace_write',
    { lease },
  );
  // Today: the diff body is fed to isGovernancePath() and never matches → the
  // patch proceeds past the guard.
  assert.equal(r.reasonCode, 'DENY_POLICY_SELF_MUTATION');
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
  try {
    const baseline = buildBaseline(root);
    // Governance file changes after the session-start snapshot.
    writeFileSync(join(root, '.gitignore'), 'changed after baseline');
    const r = decideWithLease(
      { type: 'write_file', path: 'src/foo.ts' } as unknown as AgentAction,
      'workspace_write',
      { lease, baseline: { repoRoot: root, manifest: baseline } },
    );
    // Today: decideWithLease carries the baseline but never evaluates it — the
    // decision is unaffected by drift. Fix: evaluate drift before privileged
    // decisions and invalidate the lease/session (fail-closed).
    assert.equal(r.decision, 'deny');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
