import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import type { RemoteCatalogResult } from './remoteCatalog.js';
import { HttpProtocolClient } from './httpProtocolClient.js';
import { BridgeServer } from './sessionServer.js';
import type { ThreadCreateResult, ThreadResumeResult } from '../protocol/types.js';

const PORT = 14652;
const TOKEN = 'shared-host-token-not-secret';

describe('Babel Remote shared protocol host (Phase 2)', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevRuns: string | undefined;
  let desktop: HttpProtocolClient;
  let remote: HttpProtocolClient;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-shared-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      engineFactory: (descriptor) =>
        new ChatEngine({
          task: descriptor.task ?? 'shared',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        }),
    });
    await server.start(PORT);
    const base = `http://127.0.0.1:${PORT}`;
    desktop = new HttpProtocolClient({ baseUrl: base, bearerToken: TOKEN });
    remote = new HttpProtocolClient({ baseUrl: base, bearerToken: TOKEN });
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Scenario A: desktop-created thread appears in remote.catalog on the same host', async () => {
    const desktopSession = await desktop.createTransportSession(tmp);
    const created = await desktop.call<'thread.create', { project_root: string; session_id: string }, ThreadCreateResult>(
      'thread.create',
      {
        project_root: tmp,
        session_id: desktopSession,
      },
    );
    const threadId = created.thread_id;
    const catalog = await remote.call<'remote.catalog', Record<string, never>, RemoteCatalogResult>(
      'remote.catalog',
      {},
    );
    assert.ok(
      catalog.sessions.some((session: { thread_id: string }) => session.thread_id === threadId),
      `remote catalog missing desktop thread ${threadId}`,
    );
  });

  it('Scenario B: remote transport session can resume the shared thread on the same host', async () => {
    const desktopSession = await desktop.createTransportSession(tmp);
    const created = await desktop.call<
      'thread.create',
      { project_root: string; session_id: string; task: string },
      ThreadCreateResult
    >('thread.create', {
      project_root: tmp,
      session_id: desktopSession,
      task: 'shared ownership probe',
    });
    const threadId = created.thread_id;
    const remoteSession = await remote.createTransportSession(tmp);
    const resumed = await remote.call<
      'thread.resume',
      { thread_id: string; session_id: string },
      ThreadResumeResult
    >('thread.resume', {
      thread_id: threadId,
      session_id: remoteSession,
    });
    assert.equal(resumed.thread_id, threadId);
    const minted = await fetch(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_id: remoteSession, thread_id: threadId }),
    });
    assert.equal(minted.status, 200);
  });
});
