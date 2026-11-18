import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  pickRemoteUiDir,
  remoteUiCandidates,
  remoteUiDirAvailable,
  remoteUiFileForPath,
  resolveRemoteUiDir,
  writeRemoteUiResponse,
} from './remoteUiAssets.js';

test('the source checkout resolves the Remote UI shell', () => {
  const dir = resolveRemoteUiDir().replace(/\\/g, '/');
  assert.match(dir, /src\/bridge\/remote-ui$/);
  assert.equal(remoteUiDirAvailable(), true);
  assert.ok(remoteUiFileForPath('/ui'), 'GET /ui maps to index.html');
  assert.ok(remoteUiFileForPath('/ui/app.js'));
  assert.ok(remoteUiFileForPath('/ui/manifest.webmanifest'));
});

test('rejects traversal and unknown shell paths', () => {
  assert.equal(remoteUiFileForPath('/ui/../package.json'), null);
  assert.equal(remoteUiFileForPath('/ui/..%2fpackage.json'), null);
  assert.equal(remoteUiFileForPath('/ui/missing.js'), null);
  assert.equal(remoteUiFileForPath('/health'), null);
});

test('a missing shell resolves to a not-found response instead of throwing', () => {
  let status: number | undefined;
  let body: string | undefined;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: unknown) {
      body = chunk === undefined ? '' : String(chunk);
      return this;
    },
  };
  // A path that passes the shell allow-list check but has no file on disk.
  assert.equal(writeRemoteUiResponse('/ui/index.html', res as never), true);
  assert.equal(status, 200);
  assert.ok(body && body.length > 0);
});

test('the resolver prefers the compiled shell, then staged resources, then source', () => {
  // UX-04: tsc never emits the HTML/CSS/manifest assets, so a built or
  // installed package must resolve them from dist/bridge/remote-ui or the
  // staged resources/bridge/remote-ui. This fixture is self-contained so the
  // test runs without a build step.
  const root = mkdtempSync(join(tmpdir(), 'babel-remote-ui-resolve-'));
  try {
    const packageRoot = join(root, 'babel-cli');
    const moduleDir = join(packageRoot, 'dist', 'bridge');
    const distShell = join(moduleDir, 'remote-ui');
    const resourcesShell = join(packageRoot, 'resources', 'bridge', 'remote-ui');
    const srcShell = join(packageRoot, 'src', 'bridge', 'remote-ui');
    for (const dir of [distShell, resourcesShell, srcShell]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    }
    assert.deepEqual(remoteUiCandidates(moduleDir), [distShell, resourcesShell, srcShell]);
    assert.equal(pickRemoteUiDir(remoteUiCandidates(moduleDir)), distShell);

    // A built package that lost the compiled copy still serves staged resources.
    rmSync(distShell, { recursive: true, force: true });
    assert.equal(pickRemoteUiDir(remoteUiCandidates(moduleDir)), resourcesShell);

    // An install without staged assets fails closed with an actionable message.
    rmSync(resourcesShell, { recursive: true, force: true });
    rmSync(srcShell, { recursive: true, force: true });
    assert.throws(() => pickRemoteUiDir(remoteUiCandidates(moduleDir)), /Remote UI assets are missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
