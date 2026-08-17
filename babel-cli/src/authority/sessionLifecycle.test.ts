/**
 * Production-path authority session lifecycle.
 *
 * Baseline is captured at establishAuthoritySession() — the same helper
 * ChatEngine uses — and then reused. Tests must not recapture via
 * buildBaseline() immediately before decideWithLease().
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeaseJson, type AutonomyLease } from './lease.js';
import {
  AUTHORITY_SESSION_FILENAME,
  establishAuthoritySession,
  restoreAuthoritySession,
} from './sessionContext.js';
import { join as pathJoin } from 'node:path';
import { resetLeaseInvalidations } from './wire.js';
import { createToolExecutor, executeActionWithPolicy } from '../agent/toolExecutor.js';
import type { AgentAction } from '../agent/actions.js';
import type { ToolContext } from '../localTools.js';

function makeLease(leaseId: string): AutonomyLease {
  return (
    parseLeaseJson(
      JSON.stringify({
        version: 2,
        leaseId,
        scope: { repository: 'babel', remote: 'origin' },
        allowedCapabilities: [
          'inspect_repository',
          'search_repository',
          'edit_task_files',
          'run_tests',
          'run_local_command',
        ],
      }),
    ) as { ok: true; lease: AutonomyLease }
  ).lease;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-session-'));
}

function ctx(root: string): ToolContext {
  return {
    agentId: 'lifecycle-agent',
    runId: 'lifecycle-run',
    babelRoot: root,
  };
}

function dryExecutor() {
  return createToolExecutor({
    executeTool: async () => ({ exit_code: 0, stdout: 'ok', stderr: '' }),
  });
}

test('session start captures a baseline automatically', () => {
  const root = tmpRoot();
  try {
    writeFileSync(join(root, '.gitignore'), 'orig');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('lifecycle-capture'),
    });
    assert.ok(session.baseline);
    assert.ok(session.baseline!.entries.some((e) => e.path === '.gitignore'));
    assert.equal(session.lease?.leaseId, 'lifecycle-capture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production dispatch: allow, OOB drift deny, restore still deny', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  const gitignore = join(root, '.gitignore');
  try {
    writeFileSync(gitignore, 'orig\n');
    writeFileSync(join(root, 'notes.txt'), 'ok\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('lifecycle-dispatch'),
    });
    assert.ok(session.baseline, 'baseline must be captured at session start');

    const benign: AgentAction = { type: 'write_file', path: 'notes.txt', content: 'still ok\n' };
    const first = await executeActionWithPolicy(benign, 'workspace_write', ctx(root), {
      authoritySession: session,
      executor: dryExecutor(),
      onAskApproval: async () => true,
    });
    assert.equal(first.policyBlocked, false, first.results[0]?.stderr ?? 'benign write should be allowed');

    writeFileSync(gitignore, 'mutated out of band\n');

    const drifted = await executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'after drift\n' },
      'workspace_write',
      ctx(root),
      { authoritySession: session, executor: dryExecutor(), onAskApproval: async () => true },
    );
    assert.equal(drifted.policyBlocked, true);
    assert.equal(drifted.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');

    writeFileSync(gitignore, 'orig\n');

    const afterRestore = await executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'after restore\n' },
      'workspace_write',
      ctx(root),
      { authoritySession: session, executor: dryExecutor(), onAskApproval: async () => true },
    );
    assert.equal(afterRestore.policyBlocked, true);
    assert.equal(afterRestore.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('session context ignores a later caller-built baseline refresh', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  try {
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('no-refresh'),
    });
    writeFileSync(join(root, '.gitignore'), 'drifted\n');
    const recaptured = establishAuthoritySession({
      repoRoot: root,
      lease: session.lease,
    });
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'x\n' },
      'workspace_write',
      ctx(root),
      {
        authoritySession: session,
        ...(recaptured.baseline
          ? { baseline: recaptured.baseline, baselineRepoRoot: recaptured.repoRoot }
          : {}),
        executor: dryExecutor(),
        onAskApproval: async () => true,
      },
    );
    assert.equal(result.policyBlocked, true);
    assert.equal(result.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume restores original baseline and invalidation; does not recapture', async () => {
  resetLeaseInvalidations();
  const root = tmpRoot();
  const runDir = tmpRoot();
  const persistPath = pathJoin(runDir, AUTHORITY_SESSION_FILENAME);
  try {
    writeFileSync(join(root, '.gitignore'), 'orig\n');
    const session = establishAuthoritySession({
      repoRoot: root,
      lease: makeLease('resume-persist'),
      persistPath,
    });
    writeFileSync(join(root, '.gitignore'), 'drifted\n');
    const drifted = await executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'x\n' },
      'workspace_write',
      ctx(root),
      { authoritySession: session, executor: dryExecutor(), onAskApproval: async () => true },
    );
    assert.equal(drifted.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
    resetLeaseInvalidations();
    const restored = restoreAuthoritySession({
      repoRoot: root,
      persistPath,
      lease: makeLease('resume-persist'),
    });
    assert.equal(restored.invalidated, true);
    assert.ok(restored.baseline);
    const afterRestart = await executeActionWithPolicy(
      { type: 'write_file', path: 'notes.txt', content: 'y\n' },
      'workspace_write',
      ctx(root),
      { authoritySession: restored, executor: dryExecutor(), onAskApproval: async () => true },
    );
    assert.equal(afterRestart.policyBlocked, true);
    assert.equal(afterRestart.reasonCode, 'DENY_POLICY_INTEGRITY_DRIFT');
  } finally {
    resetLeaseInvalidations();
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
