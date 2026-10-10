import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import { BridgeServer } from './sessionServer.js';

const PORT = 14651;
const TOKEN = 'pwa-bind-token-not-secret';

describe('Babel Remote PWA session binding', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevRuns: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-pwa-bind-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      engineFactory: (descriptor) =>
        new ChatEngine({
          task: descriptor.task ?? 'bind',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        }),
    });
    await server.start(PORT);
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects ticket mint for threads created without session_id (PWA defect regression)', async () => {
    const session = await fetch(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (await session.json() as { sessionId: string }).sessionId;
    const created = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: tmp },
      }),
    });
    const threadId = ((await created.json()) as { result: { thread_id: string } }).result.thread_id;
    const minted = await fetch(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    assert.equal(minted.status, 403);
  });
});
