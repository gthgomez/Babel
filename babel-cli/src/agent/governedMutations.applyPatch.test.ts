import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { ToolContext } from '../localTools.js';
import { governedApplyPatch } from './governedMutations.js';
import { createToolExecutor } from './toolExecutor.js';

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctx(root: string): ToolContext {
  return {
    agentId: 'gov-apply-patch',
    runId: `gov-apply-patch-${randomUUID()}`,
    runDir: root,
    babelRoot: root,
  };
}

describe('governedApplyPatch multi-file transactional atomicity', () => {
  test('rolls back previous file writes if a subsequent file changes concurrently', async () => {
    const root = tmpRoot('babel-patch-rollback-');
    try {
      const file1 = join(root, 'file1.txt');
      const file2 = join(root, 'file2.txt');
      writeFileSync(file1, 'line 1\nline 2\n');
      writeFileSync(file2, 'alpha\nbeta\n');

      const patch = [
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

      // Before Phase C executes file 2, we simulate concurrent modification of file 2:
      // We can use onBeforeExecutorExecute or write before execution, or simulate conflict:
      // Let's modify file2 on disk after read phase using onBeforeExecutorExecute hook!
      let callCount = 0;
      const result = await governedApplyPatch(
        { patch },
        {
          projectRoot: root,
          context: ctx(root),
          executor: createToolExecutor(),
          onBeforeExecutorExecute: () => {
            callCount++;
            if (callCount === 1) {
              // File 1 is about to be written. We mutate file2 on disk right now!
              writeFileSync(file2, 'alpha concurrently changed\nbeta\n');
            }
          },
        },
      );

      assert.equal(result.exit_code, 1);
      assert.match(result.observation, /file changed since patch was computed/);
      assert.match(result.observation, /Rolled back 1 file\(s\)/);
      assert.equal(result.preDispatchNoEffect, false);

      // Verify file1.txt was rolled back to its original content!
      assert.equal(readFileSync(file1, 'utf8'), 'line 1\nline 2\n');
      // file2 retains its concurrent content
      assert.equal(readFileSync(file2, 'utf8'), 'alpha concurrently changed\nbeta\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rolls back previous file writes if a subsequent file write is policy-blocked', async () => {
    const root = tmpRoot('babel-patch-blocked-');
    try {
      const file1 = join(root, 'file1.txt');
      const file2 = join(root, 'file2.txt');
      writeFileSync(file1, 'hello world\n');
      writeFileSync(file2, 'sensitive file\n');

      const patch = [
        '--- a/file1.txt',
        '+++ b/file1.txt',
        '@@ -1 +1 @@',
        '-hello world',
        '+hello modified',
        '--- a/file2.txt',
        '+++ b/file2.txt',
        '@@ -1 +1 @@',
        '-sensitive file',
        '+sensitive modified',
      ].join('\n');

      let written = 0;
      const result = await governedApplyPatch(
        { patch },
        {
          projectRoot: root,
          context: ctx(root),
          executor: createToolExecutor(),
          onDispatchAuthorized: () => {
            written++;
            if (written === 2) {
              return { allowed: false, message: 'Policy refused mutation of file2' };
            }
            return { allowed: true };
          },
        },
      );

      assert.equal(result.exit_code, 1);
      assert.equal(result.policyBlocked, true);
      assert.match(result.observation, /Rolled back 1 file\(s\)/);

      // Verify file1.txt was rolled back!
      assert.equal(readFileSync(file1, 'utf8'), 'hello world\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
