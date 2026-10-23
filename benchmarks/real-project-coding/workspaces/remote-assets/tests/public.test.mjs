// New benchmark probes; no provider, network, browser, or production UI is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

// The external evaluator uses its canonical test file against the supplied copy.
const workspace = process.env.BRPCB_REMOTE_ASSETS_WORKSPACE
  ? resolve(process.env.BRPCB_REMOTE_ASSETS_WORKSPACE)
  : fileURLToPath(new URL('../', import.meta.url));
const bridge = join(workspace, 'babel-cli', 'src', 'bridge');
const assets = await import(pathToFileURL(join(bridge, 'remoteUiAssets.ts')).href);
const policy = await import(pathToFileURL(join(bridge, 'remoteUiCachePolicy.ts')).href);
const swFile = join(bridge, 'remote-ui', 'sw.js');
const swSource = fs.readFileSync(swFile, 'utf8');
const expectedCsp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";

function responseRecorder() {
  const calls = [];
  return {
    calls,
    writeHead(status, headers) { calls.push({ kind: 'head', status, headers }); },
    end(body) { calls.push({ kind: 'body', body }); },
  };
}

async function isolatedModule(t, { adjacent = false, fallback = false } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'brpcb-a-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moduleDir = join(root, 'dist', 'bridge');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  for (const filename of ['remoteUiAssets.ts', 'remoteUiCachePolicy.ts']) {
    fs.copyFileSync(join(bridge, filename), join(moduleDir, filename));
  }
  const adjacentDir = join(moduleDir, 'remote-ui');
  const fallbackDir = join(root, 'src', 'bridge', 'remote-ui');
  for (const [enabled, dir, text] of [
    [adjacent, adjacentDir, 'synthetic adjacent index'],
    [fallback, fallbackDir, 'synthetic fallback index'],
  ]) {
    if (enabled) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'index.html'), text);
    }
  }
  return {
    adjacentDir,
    fallbackDir,
    module: await import(pathToFileURL(join(moduleDir, 'remoteUiAssets.ts')).href),
  };
}

function workerHarness({ networkValue = { status: 200 }, networkError, cachedValue = { fixture: 'cached shell' }, cacheMiss = false } = {}) {
  const handlers = new Map();
  const observed = { fetch: [], match: [], open: [], addAll: [], skipWaiting: 0, claim: 0 };
  const context = {
    URL,
    self: {
      addEventListener(name, listener) { handlers.set(name, listener); },
      skipWaiting() { observed.skipWaiting += 1; },
      clients: { claim() { observed.claim += 1; return Promise.resolve(); } },
    },
    caches: {
      open(name) {
        observed.open.push(name);
        return Promise.resolve({ addAll(paths) { observed.addAll.push(Array.from(paths)); return Promise.resolve(); } });
      },
      match(request) { observed.match.push(request); return Promise.resolve(cacheMiss ? undefined : cachedValue); },
    },
    fetch(request) {
      observed.fetch.push(request);
      return networkError ? Promise.reject(networkError) : Promise.resolve(networkValue);
    },
  };
  new vm.Script(swSource, { filename: swFile }).runInNewContext(context);
  return {
    handlers,
    observed,
    dispatch(pathname, { method = 'GET', authorization = null } = {}) {
      const request = {
        url: new URL(pathname, 'https://fixture.invalid').href,
        method,
        headers: { get(name) { return name.toLowerCase() === 'authorization' ? authorization : null; } },
      };
      const event = { request, responded: false, response: undefined, respondWith(promise) { this.responded = true; this.response = promise; } };
      handlers.get('fetch')(event);
      return event;
    },
  };
}

test('server /ui/ rewrites to index.html and sends the exact bytes with HTML/no-store/CSP', () => {
  const res = responseRecorder();
  const resolved = assets.remoteUiFileForPath('/ui/');
  assert.equal(resolved.file, join(bridge, 'remote-ui', 'index.html'));
  assert.equal(assets.writeRemoteUiResponse('/ui/', res), true);
  assert.equal(res.calls.length, 2);
  assert.deepEqual(res.calls[0], { kind: 'head', status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': expectedCsp,
  } });
  assert.equal(Buffer.isBuffer(res.calls[1].body), true);
  assert.deepEqual(res.calls[1].body, fs.readFileSync(resolved.file));
  assert.match(res.calls[1].body.toString('utf8'), /synthetic index payload/);
});

test('server /ui/sw.js serves pinned JavaScript with Service-Worker-Allowed /ui', () => {
  const res = responseRecorder();
  assert.equal(assets.writeRemoteUiResponse('/ui/sw.js', res), true);
  assert.deepEqual(res.calls[0], { kind: 'head', status: 200, headers: {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': expectedCsp,
    'Service-Worker-Allowed': '/ui',
  } });
  assert.deepEqual(res.calls[1].body, fs.readFileSync(swFile));
});

test('unknown and traversal-like paths are rejected without a response', () => {
  for (const path of ['/unrelated', '/ui/unknown.js', '/ui/../secret', '/ui/./app.js', '/ui//app.js']) {
    const res = responseRecorder();
    assert.equal(assets.remoteUiFileForPath(path), null, path);
    assert.equal(assets.writeRemoteUiResponse(path, res), false, path);
    assert.deepEqual(res.calls, [], path);
  }
});

test('unknown path returns false before directory discovery even if no directory exists', async (t) => {
  const fixture = await isolatedModule(t);
  const res = responseRecorder();
  assert.equal(fixture.module.writeRemoteUiResponse('/unknown', res), false);
  assert.deepEqual(res.calls, []);
});

test('allowed path throws when neither candidate directory has index.html', async (t) => {
  const fixture = await isolatedModule(t);
  const res = responseRecorder();
  assert.throws(() => fixture.module.writeRemoteUiResponse('/ui/', res), /Remote UI assets not found/);
  assert.deepEqual(res.calls, []);
});

test('adjacent directory takes precedence when both directories have index.html', async (t) => {
  const fixture = await isolatedModule(t, { adjacent: true, fallback: true });
  assert.equal(fixture.module.resolveRemoteUiDir(), fixture.adjacentDir);
  const res = responseRecorder();
  assert.equal(fixture.module.writeRemoteUiResponse('/ui/', res), true);
  assert.equal(res.calls[1].body.toString('utf8'), 'synthetic adjacent index');
});

test('directory resolution falls back to src/bridge/remote-ui with its index.html sentinel', async (t) => {
  const fixture = await isolatedModule(t, { fallback: true });
  fs.mkdirSync(fixture.adjacentDir, { recursive: true });
  fs.writeFileSync(join(fixture.adjacentDir, 'app.js'), 'synthetic file without index sentinel');
  assert.equal(fixture.module.resolveRemoteUiDir(), fixture.fallbackDir);
  const res = responseRecorder();
  assert.equal(fixture.module.writeRemoteUiResponse('/ui/', res), true);
  assert.equal(res.calls[1].body.toString('utf8'), 'synthetic fallback index');
});

test('missing allowed asset returns false after directory discovery without writing', () => {
  const res = responseRecorder();
  assert.equal(policy.isRemoteUiShellPath('/ui/styles.css'), true);
  assert.equal(assets.remoteUiFileForPath('/ui/styles.css'), null);
  assert.equal(assets.writeRemoteUiResponse('/ui/styles.css', res), false);
  assert.deepEqual(res.calls, []);
});

test('a controlled filesystem read failure propagates before writeHead/end', () => {
  // Inject only at the real fs boundary, after source loading and path resolution.
  const file = assets.remoteUiFileForPath('/ui/app.js').file;
  const failure = new Error('BRPCB-A synthetic filesystem read failure');
  const originalRead = fs.readFileSync;
  const res = responseRecorder();
  fs.readFileSync = function (path, ...args) {
    if (path === file) throw failure;
    return Reflect.apply(originalRead, this, [path, ...args]);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => assets.writeRemoteUiResponse('/ui/app.js', res), (error) => error === failure);
    assert.deepEqual(res.calls, []);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
});

test('policy permits shell GETs and rejects authorization, other methods, and runtime paths', () => {
  assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: '/ui/app.js' }), true);
  assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: '/ui/app.js', method: 'get' }), true);
  assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: '/ui/app.js', method: 'POST' }), false);
  assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: '/ui/app.js', hasAuthorization: true }), false);
  for (const prefix of ['/rpc', '/ws', '/sessions', '/health']) {
    assert.equal(policy.isRemoteUiNetworkOnlyPath(prefix), true);
    assert.equal(policy.isRemoteUiNetworkOnlyPath(`${prefix}/child`), true);
    assert.equal(policy.isRemoteUiNetworkOnlyPath(`${prefix}-other`), false);
    assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: `${prefix}/child` }), false);
  }
  assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: '/ui/sw.js' }), true);
  assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: '/ui/pair.js' }), true);
  assert.equal(policy.shouldCacheRemoteUiRequest({ pathname: '/pair' }), false);
});

test('worker VM install queues shell precache and activate claims clients', async () => {
  const worker = workerHarness();
  let installWork;
  worker.handlers.get('install')({ waitUntil(promise) { installWork = promise; } });
  await installWork;
  assert.deepEqual(worker.observed.open, ['babel-remote-shell-v1']);
  assert.deepEqual(worker.observed.addAll, [[
    '/ui', '/ui/', '/ui/index.html', '/ui/app.js', '/ui/styles.css',
    '/ui/state.js', '/ui/render.js', '/ui/manifest.webmanifest', '/ui/icon.svg',
  ]]);
  assert.equal(worker.observed.skipWaiting, 1);
  let activationWork;
  worker.handlers.get('activate')({ waitUntil(promise) { activationWork = promise; } });
  await activationWork;
  assert.equal(worker.observed.claim, 1);
});

test('worker VM successful shell fetch returns network response without cache fallback/update', async () => {
  const networkValue = { status: 200, fixture: 'network shell' };
  const worker = workerHarness({ networkValue });
  const event = worker.dispatch('/ui/app.js');
  assert.equal(event.responded, true);
  assert.equal(await event.response, networkValue);
  assert.deepEqual(worker.observed.fetch, [event.request]);
  assert.deepEqual(worker.observed.match, []);
  assert.deepEqual(worker.observed.open, []);
});

test('worker VM rejected shell fetch returns caches.match result', async () => {
  const cachedValue = { fixture: 'available cached shell' };
  const worker = workerHarness({ networkError: new Error('synthetic network rejection'), cachedValue });
  const event = worker.dispatch('/ui/');
  assert.equal(event.responded, true);
  assert.equal(await event.response, cachedValue);
  assert.deepEqual(worker.observed.fetch, [event.request]);
  assert.deepEqual(worker.observed.match, [event.request]);
});

test('worker VM resolved HTTP 503 does not trigger rejection fallback', async () => {
  const networkValue = { status: 503, ok: false, fixture: 'HTTP error response' };
  const worker = workerHarness({ networkValue });
  const event = worker.dispatch('/ui/index.html');
  assert.equal(await event.response, networkValue);
  assert.deepEqual(worker.observed.match, []);
});

test('worker VM cache miss after network rejection has no fabricated offline response', async () => {
  const worker = workerHarness({ networkError: new Error('synthetic network rejection'), cacheMiss: true });
  // This stub models an absent cache entry as undefined, as caches.match can do.
  const event = worker.dispatch('/ui/app.js');
  assert.equal(await event.response, undefined);
  assert.deepEqual(worker.observed.match, [event.request]);
});

test('worker VM authorized GET and POST leave the fetch event unhandled', () => {
  for (const options of [{ authorization: 'synthetic-test-token' }, { method: 'POST' }]) {
    const worker = workerHarness();
    const event = worker.dispatch('/ui/app.js', options);
    assert.equal(event.responded, false);
    assert.deepEqual(worker.observed.fetch, []);
    assert.deepEqual(worker.observed.match, []);
  }
});

test('worker VM runtime paths and non-shell paths including sw.js bypass interception', () => {
  for (const pathname of [
    '/rpc', '/rpc/child', '/ws', '/ws/child', '/sessions', '/sessions/child',
    '/health', '/health/child', '/ui/sw.js', '/ui/pair.js', '/pair', '/unknown',
  ]) {
    const worker = workerHarness();
    const event = worker.dispatch(pathname);
    assert.equal(event.responded, false, pathname);
    assert.deepEqual(worker.observed.fetch, [], pathname);
    assert.deepEqual(worker.observed.match, [], pathname);
  }
});
