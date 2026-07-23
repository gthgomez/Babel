/**
 * cacheCoherence.test.ts — Tests for Cache Coherence Manager (P1.4)
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  InMemoryCache,
  CacheCoherenceManager,
  getCacheCoherence,
  resetCacheCoherence,
} from './cacheCoherence.js';

// ── InMemoryCache Tests ──────────────────────────────────────────────────────

describe('InMemoryCache', () => {
  let cache: InMemoryCache<string>;

  beforeEach(() => {
    cache = new InMemoryCache<string>('test-cache', 10);
  });

  it('stores and retrieves values', () => {
    cache.set('key1', 'value1');
    assert.equal(cache.get('key1'), 'value1');
  });

  it('returns undefined for missing keys', () => {
    assert.equal(cache.get('missing'), undefined);
  });

  it('tracks hits and misses in stats', () => {
    cache.set('a', '1');
    cache.get('a');
    cache.get('a');
    cache.get('b');
    const s = cache.stats();
    assert.equal(s.hits, 2);
    assert.equal(s.misses, 1);
    assert.equal(s.entries, 1);
  });

  it('evicts oldest entry when at capacity', () => {
    const small = new InMemoryCache<string>('small', 3);
    small.set('a', '1');
    small.set('b', '2');
    small.set('c', '3');
    small.set('d', '4'); // should evict 'a'
    assert.equal(small.get('a'), undefined);
    assert.equal(small.get('d'), '4');
  });

  it('invalidates entries by path dependency', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-coherence-'));
    try {
      const filePath = join(tmpDir, 'test.txt');
      writeFileSync(filePath, 'hello', 'utf-8');
      // Force a known mtime in the past so modification is detectable
      const pastTime = new Date(Date.now() - 10000);
      utimesSync(filePath, pastTime, pastTime);

      cache.set('file-key', 'cached content', filePath);

      // Fresh immediately after setting (mtime matches)
      assert.ok(cache.isFresh('file-key'));

      // Modify the file (this updates mtime to now)
      writeFileSync(filePath, 'modified', 'utf-8');

      // Should no longer be fresh (mtime changed)
      assert.ok(!cache.isFresh('file-key'));

      // Invalidate
      const count = cache.invalidateByPath(filePath);
      assert.equal(count, 1);
      assert.equal(cache.get('file-key'), undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('delete removes entry', () => {
    cache.set('x', 'val');
    assert.equal(cache.get('x'), 'val');
    cache.delete('x');
    assert.equal(cache.get('x'), undefined);
  });

  it('clear removes all entries', () => {
    cache.set('x', '1');
    cache.set('y', '2');
    cache.clear();
    assert.equal(cache.stats().entries, 0);
  });
});

// ── CacheCoherenceManager Tests ────────────────────────────────────────────

describe('CacheCoherenceManager', () => {
  beforeEach(() => {
    resetCacheCoherence();
  });

  it('returns singleton instance', () => {
    const a = getCacheCoherence();
    const b = getCacheCoherence();
    assert.strictEqual(a, b);
  });

  it('registers and unregisters adapters', () => {
    const mgr = getCacheCoherence();
    const cache = new InMemoryCache<string>('adapter-1', 10);
    mgr.register(cache);

    const stats = mgr.allStats();
    assert.ok('adapter-1' in stats);

    mgr.unregister('adapter-1');
    const stats2 = mgr.allStats();
    assert.ok(!('adapter-1' in stats2));
  });

  it('invalidates path across all adapters', () => {
    const mgr = getCacheCoherence();
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-coherence-mgr-'));
    try {
      const filePath = join(tmpDir, 'shared.txt');
      writeFileSync(filePath, 'initial', 'utf-8');

      const c1 = new InMemoryCache<string>('c1', 10);
      const c2 = new InMemoryCache<string>('c2', 10);
      mgr.register(c1);
      mgr.register(c2);

      c1.set('k1', 'v1', filePath);
      c2.set('k2', 'v2', filePath);

      assert.equal(c1.get('k1'), 'v1');
      assert.equal(c2.get('k2'), 'v2');

      mgr.invalidatePath(filePath);

      assert.equal(c1.get('k1'), undefined);
      assert.equal(c2.get('k2'), undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clearAll empties all caches', () => {
    const mgr = getCacheCoherence();
    const c1 = new InMemoryCache<string>('a', 10);
    const c2 = new InMemoryCache<string>('b', 10);
    mgr.register(c1);
    mgr.register(c2);
    c1.set('x', '1');
    c2.set('y', '2');

    mgr.clearAll();
    assert.equal(c1.stats().entries, 0);
    assert.equal(c2.stats().entries, 0);
  });

  it('does not add duplicate adapters', () => {
    const mgr = getCacheCoherence();
    const c = new InMemoryCache<string>('unique', 10);
    mgr.register(c);
    mgr.register(c); // duplicate
    const stats = mgr.allStats();
    // Should only appear once
    const names = Object.keys(stats).filter((k) => k === 'unique');
    assert.equal(names.length, 1);
  });
});
