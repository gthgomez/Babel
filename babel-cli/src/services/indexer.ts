import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { FtsSearchIndex, type FtsSearchHit } from './ftsIndex.js';
import { VectorIndex } from './vectorIndex.js';

export interface FileDocument {
  id: string;
  path: string;
  name: string;
  content: string;
  extension: string;
}

export interface SearchHit {
  id: string;
  name: string;
  score: number;
  snippet?: string;
}

export interface RepoMapEntry {
  path: string;
  extension: string;
  symbols: string[];
  preview?: string;
}

export interface RepoMap {
  schema_version: 1;
  root: string;
  generated_at: string;
  files_indexed: number;
  entries: RepoMapEntry[];
  coverage?: { complete: boolean; truncated: boolean; depth_limited: boolean; unreadable_files: number; unreadable_directories: number; target_exists: boolean };
}

export interface RepoMapOptions {
  limit?: number;
  target?: string | undefined;
  includePreview?: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cjs',
  '.cpp',
  '.cs',
  '.css',
  '.d.ts',
  '.dart',
  '.ex',
  '.exs',
  '.go',
  '.gradle',
  '.graphql',
  '.groovy',
  '.h',
  '.hpp',
  '.html',
  '.hs',
  '.java',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.kt',
  '.kts',
  '.lua',
  '.md',
  '.mjs',
  '.php',
  '.proto',
  '.ps1',
  '.py',
  '.pyi',
  '.rb',
  '.rs',
  '.sc',
  '.scala',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.godot',
  '.idea',
  '.next',
  '.terraform',
  '.turbo',
  '.venv',
  '.vscode',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'runs',
  'target',
  'vendor',
]);

/** Hard cap on files collected per index run. Prevents unbounded I/O and CPU
 *  on mega-repos (1M+ files). @see prePlanningDiscovery.ts MAX_DISCOVERY_FILES */
const MAX_INDEX_FILES = 50_000;

/** Maximum directory depth for recursive text-file collection. Acts as a
 *  structural fuse against deeply nested generated directories. */
const MAX_INDEX_DEPTH = 15;

function normalizeRepoPath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).replace(/\\/g, '/');
}

// ─── Extended symbol extraction (14+ languages) ──────────────────────────────

const SYMBOL_PATTERNS_BY_EXT: Record<string, Array<{ pattern: RegExp; kind: string }>> = {
  // TypeScript
  ts: [
    { pattern: /(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z0-9_$]+)/gm, kind: 'class' },
    { pattern: /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/gm, kind: 'interface' },
    { pattern: /(?:export\s+)?type\s+([a-zA-Z0-9_$]+)\s*=/gm, kind: 'type' },
    {
      pattern: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/gm,
      kind: 'function',
    },
    {
      pattern:
        /(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/gm,
      kind: 'function',
    },
    { pattern: /(?:export\s+)?enum\s+([a-zA-Z0-9_$]+)/gm, kind: 'enum' },
  ],
  // JavaScript
  js: [
    { pattern: /(?:export\s+(?:default\s+)?)?class\s+([a-zA-Z0-9_$]+)/gm, kind: 'class' },
    {
      pattern: /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/gm,
      kind: 'function',
    },
    {
      pattern:
        /(?:export\s+)?const\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/gm,
      kind: 'function',
    },
  ],
  // Python
  py: [
    { pattern: /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm, kind: 'class' },
    { pattern: /^\s*(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm, kind: 'function' },
  ],
  // Go
  go: [
    { pattern: /^func\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'function' },
    { pattern: /^func\s+\([^)]+\)\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'method' },
    { pattern: /^type\s+([a-zA-Z0-9_]+)\s+(struct|interface)/gm, kind: 'type' },
  ],
  // Rust
  rs: [
    { pattern: /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/gm, kind: 'function' },
    { pattern: /(?:pub\s+)?struct\s+([a-zA-Z0-9_]+)/gm, kind: 'struct' },
    { pattern: /(?:pub\s+)?enum\s+([a-zA-Z0-9_]+)/gm, kind: 'enum' },
    { pattern: /(?:pub\s+)?trait\s+([a-zA-Z0-9_]+)/gm, kind: 'trait' },
    { pattern: /(?:pub\s+)?impl\s+([a-zA-Z0-9_]+)/gm, kind: 'impl' },
  ],
  // Java
  java: [
    {
      pattern: /(?:public\s+|private\s+|protected\s+|static\s+)*class\s+([a-zA-Z0-9_]+)/gm,
      kind: 'class',
    },
    {
      pattern: /(?:public\s+|private\s+|protected\s+|static\s+)*interface\s+([a-zA-Z0-9_]+)/gm,
      kind: 'interface',
    },
    {
      pattern:
        /(?:public\s+|private\s+|protected\s+|static\s+|synchronized\s+|final\s+)+[a-zA-Z0-9_<>@\[\]]+\s+([a-zA-Z0-9_]+)\s*\(/gm,
      kind: 'method',
    },
  ],
  // C# (.NET)
  cs: [
    {
      pattern:
        /(?:public\s+|private\s+|protected\s+|internal\s+|static\s+)*class\s+([a-zA-Z0-9_]+)/gm,
      kind: 'class',
    },
    {
      pattern:
        /(?:public\s+|private\s+|protected\s+|internal\s+|static\s+)*interface\s+([a-zA-Z0-9_]+)/gm,
      kind: 'interface',
    },
    {
      pattern:
        /(?:public\s+|private\s+|protected\s+|internal\s+|static\s+)*enum\s+([a-zA-Z0-9_]+)/gm,
      kind: 'enum',
    },
    {
      pattern:
        /(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|virtual\s+|override\s+)+[a-zA-Z0-9_<>\[\]]+\s+([a-zA-Z0-9_]+)\s*\(/gm,
      kind: 'method',
    },
  ],
  // Kotlin
  kt: [
    { pattern: /(?:data\s+)?class\s+([a-zA-Z0-9_]+)/gm, kind: 'class' },
    { pattern: /interface\s+([a-zA-Z0-9_]+)/gm, kind: 'interface' },
    { pattern: /object\s+([a-zA-Z0-9_]+)/gm, kind: 'object' },
    { pattern: /fun\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'function' },
    { pattern: /val\s+([a-zA-Z0-9_]+)\s*[=:]/gm, kind: 'property' },
  ],
  // Ruby
  rb: [
    { pattern: /^\s*class\s+([A-Z][a-zA-Z0-9_]*)/gm, kind: 'class' },
    { pattern: /^\s*module\s+([A-Z][a-zA-Z0-9_]*)/gm, kind: 'module' },
    { pattern: /^\s*def\s+([a-z_][a-zA-Z0-9_?!]*)/gm, kind: 'method' },
  ],
  // PHP
  php: [
    { pattern: /class\s+([a-zA-Z0-9_]+)/gm, kind: 'class' },
    { pattern: /interface\s+([a-zA-Z0-9_]+)/gm, kind: 'interface' },
    { pattern: /trait\s+([a-zA-Z0-9_]+)/gm, kind: 'trait' },
    { pattern: /function\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'function' },
  ],
  // Swift
  swift: [
    { pattern: /(?:public\s+|private\s+|internal\s+)?class\s+([a-zA-Z0-9_]+)/gm, kind: 'class' },
    { pattern: /(?:public\s+|private\s+|internal\s+)?struct\s+([a-zA-Z0-9_]+)/gm, kind: 'struct' },
    { pattern: /(?:public\s+|private\s+|internal\s+)?enum\s+([a-zA-Z0-9_]+)/gm, kind: 'enum' },
    {
      pattern: /(?:public\s+|private\s+|internal\s+)?protocol\s+([a-zA-Z0-9_]+)/gm,
      kind: 'protocol',
    },
    { pattern: /func\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'function' },
  ],
  // Scala
  scala: [
    { pattern: /class\s+([a-zA-Z0-9_]+)/gm, kind: 'class' },
    { pattern: /object\s+([a-zA-Z0-9_]+)/gm, kind: 'object' },
    { pattern: /trait\s+([a-zA-Z0-9_]+)/gm, kind: 'trait' },
    { pattern: /def\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'method' },
    { pattern: /val\s+([a-zA-Z0-9_]+)\s*[=:]/gm, kind: 'val' },
  ],
  // Haskell
  hs: [
    { pattern: /^data\s+([A-Z][a-zA-Z0-9_]*)/gm, kind: 'data' },
    { pattern: /^newtype\s+([A-Z][a-zA-Z0-9_]*)/gm, kind: 'newtype' },
    { pattern: /^type\s+([A-Z][a-zA-Z0-9_]*)/gm, kind: 'type' },
    { pattern: /^class\s+([A-Z][a-zA-Z0-9_]*)/gm, kind: 'class' },
    { pattern: /^([a-z][a-zA-Z0-9_]*)\s*::/gm, kind: 'function' },
  ],
  // Elixir
  ex: [
    { pattern: /defmodule\s+([A-Z][a-zA-Z0-9_.]+)\s+do/gm, kind: 'module' },
    { pattern: /def\s+([a-z_][a-zA-Z0-9_?!]*)\s*\(/gm, kind: 'function' },
    { pattern: /defp\s+([a-z_][a-zA-Z0-9_?!]*)\s*\(/gm, kind: 'private_function' },
  ],
  // Dart
  dart: [
    { pattern: /class\s+([a-zA-Z0-9_]+)/gm, kind: 'class' },
    { pattern: /enum\s+([a-zA-Z0-9_]+)/gm, kind: 'enum' },
    { pattern: /mixin\s+([a-zA-Z0-9_]+)/gm, kind: 'mixin' },
    { pattern: /(?:[a-zA-Z0-9_<>\[\]]+\s+)?([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/gm, kind: 'function' },
  ],
  // Lua
  lua: [
    { pattern: /function\s+([a-zA-Z0-9_.:]+)\s*\(/gm, kind: 'function' },
    { pattern: /local\s+function\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'local_function' },
  ],
  // Groovy
  groovy: [
    { pattern: /class\s+([a-zA-Z0-9_]+)/gm, kind: 'class' },
    { pattern: /interface\s+([a-zA-Z0-9_]+)/gm, kind: 'interface' },
    { pattern: /trait\s+([a-zA-Z0-9_]+)/gm, kind: 'trait' },
    { pattern: /def\s+([a-zA-Z0-9_]+)\s*\(/gm, kind: 'method' },
  ],
  // Shell
  sh: [{ pattern: /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)/gm, kind: 'function' }],
  // SQL
  sql: [
    {
      pattern:
        /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gim,
      kind: 'definition',
    },
  ],
};

// Alias extensions to their canonical form
SYMBOL_PATTERNS_BY_EXT['tsx'] = SYMBOL_PATTERNS_BY_EXT['ts']!;
SYMBOL_PATTERNS_BY_EXT['jsx'] = SYMBOL_PATTERNS_BY_EXT['js']!;
SYMBOL_PATTERNS_BY_EXT['mjs'] = SYMBOL_PATTERNS_BY_EXT['js']!;
SYMBOL_PATTERNS_BY_EXT['cjs'] = SYMBOL_PATTERNS_BY_EXT['js']!;
SYMBOL_PATTERNS_BY_EXT['pyi'] = SYMBOL_PATTERNS_BY_EXT['py']!;
SYMBOL_PATTERNS_BY_EXT['kts'] = SYMBOL_PATTERNS_BY_EXT['kt']!;
SYMBOL_PATTERNS_BY_EXT['exs'] = SYMBOL_PATTERNS_BY_EXT['ex']!;
SYMBOL_PATTERNS_BY_EXT['sc'] = SYMBOL_PATTERNS_BY_EXT['scala']!;

function extractSymbols(content: string, extension: string): string[] {
  const ext = extension.toLowerCase().replace(/^\./, '');
  const patterns = SYMBOL_PATTERNS_BY_EXT[ext];

  if (!patterns) return [];

  const symbols = new Set<string>();
  for (const { pattern } of patterns) {
    // Clone regex to reset lastIndex for patterns with global flag
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of content.matchAll(re)) {
      const symbol = match[1]?.trim();
      if (symbol) {
        symbols.add(symbol);
      }
    }
  }
  return [...symbols].sort(
    (left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right),
  );
}

function previewContent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(' ')
    .slice(0, 240);
}

export function extractMatchingSnippet(content: string, query: string): string | undefined {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const normalized = line.toLowerCase();
    if (terms.length === 0 || terms.some((term) => normalized.includes(term))) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        return trimmed.slice(0, 200);
      }
    }
  }
  return previewContent(content) || undefined;
}

function resolveFtsDbPath(): string {
  const babelRoot = process.env['BABEL_ROOT'];
  if (babelRoot) {
    return join(babelRoot, 'runs', 'index', 'fts-index.db');
  }
  return join(process.cwd(), '.babel', 'fts-index.db');
}

export class SemanticIndexer {
  private ftsIndex: FtsSearchIndex | null = null;
  private vecIndex: VectorIndex | null = null;
  private indexedRoot: string | null = null;
  private readonly baseDbPath: string;
  private activeDbPath: string | null = null;
  private ready = false;
  private lifetime = 0;
  private revision = 0;
  private activeWork = false;
  private retirementRequested = false;
  private embedFn: ((text: string) => Float32Array | Promise<Float32Array>) | null = null;

  constructor(dbPath?: string) {
    this.baseDbPath = dbPath ?? resolveFtsDbPath();
  }

  /**
   * Register a text-to-embedding function. When set, the indexer will
   * attempt vector-based semantic search before falling back to FTS5.
   */
  public setEmbeddingFunction(
    fn: (text: string) => Float32Array | Promise<Float32Array>,
  ): void {
    this.embedFn = fn;
  }

  private get fts(): FtsSearchIndex {
    if (!this.ready || !this.ftsIndex) throw new Error('Semantic search unavailable: no ready project index');
    return this.ftsIndex;
  }

  /** Already-open vector view; read-only callers never initialize SQLite. */
  public get vectorIndex(): VectorIndex | null {
    return this.ready ? this.vecIndex : null;
  }

  private initializeVectorIndex(): void {
    if (!this.ready || !this.activeDbPath || !this.embedFn) return;
    if (this.vecIndex === null) {
      try {
        this.vecIndex = new VectorIndex(this.activeDbPath);
        // If the extension didn't load, discard the instance
        if (!this.vecIndex.getStats().extensionLoaded) {
          this.vecIndex.close();
          this.vecIndex = null;
        }
      } catch {
        this.vecIndex = null;
      }
    }
  }

  /**
   * The database file path shared by the FTS and vector indices.
   */
  public getDbPath(): string {
    return this.activeDbPath ?? this.baseDbPath;
  }

  public get indexedProjectRoot(): string | null {
    return this.ready ? this.indexedRoot : null;
  }

  /** Readiness is a side-effect-free check against a physical project root. */
  public isReadyForRoot(rootPath: string): boolean {
    try {
      return this.ready && this.ftsIndex !== null && this.indexedRoot === realpathSync(rootPath);
    } catch {
      return false;
    }
  }

  private dbPathForRoot(root: string): string {
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 24);
    const extension = extname(this.baseDbPath) || '.db';
    return join(dirname(this.baseDbPath), `${basename(this.baseDbPath, extension)}-${digest}${extension}`);
  }

  /** Keep a root switch and its search together across overlapping tasks. */
  private indexQueue: Promise<void> = Promise.resolve();

  private async withIndexLock<T>(work: (lifetime: number) => Promise<T>): Promise<T> {
    const lifetime = this.lifetime;
    const prior = this.indexQueue;
    let release!: () => void;
    this.indexQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    if (lifetime !== this.lifetime) {
      release();
      throw new Error('Semantic index lifetime retired');
    }
    this.activeWork = true;
    try {
      return await work(lifetime);
    } finally {
      this.activeWork = false;
      if (this.retirementRequested) {
        this.retireHandles();
        this.retirementRequested = false;
      }
      release();
    }
  }

  /** A search cannot race another task's project reindex. */
  public withProjectIndex<T>(
    rootPath: string,
    allowIndex: boolean,
    search: () => Promise<T>,
  ): Promise<T> {
    let root: string;
    try {
      root = realpathSync(rootPath);
    } catch (error) {
      if (!allowIndex) {
        return Promise.reject(new Error('Semantic search unavailable: no already-open index for this project in the read-only lane.'));
      }
      return Promise.reject(error);
    }
    return this.withIndexLock(async (lifetime) => {
      if (!this.isReadyForRoot(root)) {
        if (!allowIndex) throw new Error('Semantic search unavailable: no already-open index for this project in the read-only lane.');
        await this.indexProjectUnlocked(root, undefined, lifetime);
      }
      if (lifetime !== this.lifetime) throw new Error('Semantic index lifetime retired');
      const result = await search();
      if (lifetime !== this.lifetime || !this.isReadyForRoot(root)) {
        throw new Error('Semantic index query view retired');
      }
      return result;
    });
  }

  /** Incrementally index a project without racing another root switch. */
  public async indexProject(
    rootPath: string,
    options?: { force?: boolean; onProgress?: (indexed: number, total: number) => void; maxFiles?: number },
  ): Promise<number> {
    const root = realpathSync(rootPath);
    return this.withIndexLock((lifetime) => this.indexProjectUnlocked(root, options, lifetime));
  }

  private async indexProjectUnlocked(
    root: string,
    options?: { force?: boolean; onProgress?: (indexed: number, total: number) => void; maxFiles?: number },
    lifetime = this.lifetime,
  ): Promise<number> {
      let scanIncomplete = false;
      const files = await collectTextFiles(root, [], {
        ...(options?.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
        onDepthLimit: () => { scanIncomplete = true; },
        onUnreadableDirectory: () => { scanIncomplete = true; },
      });
      if (files.length >= (options?.maxFiles ?? MAX_INDEX_FILES)) scanIncomplete = true;
      if (lifetime !== this.lifetime) throw new Error('Semantic index lifetime retired');

      const fileEntries: Array<{ filePath: string; relativePath: string }> = [];
      for (const filePath of files) {
        const relativePath = normalizeRepoPath(root, filePath);
        fileEntries.push({ filePath, relativePath });
      }

      const sameRoot = this.isReadyForRoot(root);
      const nextDbPath = this.dbPathForRoot(root);
      const nextFts = sameRoot ? this.ftsIndex! : new FtsSearchIndex(nextDbPath);
      const discoveredPaths = new Set(fileEntries.map((entry) => entry.relativePath));
      if (sameRoot) this.ready = false;
      try {
        await nextFts.indexFiles(fileEntries, {
          ...options,
          rootPath: root,
          shouldContinue: () => lifetime === this.lifetime,
        });
        await nextFts.pruneMissing(root, scanIncomplete ? undefined : discoveredPaths,
          () => lifetime === this.lifetime);
        if (lifetime !== this.lifetime) throw new Error('Semantic index lifetime retired');

        if (!sameRoot) {
          this.vecIndex?.close();
          this.vecIndex = null;
          this.ftsIndex?.close();
          this.ftsIndex = nextFts;
        }
        this.activeDbPath = nextDbPath;
        this.indexedRoot = root;
        this.revision++;
        this.ready = true;
      } catch (error) {
        if (!sameRoot) nextFts.close();
        else this.close();
        throw error;
      }

      // ── Vector embedding generation (R2.5) ──────────────────────────────
      // After FTS indexing completes, generate embeddings for newly indexed
      // files. Skipped when no embedding provider is configured (graceful no-op).
      this.initializeVectorIndex();
      if (this.embedFn && this.vectorIndex) {
        try {
          await this.vectorIndex.indexEmbeddings(
            this.embedFn,
            options?.onProgress,
          );
        } catch {
          // Embedding generation failed — FTS search remains available
        }
      }

      if (lifetime !== this.lifetime) throw new Error('Semantic index lifetime retired');
      return nextFts.count;
  }

  /**
   * Search the persistent FTS index (synchronous, FTS5-only).
   *
   * This is the fast path used by the @-mention popup and semantic context
   * builder — it must remain synchronous. For embedding-based semantic search,
   * use {@link searchWithEmbedding} instead.
   */
  public search(query: string, limit = 5): SearchHit[] {
    const hits = this.fts.search(query, Math.max(1, limit));

    return hits.map((hit: FtsSearchHit) => ({
      id: hit.path,
      name: hit.name,
      score: hit.score,
      ...(hit.snippet !== undefined ? { snippet: hit.snippet } : {}),
    }));
  }

  /**
   * Search with embedding-based semantic ranking (R2.5).
   *
   * When an embedding function is registered via {@link setEmbeddingFunction}
   * and the vector index is available, this method:
   *   1. Converts the query to an embedding vector
   *   2. Performs KNN search via `vectorIndex.search()`
   *   3. Resolves vector hit file IDs to paths
   *   4. Falls back to FTS5 if vector search returns no hits or fails
   *
   * When no embedding function is registered, this delegates directly to
   * {@link search} (FTS5-only). This is the graceful no-op — embedding is
   * strictly additive and never blocks or degrades existing search.
   */
  public async searchWithEmbedding(query: string, limit = 5): Promise<SearchHit[]> {
    const fts = this.fts;
    const vector = this.vectorIndex;
    if (!this.embedFn || !vector) {
      return this.search(query, limit);
    }
    const root = this.indexedRoot;
    const lifetime = this.lifetime;
    const revision = this.revision;
    const currentView = () =>
      this.ready && this.indexedRoot === root && this.lifetime === lifetime &&
      this.revision === revision &&
      this.ftsIndex === fts && this.vecIndex === vector;

    try {
      const queryVec = await this.embedFn(query);
      if (!currentView()) throw new Error('Semantic index query view retired');
      const vectorHits = vector.search(queryVec, Math.max(1, limit));

      if (vectorHits.length === 0) {
        return this.search(query, limit);
      }

      // Resolve vector hit file IDs to path/name pairs
      const fileIds = vectorHits.map((h) => h.fileId);
      const idToPath = fts.resolveFilePaths(fileIds);

      return vectorHits
        .map((hit) => {
          const file = idToPath.get(hit.fileId);
          return file ? { id: file.path, name: file.name, score: hit.score } : null;
        })
        .filter((hit): hit is SearchHit => hit !== null);
    } catch {
      if (!currentView()) throw new Error('Semantic index query view retired');
      // Vector search failed — fall back to FTS5
      return this.search(query, limit);
    }
  }

  /**
   * Number of files currently indexed.
   */
  public get count(): number {
    return this.ready && this.ftsIndex ? this.ftsIndex.count : 0;
  }

  /**
   * Access the underlying FTS index for advanced queries.
   */
  public get underlyingFts(): FtsSearchIndex {
    return this.fts;
  }

  /**
   * Close the index (releases SQLite WAL).
   */
  public close(): void {
    this.lifetime++;
    this.ready = false;
    this.indexedRoot = null;
    if (this.activeWork) {
      this.retirementRequested = true;
      return;
    }
    this.retireHandles();
  }

  private retireHandles(): void {
    if (this.ftsIndex) {
      this.ftsIndex.close();
      this.ftsIndex = null;
    }
    if (this.vecIndex) {
      this.vecIndex.close();
      this.vecIndex = null;
    }
    this.activeDbPath = null;
  }
}

/**
 * Recursively collect text files under one or more directory roots.
 *
 * Guardrails (all default to generous values; override via `options`):
 *   - `maxFiles` — hard cap on total files collected (prevents unbounded I/O)
 *   - `maxDepth` — structural fuse against deeply nested generated dirs
 *   - `SKIPPED_DIRECTORIES` — cache / build / dependency dirs are excluded
 *   - `TEXT_EXTENSIONS`  — only recognized source / config / doc extensions
 */
export async function collectTextFiles(
  dir: string | string[],
  allFiles: string[] = [],
  options: {
    projectRoot?: string;
    taskTokens?: string[];
    maxDepth?: number;
    currentDepth?: number;
    /** Hard cap on total files collected. Defaults to {@link MAX_INDEX_FILES}. */
    maxFiles?: number;
    onDepthLimit?: () => void;
    onUnreadableDirectory?: () => void;
  } = {},
): Promise<string[]> {
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : undefined;
  const maxDepth = options.maxDepth ?? MAX_INDEX_DEPTH;
  const currentDepth = options.currentDepth ?? 0;
  const maxFiles = options.maxFiles ?? MAX_INDEX_FILES;

  // Bail early if we already hit the cap (can happen after recursive calls).
  if (allFiles.length >= maxFiles) return allFiles;

  if (Array.isArray(dir)) {
    for (const d of dir) {
      await collectTextFiles(d, allFiles, {
        ...options,
        maxFiles,
        currentDepth: 0,
      });
      if (allFiles.length >= maxFiles) return allFiles;
    }
    return allFiles;
  }

  const resolvedDir = resolve(dir);
  if (!existsSync(resolvedDir)) {
    return allFiles;
  }

  const isProjRoot =
    projectRoot &&
    (process.platform === 'win32'
      ? resolvedDir.toLowerCase() === projectRoot.toLowerCase()
      : resolvedDir === projectRoot);

  // Depth guard — applies to project root AND sibling roots alike.
  if (currentDepth > maxDepth) {
    options.onDepthLimit?.();
    return allFiles;
  }

  // If we are scanning a sibling approved read root (not project root), enforce task-token guard.
  if (!isProjRoot && projectRoot) {
    // At depth 1 (immediate children of an approved read root), check folder token match
    if (currentDepth === 1 && options.taskTokens && options.taskTokens.length > 0) {
      const base = basename(resolvedDir).toLowerCase();
      const match = options.taskTokens.some(
        (token) => base === token.toLowerCase() || base.includes(token.toLowerCase()),
      );
      if (!match) {
        return allFiles;
      }
    }
  }

  try {
    if (!statSync(resolvedDir).isDirectory()) return allFiles;
  } catch {
    options.onUnreadableDirectory?.();
    return allFiles;
  }

  let entries;
  try {
    entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  } catch {
    options.onUnreadableDirectory?.();
    return allFiles;
  }

  for (const entry of entries) {
    // Early exit once the cap is hit — don't waste I/O on remaining entries.
    if (allFiles.length >= maxFiles) return allFiles;

    const fullPath = join(resolvedDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await collectTextFiles(fullPath, allFiles, {
        ...options,
        maxFiles,
        currentDepth: currentDepth + 1,
      });
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      allFiles.push(fullPath);
    }
  }
  return allFiles;
}

export async function buildRepoMap(
  rootPath: string,
  options: RepoMapOptions = {},
): Promise<RepoMap> {
  const root = realpathSync(rootPath);
  const limit = Math.max(1, options.limit ?? 200);
  const requestedTarget = options.target ? resolve(root, options.target) : root;
  const lexicalRelative = relative(root, requestedTarget);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new Error('Repo map target is outside the project root');
  }
  const targetExists = existsSync(requestedTarget);
  const target = targetExists ? realpathSync(requestedTarget) : requestedTarget;
  const physicalRelative = relative(root, target);
  if (physicalRelative === '..' || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) {
    throw new Error('Repo map target resolves outside the project root');
  }
  const targetIsFile = targetExists && statSync(target).isFile();
  let depthLimited = false;
  let unreadableDirectories = 0;
  const collected = !targetExists
    ? []
    : targetIsFile
      ? (TEXT_EXTENSIONS.has(extname(target).toLowerCase()) ? [target] : [])
      : await collectTextFiles(target, [], {
          maxFiles: limit + 1,
          onDepthLimit: () => { depthLimited = true; },
          onUnreadableDirectory: () => { unreadableDirectories++; },
        });
  const truncated = collected.length > limit;
  const files = collected
    .map((filePath) => ({ filePath, relativePath: normalizeRepoPath(root, filePath) }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .slice(0, limit);

  const entries: RepoMapEntry[] = [];
  let unreadableFiles = 0;
  for (const { filePath, relativePath } of files) {
    const file = FtsSearchIndex.readFileContent(filePath, root);
    if (file) {
      const content = file.content;
      const extension = extname(filePath).toLowerCase();
      entries.push({
        path: relativePath,
        extension,
        symbols: extractSymbols(content.slice(0, 16_384), extension),
        ...(options.includePreview ? { preview: previewContent(content) } : {}),
      });
    } else {
      unreadableFiles++;
    }
  }

  return {
    schema_version: 1,
    root,
    generated_at: new Date().toISOString(),
    files_indexed: entries.length,
    entries,
    coverage: {
      complete: targetExists && !truncated && !depthLimited && unreadableFiles === 0 && unreadableDirectories === 0,
      truncated,
      depth_limited: depthLimited,
      unreadable_files: unreadableFiles,
      unreadable_directories: unreadableDirectories,
      target_exists: targetExists,
    },
  };
}

export function formatRepoMapHuman(repoMap: RepoMap): string {
  return [
    `Repo map: ${repoMap.root}`,
    `Files indexed: ${repoMap.files_indexed}`,
    ...repoMap.entries.map((entry) => {
      const symbolText = entry.symbols.length > 0 ? ` symbols=${entry.symbols.join(',')}` : '';
      return `  ${entry.path}${symbolText}`;
    }),
  ].join('\n');
}

// ── Cached Repo Map ──────────────────────────────────────────────────────────

const REPO_MAP_CACHE_DIR = '.babel';
const REPO_MAP_CACHE_FILE = 'repo-map.json';
const REPO_MAP_SCHEMA_VERSION = 1;

interface CachedRepoMap {
  schema_version: number;
  generated_at: string;
  project_root: string;
  file_count: number;
  entries: RepoMapEntry[];
  content_fingerprint: string;
}

function getRepoMapCachePath(projectRoot: string): string {
  return join(projectRoot, REPO_MAP_CACHE_DIR, REPO_MAP_CACHE_FILE);
}

/**
 * Load a cached repo map from disk if it exists and is still fresh.
 * Returns null if no cache exists or the cache is stale.
 *
 * Staleness is determined by comparing mtimes of key directories (src/, lib/,
 * app/) against the cache timestamp. If any key dir is newer, the cache is
 * considered stale and is discarded.
 */
export function loadCachedRepoMap(projectRoot: string): RepoMap | null {
  const cachePath = getRepoMapCachePath(projectRoot);
  if (!existsSync(cachePath)) return null;

  try {
    const raw = readFileSync(cachePath, 'utf-8');
    const cached: CachedRepoMap = JSON.parse(raw);
    if (cached.schema_version !== REPO_MAP_SCHEMA_VERSION) return null;

    // Staleness check: if any key source directory is newer than the cache,
    // the cache is stale.
    const cacheTime = new Date(cached.generated_at).getTime();
    const watchDirs = ['src', 'lib', 'app', 'packages', 'crates'];
    for (const dir of watchDirs) {
      const dirPath = join(projectRoot, dir);
      if (existsSync(dirPath)) {
        const dirStat = statSync(dirPath);
        if (dirStat.mtimeMs > cacheTime) return null;
        // Also check immediate children for freshness
        const children = readdirSync(dirPath, { withFileTypes: true });
        for (const child of children) {
          if (child.isDirectory()) {
            const childPath = join(dirPath, child.name);
            const childStat = statSync(childPath);
            if (childStat.mtimeMs > cacheTime) return null;
          }
        }
      }
    }

    // Also check key config files
    const watchFiles = ['package.json', 'tsconfig.json', 'CLAUDE.md', 'AGENTS.md'];
    for (const file of watchFiles) {
      const filePath = join(projectRoot, file);
      if (existsSync(filePath)) {
        const fileStat = statSync(filePath);
        if (fileStat.mtimeMs > cacheTime) return null;
      }
    }

    return {
      schema_version: 1,
      root: cached.project_root,
      generated_at: cached.generated_at,
      files_indexed: cached.file_count,
      entries: cached.entries,
    };
  } catch {
    return null;
  }
}

/**
 * Build a repo map from the FTS index cache (no directory walk needed).
 * The FTS DB already stores every file's content — we just extract symbols
 * from those cached contents and write a structured summary to disk.
 *
 * Falls back to a lightweight directory scan if the FTS index isn't ready yet.
 */
export async function buildCachedRepoMap(
  projectRoot: string,
  options?: { maxEntries?: number },
): Promise<RepoMap> {
  const root = resolve(projectRoot);
  const maxEntries = Math.max(1, options?.maxEntries ?? 60);

  const indexer = getGlobalIndexer();
  const hasIndex = indexer.isReadyForRoot(root) && indexer.count > 0;

  let entries: RepoMapEntry[] = [];

  if (hasIndex) {
    // Fast path: extract symbols from FTS-cached content
    const paths = indexer.underlyingFts.listPaths();
    const sorted = sortRepoPathsByImportance(paths);

    for (const relPath of sorted) {
      if (entries.length >= maxEntries) break;
      try {
        const content = indexer.underlyingFts.getContent(relPath);
        if (!content) continue;
        const ext = extname(relPath).toLowerCase();
        const symbols = extractSymbols(content.slice(0, 16_384), ext);
        entries.push({ path: relPath, extension: ext, symbols });
      } catch {
        // Skip unreadable entries
      }
    }
  }

  // Slow path (or supplement): scan top-level structure for context files
  // not yet in the FTS index
  const supplemental = await collectTextFiles(root, [], { maxFiles: 20, maxDepth: 2 });
  for (const f of supplemental) {
    const relPath = relative(root, f).replace(/\\/g, '/');
    if (entries.some((e) => e.path === relPath)) continue;
    if (entries.length >= maxEntries) break;
    try {
      const content = readFileSync(f, 'utf-8');
      const ext = extname(f).toLowerCase();
      const symbols = extractSymbols(content.slice(0, 16_384), ext);
      entries.push({ path: relPath, extension: ext, symbols });
    } catch {
      // Skip
    }
  }

  // Sort final entries by importance
  entries = sortRepoEntriesByImportance(entries);

  const repoMap: RepoMap = {
    schema_version: 1,
    root,
    generated_at: new Date().toISOString(),
    files_indexed: entries.length,
    entries,
  };

  // Write cache atomically
  try {
    const cacheDir = join(root, REPO_MAP_CACHE_DIR);
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = getRepoMapCachePath(root);
    const tempPath = cachePath + '.tmp';
    const cached: CachedRepoMap = {
      schema_version: REPO_MAP_SCHEMA_VERSION,
      generated_at: repoMap.generated_at,
      project_root: root,
      file_count: repoMap.files_indexed,
      entries: repoMap.entries,
      content_fingerprint: `${repoMap.files_indexed}_${repoMap.generated_at}`,
    };
    writeFileSync(tempPath, JSON.stringify(cached, null, 2), 'utf-8');
    renameSync(tempPath, cachePath);
  } catch {
    // Non-fatal — cache write failure shouldn't break the session
  }

  return repoMap;
}

/** Sort paths so the most important files (configs, entry points) come first. */
function sortRepoPathsByImportance(paths: string[]): string[] {
  const configPriority = /^[^/]*\.(json|ya?ml|toml|md)$/i;
  const entryPriority = /(^|\/)(index|main|app|server|cli)\.(ts|js|tsx|jsx|py|rs|go)$/i;
  const sourcePriority = /\.(ts|tsx|js|jsx|py|rs|go|java|rb)$/i;

  const scored = paths.map((p) => {
    let score = 0;
    if (configPriority.test(p)) score = 100;
    if (entryPriority.test(p)) score = 200;
    if (p.startsWith('src/')) score += 10;
    if (!sourcePriority.test(p)) score -= 50;
    return { path: p, score };
  });

  return scored.sort((a, b) => b.score - a.score).map((s) => s.path);
}

function sortRepoEntriesByImportance(entries: RepoMapEntry[]): RepoMapEntry[] {
  const configPriority = /^[^/]*\.(json|ya?ml|toml|md)$/i;
  const entryPriority = /(^|\/)(index|main|app|server|cli)\.(ts|js|tsx|jsx|py|rs|go)$/i;
  const scoreEntry = (e: RepoMapEntry) => {
    let s = 0;
    if (configPriority.test(e.path)) s = 100;
    if (entryPriority.test(e.path)) s = 200;
    if (e.path.startsWith('src/')) s += 10;
    if (e.symbols.length > 0) s += 5;
    return s;
  };
  return entries.sort((a, b) => scoreEntry(b) - scoreEntry(a));
}

let _globalIndexer: SemanticIndexer | null = null;

export function getGlobalIndexer(): SemanticIndexer {
  if (!_globalIndexer) {
    _globalIndexer = new SemanticIndexer();
  }
  return _globalIndexer;
}

/**
 * Lazy-initialized global semantic indexer.
 * The underlying SQLite FTS5 database is opened on first use, not at module load.
 *
 * The vector index (sqlite-vec) is lazily initialised on first access via
 * the `vectorIndex` property. It shares the same SQLite database file, so
 * no separate configuration is needed.
 */
export const globalIndexer = {
  get indexedProjectRoot(): string | null {
    return getGlobalIndexer().indexedProjectRoot;
  },
  get count(): number {
    return getGlobalIndexer().count;
  },
  isReadyForRoot(rootPath: string): boolean {
    return getGlobalIndexer().isReadyForRoot(rootPath);
  },
  get underlyingFts(): FtsSearchIndex {
    return getGlobalIndexer().underlyingFts;
  },
  get vectorIndex(): VectorIndex | null {
    return getGlobalIndexer().vectorIndex;
  },
  setEmbeddingFunction(
    fn: (text: string) => Float32Array | Promise<Float32Array>,
  ): void {
    return getGlobalIndexer().setEmbeddingFunction(fn);
  },
  getDbPath(): string {
    return getGlobalIndexer().getDbPath();
  },
  indexProject(
    rootPath: string,
    options?: { force?: boolean; onProgress?: (indexed: number, total: number) => void },
  ): Promise<number> {
    return getGlobalIndexer().indexProject(rootPath, options);
  },
  search(query: string, limit?: number) {
    return getGlobalIndexer().search(query, limit);
  },
  searchWithEmbedding(query: string, limit?: number) {
    return getGlobalIndexer().searchWithEmbedding(query, limit);
  },
  withProjectIndex<T>(rootPath: string, allowIndex: boolean, search: () => Promise<T>): Promise<T> {
    return getGlobalIndexer().withProjectIndex(rootPath, allowIndex, search);
  },
  close(): void {
    return getGlobalIndexer().close();
  },
};
