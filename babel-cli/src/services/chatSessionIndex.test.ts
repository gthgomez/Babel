import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { transcriptPath } from '../cli/runsLayout.js';
import { HISTORY_CELL_SCHEMA_VERSION } from '../ui/historyCells/types.js';
import { appendTurnCells } from './threadStore/index.js';
import { listResumableSessions } from './chatSessionIndex.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-index-'));
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

test('chatSessionIndex', { concurrency: false }, async (t) => {
  await t.test('listResumableSessions includes thread-store-only sessions', async () => {
    const fixture = withTempRunsDir();
    try {
      const threadId = 'chat-thread-only';
      appendTurnCells(threadId, 1, [
        {
          schema_version: HISTORY_CELL_SCHEMA_VERSION,
          cell_id: 'cell-u1',
          thread_id: threadId,
          turn_id: 1,
          ts: new Date().toISOString(),
          kind: 'user_message',
          lifecycle: 'committed',
          revision: 0,
          payload: { message: 'hello from thread store' },
        },
      ]);

      const sessions = await listResumableSessions({ limit: 10 });
      const match = sessions.find((s) => s.id === threadId);
      assert.ok(match);
      assert.equal(match?.hasThreadStore, true);
      assert.equal(match?.transcriptPath, transcriptPath(threadId));
      assert.match(match?.preview ?? '', /hello from thread store/);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('listResumableSessions merges transcript and thread-store metadata', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-merged';
      const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'transcript.jsonl'),
        `${JSON.stringify({ role: 'user', content: 'legacy transcript' })}\n`,
        'utf8',
      );

      appendTurnCells(sessionId, 1, [
        {
          schema_version: HISTORY_CELL_SCHEMA_VERSION,
          cell_id: 'cell-u1',
          thread_id: sessionId,
          turn_id: 1,
          ts: new Date().toISOString(),
          kind: 'user_message',
          lifecycle: 'committed',
          revision: 0,
          payload: { message: 'thread store preview wins' },
        },
      ]);

      const sessions = await listResumableSessions({ limit: 10 });
      const match = sessions.find((s) => s.id === sessionId);
      assert.ok(match);
      assert.equal(match?.hasThreadStore, true);
      assert.match(match?.preview ?? '', /thread store preview wins/);
    } finally {
      fixture.cleanup();
    }
  });
});