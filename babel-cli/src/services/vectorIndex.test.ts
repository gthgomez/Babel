import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { VectorIndex } from './vectorIndex.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temporary FTS database with some test files, so the VectorIndex
 * can find `fts_files` rows when it opens the same .db file.
 */
function makeFtsDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS fts_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      extension TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    "INSERT INTO fts_files (path, name, content, extension, content_hash, size_bytes) VALUES " +
    "('src/main.ts', 'main.ts', 'console.log(\"hello world\");', '.ts', 'abc', 28)",
  );
  db.exec(
    "INSERT INTO fts_files (path, name, content, extension, content_hash, size_bytes) VALUES " +
    "('src/utils.ts', 'utils.ts', 'export function add(a: number, b: number) { return a + b; }', '.ts', 'def', 63)",
  );
  db.exec(
    "INSERT INTO fts_files (path, name, content, extension, content_hash, size_bytes) VALUES " +
    "('README.md', 'README.md', '# Test Project\\n\\nThis is a test.', '.md', 'ghi', 34)",
  );
  db.close();
}

/** A simple embedding function that creates a deterministic vector from text. */
function testEmbedding(content: string): Float32Array {
  // Create a simple deterministic embedding: use char codes normalized
  const dim = 4;
  const vec = new Float32Array(dim);
  for (let i = 0; i < content.length; i++) {
    const idx = i % dim;
    vec[idx] = (vec[idx] ?? 0) + content.charCodeAt(i) / 100;
  }
  return vec;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'vector-index-test-'));
}

/** Clean up a temp directory, retrying once if EPERM on Windows. */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // On Windows, SQLite WAL/SHM files may briefly hold a lock after close().
    // Retry once after a short delay.
    setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore final cleanup errors
      }
    }, 100).unref();
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('VectorIndex initializes with correct defaults', () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);

    const vi = new VectorIndex(dbPath, 4);
    const stats = vi.getStats();

    assert.equal(stats.extensionLoaded, true, 'sqlite-vec extension should load');
    assert.equal(stats.dimension, 4, 'dimension should match constructor arg');
    assert.equal(stats.dbPath, dbPath, 'dbPath should match');
    assert.equal(stats.totalEmbeddings, 0, 'no embeddings yet');

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('indexEmbeddings populates vectors and sets has_embedding', async () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);

    const vi = new VectorIndex(dbPath, 4);
    if (!vi.getStats().extensionLoaded) {
      vi.close();
      return; // Skip test if extension not available on this platform
    }

    // Index embeddings for all files without embeddings
    const indexed = await vi.indexEmbeddings(testEmbedding);
    assert.equal(indexed, 3, 'All 3 files should be embedded');

    const stats = vi.getStats();
    assert.equal(stats.totalEmbeddings, 3, 'vec_files should have 3 rows');

    // Verify has_embedding flags were set
    const verifyDb = new DatabaseSync(dbPath);
    const pendingCount = verifyDb
      .prepare('SELECT COUNT(*) as cnt FROM fts_files WHERE has_embedding = 0')
      .get() as { cnt: number };
    assert.equal(pendingCount.cnt, 0, 'All files should have has_embedding=1');
    verifyDb.close();

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('search returns results ordered by similarity', async () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);

    const vi = new VectorIndex(dbPath, 4);
    if (!vi.getStats().extensionLoaded) {
      vi.close();
      return; // Skip test if extension not available on this platform
    }

    await vi.indexEmbeddings(testEmbedding);

    // Search with a query similar to the first file's content
    const querySimilar = testEmbedding('console.log("hello world");');
    const hits = vi.search(querySimilar, 5);

    assert.ok(hits.length > 0, 'Should return at least one result');
    const firstHit = hits[0];
    assert.ok(firstHit, 'First hit should exist');
    assert.equal(firstHit.fileId, 1, 'First result should be the most similar file (id=1)');

    // Verify score is in [0, 1]
    for (const hit of hits) {
      assert.ok(hit.score >= 0 && hit.score <= 1, `Score ${hit.score} should be in [0, 1]`);
      assert.ok(typeof hit.distance === 'number', 'Distance should be a number');
      assert.ok(typeof hit.fileId === 'number', 'fileId should be a number');
      assert.ok(hit.distance >= 0, `Distance ${hit.distance} should be >= 0`);
    }

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('search with limit returns correct number of results', async () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);

    const vi = new VectorIndex(dbPath, 4);
    if (!vi.getStats().extensionLoaded) {
      vi.close();
      return;
    }

    await vi.indexEmbeddings(testEmbedding);

    // Search with limit=2
    const hits = vi.search(testEmbedding('test'), 2);
    assert.ok(hits.length <= 2, 'Should return at most 2 results');

    // Search with limit=0 should return empty
    const emptyHits = vi.search(testEmbedding('test'), 0);
    assert.equal(emptyHits.length, 0, 'Limit=0 should return empty results');

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('search returns empty array when no embeddings exist', () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);

    const vi = new VectorIndex(dbPath, 4);
    if (!vi.getStats().extensionLoaded) {
      vi.close();
      return;
    }

    // Search before indexing any embeddings
    const hits = vi.search(testEmbedding('anything'), 5);
    assert.equal(hits.length, 0, 'Should return empty array when vec_files is empty');

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('getStats returns correct metadata', () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);

    const vi = new VectorIndex(dbPath, 8); // Use dimension 8 for this test
    const stats = vi.getStats();

    assert.equal(stats.dimension, 8);
    assert.equal(stats.dbPath, dbPath);
    assert.equal(typeof stats.extensionLoaded, 'boolean');

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('close is idempotent', () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);
    const vi = new VectorIndex(dbPath, 4);
    vi.close();
    // Calling close again should not throw
    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('indexEmbeddings processes only files without embeddings', async () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    makeFtsDatabase(dbPath);

    const vi = new VectorIndex(dbPath, 4);
    if (!vi.getStats().extensionLoaded) {
      vi.close();
      return;
    }

    // First pass: index all files
    const firstPass = await vi.indexEmbeddings(testEmbedding);
    assert.equal(firstPass, 3, 'First pass should index all 3 files');

    // Second pass: should be 0 since all files already have embeddings
    const secondPass = await vi.indexEmbeddings(testEmbedding);
    assert.equal(secondPass, 0, 'Second pass should index 0 files');

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});

test('indexEmbeddings respects onProgress callback', async () => {
  const tmpDir = makeTempDir();
  const dbPath = join(tmpDir, 'test-index.db');
  try {
    // Create many files to trigger batching
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS fts_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        extension TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    for (let i = 0; i < 25; i++) {
      db.exec(
        `INSERT INTO fts_files (path, name, content, extension, content_hash, size_bytes) VALUES ` +
        `('file${i}.ts', 'file${i}.ts', 'content ${i}', '.ts', 'hash${i}', ${i + 10})`,
      );
    }
    db.close();

    const vi = new VectorIndex(dbPath, 4);
    if (!vi.getStats().extensionLoaded) {
      vi.close();
      return;
    }

    const progressCalls: Array<{ indexed: number; total: number }> = [];
    const indexed = await vi.indexEmbeddings(testEmbedding, (idx, total) => {
      progressCalls.push({ indexed: idx, total });
    });

    assert.equal(indexed, 25, 'All 25 files should be embedded');
    assert.ok(progressCalls.length >= 1, 'onProgress should have been called at least once');

    vi.close();
  } finally {
    cleanupDir(tmpDir);
  }
});
