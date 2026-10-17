// License: Apache-2.0 - see LICENSE
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RemoteBridgeChild, buildRemoteServeArgs} from '../native/remoteHost.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = tmpdir();
const NOT_OURS = /did not report readiness for this launch/;

test('RemoteBridgeChild exposes stopped lifecycle state before start', () => {
  const entry = join(tmpdir(), 'babel-cli', 'dist', 'index.js');
  const root = join(tmpdir(), 'project');
  const bridge = new RemoteBridgeChild({executable: process.execPath, entry, projectRoot: root});
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.running, false);
  assert.throws(() => buildRemoteServeArgs(entry, root, {port: 80}), /Invalid remote listen port/);
});

test('the silent fixture exits when the host terminates it', async () => {
  // A fixture that ignored the host's termination would keep the whole test run
  // alive on POSIX, where the host sends SIGTERM rather than force-killing it.
  const child = spawn(process.execPath, [join(here, 'fixture-remote-silent.mjs')], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    child.kill();
    const outcome = await Promise.race([
      exited,
      new Promise(resolve => setTimeout(() => resolve('still running'), 5000)),
    ]);
    assert.notEqual(outcome, 'still running', 'the fixture must exit on the host signal');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

// ── Fixtures ──────────────────────────────────────────────────────────────

function listenOn(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
  });
}

async function reservePort() {
  const probe = createServer();
  const port = await listenOn(probe);
  await closeServer(probe);
  return port;
}

/** A loopback listener whose /health body the test controls. */
function responder(body, {status = 200, contentType = 'application/json'} = {}) {
  return createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(status, {'content-type': contentType});
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

/** Scripted child stand-in: the test owns its stdout lines and close event. */
function scriptedChild() {
  const child = new EventEmitter();
  // pid 0 keeps terminateChildTree off the Windows taskkill branch, so a test
  // can never signal a real (unrelated) process tree.
  child.pid = 0;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.announce = (port, host = '127.0.0.1') =>
    child.stdout.emit('data', Buffer.from(`Babel Remote listening on http://${host}:${port}\n`));
  return child;
}

async function waitFor(predicate, {timeoutMs = 5000, label = 'condition'} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ── Readiness must identify the child this host started ───────────────────

test('an unrelated listener answering 200 on the requested port is never adopted', async () => {
  const foreign = responder('not json at all', {contentType: 'text/plain'});
  const port = await listenOn(foreign);
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry: join(here, 'fixture-remote-silent.mjs'),
    projectRoot,
    inheritEnv: false,
  });
  try {
    await assert.rejects(bridge.start({port, readyTimeoutMs: 1200}), NOT_OURS);
    assert.equal(bridge.state, 'failed');
    assert.equal(bridge.running, false);
    assert.equal(bridge.port, null);
    // The unrelated listener still serves: it was never adopted or killed.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    bridge.stop();
    await closeServer(foreign);
  }
});

test('another bridge belonging to a different launch is never adopted', async () => {
  const foreign = responder(JSON.stringify({ok: true, protocol: 'adr-010', instance: 'someone-else'}));
  const port = await listenOn(foreign);
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry: join(here, 'fixture-remote-silent.mjs'),
    projectRoot,
    inheritEnv: false,
  });
  try {
    await assert.rejects(bridge.start({port, readyTimeoutMs: 1200}), NOT_OURS);
    assert.equal(bridge.state, 'failed');
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    bridge.stop();
    await closeServer(foreign);
  }
});

test('a bridge-shaped peer is not adopted when this launch announced nothing', async () => {
  // No instance label (an older peer) and this launch's child never announced a
  // listener of its own, so there is no evidence the responder is ours.
  const foreign = responder(JSON.stringify({ok: true, protocol: 'adr-010'}));
  const port = await listenOn(foreign);
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry: join(here, 'fixture-remote-silent.mjs'),
    projectRoot,
    inheritEnv: false,
  });
  try {
    await assert.rejects(bridge.start({port, readyTimeoutMs: 1200}), NOT_OURS);
    assert.equal(bridge.state, 'failed');
  } finally {
    bridge.stop();
    await closeServer(foreign);
  }
});

test('a fragmented, mixed-case aliased announcement still reaches ready', async () => {
  // Guards the pre-instance-label path: the announcement may be split across
  // pipe writes and may name a loopback alias in any case while the socket
  // binds 127.0.0.1.
  const peer = responder(JSON.stringify({ok: true, protocol: 'adr-010'}));
  const port = await listenOn(peer);
  const child = scriptedChild();
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry: join(here, 'fixture-remote-announce.mjs'),
    projectRoot,
    inheritEnv: false,
    spawnChild: () => child,
  });
  try {
    const started = bridge.start({port, readyTimeoutMs: 5000});
    const line = `Babel Remote listening on http://LocalHost:${port}\n`;
    child.stdout.emit('data', Buffer.from(line.slice(0, 21)));
    child.stdout.emit('data', Buffer.from(line.slice(21)));
    await started;
    assert.equal(bridge.state, 'ready');
    assert.equal(bridge.port, port);
  } finally {
    bridge.stop();
    child.emit('close', 0, 'SIGTERM');
    await closeServer(peer);
  }
});

test('a real announcing child reaches ready and stop settles it', async () => {
  const port = await reservePort();
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry: join(here, 'fixture-remote-announce.mjs'),
    projectRoot,
    inheritEnv: false,
  });
  try {
    const ready = await bridge.start({port, readyTimeoutMs: 10_000});
    assert.equal(bridge.state, 'ready');
    assert.equal(ready.port, port);
    assert.equal(bridge.port, port);
  } finally {
    bridge.stop();
  }
  await waitFor(() => bridge.state === 'stopped', {label: 'bridge stop'});
  assert.equal(bridge.port, null);
  const rebound = createServer();
  const reboundPort = await listenOn(rebound, port);
  assert.equal(reboundPort, port, 'the owned child must release its port');
  await closeServer(rebound);
});

// ── Late-close ownership ──────────────────────────────────────────────────

test('a late close from a replaced child cannot reset its successor', async () => {
  const first = scriptedChild();
  const second = scriptedChild();
  const children = [first, second];
  const firstResponder = responder(JSON.stringify({ok: true, protocol: 'adr-010'}));
  const firstPort = await listenOn(firstResponder);
  const secondResponder = responder(JSON.stringify({ok: true, protocol: 'adr-010'}));
  const secondPort = await listenOn(secondResponder);
  const bridge = new RemoteBridgeChild({
    executable: process.execPath,
    entry: join(here, 'fixture-remote-announce.mjs'),
    projectRoot,
    inheritEnv: false,
    spawnChild: () => children.shift(),
  });
  try {
    const started = bridge.start({port: firstPort, readyTimeoutMs: 5000});
    first.announce(firstPort);
    await started;
    assert.equal(bridge.state, 'ready');

    // Stop the first child, but hold its close event back.
    bridge.stop();
    assert.equal(bridge.state, 'stopping');
    assert.equal(bridge.running, false);

    const successor = bridge.start({port: secondPort, readyTimeoutMs: 5000});
    second.announce(secondPort);
    await successor;
    assert.equal(bridge.state, 'ready');
    assert.equal(bridge.port, secondPort);

    // The replaced child finally closes: the successor keeps ownership.
    first.emit('close', 0, 'SIGTERM');
    assert.equal(bridge.state, 'ready', 'a late close must not stop the successor');
    assert.equal(bridge.running, true);
    assert.equal(bridge.port, secondPort);

    // The successor is still the owned handle, so stop reaches it.
    bridge.stop();
    assert.equal(second.killed, true, 'stop must reach the current child');
    second.emit('close', 0, 'SIGTERM');
    assert.equal(bridge.state, 'stopped');
  } finally {
    await closeServer(firstResponder);
    await closeServer(secondResponder);
  }
});
