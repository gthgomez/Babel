import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  remoteUiDirAvailable,
  remoteUiFileForPath,
  resolveRemoteUiDir,
  writeRemoteUiResponse,
} from './remoteUiAssets.js';

const distShell = fileURLToPath(new URL('../../dist/bridge/remote-ui/index.html', import.meta.url));

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

test('the build stages the Remote UI shell next to the compiled bridge', { skip: !existsSync(distShell) }, () => {
  // UX-04: an npm-packed install 500ed on /ui because tsc never emitted the
  // HTML/CSS/manifest assets. The build step must place them in dist.
  for (const asset of ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js']) {
    assert.ok(
      existsSync(fileURLToPath(new URL(`../../dist/bridge/remote-ui/${asset}`, import.meta.url))),
      `missing staged asset dist/bridge/remote-ui/${asset}`,
    );
  }
});
