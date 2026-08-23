/**
 * Lock ownership and mutation path-root regressions for governedStrReplace.
 *
 * Same-path nested FileWriteMutex acquisition must not deadlock, and
 * write_file transaction snapshots must target the project-root file
 * rather than a cwd-relative decoy.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import type { ToolContext, ToolResult } from '../localTools.js';
import { FileWriteMutex } from '../services/editReliability.js';
import { WorkspaceTransactionManager } from '../services/workspaceTransactions.js';
import type { AgentAction } from './actions.js';
import { governedStrReplace } from './governedMutations.js';
import {
  createToolExecutor,
  executeActionWithPolicy,
  resetCircuitBreaker,
  type ToolExecutor,
} from './toolExecutor.js';

const DEADLOCK_MS = 8_000;

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctx(root: string): ToolContext {
  return {
    agentId: 'gov-lock',
    runId: `gov-lock-${randomUUID()}`,
    runDir: root,
    babelRoot: root,
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writingExecutor(projectRoot: string): ToolExecutor {
  return createToolExecutor({
    executeTool: async (req): Promise<ToolResult> => {
      if (req.tool === 'file_write') {
        const target = resolve(projectRoot, req.path);
        writeFileSync(target, req.content, 'utf8');
        return { exit_code: 0, stdout: `Written: ${target}`, stderr: '' };
      }
      return { exit_code: 0, stdout: '', stderr: '' };
    },
  });
}

function failingAfterWriteExecutor(projectRoot: string): ToolExecutor {
  return createToolExecutor({
    executeTool: async (req): Promise<ToolResult> => {
      if (req.tool === 'file_write') {
        const target = resolve(projectRoot, req.path);
        writeFileSync(target, req.content, 'utf8');
        return { exit_code: 1, stdout: '', stderr: 'forced-write-failure' };
      }
      return { exit_code: 1, stdout: '', stderr: 'unexpected-tool' };
    },
  });
}

describe('governed mutation lock ownership and path root', { concurrency: false }, () => {
  test('completes when projectRoot equals cwd instead of deadlocking', async () => {
    resetCircuitBreaker();
    const projectRoot = process.cwd();
    const fileName = `gov-lock-same-cwd-${randomUUID()}.ts`;
    const filePath = join(projectRoot, fileName);
    try {
      writeFileSync(filePath, 'const x = 1;\n', 'utf8');
      const result = await withTimeout(
        governedStrReplace(
          { file_path: fileName, old_str: 'const x = 1;', new_str: 'const x = 2;' },
          {
            projectRoot,
            context: ctx(projectRoot),
            preset: 'workspace_write',
            executor: writingExecutor(projectRoot),
          },
        ),
        DEADLOCK_MS,
        'projectRoot == cwd governedStrReplace',
      );
      assert.equal(result.exit_code, 0, result.observation);
      assert.equal(result.policyBlocked, false);
      assert.equal(readFileSync(filePath, 'utf8'), 'const x = 2;\n');
      assert.deepEqual(result.mutationPaths, [resolve(filePath)]);
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  test('transaction paths follow projectRoot when it differs from cwd', async () => {
    resetCircuitBreaker();
    const projectDir = tmpRoot('babel-gov-lock-proj-');
    const decoyName = `gov-path-root-${randomUUID()}.ts`;
    const decoyPath = join(process.cwd(), decoyName);
    try {
      writeFileSync(join(projectDir, decoyName), 'const x = 1;\n', 'utf8');
      writeFileSync(decoyPath, 'DECOY\n', 'utf8');
      const result = await withTimeout(
        governedStrReplace(
          { file_path: decoyName, old_str: 'const x = 1;', new_str: 'const x = 2;' },
          {
            projectRoot: projectDir,
            context: ctx(projectDir),
            preset: 'workspace_write',
            executor: writingExecutor(projectDir),
          },
        ),
        DEADLOCK_MS,
        'projectRoot != cwd governedStrReplace',
      );
      assert.equal(result.exit_code, 0, result.observation);
      assert.equal(readFileSync(join(projectDir, decoyName), 'utf8'), 'const x = 2;\n');
      assert.equal(readFileSync(decoyPath, 'utf8'), 'DECOY\n');
      assert.deepEqual(result.mutationPaths, [resolve(projectDir, decoyName)]);
      assert.equal(Object.keys(result.preBatchHash ?? {}).includes(resolve(projectDir, decoyName)), true);
      assert.equal(Object.keys(result.preBatchHash ?? {}).includes(resolve(process.cwd(), decoyName)), false);
    } finally {
      rmSync(decoyPath, { force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('serializes concurrent same-file governed replacements', async () => {
    resetCircuitBreaker();
    const dir = tmpRoot('babel-gov-lock-samefile-');
    try {
      writeFileSync(join(dir, 'counter.ts'), 'counter=0\n', 'utf8');
      const executor = writingExecutor(dir);
      const options = {
        projectRoot: dir,
        context: ctx(dir),
        preset: 'workspace_write' as const,
        executor,
      };
      const [first, second] = await withTimeout(
        Promise.all([
          governedStrReplace(
            { file_path: 'counter.ts', old_str: 'counter=0', new_str: 'counter=A' },
            options,
          ),
          governedStrReplace(
            { file_path: 'counter.ts', old_str: 'counter=0', new_str: 'counter=B' },
            { ...options, context: ctx(dir) },
          ),
        ]),
        DEADLOCK_MS,
        'concurrent same-file governedStrReplace',
      );
      const successes = [first, second].filter((result) => result.exit_code === 0);
      const failures = [first, second].filter((result) => result.exit_code !== 0);
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      const body = readFileSync(join(dir, 'counter.ts'), 'utf8');
      assert.match(body, /counter=[AB]/);
      assert.equal(body.includes('counter=0'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not globally serialize concurrent different-file replacements', async () => {
    resetCircuitBreaker();
    const dir = tmpRoot('babel-gov-lock-difffile-');
    try {
      writeFileSync(join(dir, 'a.ts'), 'a=1\n', 'utf8');
      writeFileSync(join(dir, 'b.ts'), 'b=1\n', 'utf8');
      const events: string[] = [];
      const delayingExecutor = createToolExecutor({
        executeTool: async (req): Promise<ToolResult> => {
          if (req.tool === 'file_write') {
            events.push(`start:${req.path}`);
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
            writeFileSync(resolve(dir, req.path), req.content, 'utf8');
            events.push(`end:${req.path}`);
            return { exit_code: 0, stdout: 'ok', stderr: '' };
          }
          return { exit_code: 0, stdout: '', stderr: '' };
        },
      });
      const [aResult, bResult] = await withTimeout(
        Promise.all([
          governedStrReplace(
            { file_path: 'a.ts', old_str: 'a=1', new_str: 'a=2' },
            {
              projectRoot: dir,
              context: ctx(dir),
              preset: 'workspace_write',
              executor: delayingExecutor,
            },
          ),
          governedStrReplace(
            { file_path: 'b.ts', old_str: 'b=1', new_str: 'b=2' },
            {
              projectRoot: dir,
              context: ctx(dir),
              preset: 'workspace_write',
              executor: delayingExecutor,
            },
          ),
        ]),
        DEADLOCK_MS,
        'concurrent different-file governedStrReplace',
      );
      assert.equal(aResult.exit_code, 0, aResult.observation);
      assert.equal(bResult.exit_code, 0, bResult.observation);
      const aStart = events.indexOf('start:a.ts');
      const aEnd = events.indexOf('end:a.ts');
      const bStart = events.indexOf('start:b.ts');
      const bEnd = events.indexOf('end:b.ts');
      assert.ok(aStart >= 0 && aEnd > aStart);
      assert.ok(bStart >= 0 && bEnd > bStart);
      assert.ok(aStart < bEnd && bStart < aEnd, `expected overlap, got ${events.join(',')}`);
      assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'a=2\n');
      assert.equal(readFileSync(join(dir, 'b.ts'), 'utf8'), 'b=2\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('policy-blocked mutation writes nothing and does not stick the lock', async () => {
    resetCircuitBreaker();
    const dir = tmpRoot('babel-gov-lock-policy-');
    try {
      writeFileSync(join(dir, 'keep.ts'), 'keep\n', 'utf8');
      const blocked = await withTimeout(
        governedStrReplace(
          { file_path: 'keep.ts', old_str: 'keep', new_str: 'gone' },
          {
            projectRoot: dir,
            context: ctx(dir),
            preset: 'read_only',
            executor: writingExecutor(dir),
          },
        ),
        DEADLOCK_MS,
        'policy-blocked governedStrReplace',
      );
      assert.equal(blocked.policyBlocked, true);
      assert.equal(readFileSync(join(dir, 'keep.ts'), 'utf8'), 'keep\n');

      const allowed = await withTimeout(
        governedStrReplace(
          { file_path: 'keep.ts', old_str: 'keep', new_str: 'kept' },
          {
            projectRoot: dir,
            context: ctx(dir),
            preset: 'workspace_write',
            executor: writingExecutor(dir),
          },
        ),
        DEADLOCK_MS,
        'follow-up governedStrReplace after policy block',
      );
      assert.equal(allowed.exit_code, 0, allowed.observation);
      assert.equal(readFileSync(join(dir, 'keep.ts'), 'utf8'), 'kept\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed mutation rolls back the project-root file and releases the lock', async () => {
    resetCircuitBreaker();
    const dir = tmpRoot('babel-gov-lock-rollback-');
    const decoyName = `gov-rollback-${randomUUID()}.ts`;
    const decoyPath = join(process.cwd(), decoyName);
    try {
      writeFileSync(join(dir, decoyName), 'original\n', 'utf8');
      writeFileSync(decoyPath, 'DECOY\n', 'utf8');
      const failed = await withTimeout(
        governedStrReplace(
          { file_path: decoyName, old_str: 'original', new_str: 'mutated' },
          {
            projectRoot: dir,
            context: ctx(dir),
            preset: 'workspace_write',
            executor: failingAfterWriteExecutor(dir),
          },
        ),
        DEADLOCK_MS,
        'failed governedStrReplace rollback',
      );
      assert.equal(failed.exit_code, 1);
      assert.equal(failed.policyBlocked, false);
      assert.equal(readFileSync(join(dir, decoyName), 'utf8'), 'original\n');
      assert.equal(readFileSync(decoyPath, 'utf8'), 'DECOY\n');

      const recovered = await withTimeout(
        governedStrReplace(
          { file_path: decoyName, old_str: 'original', new_str: 'recovered' },
          {
            projectRoot: dir,
            context: ctx(dir),
            preset: 'workspace_write',
            executor: writingExecutor(dir),
          },
        ),
        DEADLOCK_MS,
        'governedStrReplace after rollback',
      );
      assert.equal(recovered.exit_code, 0, recovered.observation);
      assert.equal(readFileSync(join(dir, decoyName), 'utf8'), 'recovered\n');
    } finally {
      rmSync(decoyPath, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('write_file transaction paths use mutationRoot rather than cwd', async () => {
    resetCircuitBreaker();
    const projectDir = tmpRoot('babel-gov-lock-write-');
    const decoyName = `gov-write-root-${randomUUID()}.txt`;
    const decoyPath = join(process.cwd(), decoyName);
    try {
      writeFileSync(join(projectDir, decoyName), 'before\n', 'utf8');
      writeFileSync(decoyPath, 'DECOY\n', 'utf8');
      const action: AgentAction = {
        type: 'write_file',
        path: decoyName,
        content: 'after\n',
      };
      const result = await withTimeout(
        executeActionWithPolicy(action, 'workspace_write', ctx(projectDir), {
          executor: writingExecutor(projectDir),
          mutationRoot: projectDir,
        }),
        DEADLOCK_MS,
        'write_file mutationRoot path',
      );
      assert.equal(result.policyBlocked, false);
      assert.equal(result.results[0]?.exit_code, 0);
      assert.deepEqual(result.mutationPaths, [resolve(projectDir, decoyName)]);
      assert.equal(readFileSync(join(projectDir, decoyName), 'utf8'), 'after\n');
      assert.equal(readFileSync(decoyPath, 'utf8'), 'DECOY\n');
    } finally {
      rmSync(decoyPath, { force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('nested same-path FileWriteMutex.runExclusive deadlocks without lockContext and succeeds with lockContext', async () => {
    const key = `mutex-nested-${randomUUID()}`;
    let innerStarted = false;
    let innerTimedOut = false;
    let innerFinishedPromise: Promise<void> | undefined;

    await FileWriteMutex.runExclusive(key, async () => {
      const innerPromise = FileWriteMutex.runExclusive(key, async () => {
        innerStarted = true;
      });
      innerFinishedPromise = innerPromise;
      try {
        await withTimeout(innerPromise, 150, 'nested mutex without lockContext');
      } catch (err: any) {
        if (err instanceof Error && /timed out/.test(err.message)) {
          innerTimedOut = true;
        }
      }
      assert.equal(innerStarted, false, 'inner must not run while outer holds lock');
      assert.equal(innerTimedOut, true, 'inner must time out while outer holds lock');
    });

    // Wait for queued inner promise to drain cleanly after outer release
    if (innerFinishedPromise) {
      await withTimeout(innerFinishedPromise, DEADLOCK_MS, 'inner lock drain');
    }

    // With active lockContext, nested acquisition succeeds immediately
    let innerWithContextRan = false;
    await FileWriteMutex.runExclusive(key, async (handle) => {
      await FileWriteMutex.runExclusive(key, async () => {
        innerWithContextRan = true;
      }, { lockContext: handle });
    });
    assert.equal(innerWithContextRan, true);
  });

  test('deferred undo after outer lock release reacquires lock and serializes against competing lock', async () => {
    resetCircuitBreaker();
    const dir = tmpRoot('babel-gov-lock-undo-compete-');
    const fileName = `target-${randomUUID()}.ts`;
    const targetPath = join(dir, fileName);
    const sessionId = `session-undo-${randomUUID()}`;

    try {
      writeFileSync(targetPath, 'initial_content\n', 'utf8');

      // 1. Successful governed mutation
      const mutResult = await withTimeout(
        governedStrReplace(
          { file_path: fileName, old_str: 'initial_content', new_str: 'mutated_content' },
          {
            projectRoot: dir,
            context: {
              agentId: 'gov-lock',
              runId: sessionId,
              runDir: dir,
              babelRoot: dir,
            },
            preset: 'workspace_write',
            executor: writingExecutor(dir),
          },
        ),
        DEADLOCK_MS,
        'initial governedStrReplace for deferred undo test',
      );
      assert.equal(mutResult.exit_code, 0, mutResult.observation);
      assert.equal(readFileSync(targetPath, 'utf8'), 'mutated_content\n');

      // 2. Outer lock scope is now fully closed.
      // 3. Start a competing lock on targetPath that holds the lock until explicitly released.
      let competingLockAcquired = false;
      let releaseCompetingLock!: () => void;
      const competingHold = new Promise<void>((res) => {
        releaseCompetingLock = res;
      });

      let competingFinished = false;
      const competingPromise = FileWriteMutex.runExclusive(targetPath, async () => {
        competingLockAcquired = true;
        await competingHold;
        writeFileSync(targetPath, 'competing_mutation\n', 'utf8');
        competingFinished = true;
      });

      // Wait until competing lock is actively held
      while (!competingLockAcquired) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // 4. Trigger deferred undoLastMutationBatch(sessionId).
      // Stale implementation would bypass the mutex because tx retained alreadyLockedPaths.
      // Hardened implementation MUST queue behind the competing lock.
      let undoFinished = false;
      const undoPromise = WorkspaceTransactionManager.undoLastMutationBatch(sessionId).then((res) => {
        undoFinished = true;
        return res;
      });

      // Give the event loop time to attempt immediate unsynchronized write if buggy
      await new Promise((r) => setTimeout(r, 100));

      // Assert undo has NOT executed while competing lock is active
      assert.equal(undoFinished, false, 'undo must not bypass mutex or execute while competing lock is held');
      assert.equal(competingFinished, false);

      // 5. Release competing lock and let competing mutation finish
      releaseCompetingLock();
      await competingPromise;
      assert.equal(competingFinished, true);

      // 6. Now deferred undo acquires lock, executes, and restores initial content
      const undoResult = await withTimeout(undoPromise, DEADLOCK_MS, 'deferred undo completion');
      assert.equal(undoResult.verification, true);
      assert.equal(undoFinished, true);
      assert.equal(readFileSync(targetPath, 'utf8'), 'initial_content\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normal deferred undo restores pre-images correctly with no outer lock alive', async () => {
    resetCircuitBreaker();
    const dir = tmpRoot('babel-gov-lock-undo-normal-');
    const fileName = `target-${randomUUID()}.ts`;
    const targetPath = join(dir, fileName);
    const sessionId = `session-undo-norm-${randomUUID()}`;

    try {
      writeFileSync(targetPath, 'version_1\n', 'utf8');

      const mutResult = await withTimeout(
        governedStrReplace(
          { file_path: fileName, old_str: 'version_1', new_str: 'version_2' },
          {
            projectRoot: dir,
            context: {
              agentId: 'gov-lock',
              runId: sessionId,
              runDir: dir,
              babelRoot: dir,
            },
            preset: 'workspace_write',
            executor: writingExecutor(dir),
          },
        ),
        DEADLOCK_MS,
        'governedStrReplace for normal undo',
      );
      assert.equal(mutResult.exit_code, 0, mutResult.observation);
      assert.equal(readFileSync(targetPath, 'utf8'), 'version_2\n');

      // Deferred undo by session ID
      const undoResult = await withTimeout(
        WorkspaceTransactionManager.undoLastMutationBatch(sessionId),
        DEADLOCK_MS,
        'normal deferred undo',
      );
      assert.equal(undoResult.verification, true);
      assert.equal(readFileSync(targetPath, 'utf8'), 'version_1\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('canonical path alias serialization serializes lexically different paths to the same file', async () => {
    const dir = tmpRoot('babel-gov-lock-alias-');
    const fileName = 'target.ts';
    const directPath = join(dir, fileName);
    const aliasPath = join(dir, 'nested', '..', fileName);

    try {
      writeFileSync(directPath, 'alias_test\n', 'utf8');

      let firstLockHeld = false;
      let releaseFirstLock!: () => void;
      const firstLockPromise = new Promise<void>((res) => {
        releaseFirstLock = res;
      });

      let firstFinished = false;
      const first = FileWriteMutex.runExclusive(directPath, async () => {
        firstLockHeld = true;
        await firstLockPromise;
        firstFinished = true;
      });

      while (!firstLockHeld) {
        await new Promise((r) => setTimeout(r, 10));
      }

      let secondFinished = false;
      const second = FileWriteMutex.runExclusive(aliasPath, async () => {
        secondFinished = true;
      });

      await new Promise((r) => setTimeout(r, 100));
      assert.equal(secondFinished, false, 'alias path must wait for direct path lock on same file');

      releaseFirstLock();
      await first;
      await withTimeout(second, DEADLOCK_MS, 'alias lock completion');
      assert.equal(firstFinished, true);
      assert.equal(secondFinished, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FileWriteMutex cleans up lock map entries without memory leak', async () => {
    const key = `cleanup-test-${randomUUID()}`;
    assert.equal(FileWriteMutex.activeLockCount(), 0);

    let ran = false;
    await FileWriteMutex.runExclusive(key, async () => {
      ran = true;
    });

    assert.equal(ran, true);
    assert.equal(FileWriteMutex.activeLockCount(), 0, 'lock map must be empty after lock release');
  });

  test('FileWriteMutex rejects revoked, expired, or forged lockContext', async () => {
    const key = `context-reject-${randomUUID()}`;

    // 1. Unchecked boolean bypass is ignored and serialized
    let blockerHeld = false;
    let releaseBlocker!: () => void;
    const blockerPromise = new Promise<void>((r) => {
      releaseBlocker = r;
    });

    const blocker = FileWriteMutex.runExclusive(key, async () => {
      blockerHeld = true;
      await blockerPromise;
    });

    while (!blockerHeld) {
      await new Promise((r) => setTimeout(r, 10));
    }

    let bypassedRan = false;
    const attempt = FileWriteMutex.runExclusive(
      key,
      async () => {
        bypassedRan = true;
      },
      // Pass forged / legacy options
      { lockContext: { holds: () => true, isActive: () => true } as any },
    );

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bypassedRan, false, 'forged lockContext must not bypass serialization');

    releaseBlocker();
    await blocker;
    await withTimeout(attempt, DEADLOCK_MS, 'forged attempt finishes after blocker release');
    assert.equal(bypassedRan, true);

    // 2. Expired handle after runExclusive exits is inactive and cannot be reused
    let capturedHandle: any;
    await FileWriteMutex.runExclusive(key, async (h) => {
      capturedHandle = h;
      assert.equal(h.isActive(), true);
    });
    assert.equal(capturedHandle.isActive(), false);

    // Reusing expired handle must not bypass
    let secondBlockerHeld = false;
    let releaseSecondBlocker!: () => void;
    const secondBlockerPromise = new Promise<void>((r) => {
      releaseSecondBlocker = r;
    });
    const secondBlocker = FileWriteMutex.runExclusive(key, async () => {
      secondBlockerHeld = true;
      await secondBlockerPromise;
    });

    while (!secondBlockerHeld) {
      await new Promise((r) => setTimeout(r, 10));
    }

    let expiredRan = false;
    const expiredAttempt = FileWriteMutex.runExclusive(
      key,
      async () => {
        expiredRan = true;
      },
      { lockContext: capturedHandle },
    );

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(expiredRan, false, 'expired handle must not bypass serialization');

    releaseSecondBlocker();
    await secondBlocker;
    await withTimeout(expiredAttempt, DEADLOCK_MS, 'expired attempt finishes after blocker');
    assert.equal(expiredRan, true);
  });
});
