/**
 * cacheCoherence.ts — Unified Cache Coherence Manager (P1.4)
 *
 * Registers all three caches (compiler file cache, token count cache, tool
 * result cache) behind a single invalidation bus. When a file_write,
 * shell_exec, or test_run succeeds, all three caches invalidate entries
 * for the affected paths.
 *
 * This prevents stale compiler cache entries after a file_write, stale
 * tool results after mutation, and stale token counts after file changes.
 */

import { existsSync, statSync } from 'node:fs';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  /** Unix timestamp of last access */
  lastAccess: number;
  /** Optional: file path this entry depends on */
  dependsOn?: string;
  /** Optional: file mtime when cached */
  mtimeMs?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  entries: number;
}

export interface CacheAdapter<T = unknown> {
  /** Unique name for this cache */
  name: string;
  /** Get an entry by key */
  get(key: string): T | undefined | null;
  /** Set an entry */
  set(key: string, value: T, dependsOn?: string): void;
  /** Delete an entry by key */
  delete(key: string): boolean;
  /** Check if an entry exists and is fresh for the given path */
  isFresh(key: string, path?: string): boolean;
  /** Invalidate all entries that depend on the given path */
  invalidateByPath(path: string): number;
  /** Clear all entries */
  clear(): void;
  /** Get cache statistics */
  stats(): CacheStats;
}

// ── In-Memory Cache ──────────────────────────────────────────────────────────

export class InMemoryCache<T = unknown> implements CacheAdapter<T> {
  readonly name: string;
  private store = new Map<string, CacheEntry<T>>();
  private _hits = 0;
  private _misses = 0;
  private _invalidations = 0;
  private maxEntries: number;

  constructor(name: string, maxEntries = 256) {
    this.name = name;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry) {
      entry.lastAccess = Date.now();
      this._hits++;
      return entry.value;
    }
    this._misses++;
    return undefined;
  }

  set(key: string, value: T, dependsOn?: string): void {
    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, e] of this.store) {
        if (e.lastAccess < oldestTime) {
          oldestTime = e.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }

    const entry: CacheEntry<T> = {
      key,
      value,
      lastAccess: Date.now(),
    };
    if (dependsOn !== undefined) {
      entry.dependsOn = dependsOn;
      if (existsSync(dependsOn)) {
        entry.mtimeMs = statSync(dependsOn).mtimeMs;
      }
    }
    this.store.set(key, entry);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  isFresh(key: string, path?: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;

    const checkPath = path ?? entry.dependsOn;
    if (!checkPath) return true; // No path dependency, always fresh

    if (!existsSync(checkPath)) return false; // File was deleted

    try {
      const currentMtime = statSync(checkPath).mtimeMs;
      return entry.mtimeMs === currentMtime;
    } catch {
      return false;
    }
  }

  invalidateByPath(path: string): number {
    let count = 0;
    const normalizedPath = path.replace(/\\/g, '/').toLowerCase();

    for (const [key, entry] of this.store) {
      const depPath = entry.dependsOn?.replace(/\\/g, '/').toLowerCase();
      if (depPath && (depPath === normalizedPath || depPath.startsWith(normalizedPath + '/'))) {
        this.store.delete(key);
        count++;
        this._invalidations++;
      }
    }

    return count;
  }

  clear(): void {
    this.store.clear();
  }

  stats(): CacheStats {
    return {
      hits: this._hits,
      misses: this._misses,
      invalidations: this._invalidations,
      entries: this.store.size,
    };
  }
}

// ── Coherence Manager ────────────────────────────────────────────────────────

export class CacheCoherenceManager {
  private adapters: CacheAdapter[] = [];
  private static instance: CacheCoherenceManager | null = null;

  static getInstance(): CacheCoherenceManager {
    if (!CacheCoherenceManager.instance) {
      CacheCoherenceManager.instance = new CacheCoherenceManager();
    }
    return CacheCoherenceManager.instance;
  }

  /** Reset the singleton (for tests) */
  static resetInstance(): void {
    CacheCoherenceManager.instance = null;
  }

  register(adapter: CacheAdapter): void {
    // Avoid duplicates
    if (!this.adapters.some((a) => a.name === adapter.name)) {
      this.adapters.push(adapter);
    }
  }

  unregister(name: string): void {
    this.adapters = this.adapters.filter((a) => a.name !== name);
  }

  /**
   * Invalidate all caches for entries depending on the given file path.
   * Called after file_write, successful shell_exec, or test_run.
   */
  invalidatePath(path: string): void {
    for (const adapter of this.adapters) {
      try {
        const count = adapter.invalidateByPath(path);
        if (count > 0) {
          // Best-effort logging; not load-bearing
        }
      } catch {
        /* cache invalidation is advisory */
      }
    }
  }

  /**
   * Invalidate multiple paths at once.
   */
  invalidatePaths(paths: string[]): void {
    for (const path of paths) {
      this.invalidatePath(path);
    }
  }

  /**
   * Clear all registered caches.
   */
  clearAll(): void {
    for (const adapter of this.adapters) {
      try {
        adapter.clear();
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Get combined stats from all caches.
   */
  allStats(): Record<string, CacheStats> {
    const stats: Record<string, CacheStats> = {};
    for (const adapter of this.adapters) {
      stats[adapter.name] = adapter.stats();
    }
    return stats;
  }

  /**
   * Check freshness across all caches for a path.
   */
  isPathFreshAcrossCaches(path: string): boolean {
    for (const adapter of this.adapters) {
      if (!adapter.isFresh(path, path)) return false;
    }
    return true;
  }
}

// ── Global singleton ──────────────────────────────────────────────────────────

let globalCoherence: CacheCoherenceManager | null = null;

export function getCacheCoherence(): CacheCoherenceManager {
  if (!globalCoherence) {
    globalCoherence = CacheCoherenceManager.getInstance();
  }
  return globalCoherence;
}

export function resetCacheCoherence(): void {
  globalCoherence = null;
  CacheCoherenceManager.resetInstance();
}
