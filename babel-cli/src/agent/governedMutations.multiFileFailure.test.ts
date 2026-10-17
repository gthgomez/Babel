/**
 * M1 fault matrix — multi-file governed patch failure and rollback integrity.
 *
 * Every case drives the real governed dispatch seam (`governedApplyPatch` with
 * an injected `ToolExecutor`) against disposable fixture files, and asserts
 * independently observed bytes / existence / hashes instead of the runtime's
 * own success claims.
 *
 * Contract under test:
 *  - A later-file failure never silently discards an earlier owned write: it is
 *    either restored (proved by bytes) or reported as unrestored.
 *  - `preDispatchNoEffect: true` is never reported after an observed write.
 *  - A newer external write is never clobbered to satisfy an atomicity claim.
 *  - A failed or uncertain batch never classifies as `confirmed_no_change`
 *    (`assessMutationEffect` is the exact classification the real Chat caller
 *    in `codingLoop/applyPatchExecutor.ts` applies to this result).
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import type { ToolContext } from '../localTools.js';
import { loadEffectLedger } from '../executor/effectLedger.js';
import type { AgentAction } from './actions.js';
import { governedApplyPatch, type GovernedApplyPatchResult } from './governedMutations.js';
import { assessMutationEffect } from './mutationTools.js';
import {
  createToolExecutor,
  resetCircuitBreaker,
  type ToolExecutionResult,
  type ToolExecutor,
} from './toolExecutor.js';

// ── Fixture content ────────────────────────────────────────────────────────

const FILE1_ORIGINAL = 'line 1\nline 2\n';
const FILE1_PATCHED = 'line 1\nline 2 modified\n';
const FILE2_ORIGINAL = 'alpha\nbeta\n';
const FILE2_PATCHED = 'alpha modified\nbeta\n';
const FILE1_CREATED = 'created line 1\ncreated line 2\n';
/** A third-party write that lands on file1 after this patch wrote it. */
const FILE1_EXTERNAL = 'line 1\nexternal writer took over\n';

const TWO_FILE_PATCH = [
  '--- a/file1.txt',
  '+++ b/file1.txt',
  '@@ -1,2 +1,2 @@',
  ' line 1',
  '-line 2',
  '+line 2 modified',
  '--- a/file2.txt',
  '+++ b/file2.txt',
  '@@ -1,2 +1,2 @@',
  '-alpha',
  '+alpha modified',
  ' beta',
].join('\n');

/** file1 does not exist before this patch; file2 does. */
const CREATE_THEN_MODIFY_PATCH = [
  '--- /dev/null',
  '+++ b/file1.txt',
  '@@ -0,0 +1,2 @@',
  '+created line 1',
  '+created line 2',
  '--- a/file2.txt',
  '+++ b/file2.txt',
  '@@ -1,2 +1,2 @@',
  '-alpha',
  '+alpha modified',
  ' beta',
].join('\n');

/** Hunk context is absent from every file, so the in-memory pass fails. */
const NON_APPLYING_PATCH = [
  '--- a/file1.txt',
  '+++ b/file1.txt',
  '@@ -1,2 +1,2 @@',
  ' absent context that does not exist',
  '-absent removed line',
  '+replacement line',
].join('\n');

/** Targets a path that cannot be read during the read phase. */
const MISSING_TARGET_PATCH = [
  '--- a/file1.txt',
  '+++ b/file1.txt',
  '@@ -1,2 +1,2 @@',
  ' line 1',
  '-line 2',
  '+line 2 modified',
  '--- a/never-existed.txt',
  '+++ b/never-existed.txt',
  '@@ -1 +1 @@',
  '-gone',
  '+replaced',
].join('\n');

// ── Independent observation helpers ────────────────────────────────────────

interface FileSnapshot {
  kind: 'missing' | 'file' | 'dir';
  bytes: string | null;
  sha256: string | null;
}

function snapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return { kind: 'missing', bytes: null, sha256: null };
  const stat = statSync(path);
  if (stat.isDirectory()) return { kind: 'dir', bytes: null, sha256: null };
  const raw = readFileSync(path);
  return {
    kind: 'file',
    bytes: raw.toString('utf8'),
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctx(root: string): ToolContext {
  return {
    agentId: 'gov-multifile-fault',
    runId: `gov-multifile-fault-${randomUUID()}`,
    runDir: root,
    babelRoot: root,
  };
}

/** Mirrors the real Chat caller's classification call (applyPatchExecutor.ts). */
function classifyAsCaller(result: GovernedApplyPatchResult) {
  return assessMutationEffect({
    tool: 'apply_patch',
    error: result.error,
    exitCode: result.exit_code,
    policyBlocked: result.policyBlocked,
    mutationPaths: result.mutationPaths,
    mutationReceipt: result.mutationReceipt,
    effectTransaction: result.effectTransaction,
    preDispatchNoEffect: result.preDispatchNoEffect,
  });
}

/** A failed batch must not leave an unknown effect intent for blind replay. */
function assertNoDanglingEffectIntent(runDir: string): void {
  const records = loadEffectLedger(runDir);
  const terminalIds = new Set(
    records.filter((record) => record.status !== 'intent').map((record) => record.operationId),
  );
  const dangling = records
    .filter((record) => record.status === 'intent' && !terminalIds.has(record.operationId))
    .map((record) => record.toolName);
  assert.deepEqual(dangling, [], 'failed batch left an unresolved effect intent');
}

// ── Fault-injecting executor (the governed dispatch seam) ──────────────────

interface FaultScript {
  /** 1-based write dispatch index where the injected fault fires. */
  faultAt: number;
  /**
   * `throw` — the executor raises after (or before) its own write, the way a
   * real dispatch fault (timeout / transport error) reaches the governed loop.
   * `reject` — the executor returns a nonzero result without writing.
   */
  fault: 'throw' | 'reject';
  /** For `throw`: perform the file write before raising. */
  writeBeforeFault?: boolean;
  /** Runs after each successful write (external interference hook). */
  onAfterWrite?: (writeIndex: number, absolutePath: string) => void;
  /**
   * Runs at the start of the faulting dispatch, after every earlier dispatch
   * has fully settled (external interference hook).
   */
  beforeFault?: (faultPath: string, projectRoot: string) => void;
}

interface BarrierState {
  /** Snapshots taken at the fault instant, keyed by absolute path. */
  atFault: Record<string, FileSnapshot> | null;
  faultPath: string | null;
}

function scriptedExecutor(projectRoot: string, script: FaultScript) {
  const base = createToolExecutor({
    executeTool: async (req) => {
      if (req.tool === 'file_write') {
        writeFileSync(resolve(projectRoot, req.path), req.content, 'utf8');
        return { exit_code: 0, stdout: `wrote ${req.path}`, stderr: '' };
      }
      return { exit_code: 0, stdout: '', stderr: '' };
    },
  });

  const dispatched: string[] = [];
  const writtenPaths: string[] = [];
  const barrier: BarrierState = { atFault: null, faultPath: null };

  const captureAtFault = (faultPath: string): void => {
    const paths = [...new Set([...writtenPaths, faultPath])].map((p) =>
      resolve(projectRoot, p),
    );
    barrier.atFault = Object.fromEntries(paths.map((p) => [p, snapshot(p)]));
  };

  let writes = 0;
  const executor: ToolExecutor = {
    mapAction: (action: AgentAction) => base.mapAction(action),
    async execute(action: AgentAction, context, budget): Promise<ToolExecutionResult> {
      if (action.type !== 'write_file') return base.execute(action, context, budget);
      dispatched.push(action.path);
      writes += 1;
      if (writes !== script.faultAt) {
        const settled = await base.execute(action, context, budget);
        writtenPaths.push(action.path);
        script.onAfterWrite?.(writes, resolve(projectRoot, action.path));
        return settled;
      }
      barrier.faultPath = action.path;
      script.beforeFault?.(action.path, projectRoot);
      if (script.fault === 'reject') {
        captureAtFault(action.path);
        return {
          action,
          terminal: false,
          results: [{ exit_code: 1, stdout: '', stderr: 'injected dispatch rejection' }],
        };
      }
      if (script.writeBeforeFault) await base.execute(action, context, budget);
      captureAtFault(action.path);
      throw new Error('injected executor failure');
    },
  };

  return { executor, dispatched, barrier };
}

function seedTwoFiles(root: string): { file1: string; file2: string } {
  const file1 = join(root, 'file1.txt');
  const file2 = join(root, 'file2.txt');
  writeFileSync(file1, FILE1_ORIGINAL, 'utf8');
  writeFileSync(file2, FILE2_ORIGINAL, 'utf8');
  return { file1, file2 };
}

// ── Fault matrix ───────────────────────────────────────────────────────────

describe('governedApplyPatch multi-file failure and rollback integrity', { concurrency: false }, () => {
  test('1. fails before any dispatch without touching the workspace', async () => {
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-pre-dispatch-');
    try {
      const { file1, file2 } = seedTwoFiles(root);
      const before = [snapshot(file1), snapshot(file2)];

      // (a) the patch cannot be applied in memory at all.
      const nonApplying = scriptedExecutor(root, { faultAt: 99, fault: 'reject' });
      const failedApply = await governedApplyPatch(
        { patch: NON_APPLYING_PATCH },
        { projectRoot: root, context: ctx(root), executor: nonApplying.executor },
      );
      assert.equal(failedApply.exit_code, 1);
      assert.equal(failedApply.preDispatchNoEffect, true);
      assert.match(failedApply.observation, /all-or-nothing/);
      assert.deepEqual(nonApplying.dispatched, [], 'no executor dispatch may occur');

      // (b) a patch target cannot be read.
      const unreadable = scriptedExecutor(root, { faultAt: 99, fault: 'reject' });
      const failedRead = await governedApplyPatch(
        { patch: MISSING_TARGET_PATCH },
        { projectRoot: root, context: ctx(root), executor: unreadable.executor },
      );
      assert.equal(failedRead.exit_code, 1);
      assert.equal(failedRead.preDispatchNoEffect, true);
      assert.match(failedRead.observation, /cannot read patch target/);
      assert.deepEqual(unreadable.dispatched, [], 'no executor dispatch may occur');

      // Independently observed: the workspace is byte-identical.
      assert.deepEqual([snapshot(file1), snapshot(file2)], before);
      assertNoDanglingEffectIntent(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('2. rolls the earlier file back when the second dispatch throws before its effect', async () => {
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-throw-pre-effect-');
    try {
      const { file1, file2 } = seedTwoFiles(root);
      const script = scriptedExecutor(root, {
        faultAt: 2,
        fault: 'throw',
        writeBeforeFault: false,
      });

      const result = await governedApplyPatch(
        { patch: TWO_FILE_PATCH },
        { projectRoot: root, context: ctx(root), executor: script.executor },
      );

      // Barrier: the first write provably completed before the fault.
      assert.deepEqual(script.dispatched, ['file1.txt', 'file2.txt']);
      const atFault = script.barrier.atFault ?? {};
      assert.equal(atFault[file1]?.bytes, FILE1_PATCHED, 'first write must land before the fault');
      assert.equal(atFault[file2]?.bytes, FILE2_ORIGINAL, 'second file must have no effect');

      // Truthful failure result; never a pre-dispatch claim after an observed write.
      assert.equal(result.exit_code, 1);
      assert.equal(result.policyBlocked, false);
      assert.notEqual(result.preDispatchNoEffect, true);
      assert.match(result.observation, /Rolled back 1 file\(s\)/);
      assert.equal(result.mutationReceipt, undefined, 'a rolled-back batch retains no committed receipt');

      // Independently observed: the earlier owned write was restored.
      assert.equal(snapshot(file1).bytes, FILE1_ORIGINAL);
      assert.equal(snapshot(file2).bytes, FILE2_ORIGINAL);
      assert.equal(classifyAsCaller(result).status, 'indeterminate');
      assertNoDanglingEffectIntent(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('3. rolls both files back when the second file writes and then throws', async () => {
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-throw-post-effect-');
    try {
      const { file1, file2 } = seedTwoFiles(root);
      const script = scriptedExecutor(root, {
        faultAt: 2,
        fault: 'throw',
        writeBeforeFault: true,
      });

      const result = await governedApplyPatch(
        { patch: TWO_FILE_PATCH },
        { projectRoot: root, context: ctx(root), executor: script.executor },
      );

      const atFault = script.barrier.atFault ?? {};
      assert.equal(atFault[file1]?.bytes, FILE1_PATCHED, 'first write must land before the fault');
      assert.equal(atFault[file2]?.bytes, FILE2_PATCHED, 'second file had an effect before throwing');

      assert.equal(result.exit_code, 1);
      assert.notEqual(result.preDispatchNoEffect, true);
      assert.equal(result.mutationReceipt, undefined);
      assert.equal(snapshot(file1).bytes, FILE1_ORIGINAL, 'earlier owned write must be restored');
      assert.equal(snapshot(file2).bytes, FILE2_ORIGINAL, 'failing file effect must be restored');
      assert.equal(classifyAsCaller(result).status, 'indeterminate');
      assertNoDanglingEffectIntent(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('4. rolls the earlier file back after a normal later-file rejection', async () => {
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-reject-rollback-');
    try {
      const { file1, file2 } = seedTwoFiles(root);
      const script = scriptedExecutor(root, { faultAt: 2, fault: 'reject' });

      const result = await governedApplyPatch(
        { patch: TWO_FILE_PATCH },
        { projectRoot: root, context: ctx(root), executor: script.executor },
      );

      assert.deepEqual(script.dispatched, ['file1.txt', 'file2.txt']);
      assert.equal(result.exit_code, 1);
      assert.equal(result.policyBlocked, false);
      assert.notEqual(result.preDispatchNoEffect, true);
      assert.match(result.observation, /Rolled back 1 file\(s\)/);
      assert.equal(snapshot(file1).bytes, FILE1_ORIGINAL);
      assert.equal(snapshot(file2).bytes, FILE2_ORIGINAL);
      // The single-file dispatch transaction must not be presented as
      // batch-wide proof that the whole patch had no effect.
      assert.equal(classifyAsCaller(result).status, 'indeterminate');
      assertNoDanglingEffectIntent(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('5. reports a failed rollback write truthfully when the earlier file cannot be restored', async () => {
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-rollback-write-failure-');
    let file1 = '';
    try {
      const seeded = seedTwoFiles(root);
      file1 = seeded.file1;
      const script = scriptedExecutor(root, {
        faultAt: 2,
        fault: 'reject',
        onAfterWrite: (writeIndex, absolutePath) => {
          assert.equal(writeIndex, 1);
          assert.equal(absolutePath, file1);
          // The restore write must fail: the file is still ours byte-for-byte
          // but is no longer writable.
          chmodSync(file1, 0o444);
        },
      });

      const result = await governedApplyPatch(
        { patch: TWO_FILE_PATCH },
        { projectRoot: root, context: ctx(root), executor: script.executor },
      );

      assert.equal(result.exit_code, 1);
      assert.notEqual(result.preDispatchNoEffect, true);
      // Independently observed: file1 was NOT restored and still holds the
      // patch's bytes; the earlier write is not silently claimed as reverted.
      assert.equal(snapshot(file1).bytes, FILE1_PATCHED);
      assert.equal(snapshot(seeded.file2).bytes, FILE2_ORIGINAL);
      assert.ok(result.observation.includes('file1.txt'), 'unrestored path must be named');
      assert.doesNotMatch(result.observation, /Rolled back 1 file\(s\)/);
      // A batch that left a modified file must not classify as zero-effect.
      assert.equal(classifyAsCaller(result).status, 'indeterminate');
      assertNoDanglingEffectIntent(root);
    } finally {
      if (file1 && existsSync(file1)) chmodSync(file1, 0o666);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('6. removes a newly created first file when a later file fails', async () => {
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-created-rollback-');
    try {
      const file1 = join(root, 'file1.txt');
      const file2 = join(root, 'file2.txt');
      writeFileSync(file2, FILE2_ORIGINAL, 'utf8');
      assert.equal(existsSync(file1), false);

      const script = scriptedExecutor(root, {
        faultAt: 2,
        fault: 'reject',
        onAfterWrite: (writeIndex, absolutePath) => {
          assert.equal(writeIndex, 1);
          assert.equal(snapshot(absolutePath).bytes, FILE1_CREATED, 'creation must land before the fault');
        },
      });

      const result = await governedApplyPatch(
        { patch: CREATE_THEN_MODIFY_PATCH },
        { projectRoot: root, context: ctx(root), executor: script.executor },
      );

      assert.equal(result.exit_code, 1);
      assert.notEqual(result.preDispatchNoEffect, true);
      assert.match(result.observation, /Rolled back 1 file\(s\)/);
      assert.equal(snapshot(file1).kind, 'missing', 'created file must be removed, not emptied');
      assert.equal(snapshot(file2).bytes, FILE2_ORIGINAL);
      assert.equal(classifyAsCaller(result).status, 'indeterminate');
      assertNoDanglingEffectIntent(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('7. never clobbers a newer external write to the first file during rollback', async () => {
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-external-write-');
    try {
      const { file1, file2 } = seedTwoFiles(root);
      const script = scriptedExecutor(root, {
        faultAt: 2,
        fault: 'reject',
        beforeFault: (faultPath, projectRoot) => {
          // The first dispatch has fully settled; the file it wrote is then
          // replaced by a writer this patch does not own.
          assert.equal(resolve(projectRoot, faultPath), file2);
          assert.equal(snapshot(file1).bytes, FILE1_PATCHED);
          writeFileSync(file1, FILE1_EXTERNAL, 'utf8');
          assert.equal(snapshot(file1).sha256, digest(FILE1_EXTERNAL));
        },
      });

      const result = await governedApplyPatch(
        { patch: TWO_FILE_PATCH },
        { projectRoot: root, context: ctx(root), executor: script.executor },
      );

      assert.equal(result.exit_code, 1);
      assert.notEqual(result.preDispatchNoEffect, true);
      // Independently observed: the newer external bytes survive untouched,
      // and the batch does not claim a clean restoration of file1.
      assert.equal(snapshot(file1).bytes, FILE1_EXTERNAL);
      assert.notEqual(snapshot(file1).sha256, digest(FILE1_ORIGINAL));
      assert.notEqual(snapshot(file1).sha256, digest(FILE1_PATCHED));
      assert.equal(snapshot(file2).bytes, FILE2_ORIGINAL);
      assert.ok(result.observation.includes('file1.txt'), 'unrestored path must be named');
      assert.doesNotMatch(result.observation, /Rolled back 1 file\(s\)/);
      assert.equal(classifyAsCaller(result).status, 'indeterminate');
      assertNoDanglingEffectIntent(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('7b. reports a truthful batch result when an external write lands inside a dispatch', async () => {
    // The post-image verification inside the executor already detects that the
    // dispatched write no longer matches what was requested. This case pins the
    // *governed* result: the batch must still be reported as uncertain rather
    // than as a pre-dispatch no-op. The executor's own pre-image cleanup is a
    // separate owner (workspaceTransactions) and is not re-specified here.
    resetCircuitBreaker();
    const root = tmpRoot('babel-m1-external-inside-dispatch-');
    try {
      const { file1, file2 } = seedTwoFiles(root);
      const script = scriptedExecutor(root, {
        faultAt: 2,
        fault: 'reject',
        onAfterWrite: (writeIndex, absolutePath) => {
          assert.equal(writeIndex, 1);
          assert.equal(absolutePath, file1);
          // Lands before the dispatch's own post-image verification runs.
          writeFileSync(file1, FILE1_EXTERNAL, 'utf8');
        },
      });

      const result = await governedApplyPatch(
        { patch: TWO_FILE_PATCH },
        { projectRoot: root, context: ctx(root), executor: script.executor },
      );

      assert.equal(result.exit_code, 1);
      assert.equal(result.policyBlocked, false);
      // A write was observed on disk: never claim the pre-dispatch state.
      assert.notEqual(result.preDispatchNoEffect, true);
      assert.match(result.observation, /MUTATION_POSTIMAGE_NOT_CONFIRMED/);
      assert.equal(classifyAsCaller(result).status, 'indeterminate');
      assertNoDanglingEffectIntent(root);
      assert.equal(snapshot(file2).bytes, FILE2_ORIGINAL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
