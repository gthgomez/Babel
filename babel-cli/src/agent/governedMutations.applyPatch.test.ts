import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import type { ToolContext } from '../localTools.js';
import { governedApplyPatch, assessGovernedApplyPatchEffect } from './governedMutations.js';
import { createToolExecutor } from './toolExecutor.js';
import { buildChatRunPayload } from '../interactive/execution/chatCore.js';
import { globalCostTracker } from '../services/costTracker.js';
import { ChatEngine } from './chatEngine.js';
import type { ChatToolAction } from './chatToolDefinitions.js';

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
  test('real engine preserves mixed patch changes and per-file receipt path bindings', async () => {
    const root = tmpRoot('babel-patch-engine-metadata-');
    try {
      for (const path of ['first.txt', 'last.txt']) writeFileSync(join(root, path), 'before\n');
      for (const args of [['init', '-q'], ['add', '--all'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) {
        execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
      }
      const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'Update first.txt and preserve last.txt', projectRoot: root });
      const host = engine as unknown as {
        activeSubmissionGeneration: number;
        executeOneAction: (action: ChatToolAction, context: ToolContext, callbacks: object, meta: object) => Promise<{ observation: string }>;
        toolCallLog: Array<{ tool: string; effect_status?: string; mutation_paths?: string[] }>;
        parity: { sessionEvents: { events: Array<{ kind: string; paths?: string[]; pre_image_hashes?: Record<string, string>; post_image_hashes?: Record<string, string> }> } };
      };
      const context = { ...ctx(root), projectRoot: root, runId: engine.getEngineRunId() };
      const patch = ['first.txt', 'last.txt'].map((path, i) => [
        `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-before', i === 0 ? '+after' : '+before',
      ].join('\n')).join('\n');
      const result = await host.executeOneAction({ type: 'apply_patch', patch }, context, {},
        { index: 0, ownerGeneration: host.activeSubmissionGeneration });
      assert.equal(readFileSync(join(root, 'first.txt'), 'utf8'), 'after\n', result.observation);
      const log = host.toolCallLog.find(entry => entry.tool === 'apply_patch')!;
      assert.equal(log.effect_status, 'confirmed_change');
      assert.deepEqual(log.mutation_paths, [join(root, 'first.txt')]);
      const batches = host.parity.sessionEvents.events.filter(event => event.kind === 'mutation_batch');
      assert.equal(batches.length, 2);
      for (const [i, batch] of batches.entries()) {
        const path = join(root, i === 0 ? 'first.txt' : 'last.txt');
        assert.deepEqual(batch.paths, [path]);
        assert.deepEqual(Object.keys(batch.pre_image_hashes ?? {}), [path]);
        assert.deepEqual(Object.keys(batch.post_image_hashes ?? {}), [path]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const contents of [['after', 'before'], ['before', 'after'], ['before', 'before']]) {
    test(`mixed changed/no-op patch metadata: ${contents.join(',')}`, async () => {
      const root = tmpRoot('babel-patch-mixed-');
      try {
        const paths = ['first.txt', 'last.txt'];
        for (const path of paths) writeFileSync(join(root, path), 'before\n');
        const patch = paths.map((path, i) => [
          `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-before', `+${contents[i]}`,
        ].join('\n')).join('\n');
        const result = await governedApplyPatch({ patch }, {
          projectRoot: root, context: ctx(root), executor: createToolExecutor(),
        });
        const changed = paths.filter((_, i) => contents[i] !== 'before').map(path => join(root, path));
        assert.equal(result.exit_code, 0, result.observation);
        assert.equal(result.fileMutationEvidence?.length, 2);
        assert.deepEqual(result.fileMutationEvidence?.flatMap(e => e.mutationReceipt?.affectedFiles ?? []),
          paths.map(path => join(root, path)));
        assert.equal(assessGovernedApplyPatchEffect({ ...result, fileMutationEvidence: [{}] }).status, 'indeterminate');
        const receipt = result.fileMutationEvidence![0]!.mutationReceipt!;
        assert.equal(assessGovernedApplyPatchEffect({ ...result, fileMutationEvidence: [
          { mutationReceipt: { ...receipt, status: 'open' } }, ...result.fileMutationEvidence!.slice(1),
        ] }).status, 'indeterminate');
        assert.deepEqual(result.mutationPaths ?? [], changed);
        assert.equal(assessGovernedApplyPatchEffect(result).status, changed.length ? 'confirmed_change' : 'confirmed_no_change');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('reports every confirmed changed file in a successful multi-file patch', async () => {
    const root = tmpRoot('babel-patch-metadata-');
    try {
      const paths = ['first.txt', 'middle.txt', 'last.txt'];
      for (const path of paths) writeFileSync(join(root, path), 'before\n');
      const patch = paths.map(path => [
        `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-before', '+after',
      ].join('\n')).join('\n');
      const result = await governedApplyPatch({ patch }, {
        projectRoot: root, context: ctx(root), executor: createToolExecutor(),
      });
      assert.equal(result.exit_code, 0, result.observation);
      for (const path of paths) assert.equal(readFileSync(join(root, path), 'utf8'), 'after\n');
      assert.deepEqual(result.mutationPaths, paths.map(path => join(root, path)));
      const payload = buildChatRunPayload({
        status: 'completed', answer: 'Patch applied; acceptance unverified.',
        usage: globalCostTracker.getSessionSummary(), conversation: [],
        toolCalls: [{ tool: 'apply_patch', target: 'first.txt',
          effect_status: assessGovernedApplyPatchEffect(result).status,
          mutation_paths: result.mutationPaths }],
      }, { task: 'repair the files', projectRoot: root });
      assert.deepEqual(payload['changed_files'], paths.map(path => join(root, path)));
      assert.deepEqual((payload['patch_reality'] as { changed_files: string[] }).changed_files, payload['changed_files']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
