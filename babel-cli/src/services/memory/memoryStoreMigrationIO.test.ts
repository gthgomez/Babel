import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readJsonFile, writeJsonAtomic } from './memoryStoreMigrationIO.js';

describe('memoryStoreMigrationIO', () => {
  it('writeJsonAtomic leaves prior file intact if replace never completes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-mem-atomic-'));
    const target = join(dir, 'meta.json');
    try {
      writeJsonAtomic(target, { schemaVersion: 1, ok: true });
      const before = readJsonFile<{ ok: boolean }>(target);
      assert.equal(before?.ok, true);

      const payload = `${JSON.stringify({ schemaVersion: 1, ok: false, big: 'x'.repeat(8_000) }, null, 2)}\n`;
      const tmp = join(dir, '.interrupt.tmp');
      writeFileSync(tmp, payload.slice(0, 50), 'utf-8');
      assert.ok(!existsSync(join(dir, '.interrupt.tmp')) || existsSync(target));
      const after = readJsonFile<{ ok: boolean }>(target);
      assert.equal(after?.ok, true, 'target must remain last complete JSON');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeJsonAtomic replaces with a parseable document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-mem-atomic-replace-'));
    const target = join(dir, 'meta.json');
    try {
      writeJsonAtomic(target, { v: 1 });
      writeJsonAtomic(target, { v: 2, nested: { a: 1 } });
      const parsed = readJsonFile<{ v: number; nested: { a: number } }>(target);
      assert.equal(parsed?.v, 2);
      assert.equal(parsed?.nested.a, 1);
      assert.equal(readFileSync(target, 'utf-8').trimEnd().endsWith('}'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
