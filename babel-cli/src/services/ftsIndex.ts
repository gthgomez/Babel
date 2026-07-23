import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FtsSearchHit {
  path: string;
  name: string;
  score: number;
  snippet?: string;
}

export interface FtsIndexStats {
  totalFiles: number;
  totalBytes: number;
  dbPath: string;
  hasFts5: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CONTENT_BYTES = 128 * 1024; // 128 KB max per file for indexing

// ─── FtsSearchIndex ───────────────────────────────────────────────────────────

export class FtsSearchIndex {
  private db: DatabaseSync;
  private dbPath: string;
  private fts5Available = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.initialize();
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  private initialize(): void {
    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fts_files_path ON fts_files(path)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fts_files_hash ON fts_files(content_hash)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fts_files_name ON fts_files(name)
    `);

    // Try to create FTS5 virtual table
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_search USING fts5(
          path, name, content,
          tokenize='porter unicode61',
          content='fts_files',
          content_rowid='id'
        )
      `);
      this.fts5Available = true;
    } catch {
      // FTS5 not available in this SQLite build — LIKE-based search will be used
      this.fts5Available = false;
    }
  }

  // ── Indexing ──────────────────────────────────────────────────────────────

  /**
   * Compute SHA-256 hash of content.
   */
  static hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Read a file's content (first MAX_CONTENT_BYTES bytes) and compute its hash.
   */
  static readFileContent(
    filePath: string,
  ): { content: string; hash: string; sizeBytes: number } | null {
    try {
      const stat = statSync(filePath);
      const sizeBytes = stat.size;
      const raw = readFileSync(filePath, 'utf-8');
      const content = raw.length > MAX_CONTENT_BYTES ? raw.slice(0, MAX_CONTENT_BYTES) : raw;
      return { content, hash: FtsSearchIndex.hashContent(content), sizeBytes };
    } catch {
      return null;
    }
  }

  /**
   * Get the stored hash for a file path (null if not indexed).
   */
  getStoredHash(filePath: string): string | null {
    const row = this.db
      .prepare('SELECT content_hash FROM fts_files WHERE path = ?')
      .get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  /**
   * Upsert a single file into the index.
   * Returns true if the file was actually indexed (changed or new).
   */
  upsertFile(filePath: string, relativePath: string): boolean {
    const fileData = FtsSearchIndex.readFileContent(filePath);
    if (!fileData) return false;

    const storedHash = this.getStoredHash(relativePath);
    if (storedHash === fileData.hash) {
      // Content unchanged — skip reindexing
      return false;
    }

    const name = basename(filePath);
    const ext = extname(filePath).toLowerCase();

    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO fts_files (path, name, content, extension, content_hash, size_bytes, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      )
      .run(relativePath, name, fileData.content, ext, fileData.hash, fileData.sizeBytes);

    return true;
  }

  /**
   * Read a single file and prepare its indexing data.
   * Returns null if the file cannot be read.
   */
  private indexSingleFile(
    filePath: string,
  ): { content: string; hash: string; sizeBytes: number; name: string; ext: string } | null {
    const fileData = FtsSearchIndex.readFileContent(filePath);
    if (!fileData) return null;
    return {
      ...fileData,
      name: basename(filePath),
      ext: extname(filePath).toLowerCase(),
    };
  }

  /**
   * Bulk-index files with incremental update (skip unchanged files).
   * Processes files in batches, yielding to the event loop between batches
   * to keep the REPL responsive during background indexing.
   * Returns the count of files actually indexed/reindexed.
   */
  async indexFiles(
    files: Array<{ filePath: string; relativePath: string }>,
    options?: { force?: boolean; onProgress?: (indexed: number, total: number) => void },
  ): Promise<number> {
    const BATCH_SIZE = 50;
    const total = files.length;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO fts_files (path, name, content, extension, content_hash, size_bytes, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    let indexed = 0;
    let batchCount = 0;

    for (const { filePath, relativePath } of files) {
      const data = this.indexSingleFile(filePath);
      if (!data) continue;

      if (!options?.force) {
        const storedHash = this.getStoredHash(relativePath);
        if (storedHash === data.hash) continue;
      }

      insert.run(relativePath, data.name, data.content, data.ext, data.hash, data.sizeBytes);
      indexed++;
      batchCount++;

      // Yield to the event loop every BATCH_SIZE files so the REPL and other
      // I/O stay responsive during background indexing of large repos.
      if (batchCount >= BATCH_SIZE) {
        batchCount = 0;
        options?.onProgress?.(indexed, total);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // Rebuild FTS index
    this.rebuildFts();

    return indexed;
  }

  /**
   * Remove files from the index that no longer exist on disk.
   * Yields to the event loop periodically to avoid blocking the REPL.
   */
  async pruneMissing(rootPath: string): Promise<number> {
    const BATCH_SIZE = 100;

    const allPaths = this.db.prepare('SELECT path FROM fts_files').all() as Array<{ path: string }>;

    let removed = 0;
    let batchCount = 0;
    const del = this.db.prepare('DELETE FROM fts_files WHERE path = ?');

    for (const row of allPaths) {
      const absPath = join(rootPath, row.path);
      if (!existsSync(absPath)) {
        del.run(row.path);
        removed++;
      }
      batchCount++;

      if (batchCount >= BATCH_SIZE) {
        batchCount = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (removed > 0) {
      this.rebuildFts();
    }

    return removed;
  }

  /**
   * Clear all indexed data.
   */
  clear(): void {
    this.db.exec('DELETE FROM fts_files');
    this.rebuildFts();
  }

  private rebuildFts(): void {
    if (!this.fts5Available) return;
    try {
      this.db.exec("INSERT INTO fts_search(fts_search) VALUES('rebuild')");
    } catch {
      // Ignore rebuild failures
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * Full-text search using FTS5 when available, falling back to LIKE.
   */
  search(query: string, limit = 5): FtsSearchHit[] {
    if (this.fts5Available) {
      return this.searchFts5(query, limit);
    }
    return this.searchLike(query, limit);
  }

  private searchFts5(query: string, limit: number): FtsSearchHit[] {
    // Sanitize FTS5 query: escape special characters, wrap terms for prefix matching
    const sanitized = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => {
        // Add prefix matching for partial words
        if (term.length >= 2) return `${term}*`;
        return term;
      })
      .join(' ');

    if (!sanitized) return [];

    try {
      const rows = this.db
        .prepare(
          `
          SELECT path, name,
                 snippet(fts_search, 2, '<b>', '</b>', '...', 32) as snippet,
                 rank
            FROM fts_search
           WHERE fts_search MATCH ?
           ORDER BY rank
           LIMIT ?
        `,
        )
        .all(sanitized, Math.max(1, Math.min(limit, 100))) as Array<{
        path: string;
        name: string;
        snippet: string;
        rank: number;
      }>;

      return rows.map((row) => {
        const snippet = this.cleanSnippet(row.snippet);
        const hit: FtsSearchHit = {
          path: row.path,
          name: row.name,
          score: parseFloat((1.0 / (1.0 + Math.abs(row.rank ?? 0))).toFixed(4)),
        };
        if (snippet !== undefined) {
          hit.snippet = snippet;
        }
        return hit;
      });
    } catch {
      return this.searchLike(query, limit);
    }
  }

  private searchLike(query: string, limit: number): FtsSearchHit[] {
    const likeQuery = `%${query.replace(/[%_]/g, '\\$&')}%`;
    const maxResults = Math.max(1, Math.min(limit, 100));

    // Score: name matches > path matches > content matches
    const rows = this.db
      .prepare(
        `
        SELECT path, name, extension,
               CASE
                 WHEN name LIKE ? ESCAPE '\\' THEN 0.9
                 WHEN path LIKE ? ESCAPE '\\' THEN 0.7
                 ELSE 0.5
               END as score
          FROM fts_files
         WHERE content LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
         ORDER BY score DESC
         LIMIT ?
      `,
      )
      .all(likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, maxResults) as Array<{
      path: string;
      name: string;
      extension: string;
      score: number;
    }>;

    return rows.map((row) => ({
      path: row.path,
      name: row.name,
      score: parseFloat(row.score.toFixed(4)),
    }));
  }

  private cleanSnippet(snippet: string): string | undefined {
    if (!snippet || snippet.length === 0) return undefined;
    const cleaned = snippet.replace(/<b>/g, '').replace(/<\/b>/g, '');
    return cleaned.length > 0 ? cleaned : undefined;
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  /**
   * Look up stored content for a file.
   */
  getContent(path: string): string | null {
    const row = this.db.prepare('SELECT content FROM fts_files WHERE path = ?').get(path) as
      | { content: string }
      | undefined;
    return row?.content ?? null;
  }

  /**
   * Get file count.
   */
  get count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM fts_files').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Get index stats.
   */
  getStats(): FtsIndexStats {
    const countRow = this.db
      .prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as total_bytes FROM fts_files')
      .get() as { cnt: number; total_bytes: number };

    return {
      totalFiles: countRow.cnt,
      totalBytes: countRow.total_bytes,
      dbPath: this.dbPath,
      hasFts5: this.fts5Available,
    };
  }

  /**
   * List all indexed file paths.
   */
  listPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM fts_files ORDER BY path').all() as Array<{
      path: string;
    }>;
    return rows.map((r) => r.path);
  }

  /**
   * Resolve file IDs to path/name pairs (for vector search result mapping).
   * Returns a Map for O(1) lookup by the caller.
   */
  resolveFilePaths(ids: number[]): Map<number, { path: string; name: string }> {
    const result = new Map<number, { path: string; name: string }>();
    if (ids.length === 0) return result;

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, path, name FROM fts_files WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: number; path: string; name: string }>;

    for (const row of rows) {
      result.set(row.id, { path: row.path, name: row.name });
    }
    return result;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }
}
