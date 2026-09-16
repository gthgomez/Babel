import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildByteAttestedSourceManifest,
  verifyByteAttestedSourceManifest,
} from './sourceManifest.js';

test('source manifest records exact bytes, metadata, and classification', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-source-manifest-'));
  try {
    writeFileSync(join(root, 'tracked.txt'), 'one\r\ntwo\r\n', 'utf8');
    writeFileSync(join(root, 'supplement.txt'), 'extra\n', 'utf8');
    const manifest = buildByteAttestedSourceManifest({
      root,
      files: [
        { path: 'supplement.txt', kind: 'supplement' },
        { path: 'tracked.txt', kind: 'tracked' },
      ],
    });
    assert.deepEqual(manifest.files.map((file) => file.path), ['supplement.txt', 'tracked.txt']);
    assert.equal(manifest.files[1]?.line_ending, 'crlf');
    assert.equal(manifest.files[0]?.kind, 'supplement');
    assert.equal(verifyByteAttestedSourceManifest(manifest).ok, true);
    writeFileSync(join(root, 'tracked.txt'), 'changed\n', 'utf8');
    assert.deepEqual(verifyByteAttestedSourceManifest(manifest).mismatches, ['tracked.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source manifest refuses private paths and root escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-source-manifest-'));
  try {
    assert.throws(() => buildByteAttestedSourceManifest({ root, files: [{ path: '../outside.txt' }] }));
    assert.throws(() => buildByteAttestedSourceManifest({ root, files: [{ path: '.env' }] }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
