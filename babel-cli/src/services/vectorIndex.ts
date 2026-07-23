import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { getLoadablePath } from 'sqlite-vec';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VectorSearchHit {
  /** The fts_files.id this vector belongs to. */
  fileId: number;
  /** Cosine distance (0 = identical, 2 = opposite). Lower is more similar. */
  distance: number;
  /** Normalised similarity score (1 - distance / 2), clamped to [0, 1]. */
  score: number;
}

export interface VectorIndexStats {
  totalEmbeddings: number;
  dbPath: string;
  dimension: number;
  extensionLoaded: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default embedding dimension used when none is supplied. */
const DEFAULT_EMBEDDING_DIMENSION = 384;

// ─── VectorIndex ──────────────────────────────────────────────────────────────

/**
 * Embedding-based semantic search index backed by sqlite-vec.
 *
 * Opens a **separate** connection to the same SQLite database that
 * `FtsSearchIndex` uses, loads the sqlite-vec native extension, and
 * manages a `vec_files` virtual table (vec0) for KNN queries.
 *
 * Because the extension is loaded per-connection, this class can share
 * a .db file with `FtsSearchIndex` while the FTS connection remains
 * untouched (no extension flag needed on that side).
 *
 * Inserting vectors: use `db.exec()` with JSON-array strings.
 * Querying: use `db.prepare().all()` with JSON-array strings or Buffers.
 */
export class VectorIndex {
  private db: DatabaseSync;
  private dbPath: string;
  private dimension: number;
  private extensionLoaded = false;

  /**
   * @param dbPath  Path to the SQLite database file (same file as FtsSearchIndex).
   * @param dimension  Embedding vector dimension (default 384).
   */
  constructor(dbPath: string, dimension?: number) {
    this.dbPath = dbPath;
    this.dimension = dimension ?? DEFAULT_EMBEDDING_DIMENSION;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.initialize();
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  private initialize(): void {
    // Load the sqlite-vec native extension
    try {
      this.db.loadExtension(getLoadablePath());
      this.extensionLoaded = true;
    } catch {
      this.extensionLoaded = false;
      return;
    }

    // Create the vec0 virtual table for KNN search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_files USING vec0(
        id INTEGER PRIMARY KEY,
        embedding FLOAT[${this.dimension}] distance_metric=cosine
      )
    `);

    // Add has_embedding column to fts_files if it doesn't already exist.
    // This column tracks which files have been embedded so we can
    // incrementally index new files in future runs.
    try {
      this.db.exec('ALTER TABLE fts_files ADD COLUMN has_embedding INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists — this is the common case after first init.
    }
  }

  // ── Indexing ──────────────────────────────────────────────────────────────

  /**
   * Generate and store embeddings for files that don't have them yet.
   *
   * Queries `fts_files` for rows where `has_embedding = 0`, calls the
   * supplied `getEmbedding(content)` function for each, and stores the
   * resulting vector in `vec_files`. Updates `has_embedding` on success.
   *
   * Yields to the event loop every 20 files so the REPL stays responsive
   * during large indexing runs.
   *
   * @param getEmbedding  Async function that converts text content to a
   *                      Float32Array embedding vector.
   * @param onProgress    Optional callback invoked after each batch.
   * @returns The number of files successfully embedded.
   */
  async indexEmbeddings(
    getEmbedding: (content: string) => Float32Array | Promise<Float32Array>,
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<number> {
    if (!this.extensionLoaded) return 0;

    // Collect files that still need embeddings
    const files = this.db
      .prepare('SELECT id, content FROM fts_files WHERE has_embedding = 0')
      .all() as Array<{ id: number; content: string }>;

    if (files.length === 0) return 0;

    const total = files.length;
    let indexed = 0;
    let batchCount = 0;

    for (const file of files) {
      try {
        const embedding = await getEmbedding(file.content);
        const jsonStr = `[${Array.from(embedding).join(',')}]`;

        // Use db.exec() for INSERT into vec0 — prepared statements can
        // mismap the INTEGER PRIMARY KEY type with node:sqlite's binding.
        this.db.exec(
          `INSERT OR REPLACE INTO vec_files(id, embedding) VALUES (${file.id}, '${jsonStr}')`,
        );
        this.db.exec(`UPDATE fts_files SET has_embedding = 1 WHERE id = ${file.id}`);
        indexed++;
      } catch {
        // Skip files whose embedding generation fails
      }

      batchCount++;
      if (batchCount >= 20) {
        batchCount = 0;
        onProgress?.(indexed, total);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return indexed;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * K-nearest-neighbour search using cosine distance.
   *
   * Returns results ordered by similarity (closest first). The query
   * vector is passed as a JSON-array string to the MATCH operator.
   *
   * @param queryEmbedding  The query vector as a Float32Array.
   * @param limit  Max results to return (capped at 100).
   */
  search(queryEmbedding: Float32Array, limit: number): VectorSearchHit[] {
    if (!this.extensionLoaded || limit < 1) return [];

    const maxResults = Math.max(1, Math.min(limit, 100));
    const jsonStr = `[${Array.from(queryEmbedding).join(',')}]`;

    try {
      const rows = this.db
        .prepare(`
          SELECT id, distance
          FROM vec_files
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?
        `)
        .all(jsonStr, maxResults) as Array<{ id: number; distance: number }>;

      return rows.map((row) => ({
        fileId: row.id,
        distance: row.distance,
        score: Math.max(0, Math.min(1, 1 - row.distance / 2)),
      }));
    } catch {
      return [];
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  /**
   * Return summary statistics about the vector index.
   */
  getStats(): VectorIndexStats {
    let totalEmbeddings = 0;
    if (this.extensionLoaded) {
      try {
        const row = this.db
          .prepare('SELECT COUNT(*) as cnt FROM vec_files')
          .get() as { cnt: number };
        totalEmbeddings = row.cnt;
      } catch {
        // Table may not exist yet
      }
    }

    return {
      totalEmbeddings,
      dbPath: this.dbPath,
      dimension: this.dimension,
      extensionLoaded: this.extensionLoaded,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Close the database connection (releases WAL resources).
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }
}
