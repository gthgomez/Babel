import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

test('source manifest rejects canonical digest corruption and removed inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-source-manifest-'));
  try {
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n', 'utf8');
    const manifest = buildByteAttestedSourceManifest({ root, files: [{ path: 'source.ts' }] });
    const corruptDigest = verifyByteAttestedSourceManifest({
      ...manifest,
      manifest_sha256: '0'.repeat(64),
    });
    assert.equal(corruptDigest.ok, false);
    assert.deepEqual(corruptDigest.manifest_mismatches, ['manifest_sha256']);

    const removedInventory = verifyByteAttestedSourceManifest({ ...manifest, files: [] });
    assert.equal(removedInventory.ok, false);
    assert.ok(removedInventory.manifest_mismatches.includes('manifest_sha256'));
    assert.ok(removedInventory.manifest_mismatches.includes('inventory'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source manifest reports metadata drift separately from portable content identity', () => {
  const firstRoot = mkdtempSync(join(tmpdir(), 'babel-source-manifest-'));
  const secondRoot = mkdtempSync(join(tmpdir(), 'babel-source-manifest-'));
  try {
    writeFileSync(join(firstRoot, 'source.ts'), 'same bytes\n', 'utf8');
    writeFileSync(join(secondRoot, 'source.ts'), 'same bytes\n', 'utf8');
    const first = buildByteAttestedSourceManifest({ root: firstRoot, files: [{ path: 'source.ts' }] });
    const second = buildByteAttestedSourceManifest({ root: secondRoot, files: [{ path: 'source.ts' }] });
    assert.equal(first.manifest_sha256, second.manifest_sha256);

    utimesSync(join(firstRoot, 'source.ts'), new Date(200000), new Date(200000));
    const verification = verifyByteAttestedSourceManifest(first);
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.mismatches, []);
    assert.deepEqual(verification.metadata_mismatches, ['source.ts']);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test('source manifest rejects ancestor and leaf symlink escapes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-source-manifest-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-source-manifest-outside-'));
  try {
    writeFileSync(join(outside, 'outside.txt'), 'outside\n', 'utf8');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(outside, join(root, 'ancestor'), linkType);
      symlinkSync(join(outside, 'outside.txt'), join(root, 'leaf'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.skip(`symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => buildByteAttestedSourceManifest({ root, files: [{ path: 'ancestor/outside.txt' }] }),
      /resolves outside root/,
    );
    assert.throws(
      () => buildByteAttestedSourceManifest({ root, files: [{ path: 'leaf' }] }),
      /resolves outside root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('source manifest rejects an in-root alias into a private directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'babel-source-manifest-'));
  const privateRoot = join(root, '.codex');
  try {
    mkdirSync(privateRoot);
    writeFileSync(join(privateRoot, 'secret.txt'), 'private\n', 'utf8');
    try {
      symlinkSync(privateRoot, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.skip(`symlink creation unavailable: ${code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => buildByteAttestedSourceManifest({ root, files: [{ path: 'alias/secret.txt' }] }),
      /private resolved path/,
    );
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
