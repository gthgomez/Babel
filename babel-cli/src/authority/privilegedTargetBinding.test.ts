/**
 * Exact-target binding for rewrite and remote-delete privileged capabilities.
 */

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import { decideActionRequest } from './pdp.js';
import { parseGitCommand } from './gitCommand.js';
import { decideWithLease } from './wire.js';
import { buildBaseline } from './integrity.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function leaseWith(overrides: Record<string, unknown> = {}): AutonomyLease {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'bind-lease',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['inspect_repository', 'run_local_command'],
      ...overrides,
    }),
  );
  assert.ok(parsed.ok);
  return parsed.lease;
}

function ctxFor(lease: AutonomyLease) {
  const root = mkdtempSync(join(tmpdir(), 'babel-bind-'));
  roots.push(root);
  return { lease, baseline: { repoRoot: root, manifest: buildBaseline(root) } };
}

describe('shared_history_rewrite exact target', () => {
  const granted = () =>
    leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'shared_history_rewrite'],
      constraints: {
        ...leaseWith().constraints,
        historyRewrite: true,
        allowedRewriteTargets: ['feat/x'],
      },
    });

  test('missing target → DENY', () => {
    const d = decideActionRequest({ capability: 'shared_history_rewrite' }, granted());
    assert.equal(d.outcome, 'deny');
    assert.ok(d.rulesTriggered.includes('pdp.missing_rewrite_target'));
  });

  test('empty allowlist → DENY', () => {
    const lease = leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'shared_history_rewrite'],
      constraints: { ...leaseWith().constraints, historyRewrite: true, allowedRewriteTargets: [] },
    });
    const d = decideActionRequest(
      { capability: 'shared_history_rewrite', destinationBranch: 'feat/x' },
      lease,
    );
    assert.equal(d.outcome, 'deny');
    assert.ok(d.rulesTriggered.includes('pdp.missing_rewrite_allowlist'));
  });

  test('wrong target → DENY', () => {
    const d = decideActionRequest(
      { capability: 'shared_history_rewrite', destinationBranch: 'feat/y' },
      granted(),
    );
    assert.equal(d.outcome, 'deny');
    assert.ok(d.rulesTriggered.includes('lease.constraints.allowedRewriteTargets'));
  });

  test('exact target → VERIFY', () => {
    const d = decideActionRequest(
      { capability: 'shared_history_rewrite', destinationBranch: 'feat/x' },
      granted(),
    );
    assert.equal(d.outcome, 'verify');
  });

  test('git reset --hard feat/x is authorized; feat/y is not', () => {
    const ctx = ctxFor(granted());
    const ok = decideWithLease(
      { type: 'run_command', command: 'git reset --hard feat/x' },
      'workspace_write',
      ctx,
    );
    assert.equal(ok.decision, 'allow');
    const bad = decideWithLease(
      { type: 'run_command', command: 'git reset --hard feat/y' },
      'workspace_write',
      ctx,
    );
    assert.equal(bad.decision, 'deny');
  });
});

describe('scope_expansion remote delete exact target', () => {
  const granted = () =>
    leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'scope_expansion'],
      constraints: {
        ...leaseWith().constraints,
        scopeExpansion: true,
        remoteRefDelete: true,
        allowedRemoteDeleteTargets: ['feat/old'],
      },
    });

  test('delete + missing target → DENY', () => {
    const d = decideActionRequest({ capability: 'scope_expansion', delete: true }, granted());
    assert.equal(d.outcome, 'deny');
    assert.ok(d.rulesTriggered.includes('pdp.missing_delete_target'));
  });

  test('delete + empty allowlist → DENY', () => {
    const lease = leaseWith({
      allowedCapabilities: [...leaseWith().allowedCapabilities, 'scope_expansion'],
      constraints: {
        ...leaseWith().constraints,
        scopeExpansion: true,
        remoteRefDelete: true,
        allowedRemoteDeleteTargets: [],
      },
    });
    const d = decideActionRequest(
      { capability: 'scope_expansion', delete: true, destinationBranch: 'feat/old' },
      lease,
    );
    assert.equal(d.outcome, 'deny');
    assert.ok(d.rulesTriggered.includes('pdp.missing_delete_allowlist'));
  });

  test('delete + wrong target → DENY', () => {
    const d = decideActionRequest(
      { capability: 'scope_expansion', delete: true, destinationBranch: 'feat/other' },
      granted(),
    );
    assert.equal(d.outcome, 'deny');
    assert.ok(d.rulesTriggered.includes('lease.constraints.allowedRemoteDeleteTargets'));
  });

  test('delete + exact target → VERIFY', () => {
    const d = decideActionRequest(
      { capability: 'scope_expansion', delete: true, destinationBranch: 'feat/old' },
      granted(),
    );
    assert.equal(d.outcome, 'verify');
  });

  test('decoder extracts delete dest from colon refspec and --delete', () => {
    const colon = parseGitCommand('git push origin :refs/heads/feat/old');
    assert.equal(colon.capability, 'scope_expansion');
    assert.equal(colon.delete, true);
    assert.equal(colon.destinationBranch, 'feat/old');
    const flag = parseGitCommand('git push --delete origin feat/old');
    assert.equal(flag.delete, true);
    assert.equal(flag.destinationBranch, 'feat/old');
  });

  test('git push origin :refs/heads/feat/old is authorized; feat/other is not', () => {
    const ctx = ctxFor(granted());
    const ok = decideWithLease(
      { type: 'run_command', command: 'git push origin :refs/heads/feat/old' },
      'workspace_write',
      ctx,
    );
    assert.equal(ok.decision, 'allow');
    const bad = decideWithLease(
      { type: 'run_command', command: 'git push --delete origin feat/other' },
      'workspace_write',
      ctx,
    );
    assert.equal(bad.decision, 'deny');
  });
});
