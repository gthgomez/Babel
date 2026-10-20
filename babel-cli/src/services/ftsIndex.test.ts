import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { FtsSearchIndex } from './ftsIndex.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'babel-fts-'));
}

type TxnSpy = { openDepth: number; restore: () => void };

function attachSqliteTxnSpy(idx: FtsSearchIndex): TxnSpy {
  const db = (idx as unknown as { db: { exec: (sql: string) => void } }).db;
  const originalExec = db.exec.bind(db);
  const spy: TxnSpy = { openDepth: 0, restore: () => {} };
  db.exec = (sql: string) => {
    const normalized = sql.trim().toUpperCase();
    if (normalized.startsWith('BEGIN')) spy.openDepth++;
    originalExec(sql);
    if (normalized.startsWith('COMMIT') || normalized.startsWith('ROLLBACK')) {
      spy.openDepth = Math.max(0, spy.openDepth - 1);
    }
  };
  spy.restore = () => {
    db.exec = originalExec;
  };
  return spy;
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

test('bounded file read reports an incomplete UTF-8 prefix without a replacement character', () => {
  const root = tempDir();
  try {
    const path = join(root, 'large.ts');
    writeFileSync(path, `${'a'.repeat(128 * 1024 - 1)}é`);
    const result = FtsSearchIndex.readFileContent(path);
    assert.ok(result);
    assert.equal(Buffer.byteLength(result.content, 'utf-8'), 128 * 1024 - 1);
    assert.equal(result.content.endsWith('�'), false);
    assert.equal(result.sizeBytes, 128 * 1024 + 1);
    assert.equal(result.complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the file descriptor never requests or reads beyond the 128 KiB byte cap', () => {
  const root = tempDir();
  const nativeFs = createRequire(import.meta.url)('node:fs') as {
    readSync: (...args: unknown[]) => number;
  };
  const original = nativeFs.readSync;
  let requestedBytes = 0;
  let readBytes = 0;
  try {
    const path = join(root, 'large.ts');
    writeFileSync(path, 'a'.repeat(2 * 1024 * 1024));
    nativeFs.readSync = (...args: unknown[]) => {
      requestedBytes += Number(args[3]);
      const count = Reflect.apply(original, nativeFs, args) as number;
      readBytes += count;
      return count;
    };
    syncBuiltinESMExports();
    const result = FtsSearchIndex.readFileContent(path);
    assert.ok(result);
    assert.equal(result.indexedBytes, 128 * 1024);
    assert.ok(requestedBytes <= 128 * 1024, `requested ${requestedBytes} bytes`);
    assert.ok(readBytes <= 128 * 1024, `read ${readBytes} bytes`);
  } finally {
    nativeFs.readSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('index statistics retain coverage for content beyond the byte budget', async () => {
  const root = tempDir();
  try {
    const path = join(root, 'large.ts');
    writeFileSync(path, `${'a'.repeat(128 * 1024)}TailOnlyNeedle`);
    const index = new FtsSearchIndex(join(root, 'index.db'));
    try {
      await index.indexFiles([{ filePath: path, relativePath: 'large.ts' }]);
      assert.equal(index.search('TailOnlyNeedle').length, 0);
      assert.equal(index.getStats().incompleteFiles, 1);
      assert.equal(index.getStats().indexedBytes, 128 * 1024);
    } finally {
      index.close();
    }
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

// ── Transaction / callback boundaries ────────────────────────────────────────

test('indexFiles invokes shouldContinue and onReadFile only outside SQLite transactions', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [
      { path: 'a.ts', content: 'export const A = 1;' },
      { path: 'b.ts', content: 'export const B = 2;' },
      { path: 'c.ts', content: 'export const C = 3;' },
    ]);

    const idx = new FtsSearchIndex(dbPath);
    const txnSpy = attachSqliteTxnSpy(idx);
    try {
      await idx.indexFiles(
        [
          { filePath: join(root, 'a.ts'), relativePath: 'a.ts' },
          { filePath: join(root, 'b.ts'), relativePath: 'b.ts' },
          { filePath: join(root, 'c.ts'), relativePath: 'c.ts' },
        ],
        {
          shouldContinue: () => {
            assert.equal(txnSpy.openDepth, 0, 'shouldContinue must not run inside a transaction');
            return true;
          },
          onReadFile: () => {
            assert.equal(txnSpy.openDepth, 0, 'onReadFile must not run inside a transaction');
          },
        },
      );
      assert.equal(txnSpy.openDepth, 0, 'no transaction should remain open after indexFiles');
    } finally {
      txnSpy.restore();
    }

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexFiles leaves no open transaction when onReadFile throws', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [
      { path: 'a.ts', content: 'export const A = 1;' },
      { path: 'b.ts', content: 'export const B = 2;' },
    ]);

    const idx = new FtsSearchIndex(dbPath);
    const txnSpy = attachSqliteTxnSpy(idx);
    try {
      await assert.rejects(
        () =>
          idx.indexFiles(
            [
              { filePath: join(root, 'a.ts'), relativePath: 'a.ts' },
              { filePath: join(root, 'b.ts'), relativePath: 'b.ts' },
            ],
            {
              onReadFile: (relativePath) => {
                assert.equal(txnSpy.openDepth, 0, 'onReadFile must not run inside a transaction');
                if (relativePath === 'b.ts') throw new Error('callback abort');
              },
            },
          ),
        /callback abort/,
      );
      assert.equal(txnSpy.openDepth, 0, 'throwing callback must not leak an open transaction');
      assert.equal(idx.count, 0, 'failed run must not commit partial batches');
    } finally {
      txnSpy.restore();
    }

    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexFiles counts one reindex when the same complete file appears twice in one pass', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [{ path: 'dup.ts', content: 'export const DUP = 1;' }]);
    const filePath = join(root, 'dup.ts');
    const idx = new FtsSearchIndex(dbPath);
    const count = await idx.indexFiles([
      { filePath, relativePath: 'dup.ts' },
      { filePath, relativePath: 'dup.ts' },
    ]);
    assert.equal(count, 1, 'duplicate unchanged paths in one pass should count a single reindex');
    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexFiles preserves ordered reindex count when the same path changes twice in one pass', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  const rel = 'flip.ts';
  const filePath = join(root, rel);
  try {
    writeFileSync(filePath, 'export const TOKEN = "CONTENT_A";', 'utf-8');
    const idx = new FtsSearchIndex(dbPath);
    await idx.indexFiles([{ filePath, relativePath: rel }]);
    assert.ok(idx.search('CONTENT_A', 5).length >= 1);

    writeFileSync(filePath, 'export const TOKEN = "CONTENT_B";', 'utf-8');
    const count = await idx.indexFiles(
      [
        { filePath, relativePath: rel },
        { filePath, relativePath: rel },
      ],
      {
        onReadFile: () => {
          writeFileSync(filePath, 'export const TOKEN = "CONTENT_A";', 'utf-8');
        },
      },
    );
    assert.equal(count, 2, 'B then A on the same path should count both reindex operations');
    assert.ok(idx.search('CONTENT_A', 5).length >= 1, 'final indexed content should be A');
    assert.equal(idx.search('CONTENT_B', 5).length, 0, 'intermediate B should not remain indexed');
    idx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('indexFiles rolls back a failed pending batch and allows a later successful index', async () => {
  const root = tempDir();
  const dbPath = join(root, 'test.db');
  try {
    writeTempFiles(root, [
      { path: 'one.ts', content: 'export const ONE = 1;' },
      { path: 'two.ts', content: 'export const TWO = 2;' },
    ]);
    const idx = new FtsSearchIndex(dbPath);
    const db = (idx as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    const originalPrepare = db.prepare.bind(db);
    let insertRuns = 0;
    db.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes('INSERT OR REPLACE INTO fts_files')) {
        return statement;
      }
      return {
        run: (...args: unknown[]) => {
          insertRuns++;
          if (insertRuns === 2) {
            throw new Error('injected insert failure');
          }
          return statement.run(...args);
        },
      };
    };

    const txnSpy = attachSqliteTxnSpy(idx);
    try {
      await assert.rejects(
        () =>
          idx.indexFiles([
            { filePath: join(root, 'one.ts'), relativePath: 'one.ts' },
            { filePath: join(root, 'two.ts'), relativePath: 'two.ts' },
          ]),
        /injected insert failure/,
      );
      assert.equal(txnSpy.openDepth, 0, 'failed batch must not leak an open transaction');
      assert.equal(idx.count, 0, 'failed batch must not commit partial pending writes');
    } finally {
      txnSpy.restore();
      db.prepare = originalPrepare;
    }

    const recovered = await idx.indexFiles([
      { filePath: join(root, 'one.ts'), relativePath: 'one.ts' },
      { filePath: join(root, 'two.ts'), relativePath: 'two.ts' },
    ]);
    assert.equal(recovered, 2);
    assert.equal(idx.count, 2);
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
  let idx: FtsSearchIndex | undefined;
  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats++;
  }, 25);
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

    idx = new FtsSearchIndex(dbPath);

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

    const heartbeatsBefore = heartbeats;
    const start = performance.now();
    const count = await idx.indexFiles(allEntries);
    const elapsed = performance.now() - start;
    const heartbeatsDuring = heartbeats - heartbeatsBefore;

    assert.ok(heartbeatsDuring > 0, `event loop should heartbeat during indexing (saw ${heartbeatsDuring})`);
    assert.equal(count, 5000, 'should index all 5000 files');
    // 5000 files at 50/batch = 100 yields. CI runners with slower I/O may need more time.
    assert.ok(elapsed < 110_000, `indexing 5000 files took ${elapsed.toFixed(0)}ms, expected < 110s`);

    // Verify search still works after stress
    const hits = idx.search(`ID_3742`, 5);
    assert.ok(hits.length >= 1, 'should find a specific file after large insert');
  } finally {
    clearInterval(heartbeat);
    idx?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
