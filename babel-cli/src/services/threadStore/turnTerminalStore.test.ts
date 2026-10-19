import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';

import { createProtocolHostState } from '../../protocol/client/host.js';
import { handleProtocolRequest } from '../../protocol/client/host.js';
import {
  getThreadDir,
  loadTurnTerminalRecord,
  persistTurnTerminalRecord,
  resolveLatestTurnIdFromThreadStore,
} from './threadStore.js';

describe('durable turn terminal records', () => {
  let tmp: string;
  let prevRuns: string | undefined;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-turn-terminal-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
  });

  after(() => {
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reloads exact-turn terminal evidence after process memory is cleared', () => {
    const threadId = 'chat-durable-terminal';
    persistTurnTerminalRecord(threadId, {
      turn_id: 2,
      event_type: 'failed',
      error: 'engine exception',
      recorded_at: '2026-10-19T00:00:00.000Z',
    });
    const loaded = loadTurnTerminalRecord(threadId, 2);
    assert.ok(loaded);
    assert.equal(loaded.event_type, 'failed');
    assert.equal(loaded.error, 'engine exception');
    assert.equal(loadTurnTerminalRecord(threadId, 1), null);
  });

  it('keeps multiple turns distinct without substituting an older terminal', () => {
    const threadId = 'chat-multi-turn';
    persistTurnTerminalRecord(threadId, {
      turn_id: 1,
      event_type: 'done',
      outcome: 'VERIFIED_COMPLETE',
      recorded_at: '2026-10-19T00:00:00.000Z',
    });
    persistTurnTerminalRecord(threadId, {
      turn_id: 2,
      event_type: 'failed',
      error: 'turn two failed',
      recorded_at: '2026-10-19T00:00:01.000Z',
    });
    assert.equal(loadTurnTerminalRecord(threadId, 2)?.error, 'turn two failed');
    assert.equal(loadTurnTerminalRecord(threadId, 1)?.outcome, 'VERIFIED_COMPLETE');
    assert.equal(resolveLatestTurnIdFromThreadStore(threadId), 2);
  });

  it('ignores corrupt partial lines and returns the latest valid record for a turn', () => {
    const threadId = 'chat-partial-write';
    const dir = getThreadDir(threadId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'turn_terminals.jsonl'),
      '{"turn_id":1,"event_type":"done","outcome":"VERIFIED_COMPLETE","recorded_at":"t"}\n' +
        '{not-json\n' +
        '{"turn_id":1,"event_type":"failed","error":"replaced","recorded_at":"t2"}\n',
      'utf8',
    );
    const loaded = loadTurnTerminalRecord(threadId, 1);
    assert.ok(loaded);
    assert.equal(loaded.event_type, 'failed');
    assert.equal(loaded.error, 'replaced');
  });

  it('hydrates durable terminals into a fresh protocol host state via history.lookup', async () => {
    const threadId = 'chat-host-restart';
    persistTurnTerminalRecord(threadId, {
      turn_id: 3,
      event_type: 'cancelled',
      outcome: 'CANCELLED',
      recorded_at: '2026-10-19T00:00:00.000Z',
    });
    const state = createProtocolHostState();
    const response = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'history.lookup',
        params: { thread_id: threadId, turn_id: 3, limit: 1 },
      },
      state,
    );
    const terminal = (response as { result?: { turn_terminal?: { event_type?: string } } }).result
      ?.turn_terminal;
    assert.equal(terminal?.event_type, 'cancelled');
    assert.equal(state.turnTerminals.size, 1);
    const reread = await handleProtocolRequest(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'history.lookup',
        params: { thread_id: threadId, turn_id: 3, limit: 1 },
      },
      createProtocolHostState(),
    );
    const again = (reread as { result?: { turn_terminal?: { event_type?: string } } }).result
      ?.turn_terminal;
    assert.equal(again?.event_type, 'cancelled');
  });

  it('persists exception failure terminals for exact-turn lookup', () => {
    const threadId = 'chat-exception';
    persistTurnTerminalRecord(threadId, {
      turn_id: 1,
      event_type: 'failed',
      error: 'launch catch',
      recorded_at: '2026-10-19T00:00:00.000Z',
    });
    const raw = readFileSync(join(getThreadDir(threadId), 'turn_terminals.jsonl'), 'utf8');
    assert.match(raw, /launch catch/);
    assert.equal(loadTurnTerminalRecord(threadId, 1)?.event_type, 'failed');
    assert.equal(loadTurnTerminalRecord(threadId, 2), null);
  });
});
