// License: Apache-2.0
// Platform control only: this does not count as installed Desktop acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, open, rm, writeFile} from 'node:fs/promises';
import {createConnection, createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const supervisor = fileURLToPath(new URL('./supervisor-lifetime-control.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const validPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const categories = new Set(['console', 'invalid-handle', 'runtime-initialization', 'access-denied', 'powershell-error', 'error', 'other']);
const signals = new Set(['SIGABRT', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'other']);
const spawnCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM', 'ENOSPC', 'EINVAL', 'other']);

async function readBounded(path, limit) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const {bytesRead} = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > limit) throw new Error('control receipt exceeds limit');
    return buffer.subarray(0, total).toString('utf8');
  } finally { await handle.close(); }
}

function parseOwner(text, controllerPid) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('invalid control owner receipt'); }
  if (!value || typeof value !== 'object' || value.controllerPid !== controllerPid ||
      !validPid(value.controllerPid) || !validPid(value.supervisorPid) || value.controllerPid === value.supervisorPid) {
    throw new Error('invalid control owner receipt');
  }
  return {controllerPid: value.controllerPid, supervisorPid: value.supervisorPid};
}

function parseReceiptLines(text, owner) {
  const invalid = () => { throw new Error('invalid control receipt'); };
  const lines = text.split('\n');
  lines.pop(); // Only a complete line can be a receipt.
  return lines.map(line => {
    let value;
    try { value = JSON.parse(line); } catch { return invalid(); }
    if (!value || typeof value !== 'object' || value.supervisorPid !== owner.supervisorPid) return invalid();
    if (value.event === 'ready') {
      if (!validPid(value.providerPid) || value.providerPid === owner.supervisorPid || value.providerPid === owner.controllerPid ||
          !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return invalid();
      return {event: 'ready', supervisorPid: value.supervisorPid, providerPid: value.providerPid, port: value.port};
    }
    const stderr = value.stderr;
    if (value.event !== 'exit' || !['provider-start', 'after-ready'].includes(value.phase) ||
        !(value.providerPid === null || validPid(value.providerPid)) ||
        !(value.exitCode === null || (Number.isSafeInteger(value.exitCode) && value.exitCode >= -2147483648 && value.exitCode <= 0xffffffff)) ||
        !(value.signal === null || signals.has(value.signal)) || !(value.spawnCode === null || spawnCodes.has(value.spawnCode)) ||
        typeof value.timedOut !== 'boolean' || !['requested', 'deadline', 'unknown'].includes(value.stopReason) ||
        !stderr || !Number.isInteger(stderr.capturedBytes) || stderr.capturedBytes < 0 || stderr.capturedBytes > 4096 ||
        typeof stderr.truncated !== 'boolean' || !Array.isArray(stderr.categories) || stderr.categories.length > categories.size ||
        !stderr.categories.every(item => categories.has(item)) || ![null, '0x80070006', 'other'].includes(stderr.hresult) ||
        typeof stderr.streamError !== 'boolean') return invalid();
    return {event: 'exit', phase: value.phase, supervisorPid: value.supervisorPid, providerPid: value.providerPid,
      exitCode: value.exitCode, signal: value.signal, spawnCode: value.spawnCode, timedOut: value.timedOut,
      stopReason: value.stopReason, stderr: {capturedBytes: stderr.capturedBytes, truncated: stderr.truncated,
        categories: stderr.categories, hresult: stderr.hresult, streamError: stderr.streamError}};
  });
}

function fixtureEnv(root) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (key && process.env[key]) env[name] = process.env[key];
  }
  return {...env, HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
    XDG_CACHE_HOME: root, XDG_DATA_HOME: root, BABEL_CONTROL_ROOT: root};
}

async function waitForEvent(path, owner, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = parseReceiptLines(await readBounded(path, 8192), owner);
      for (const event of events) {
        if (predicate(event)) return event;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error('supervisor control receipt timed out');
}

async function checkHealth(port) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({host: '127.0.0.1', port});
    socket.setTimeout(5_000);
    socket.once('data', data => { socket.destroy(); resolve(data[0]); });
    socket.once('end', () => reject(new Error('control health closed before data')));
    socket.once('close', () => reject(new Error('control health closed before data')));
    socket.once('error', () => reject(new Error('control health connection failed')));
    socket.once('timeout', () => { socket.destroy(); reject(new Error('control health timed out')); });
  });
}

async function checkExclusive(port) {
  const server = createServer();
  const result = await new Promise(resolve => {
    server.once('error', error => resolve(error.code));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve('bound')));
  });
  assert.ok(result === 'EADDRINUSE' || result === 'EACCES', 'owned control address must stay exclusive');
}

test('control receipts reject malformed complete lines and ignore trailing partial lines', () => {
  const owner = {controllerPid: 100, supervisorPid: 101};
  assert.throws(() => parseOwner('{bad owner}', 100), error => error.message === 'invalid control owner receipt');
  assert.throws(() => parseOwner(JSON.stringify({controllerPid: 99, supervisorPid: 101}), 100),
    error => error.message === 'invalid control owner receipt');
  assert.throws(() => parseReceiptLines('{bad receipt}\n', owner), error => error.message === 'invalid control receipt');
  const valid = JSON.stringify({event: 'ready', supervisorPid: 101, providerPid: 102, port: 1234});
  assert.equal(parseReceiptLines(valid + '\n{partial', owner).length, 1);
  assert.throws(() => parseReceiptLines(JSON.stringify({event: 'exit', supervisorPid: 'invalid'}) + '\n', owner),
    error => error.message === 'invalid control receipt');
});

test('control health rejects an empty connection promptly', async () => {
  const server = createServer(socket => socket.end());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await assert.rejects(Promise.race([checkHealth(server.address().port), delay(500).then(() => {
      throw new Error('health promise did not settle');
    })]), /control health closed before data/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('detached Node supervisor keeps its ordinary PowerShell listener healthy after controller exit', {
  timeout: 45_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'babel-supervisor-control-'));
  const eventsPath = join(root, 'events.jsonl');
  const ownerPath = join(root, 'owner.json');
  const stopPath = join(root, 'stop');
  const program = `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const child = spawn(process.execPath, [${JSON.stringify(supervisor)}], {detached: true, stdio: 'ignore', env: process.env});
    writeFileSync(process.env.BABEL_CONTROL_ROOT + '/owner.json', JSON.stringify({controllerPid: process.pid, supervisorPid: child.pid}));
    child.unref();`;
  let owner, readyEvent, stopped = false, testError;
  try {
    const controller = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
      env: fixtureEnv(root), stdio: 'ignore', windowsHide: true, timeout: 5_000,
    });
    assert.equal(controller.status, 0, 'control controller must exit normally');
    owner = parseOwner(await readBounded(ownerPath, 512), controller.pid);
    t.diagnostic('control owner: ' + JSON.stringify(owner));
    const event = await waitForEvent(eventsPath, owner, item => item.event === 'ready' || item.event === 'exit', 12_000);
    if (event.event !== 'ready') {
      throw new Error('supervisor control failed: ' + JSON.stringify(event));
    }
    readyEvent = event;
    assert.equal(event.supervisorPid, owner.supervisorPid);
    assert.ok(Number.isInteger(event.providerPid) && event.providerPid > 0);
    assert.notEqual(event.supervisorPid, event.providerPid);
    assert.equal(await checkHealth(event.port), 42);
    await checkExclusive(event.port);
    t.diagnostic('control health: ' + JSON.stringify({...event, health: 'ok', exclusive: true}));
    await writeFile(stopPath, 'stop');
    const exit = await waitForEvent(eventsPath, owner, item => item.event === 'exit', 15_000);
    t.diagnostic('control exit: ' + JSON.stringify(exit));
    assert.equal(exit.providerPid, event.providerPid);
    assert.equal(exit.phase, 'after-ready');
    assert.equal(exit.signal, null);
    assert.equal(exit.timedOut, false);
    assert.equal(exit.stopReason, 'requested');
    assert.equal(exit.stderr.streamError, false);
    assert.equal(exit.exitCode, 0);
    stopped = true;
  } catch (error) { testError = error; }
  finally {
    if (!stopped) {
      try {
        await writeFile(stopPath, 'stop');
        if (owner) {
          const exit = await waitForEvent(eventsPath, owner, item => item.event === 'exit', 20_000);
          t.diagnostic('control cleanup: ' + JSON.stringify(exit));
          if (readyEvent && (exit.phase !== 'after-ready' || exit.providerPid !== readyEvent.providerPid)) {
            throw new Error('control listener ownership unresolved');
          }
        } else {
          throw new Error('control owner is unknown');
        }
        stopped = true;
      } catch { /* Preserve the isolated control directory when exit is unknown. */ }
    }
    if (stopped) await rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
  if (testError) throw testError;
});
