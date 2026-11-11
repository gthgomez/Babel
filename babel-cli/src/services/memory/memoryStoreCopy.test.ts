import assert from 'node:assert/strict';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { copyMemoryFileExclusive, sha256File } from './memoryStoreCopy.js';

describe('memoryStoreCopy', () => {
  it('creates destination exclusively (COPYFILE_EXCL)', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-mem-copy-'));
    const srcRoot = join(root, 'src');
    const destRoot = join(root, 'dest');
    try {
      mkdirSync(srcRoot);
      mkdirSync(destRoot);
      writeFileSync(join(srcRoot, 'a.md'), 'alpha', 'utf-8');
      const out = copyMemoryFileExclusive(srcRoot, destRoot, 'a.md');
      assert.equal(out.status, 'created');
      assert.equal(readFileSync(join(destRoot, 'a.md'), 'utf-8'), 'alpha');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats identical bytes as migrated without overwrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-mem-identical-'));
    const srcRoot = join(root, 'src');
    const destRoot = join(root, 'dest');
    try {
      mkdirSync(srcRoot);
      mkdirSync(destRoot);
      writeFileSync(join(srcRoot, 'a.md'), 'same-body', 'utf-8');
      writeFileSync(join(destRoot, 'a.md'), 'same-body', 'utf-8');
      const digest = sha256File(join(destRoot, 'a.md'));
      const out = copyMemoryFileExclusive(srcRoot, destRoot, 'a.md');
      assert.equal(out.status, 'identical');
      assert.equal(out.contentSha256, digest);
      assert.equal(readFileSync(join(destRoot, 'a.md'), 'utf-8'), 'same-body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports conflict and preserves differing destination bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-mem-conflict-'));
    const srcRoot = join(root, 'src');
    const destRoot = join(root, 'dest');
    try {
      mkdirSync(srcRoot);
      mkdirSync(destRoot);
      writeFileSync(join(srcRoot, 'a.md'), 'legacy-body', 'utf-8');
      writeFileSync(join(destRoot, 'a.md'), 'canonical-body', 'utf-8');
      const out = copyMemoryFileExclusive(srcRoot, destRoot, 'a.md');
      assert.equal(out.status, 'conflict');
      assert.equal(readFileSync(join(destRoot, 'a.md'), 'utf-8'), 'canonical-body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries on EEXIST race without overwriting winner bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-mem-race-'));
    const srcRoot = join(root, 'src');
    const destRoot = join(root, 'dest');
    try {
      mkdirSync(srcRoot);
      mkdirSync(destRoot);
      writeFileSync(join(srcRoot, 'race.md'), 'legacy', 'utf-8');
      const dest = join(destRoot, 'race.md');
      const first = copyMemoryFileExclusive(srcRoot, destRoot, 'race.md');
      assert.equal(first.status, 'created');
      writeFileSync(join(srcRoot, 'race.md'), 'legacy-changed', 'utf-8');
      rmSync(dest);
      writeFileSync(dest, 'racer', 'utf-8');
      try {
        copyFileSync(join(srcRoot, 'race.md'), dest, constants.COPYFILE_EXCL);
        assert.fail('expected EEXIST path');
      } catch (err) {
        assert.equal((err as NodeJS.ErrnoException).code, 'EEXIST');
      }
      const raced = copyMemoryFileExclusive(srcRoot, destRoot, 'race.md');
      assert.equal(raced.status, 'conflict');
      assert.equal(readFileSync(dest, 'utf-8'), 'racer');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
