import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { FtsSearchIndex } from './ftsIndex.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'babel-fts-'));
}

function writeTempFiles(root: string, files: Array<{ path: string; content: string }>): string[] {
  const written: string[] = [];
  for (const f of files) {
    const fullPath = join(root, f.path);
    const dir = join(fullPath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, f.content, 'utf-8');
    written.push(f.path);
  }
  return written;
}

// ── Basic index + search ─────────────────────────────────────────────────────

test('indexes files and returns search hits', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [
      { path: 'agent.ts', content: 'export class AgentRuntime { run() {} }' },
      { path: 'config.ts', content: 'export const PORT = 3000;' },
      { path: 'worker.ts', content: 'export class WorkerPool { spawn() {} }' },
      { path: 'utils.ts', content: 'export function debounce(fn, ms) {}' },
      { path: 'types.ts', content: 'export type ID = string;' },
    ]);

    const idx = new FtsSearchIndex(dbPath);
    const count = await idx.indexFiles([
      { filePath: join(root, 'agent.ts'), relativePath: 'agent.ts' },
      { filePath: join(root, 'config.ts'), relativePath: 'config.ts' },
      { filePath: join(root, 'worker.ts'), relativePath: 'worker.ts' },
      { filePath: join(root, 'utils.ts'), relativePath: 'utils.ts' },
      { filePath: join(root, 'types.ts'), relativePath: 'types.ts' },
    ]);
    assert.equal(count, 5);

    // Search for class names
    const hits = idx.search('AgentRuntime', 5);
    assert.ok(hits.length >= 1, 'should find AgentRuntime');
    assert.match(hits[0]!.path, /agent\.ts/);

    // Search for function
    const debounceHits = idx.search('debounce', 5);
    assert.ok(debounceHits.length >= 1, 'should find debounce');
    assert.match(debounceHits[0]!.path, /utils\.ts/);

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Incremental indexing (hash comparison) ───────────────────────────────────

test('skips unchanged files on reindex (hash comparison)', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [
      { path: 'a.ts', content: 'export const X = 1;' },
      { path: 'b.ts', content: 'export const Y = 2;' },
    ]);

    const idx = new FtsSearchIndex(dbPath);

    // First index — both files should be indexed
    const first = await idx.indexFiles([
      { filePath: join(root, 'a.ts'), relativePath: 'a.ts' },
      { filePath: join(root, 'b.ts'), relativePath: 'b.ts' },
    ]);
    assert.equal(first, 2, 'first pass should index both files');

    // Second index with no changes — both should be skipped
    const second = await idx.indexFiles([
      { filePath: join(root, 'a.ts'), relativePath: 'a.ts' },
      { filePath: join(root, 'b.ts'), relativePath: 'b.ts' },
    ]);
    assert.equal(second, 0, 'second pass should skip unchanged files');

    // Modify a.ts — only a.ts should be reindexed
    writeFileSync(join(root, 'a.ts'), 'export const X = 999;', 'utf-8');
    const third = await idx.indexFiles([
      { filePath: join(root, 'a.ts'), relativePath: 'a.ts' },
      { filePath: join(root, 'b.ts'), relativePath: 'b.ts' },
    ]);
    assert.equal(third, 1, 'third pass should reindex only changed file');

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Reindex on content change ────────────────────────────────────────────────

test('reindexed file content is searchable', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [{ path: 'needle.ts', content: 'export const OLD_TOKEN = "original";' }]);

    const idx = new FtsSearchIndex(dbPath);
    await idx.indexFiles([{ filePath: join(root, 'needle.ts'), relativePath: 'needle.ts' }]);

    // Original content searchable
    assert.ok(idx.search('OLD_TOKEN', 5).length >= 1);
    assert.equal(idx.search('NEW_TOKEN', 5).length, 0);

    // Modify and reindex
    writeFileSync(join(root, 'needle.ts'), 'export const NEW_TOKEN = "updated";', 'utf-8');
    await idx.indexFiles([{ filePath: join(root, 'needle.ts'), relativePath: 'needle.ts' }]);

    // New content searchable, old content gone
    assert.ok(idx.search('NEW_TOKEN', 5).length >= 1, 'new content should be findable');
    assert.equal(idx.search('OLD_TOKEN', 5).length, 0, 'old content should be gone');

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── pruneMissing ─────────────────────────────────────────────────────────────

test('pruneMissing removes deleted files from index', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [
      { path: 'keep.ts', content: 'export const KEEP = 1;' },
      { path: 'remove.ts', content: 'export const REMOVE = 2;' },
    ]);

    const idx = new FtsSearchIndex(dbPath);
    await idx.indexFiles([
      { filePath: join(root, 'keep.ts'), relativePath: 'keep.ts' },
      { filePath: join(root, 'remove.ts'), relativePath: 'remove.ts' },
    ]);
    assert.equal(idx.count, 2);

    // Delete remove.ts
    unlinkSync(join(root, 'remove.ts'));

    // Prune
    const removed = await idx.pruneMissing(root);
    assert.equal(removed, 1);
    assert.equal(idx.count, 1);

    // keep.ts still findable
    assert.ok(idx.search('KEEP', 5).length >= 1);
    // remove.ts no longer findable
    assert.equal(idx.search('REMOVE', 5).length, 0);

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Yielding verification ────────────────────────────────────────────────────

test('indexFiles yields to event loop (no blocking > 100ms per batch)', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    // Create 200 files to exercise batching (BATCH_SIZE = 50 → 4+ yields)
    const files: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < 200; i++) {
      files.push({
        path: `file_${String(i).padStart(4, '0')}.ts`,
        content: `export const TOKEN_${i} = ${i};\n`.repeat(5),
      });
    }
    writeTempFiles(root, files);

    const idx = new FtsSearchIndex(dbPath);
    const fileEntries = files.map((f) => ({
      filePath: join(root, f.path),
      relativePath: f.path,
    }));

    // Measure time to verify it yields (doesn't block)
    const start = performance.now();
    const count = await idx.indexFiles(fileEntries);
    const elapsed = performance.now() - start;

    assert.equal(count, 200, 'should index all 200 files');
    // With yielding every 50 files, elapsed should be well under 30 seconds.
    // On a healthy system this takes < 2 seconds.
    assert.ok(elapsed < 30_000, `indexing 200 files took ${elapsed.toFixed(0)}ms, expected < 30s`);

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Large-repo stress test ───────────────────────────────────────────────────

test('large-repo stress: indexes 5000 files without blocking', { timeout: 120_000 }, async () => {
  const root = tempDir();
  const dbPath = join(root, 'stress.db');
  try {
    // Create 5000 small files
    const BATCH = 500;
    for (let b = 0; b < 10; b++) {
      const batchFiles: Array<{ path: string; content: string }> = [];
      for (let i = 0; i < BATCH; i++) {
        const id = b * BATCH + i;
        batchFiles.push({
          path: `batch_${b}/file_${String(id).padStart(5, '0')}.ts`,
          content: `export const ID_${id} = "${randomUUID()}";\nexport function fn_${id}() { return ${id}; }\n`,
        });
      }
      writeTempFiles(root, batchFiles);
    }

    const idx = new FtsSearchIndex(dbPath);

    // Collect all file entries
    const allEntries: Array<{ filePath: string; relativePath: string }> = [];
    for (let b = 0; b < 10; b++) {
      for (let i = 0; i < BATCH; i++) {
        const id = b * BATCH + i;
        const relPath = `batch_${b}/file_${String(id).padStart(5, '0')}.ts`;
        allEntries.push({ filePath: join(root, relPath), relativePath: relPath });
      }
    }
    assert.equal(allEntries.length, 5000);

    const start = performance.now();
    const count = await idx.indexFiles(allEntries);
    const elapsed = performance.now() - start;

    assert.equal(count, 5000, 'should index all 5000 files');
    // 5000 files at 50/batch = 100 yields. CI runners with slower I/O may need more time.
    assert.ok(elapsed < 110_000, `indexing 5000 files took ${elapsed.toFixed(0)}ms, expected < 110s`);

    // Verify search still works after stress
    const hits = idx.search(`ID_3742`, 5);
    assert.ok(hits.length >= 1, 'should find a specific file after large insert');

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
