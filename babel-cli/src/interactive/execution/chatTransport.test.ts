import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../../agent/chatEngine.js';
import { HISTORY_CELL_SCHEMA_VERSION } from '../../ui/historyCells/types.js';
import { appendTurnCells } from '../../services/threadStore/index.js';
import {
  beginProtocolTurn,
  finalizeProtocolTurn,
  mapChatEventToTurnStreamEvent,
  setProtocolNotificationSink,
  type ProtocolNotification,
} from './chatTransport.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-transport-'));
  const prevRuns = process.env['BABEL_RUNS_DIR'];
  const prevProtocol = process.env['BABEL_PROTOCOL_CLIENT'];
  const prevInProcess = process.env['BABEL_INPROCESS'];
  process.env['BABEL_RUNS_DIR'] = root;
  process.env['BABEL_INPROCESS'] = '1';
  process.env['BABEL_PROTOCOL_CLIENT'] = '1';
  return {
    root,
    cleanup() {
      if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prevRuns;
      if (prevProtocol === undefined) delete process.env['BABEL_PROTOCOL_CLIENT'];
      else process.env['BABEL_PROTOCOL_CLIENT'] = prevProtocol;
      if (prevInProcess === undefined) delete process.env['BABEL_INPROCESS'];
      else process.env['BABEL_INPROCESS'] = prevInProcess;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('mapChatEventToTurnStreamEvent normalizes answer chunks', () => {
  const mapped = mapChatEventToTurnStreamEvent({ type: 'answer_chunk', text: 'hello' });
  assert.deepEqual(mapped, { type: 'answer_chunk', text: 'hello' });
});

test('beginProtocolTurn issues turn.submit for engine thread id', async () => {
  const fixture = withTempRunsDir();
  try {
    const engine = new ChatEngine({ task: 'protocol turn', projectRoot: fixture.root });
    const threadId = 'chat-transport-turn';
    engine.assignRunId(threadId);

    const session = await beginProtocolTurn(engine, 'hello protocol');
    assert.ok(session);
    assert.equal(session!.threadId, threadId);
    assert.ok(session!.turnId >= 1);
  } finally {
    fixture.cleanup();
  }
});

test('protocol turn emits turn.event and cell.committed notifications', async () => {
  const fixture = withTempRunsDir();
  const notifications: ProtocolNotification[] = [];
  setProtocolNotificationSink((notification) => notifications.push(notification));
  try {
    const engine = new ChatEngine({ task: 'protocol notify', projectRoot: fixture.root });
    const threadId = 'chat-transport-notify';
    engine.assignRunId(threadId);

    const session = await beginProtocolTurn(engine, 'persist me');
    assert.ok(session);

    session!.emitChatEvent({ type: 'answer_chunk', text: 'partial' });
    appendTurnCells(threadId, session!.turnId, [
      {
        schema_version: HISTORY_CELL_SCHEMA_VERSION,
        cell_id: 'cell-u1',
        thread_id: threadId,
        turn_id: session!.turnId,
        ts: new Date().toISOString(),
        kind: 'user_message',
        lifecycle: 'committed',
        revision: 0,
        payload: { message: 'persist me' },
      },
    ]);
    finalizeProtocolTurn(session);

    assert.equal(
      notifications.filter((n) => n.method === 'turn.event').length,
      1,
    );
    const committed = notifications.find((n) => n.method === 'cell.committed');
    assert.ok(committed);
    assert.equal(committed!.params.cells.length, 1);
  } finally {
    setProtocolNotificationSink(null);
    fixture.cleanup();
  }
});