import type { ToolResult } from '../sandbox.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: ToolResult;
  cachedAt: number;
  ttlMs: number;
}

// ─── TTL by tool category ─────────────────────────────────────────────────────

const CATEGORY_TTL_MS: Record<string, number> = {
  search: 60_000, // 60s — code doesn't change that fast
  filesystem: 5_000, // 5s  — file state can change quickly
  web: 300_000, // 5min — external content is semi-stable
  git: 30_000, // 30s — git state changes on commit
};

const DEFAULT_TTL_MS = 10_000;

const TOOL_CATEGORY: Record<string, string> = {
  grep: 'search',
  glob: 'search',
  semantic_search: 'search',
  workspace_symbol_search: 'search',
  workspace_map: 'search',
  git_context: 'git',
  directory_list: 'filesystem',
  file_read: 'filesystem',
  web_search: 'web',
  web_fetch: 'web',
};

/** Tools that invalidate the entire cache when executed successfully */
const MUTATING_TOOLS = new Set(['file_write', 'shell_exec', 'test_run']);

function getTtlMs(toolName: string): number {
  const category = TOOL_CATEGORY[toolName];
  return category ? (CATEGORY_TTL_MS[category] ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
}

// ─── ToolResultCache ──────────────────────────────────────────────────────────

export class ToolResultCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 128) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * Build a deterministic cache key from tool name and input.
   */
  buildKey(toolName: string, input: Record<string, unknown>): string {
    // Sort keys for deterministic serialization
    const sorted = Object.keys(input)
      .sort()
      .reduce<Record<string, unknown>>((obj, key) => {
        obj[key] = input[key];
        return obj;
      }, {});
    return `${toolName}:${JSON.stringify(sorted)}`;
  }

  /**
   * Try to retrieve a cached result. Returns null on miss or expiry.
   */
  get(toolName: string, input: Record<string, unknown>): ToolResult | null {
    const key = this.buildKey(toolName, input);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // LRU: move to end by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.result;
  }

  /**
   * Store a tool result in the cache.
   */
  set(toolName: string, input: Record<string, unknown>, result: ToolResult): void {
    // Don't cache errors
    if (result.exit_code !== 0) return;

    const key = this.buildKey(toolName, input);

    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    const ttlMs = getTtlMs(toolName);
    this.cache.set(key, { result, cachedAt: Date.now(), ttlMs });
  }

  /**
   * Check if this tool's execution should invalidate the cache.
   * Mutating tools (file_write, shell_exec, test_run) clear the cache on success.
   */
  invalidateOnMutation(toolName: string, exitCode: number): void {
    if (MUTATING_TOOLS.has(toolName) && exitCode === 0) {
      this.invalidate();
    }
  }

  /**
   * Clear all cached entries.
   */
  invalidate(): void {
    this.cache.clear();
    // Don't reset hit/miss counters — they're useful for diagnostics
  }

  /**
   * Number of entries currently cached.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Cache hit rate since last invalidation.
   */
  get hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  /**
   * Diagnostic summary.
   */
  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    return {
      size: this.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hitRate,
    };
  }
}

// ─── Session singleton ────────────────────────────────────────────────────────

let sessionCache: ToolResultCache | null = null;

export function getSessionCache(): ToolResultCache {
  if (!sessionCache) {
    sessionCache = new ToolResultCache();
  }
  return sessionCache;
}

export function resetSessionCache(): void {
  sessionCache = null;
}
