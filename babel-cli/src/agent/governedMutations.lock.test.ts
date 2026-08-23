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

  test('nested same-path FileWriteMutex.runExclusive deadlocks without alreadyHeld', async () => {
    const key = `mutex-nested-${randomUUID()}`;
    let innerStarted = false;
    const nested = FileWriteMutex.runExclusive(key, async () => {
      await FileWriteMutex.runExclusive(key, async () => {
        innerStarted = true;
      });
    });
    await assert.rejects(
      withTimeout(nested, 250, 'nested mutex without alreadyHeld'),
      /timed out/,
    );
    assert.equal(innerStarted, false);
  });
});
