import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import {
  buildDesktopCliShimEntrySource,
  classifyAllowlistedStartupCodes,
  desktopCliShimRuntimeImportHref,
  windowsShapedDriveLetterImportSpecifier,
} from './shared-protocol-shim-import.mjs';

function spawnNodeEntry(entry, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-wasm-modules', entry, ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ code, stderr, allowlisted: classifyAllowlistedStartupCodes(stderr) });
    });
  });
}

test('desktopCliShimRuntime import href is a file URL on this platform', () => {
  const href = desktopCliShimRuntimeImportHref();
  assert.match(href, /^file:\/\//);
  assert.equal(href.includes('\\'), false);
});

test('generated shim entry uses file URL import, not Windows drive-letter paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shim-import-spec-'));
  const entry = join(root, 'shim.mjs');
  const receipt = join(root, 'receipt.jsonl');
  const distPath = join(root, 'dist', 'index.js');
  const source = buildDesktopCliShimEntrySource({ distPath, receiptPath: receipt });
  await writeFile(entry, source, 'utf8');
  const text = await readFile(entry, 'utf8');
  assert.match(text, /from "file:\/\//);
  assert.doesNotMatch(text, /from "[A-Za-z]:\\/);
  assert.doesNotMatch(text, /from "[A-Za-z]:\//);
});

test('Windows-shaped drive-letter static import fails before shim body runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shim-bad-import-'));
  const entry = join(root, 'bad-import.mjs');
  const badSpecifier = windowsShapedDriveLetterImportSpecifier();
  await writeFile(
    entry,
    `import { runDesktopCliShim } from ${JSON.stringify(badSpecifier)};
runDesktopCliShim({ dist: '.', argv: [], hostRunReceipt: ${JSON.stringify(join(root, 'r.jsonl'))} });
`,
    'utf8',
  );
  const result = await spawnNodeEntry(entry);
  assert.equal(result.code, 1);
  assert.ok(
    result.allowlisted.includes('ERR_UNSUPPORTED_ESM_URL_SCHEME'),
    `expected allowlisted loader code, got stderr codes ${result.allowlisted.join(',')}`,
  );
});

test('file URL static import reaches shim module (loader regression)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shim-good-import-'));
  const entry = join(root, 'good-import.mjs');
  const marker = join(root, 'entered.txt');
  const runtimeHref = desktopCliShimRuntimeImportHref();
  await writeFile(
    entry,
    `import { appendFileSync } from 'node:fs';
import ${JSON.stringify(runtimeHref)};
appendFileSync(${JSON.stringify(marker)}, 'import-ok');
`,
    'utf8',
  );
  const result = await spawnNodeEntry(entry);
  assert.equal(result.code, 0);
  const markerText = await readFile(marker, 'utf8');
  assert.equal(markerText, 'import-ok');
});
