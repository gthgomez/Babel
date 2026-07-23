import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HISTORY_CELL_SCHEMA_VERSION } from '../../ui/historyCells/types.js';
import type { HistoryCellRecord } from '../../ui/historyCells/types.js';
import {
  appendTurnCells,
  forkThread,
  getThreadBranchMeta,
  getThreadMeta,
  getTurnBounds,
  listThreads,
  loadThreadCells,
  ensureThread,
  rewindThread,
  threadStoreExists,
} from './index.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-thread-store-test-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  return {
    root,
    cleanup() {
      if (prev === undefined) {
        delete process.env['BABEL_RUNS_DIR'];
      } else {
        process.env['BABEL_RUNS_DIR'] = prev;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeRecord(
  cellId: string,
  kind: HistoryCellRecord['kind'],
  turnId: number,
  threadId: string,
): HistoryCellRecord {
  return {
    schema_version: HISTORY_CELL_SCHEMA_VERSION,
    cell_id: cellId,
    thread_id: threadId,
    turn_id: turnId,
    ts: new Date().toISOString(),
    kind,
    lifecycle: 'committed',
    revision: 0,
    payload:
      kind === 'user_message'
        ? { message: `message-${cellId}` }
        : kind === 'assistant_message'
          ? { message: `answer-${cellId}` }
          : { tool: 'read', target: 'file.ts', status: 'completed' },
  };
}

test('threadStore', { concurrency: false }, async (t) => {
  await t.test('round-trips cells across turns', () => {
    const fixture = withTempRunsDir();
    try {
      const threadId = `chat-test-${fixture.root.replace(/[^a-z0-9]/gi, '')}`;
      const turn1 = [
        makeRecord('cell-u1', 'user_message', 1, threadId),
        makeRecord('cell-a1', 'assistant_message', 1, threadId),
      ];
      const turn2 = [makeRecord('cell-t2', 'tool_call', 2, threadId)];

      ensureThread(threadId, { project_root: '/tmp/project' });
      appendTurnCells(threadId, 1, turn1);
      appendTurnCells(threadId, 2, turn2);

      assert.equal(threadStoreExists(threadId), true);

      const reloaded = loadThreadCells(threadId);
      assert.equal(reloaded.length, 3);
      assert.deepEqual(
        reloaded.map((record) => record.cell_id),
        ['cell-u1', 'cell-a1', 'cell-t2'],
      );
      assert.equal(reloaded[0]?.lifecycle, 'committed');
      assert.equal(reloaded[0]?.thread_id, threadId);

      const meta = getThreadMeta(threadId);
      assert.ok(meta);
      assert.equal(meta?.cell_count, 3);
      assert.equal(meta?.turn_count, 2);
      assert.equal(meta?.project_root, '/tmp/project');
      assert.equal(meta?.resume_line_offset, 2);

      const turn1Bounds = getTurnBounds(threadId, 1);
      assert.ok(turn1Bounds);
      assert.equal(turn1Bounds?.cell_count, 2);
      assert.equal(turn1Bounds?.first_cell_id, 'cell-u1');
      assert.equal(turn1Bounds?.last_cell_id, 'cell-a1');

      const turn2Bounds = getTurnBounds(threadId, 2);
      assert.ok(turn2Bounds);
      assert.equal(turn2Bounds?.cell_count, 1);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('fork copies prefix cells into a new thread with parent pointer', async () => {
    const fixture = withTempRunsDir();
    try {
      const sourceId = `chat-src-${fixture.root.replace(/[^a-z0-9]/gi, '')}`;
      appendTurnCells(sourceId, 1, [
        makeRecord('cell-u1', 'user_message', 1, sourceId),
        makeRecord('cell-a1', 'assistant_message', 1, sourceId),
        makeRecord('cell-u2', 'user_message', 2, sourceId),
        makeRecord('cell-a2', 'assistant_message', 2, sourceId),
      ]);

      const forked = await forkThread(sourceId, { upToCellId: 'cell-a1', newThreadId: 'chat-fork-test' });
      assert.equal(forked.copied_cell_count, 2);
      assert.equal(forked.fork_point_cell_id, 'cell-a1');

      const forkCells = loadThreadCells('chat-fork-test');
      assert.deepEqual(
        forkCells.map((r) => r.cell_id),
        ['cell-u1', 'cell-a1'],
      );
      assert.equal(forkCells[0]?.thread_id, 'chat-fork-test');

      const branch = getThreadBranchMeta('chat-fork-test');
      assert.equal(branch.parent_thread_id, sourceId);
      assert.equal(branch.fork_point_cell_id, 'cell-a1');
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('rewind truncates cells after checkpoint', async () => {
    const fixture = withTempRunsDir();
    try {
      const threadId = `chat-rw-${fixture.root.replace(/[^a-z0-9]/gi, '')}`;
      appendTurnCells(threadId, 1, [
        makeRecord('cell-u1', 'user_message', 1, threadId),
        makeRecord('cell-a1', 'assistant_message', 1, threadId),
      ]);
      appendTurnCells(threadId, 2, [
        makeRecord('cell-u2', 'user_message', 2, threadId),
        makeRecord('cell-a2', 'assistant_message', 2, threadId),
      ]);

      const result = await rewindThread(threadId, 'cell-a1');
      assert.equal(result.kept_cell_count, 2);
      assert.equal(result.truncated_cell_count, 2);

      const reloaded = loadThreadCells(threadId);
      assert.deepEqual(
        reloaded.map((r) => r.cell_id),
        ['cell-u1', 'cell-a1'],
      );

      const meta = getThreadMeta(threadId);
      assert.equal(meta?.cell_count, 2);
      assert.equal(meta?.turn_count, 1);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('listThreads returns thread metadata sorted by updated_at', async () => {
    const fixture = withTempRunsDir();
    try {
      const olderId = `chat-older-${fixture.root.replace(/[^a-z0-9]/gi, '')}`;
      const newerId = `chat-newer-${fixture.root.replace(/[^a-z0-9]/gi, '')}`;

      appendTurnCells(olderId, 1, [makeRecord('old-u', 'user_message', 1, olderId)]);
      appendTurnCells(newerId, 1, [makeRecord('new-u', 'user_message', 1, newerId)]);

      const listed = (await listThreads({ limit: 10 })).filter(
        (entry) => entry.thread_id === olderId || entry.thread_id === newerId,
      );
      assert.equal(listed.length, 2);
      assert.ok(listed[0]!.updated_at >= listed[1]!.updated_at);
    } finally {
      fixture.cleanup();
    }
  });
});