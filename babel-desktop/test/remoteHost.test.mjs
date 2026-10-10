// License: Apache-2.0 - see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteBridgeChild, buildRemoteServeArgs} from '../native/remoteHost.mjs';

test('RemoteBridgeChild exposes stopped lifecycle state before start', () => {
  const entry = join(tmpdir(), 'babel-cli', 'dist', 'index.js');
  const root = join(tmpdir(), 'project');
  const bridge = new RemoteBridgeChild({executable: process.execPath, entry, projectRoot: root});
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.running, false);
  assert.throws(() => buildRemoteServeArgs(entry, root, {port: 80}), /Invalid remote listen port/);
});
