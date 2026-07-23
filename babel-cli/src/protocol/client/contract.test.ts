import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../../agent/chatEngine.js';
import { HISTORY_CELL_SCHEMA_VERSION } from '../../ui/historyCells/types.js';
import { appendTurnCells } from '../../services/threadStore/index.js';
import { isInProcessMode, isProtocolClientEnabled } from './mode.js';
import {
  BabelProtocolClient,
  createProtocolHostState,
  formatCellCommittedNotification,
  formatTurnEventNotification,
  handleProtocolRequest,
  roundtripRequestLine,
} from './index.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-protocol-contract-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  return {
    root,
    cleanup() {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('isInProcessMode defaults true', () => {
  const prev = process.env['BABEL_INPROCESS'];
  delete process.env['BABEL_INPROCESS'];
  assert.equal(isInProcessMode(), true);
  process.env['BABEL_INPROCESS'] = '0';
  assert.equal(isInProcessMode(), false);
  if (prev === undefined) delete process.env['BABEL_INPROCESS'];
  else process.env['BABEL_INPROCESS'] = prev;
});

test('isProtocolClientEnabled defaults false in in-process mode', () => {
  const prevIn = process.env['BABEL_INPROCESS'];
  const prevClient = process.env['BABEL_PROTOCOL_CLIENT'];
  delete process.env['BABEL_INPROCESS'];
  delete process.env['BABEL_PROTOCOL_CLIENT'];
  assert.equal(isProtocolClientEnabled(), false);
  process.env['BABEL_PROTOCOL_CLIENT'] = '1';
  assert.equal(isProtocolClientEnabled(), true);
  if (prevIn === undefined) delete process.env['BABEL_INPROCESS'];
  else process.env['BABEL_INPROCESS'] = prevIn;
  if (prevClient === undefined) delete process.env['BABEL_PROTOCOL_CLIENT'];
  else process.env['BABEL_PROTOCOL_CLIENT'] = prevClient;
});

test('thread.create roundtrips through JSON-RPC host', async () => {
  const fixture = withTempRunsDir();
  try {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'thread.create',
      params: { project_root: fixture.root, task: 'contract test' },
    });
    const response = await roundtripRequestLine(line);
    assert.ok(response);
    assert.ok('result' in response!);
    const result = (response as { result: { thread_id: string } }).result;
    assert.match(result.thread_id, /^chat-[a-f0-9]+$/);
  } finally {
    fixture.cleanup();
  }
});

test('turn.submit and history.lookup roundtrip', async () => {
  const fixture = withTempRunsDir();
  try {
    const client = new BabelProtocolClient();
    const created = await client.threadCreate({ project_root: fixture.root, task: 'hello' });
    const submitted = await client.turnSubmit({
      thread_id: created.thread_id,
      message: 'hello',
    });
    assert.equal(submitted.thread_id, created.thread_id);
    assert.ok(submitted.turn_id >= 1);

    appendTurnCells(created.thread_id, submitted.turn_id, [
      {
        schema_version: HISTORY_CELL_SCHEMA_VERSION,
        cell_id: 'cell-u1',
        thread_id: created.thread_id,
        turn_id: submitted.turn_id,
        ts: new Date().toISOString(),
        kind: 'user_message',
        lifecycle: 'committed',
        revision: 0,
        payload: { message: 'hello' },
      },
    ]);

    const history = await client.historyLookup({ thread_id: created.thread_id });
    assert.equal(history.cells.length, 1);
    assert.equal(history.cells[0]?.cell_id, 'cell-u1');
  } finally {
    fixture.cleanup();
  }
});

test('notification formatters produce valid JSON-RPC notifications', () => {
  const turnEvent = formatTurnEventNotification({
    thread_id: 'chat-abc',
    turn_id: 1,
    seq: 0,
    event: { type: 'answer_chunk', text: 'hi' },
  });
  const parsed = JSON.parse(turnEvent) as { method: string; params: unknown };
  assert.equal(parsed.method, 'turn.event');

  const committed = formatCellCommittedNotification({
    thread_id: 'chat-abc',
    turn_id: 1,
    cells: [],
  });
  const committedParsed = JSON.parse(committed) as { method: string };
  assert.equal(committedParsed.method, 'cell.committed');
});

test('turn.cancel returns cancelled=true for active thread', async () => {
  const state = createProtocolHostState();
  const createResp = await handleProtocolRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'thread.create',
      params: { project_root: process.cwd() },
    },
    state,
  );
  assert.ok('result' in createResp);
  const threadId = (createResp as { result: { thread_id: string } }).result.thread_id;

  await handleProtocolRequest(
    { jsonrpc: '2.0', id: 3, method: 'turn.submit', params: { thread_id: threadId, message: 'x' } },
    state,
  );

  const engine = new ChatEngine({ task: 'cancel test', projectRoot: process.cwd() });
  engine.assignRunId(threadId);
  state.engines.set(threadId, engine);

  const cancelResp = await handleProtocolRequest(
    { jsonrpc: '2.0', id: 4, method: 'turn.cancel', params: { thread_id: threadId } },
    state,
  );
  assert.ok('result' in cancelResp);
  const cancel = (cancelResp as { result: { cancelled: boolean } }).result;
  assert.equal(cancel.cancelled, true);
});