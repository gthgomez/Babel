import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RepoMapTagCache } from './tagCache.js';

test('bounded tag cache evicts the least recently used entry and refuses oversized entries', () => {
  const tag = [{ name: 'symbol', kind: 'def' as const, line: 0 }];
  const cache = new RepoMapTagCache(1_000, 2);
  cache.set('a', 'hash-a', tag);
  cache.set('b', 'hash-b', tag);
  assert.equal(cache.get('a')?.hash, 'hash-a');
  cache.set('c', 'hash-c', tag);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a')?.hash, 'hash-a');
  assert.equal(cache.get('c')?.hash, 'hash-c');
  assert.equal(cache.stats().entries, 2);
  cache.delete('a');
  assert.equal(cache.stats().entries, 1);
  cache.clear();
  assert.deepEqual(cache.stats(), { entries: 0, estimatedBytes: 0 });

  const small = new RepoMapTagCache(10, 2);
  small.set('a', 'hash-a', tag);
  assert.deepEqual(small.stats(), { entries: 0, estimatedBytes: 0 });
  const sourceBound = new RepoMapTagCache(1_000, 2);
  sourceBound.set('a', 'hash-a', tag, 600);
  assert.deepEqual(sourceBound.stats(), { entries: 0, estimatedBytes: 0 });
});
