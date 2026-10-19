import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const load = async name => import(`../native/${name}.mjs`);

test('shared-session serve argv includes --shared-session', async () => {
  const { buildRemoteServeArgs } = await load('remoteHost');
  const entry = join(tmpdir(), 'babel-cli', 'dist', 'index.js');
  const root = join(tmpdir(), 'project');
  const args = buildRemoteServeArgs(entry, root, { port: 4545, sharedSession: true });
  assert.deepEqual(args, [entry, 'remote', 'serve', '--port', '4545', '--project', root, '--shared-session']);
});

test('loopback protocol headers carry the desktop controller id', async () => {
  const {
    mintDesktopControllerClientId,
    loopbackProtocolHeaders,
    DESKTOP_CLIENT_ID_HEADER,
    DESKTOP_PROOF_HEADER,
  } = await load('sharedSessionBridge');
  const id = mintDesktopControllerClientId();
  assert.match(id, /^desktop:/);
  const headers = loopbackProtocolHeaders(id, 'synthetic-proof-key-value');
  assert.equal(headers[DESKTOP_CLIENT_ID_HEADER], id);
  assert.ok(headers[DESKTOP_PROOF_HEADER]);
});
