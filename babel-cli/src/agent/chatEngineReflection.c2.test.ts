/**
 * Integration: bounded reflection loop on failed edits (packet C2), driven
 * through ChatEngineActionExecutor.executeOneAction — the same governed
 * write path the coding loop uses. No live provider: the "model" is the
 * test issuing the next str_replace action based on the settled observation
 * (malformed anchor → corrected anchor), exactly like a reflection retry.
 *
 * Under the cap the failure diagnostics flow back with a reflection note;
 * at the cap (3 failed rounds per file per turn) the executor halts with an
 * explicit `edit_reflection_cap` surface (stop: true) instead of letting the
 * retry loop continue. A new turn (owner generation) resets the counter.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { ChatEngineActionExecutor } from './chatEngineActionExecutor.js';
import type { ChatEngineActionExecutorHost, ChatCallbacks } from './chatEngineContracts.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { createSessionEventLog } from './sessionEvents.js';
import { createWorkingState } from './codingLoop/workingState.js';
import { EDIT_REFLECTION_CAP_MARKER, MAX_EDIT_REFLECTION_ROUNDS } from './codingLoop/reflection.js';
import type { ToolContext } from '../localTools.js';

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeHost(projectRoot: string): ChatEngineActionExecutorHost {
  return {
    _lastPhase: null,
    _turnIndex: 0,
    activeSubmissionGeneration: 1,
    dedupeHitCount: 0,
    engineRunDir: projectRoot,
    engineRunId: 'c2-test-run',
    executionProfile: 'chat',
    hardPlanMode: false,
    requireTodoBeforeMutate: false,
    isolationBrokerFlags: () => ({ hostFallbackAllowed: false }),
    readContextEpoch: 0,
    recoveryStatePersistenceUnavailable: false,
    taskClass: 'general_swe',
    todos: new Map(),
    toolCallLog: [],
    fullReadCounts: new Map(),
    readCache: new Map(),
    readCacheKey: (filePath: string) => filePath,
    options: { projectRoot } as ChatEngineActionExecutorHost['options'],
    parity: { turnId: 't0', sessionEvents: createSessionEventLog() } as never,
    policyEventLog: { record: () => {}, events: [] } as never,
    progressController: {} as never,
    workingState: createWorkingState(),
    writeCount: 0,
    consecutiveReadOnlyTools: 0,
    lastVerifierReceipt: null,
    executedVerifierLedger: [],
    platformUnusableVerifiers: new Set(),
    patchRecoveryPath: null,
    beginRecoveryLocalizationInspection: () => false,
    checkVerifierTamper: () => null,
    consumeFailureBudget: () => true,
    currentRecoveryBinding: () => null,
    finishRecoveryLocalizationInspection: () => {},
    getResolvedRequiredVerifiers: () => [],
    getTurnRuntimeSnapshot: () => null,
    hashContent: (content: string) => content,
    hashFilePath: async () => 'hash',
    isSubmissionCurrent: () => true,
    recoveredOperationDispatchAuthorization: () => ({ allowed: true }),
    noteToolForReadThrash: () => {},
    persistRecoveryWorkingState: () => {},
    persistToolStartedAtExecutorDispatch: () => {},
    settleStaleActionResult: (
      tool: string,
      target: string,
      index: number,
      reason: string,
    ) => ({
      index,
      observation: `stale ${tool} ${target}: ${reason}`,
    }),
    runPostEditStaticCheck: async () => null,
  } as unknown as ChatEngineActionExecutorHost;
}

function toolContext(root: string): ToolContext {
  return {
    agentId: 'c2-reflection',
    runId: `c2-reflection-${randomUUID()}`,
    runDir: root,
    babelRoot: root,
  };
}

function callbacks(): ChatCallbacks & { statuses: unknown[] } {
  const statuses: unknown[] = [];
  return {
    statuses,
    onToolStart: () => 1,
    onToolComplete: (...values: unknown[]) => {
      statuses.push(values);
    },
  } as never;
}

async function runStrReplace(
  executor: ChatEngineActionExecutor,
  root: string,
  oldStr: string,
  newStr: string,
): Promise<{ observation: string; stop?: boolean }> {
  const action: ChatToolAction = {
    type: 'str_replace',
    file_path: 'target.ts',
    old_str: oldStr,
    new_str: newStr,
  } as ChatToolAction;
  return await executor.executeOneAction(action, toolContext(root), callbacks(), {
    index: 0,
    ownerGeneration: 1,
  });
}

describe('bounded reflection loop on failed edits (C2)', { concurrency: false }, () => {
  const cleanup: string[] = [];
  after(() => {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  });

  test('malformed anchor succeeds on retry 1 with a reflection note', async () => {
    const root = tmpRoot('babel-c2-reflection-hit-');
    cleanup.push(root);
    const filePath = join(root, 'target.ts');
    writeFileSync(filePath, 'alpha\nconst value = 2\nomega\n', 'utf8');
    const executor = new ChatEngineActionExecutor(makeHost(root));

    // Malformed anchor below the fuzzy-assist threshold (>= 0.90 similarity
    // auto-applies): "const value = 22222222" is a hard miss.
    const first = await runStrReplace(executor, root, 'const value = 22222222', 'const value = 9');
    assert.equal(first.stop, undefined);
    assert.match(first.observation, /Error:|not found/i);
    assert.match(first.observation, /edit_reflection/);
    assert.match(first.observation, new RegExp(`reflection round 1/${MAX_EDIT_REFLECTION_ROUNDS}`));

    // Reflection retry: corrected anchor, same governed write path.
    const second = await runStrReplace(executor, root, 'const value = 2', 'const value = 9');
    assert.equal(second.stop, undefined);
    assert.match(second.observation, /lines 2-2, exact/);
    assert.match(second.observation, /exit_code: 0/);
    assert.equal(readFileSync(filePath, 'utf8'), 'alpha\nconst value = 9\nomega\n');
  });

  test(`a ${MAX_EDIT_REFLECTION_ROUNDS}-round failure halts with the explicit cap surface`, async () => {
    const root = tmpRoot('babel-c2-reflection-cap-');
    cleanup.push(root);
    const filePath = join(root, 'target.ts');
    const original = 'alpha\nconst value = 2\nomega\n';
    writeFileSync(filePath, original, 'utf8');
    const host = makeHost(root);
    const executor = new ChatEngineActionExecutor(host);

    let last: { observation: string; stop?: boolean } | null = null;
    for (let round = 1; round <= MAX_EDIT_REFLECTION_ROUNDS; round++) {
      last = await runStrReplace(executor, root, 'const value = 22222222', 'const value = 0');
      if (round < MAX_EDIT_REFLECTION_ROUNDS) {
        assert.equal(last.stop, undefined, `round ${round} should still reflect`);
        assert.match(last.observation, new RegExp(`reflection round ${round}/`));
      }
    }
    assert.ok(last);
    // 4th round must never be reached as a reflection: the cap round halts.
    assert.equal(last!.stop, true);
    assert.match(last!.observation, new RegExp(EDIT_REFLECTION_CAP_MARKER));
    assert.match(last!.observation, /stopped for this turn/);
    assert.match(last!.observation, /not found|Error:/i);
    // Nothing was ever written.
    assert.equal(readFileSync(filePath, 'utf8'), original);
    // Cap is recorded as a policy event, not silently dropped.
    const capEvents = host.toolCallLog.filter((entry) => entry.detail === EDIT_REFLECTION_CAP_MARKER);
    assert.equal(capEvents.length, 1);
  });

  test('apply_patch: malformed hunk reflects, corrected patch applies, cap halts', async () => {
    const root = tmpRoot('babel-c2-reflection-patch-');
    cleanup.push(root);
    const filePath = join(root, 'src', 'add.ts');
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(root, 'src'), { recursive: true });
    wf(filePath, 'function add(a, b) {\n  return a - b\n}\n', 'utf8');
    const executor = new ChatEngineActionExecutor(makeHost(root));
    const runPatch = async (oldLine: string, newLine: string, generation = 1) =>
      await executor.executeOneAction(
        {
          type: 'apply_patch',
          patch:
            `--- a/src/add.ts\n+++ b/src/add.ts\n@@ -1,3 +1,3 @@\n function add(a, b) {\n-${oldLine}\n+${newLine}\n }\n`,
        } as ChatToolAction,
        toolContext(root),
        callbacks(),
        { index: 0, ownerGeneration: generation },
      );

    // Round 1: wrong context line → patch fails to apply, reflection note.
    const first = await runPatch('return a * b', 'return a + b');
    assert.equal(first.stop, undefined);
    assert.match(first.observation, /patch failed to apply|Error:/i);
    assert.match(first.observation, /edit_reflection/);

    // Corrected patch succeeds through the same governed path.
    const second = await runPatch('return a - b', 'return a + b');
    assert.equal(second.stop, undefined);
    assert.match(second.observation, /Applied 1 hunk/);
    const patched = readFileSync(filePath, 'utf8');
    assert.match(patched, /return a \+ b/);
    assert.doesNotMatch(patched, /return a - b/);

    // Three consecutive failures on a fresh file hit the cap with stop.
    wf(join(root, 'src', 'sub.ts'), 'function sub(a, b) {\n  return a - b\n}\n', 'utf8');
    const runPatch2 = async (oldLine: string, newLine: string) =>
      await executor.executeOneAction(
        {
          type: 'apply_patch',
          patch:
            `--- a/src/sub.ts\n+++ b/src/sub.ts\n@@ -1,3 +1,3 @@\n function sub(a, b) {\n-${oldLine}\n+${newLine}\n }\n`,
        } as ChatToolAction,
        toolContext(root),
        callbacks(),
        { index: 0, ownerGeneration: 1 },
      );
    let capped = null;
    for (let round = 0; round < MAX_EDIT_REFLECTION_ROUNDS; round++) {
      capped = await runPatch2('return a * b', 'return a / b');
    }
    assert.ok(capped);
    assert.equal(capped!.stop, true);
    assert.match(capped!.observation, new RegExp(EDIT_REFLECTION_CAP_MARKER));
  });

  test('counter resets per file per turn: a new owner generation reflects from round 1', async () => {
    const root = tmpRoot('babel-c2-reflection-turn-');
    cleanup.push(root);
    writeFileSync(join(root, 'target.ts'), 'alpha\nconst value = 2\nomega\n', 'utf8');
    const host = makeHost(root);
    const executor = new ChatEngineActionExecutor(host);

    // Exhaust the cap in turn 1.
    for (let round = 0; round < MAX_EDIT_REFLECTION_ROUNDS; round++) {
      const result = await executor.executeOneAction(
        {
          type: 'str_replace',
          file_path: 'target.ts',
          old_str: 'const value = 22222222',
          new_str: 'const value = 0',
        } as ChatToolAction,
        toolContext(root),
        callbacks(),
        { index: 0, ownerGeneration: 1 },
      );
      if (round < MAX_EDIT_REFLECTION_ROUNDS - 1) {
        assert.equal(result.stop, undefined);
      } else {
        assert.equal(result.stop, true);
      }
    }

    // Turn 2 (new owner generation): the same failing edit reflects again
    // from round 1 — no carry-over.
    const fresh = await executor.executeOneAction(
      {
        type: 'str_replace',
        file_path: 'target.ts',
          old_str: 'const value = 22222222',
          new_str: 'const value = 0',
        } as ChatToolAction,
        toolContext(root),
        callbacks(),
        { index: 0, ownerGeneration: 2 },
    );
    assert.equal(fresh.stop, undefined);
    assert.match(fresh.observation, new RegExp(`reflection round 1/${MAX_EDIT_REFLECTION_ROUNDS}`));
  });
});
