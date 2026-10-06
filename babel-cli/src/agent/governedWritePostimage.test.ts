/**
 * Regression: an exit-zero tool result must not mark a mutation effect
 * completed unless the requested post-image actually landed on disk
 * (chat-reliability-20261004 — commitBatch observed post-operation bytes but
 * never compared them against the requested content).
 *
 * Distinguishes the four material outcomes through the real governed path
 * (executeActionWithPolicy): legitimate no-op, real change, requested write
 * never occurred, and wrong-content write. The last two must fail the action
 * truthfully and never be recorded as completed effects.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeActionWithPolicy, resetCircuitBreaker, type ToolExecutor } from './toolExecutor.js';
import { loadEffectLedger } from '../executor/effectLedger.js';
import type { ToolContext } from '../localTools.js';
import type { AgentAction } from './actions.js';

const ORIGINAL = 'export const value = 1;\n';
const REQUESTED = 'export const value = 2;\n';
const WRONG = 'export const value = 3;\n';

function ctx(runId: string, projectRoot: string, runDir: string): ToolContext {
  return {
    runId,
    agentId: 'test-agent',
    projectRoot,
    cwd: projectRoot,
    babelRoot: projectRoot,
    runDir,
  } as unknown as ToolContext;
}

function executorThat(behavior: 'write' | 'silent-no-op' | 'write-wrong'): ToolExecutor {
  return {
    mapAction: () => [],
    async execute(action: AgentAction) {
      // Exit zero is returned regardless of whether the file effect happens —
      // exactly the failure mode the governed path must detect for itself.
      if (behavior === 'write') {
        const a = action as Extract<AgentAction, { type: 'write_file' }>;
        writeFileSync(a.path, a.content, 'utf8');
      } else if (behavior === 'write-wrong') {
        const a = action as Extract<AgentAction, { type: 'write_file' }>;
        writeFileSync(a.path, WRONG, 'utf8');
      }
      return {
        action,
        terminal: false,
        results: [{ exit_code: 0, stdout: 'ok', stderr: '' }],
      };
    },
  } as unknown as ToolExecutor;
}

describe('governed write_file verifies the requested post-image', { concurrency: false }, () => {
  let root: string;
  let runDir: string;
  let target: string;

  beforeEach(() => {
    resetCircuitBreaker();
    root = mkdtempSync(join(tmpdir(), 'babel-postimage-'));
    runDir = mkdtempSync(join(tmpdir(), 'babel-postimage-run-'));
    target = join(root, 'value.ts');
    writeFileSync(target, ORIGINAL, 'utf8');
  });

  test('a silent no-op when the requested content differs is refused (red on pre-fix behavior)', async () => {
    const action: AgentAction = { type: 'write_file', path: target, content: REQUESTED };
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('postimage-1', root, runDir), {
      executor: executorThat('silent-no-op'),
      mutationRoot: root,
      mode: 'chat',
    });
    assert.equal(result.results[0]?.exit_code, 1, 'exit zero must not stand for a completed write');
    assert.match(result.results[0]?.stderr ?? '', /MUTATION_POSTIMAGE_NOT_CONFIRMED/);
    assert.match(result.results[0]?.stderr ?? '', /unchanged/);
    assert.equal(readFileSync(target, 'utf8'), ORIGINAL, 'the file must not be touched');
    const ledger = loadEffectLedger(runDir);
    assert.equal(ledger.at(-1)?.status, 'failed', 'the effect must not be marked completed');
  });

  test('a wrong-content write is refused and rolled back to the recorded pre-image', async () => {
    const action: AgentAction = { type: 'write_file', path: target, content: REQUESTED };
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('postimage-2', root, runDir), {
      executor: executorThat('write-wrong'),
      mutationRoot: root,
      mode: 'chat',
    });
    assert.equal(result.results[0]?.exit_code, 1);
    assert.match(result.results[0]?.stderr ?? '', /not to the requested content/);
    assert.equal(readFileSync(target, 'utf8'), ORIGINAL, 'wrong content must be rolled back');
    assert.equal(result.mutationReceipt?.status, 'rolled_back');
    const ledger = loadEffectLedger(runDir);
    assert.equal(ledger.at(-1)?.status, 'failed');
  });

  test('a real change is marked completed with a verified post-image', async () => {
    const action: AgentAction = { type: 'write_file', path: target, content: REQUESTED };
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('postimage-3', root, runDir), {
      executor: executorThat('write'),
      mutationRoot: root,
      mode: 'chat',
    });
    assert.equal(result.results[0]?.exit_code, 0);
    assert.equal(readFileSync(target, 'utf8'), REQUESTED);
    assert.ok(result.mutationReceipt);
    assert.equal(result.mutationReceipt?.status, 'committed');
    const ledger = loadEffectLedger(runDir);
    assert.equal(ledger.at(-1)?.status, 'completed');
  });

  test('a genuine no-op (file already matches requested content) stays a completed no-change effect', async () => {
    writeFileSync(target, REQUESTED, 'utf8');
    const action: AgentAction = { type: 'write_file', path: target, content: REQUESTED };
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('postimage-4', root, runDir), {
      executor: executorThat('silent-no-op'),
      mutationRoot: root,
      mode: 'chat',
    });
    assert.equal(result.results[0]?.exit_code, 0, 'a proven no-op is legitimate');
    assert.equal(result.mutationReceipt?.changedBytes, 0);
    assert.equal(result.mutationReceipt?.status, 'committed');
    const ledger = loadEffectLedger(runDir);
    assert.equal(ledger.at(-1)?.status, 'completed');
  });

  test('apply_patch with exit zero but zero byte delta on every target is refused', async () => {
    const action: AgentAction = {
      type: 'apply_patch',
      patch: [
        '--- a/value.ts',
        '+++ b/value.ts',
        '@@ -1 +1 @@',
        '-export const value = 1;',
        '+export const value = 2;',
        '',
      ].join('\n'),
    };
    // Executor applies nothing but reports success.
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('postimage-5', root, runDir), {
      executor: executorThat('silent-no-op'),
      mutationRoot: root,
      mode: 'chat',
    });
    assert.equal(result.results[0]?.exit_code, 1);
    assert.match(result.results[0]?.stderr ?? '', /apply_patch reported success but no target file bytes changed/);
    const ledger = loadEffectLedger(runDir);
    assert.equal(ledger.at(-1)?.status, 'failed');
  });
});
