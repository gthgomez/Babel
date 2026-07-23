/**
 * Tests for knowledgeGraphIndexer — covers progress parsing, stats parsing,
 * module state, and env-var guard conditions.
 *
 * Spawn-lifecycle tests (guard conditions involving existsSync, concurrent
 * guard, complete/fail/timeout/error paths, progress updates) require
 * mocking node:fs.existsSync and node:child_process.spawn.  Node.js 24 ESM
 * built-in modules have non-configurable exports — mock.method cannot
 * intercept them.  These paths are integration-tested via the
 * liveCliReliabilityMatrix which exercises full CLI sessions including
 * knowledge-graph indexing.
 *
 * To add unit-level spawn-lifecycle coverage, add optional DI parameters
 * to startBackgroundIndexing (following the codeGraphBackend DI pattern).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProgress,
  parseStats,
  startBackgroundIndexing,
  getCachedIndexStatus,
  getIndexingPromise,
  __testReset,
} from './knowledgeGraphIndexer.js';

// ── Lifecycle ────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  __testReset();
  delete process.env['BABEL_SKIP_KG_INDEX'];
});

test.afterEach(() => {
  delete process.env['BABEL_SKIP_KG_INDEX'];
});

// ── Section 1: parseProgress (pure function) ────────────────────────────────

test('parseProgress', async (t) => {
  await t.test('returns correct values for a single line', () => {
    const result = parseProgress('Indexing 50/100');
    assert.ok(result !== null);
    assert.equal(result!.current, 50);
    assert.equal(result!.total, 100);
  });

  await t.test('takes the LAST match from multiple lines', () => {
    const result = parseProgress('Indexing 10/100\nIndexed 99/100');
    assert.ok(result !== null);
    assert.equal(result!.current, 99);
    assert.equal(result!.total, 100);
  });

  await t.test('handles comma-formatted numbers', () => {
    const result = parseProgress('Indexed 1,234/5,678');
    assert.ok(result !== null);
    assert.equal(result!.current, 1234);
    assert.equal(result!.total, 5678);
  });

  await t.test('handles zero-based counts', () => {
    const result = parseProgress('Indexing 0/0');
    assert.ok(result !== null);
    assert.equal(result!.current, 0);
    assert.equal(result!.total, 0);
  });

  await t.test('handles interleaved text', () => {
    const result = parseProgress('[INFO] Indexing 42/100 files...');
    assert.ok(result !== null);
    assert.equal(result!.current, 42);
    assert.equal(result!.total, 100);
  });

  await t.test('handles case-insensitive prefix', () => {
    const result = parseProgress('indexed 5/10');
    assert.ok(result !== null);
    assert.equal(result!.current, 5);
    assert.equal(result!.total, 10);
  });

  await t.test('returns null when no match', () => {
    const result = parseProgress('No indexing happening here');
    assert.equal(result, null);
  });

  await t.test('returns null on empty string', () => {
    const result = parseProgress('');
    assert.equal(result, null);
  });

  await t.test('handles multiple matches in one chunk taking last', () => {
    const result = parseProgress('Indexing 1/10 Indexing 5/10 Indexed 10/10');
    assert.ok(result !== null);
    assert.equal(result!.current, 10);
    assert.equal(result!.total, 10);
  });
});

// ── Section 2: parseStats (pure function) ────────────────────────────────────

test('parseStats', async (t) => {
  await t.test('returns node/edge count from normal output', () => {
    const result = parseStats('Indexed 100 nodes, 200 edges');
    assert.ok(result !== null);
    assert.equal(result!.nodeCount, 100);
    assert.equal(result!.edgeCount, 200);
  });

  await t.test('handles comma-formatted numbers', () => {
    const result = parseStats('1,234 nodes ... 5,678 edges');
    assert.ok(result !== null);
    assert.equal(result!.nodeCount, 1234);
    assert.equal(result!.edgeCount, 5678);
  });

  await t.test('handles zero counts', () => {
    const result = parseStats('0 nodes, 0 edges');
    assert.ok(result !== null);
    assert.equal(result!.nodeCount, 0);
    assert.equal(result!.edgeCount, 0);
  });

  await t.test('returns null when no match', () => {
    const result = parseStats('Nothing to see here');
    assert.equal(result, null);
  });

  await t.test('returns null on empty string', () => {
    const result = parseStats('');
    assert.equal(result, null);
  });

  await t.test('takes first match — ignores later stats-like lines', () => {
    const result = parseStats(
      '10 nodes, 20 edges completed\n100 nodes, 200 edges total',
    );
    assert.ok(result !== null);
    assert.equal(result!.nodeCount, 10);
    assert.equal(result!.edgeCount, 20);
  });

  await t.test('handles flexible whitespace and dots', () => {
    const result = parseStats(
      'Indexed 50 nodes.......................... 150 edges',
    );
    assert.ok(result !== null);
    assert.equal(result!.nodeCount, 50);
    assert.equal(result!.edgeCount, 150);
  });

  await t.test('handles singular "node" and "edge"', () => {
    const result = parseStats('1 node... 1 edge');
    assert.ok(result !== null);
    assert.equal(result!.nodeCount, 1);
    assert.equal(result!.edgeCount, 1);
  });
});

// ── Section 3: Module state ──────────────────────────────────────────────────

test('module state', async (t) => {
  await t.test('getCachedIndexStatus returns null before indexing', () => {
    assert.equal(getCachedIndexStatus(), null);
  });

  await t.test('getIndexingPromise returns null before indexing', () => {
    assert.equal(getIndexingPromise(), null);
  });

  await t.test('__testReset clears state and is idempotent', () => {
    __testReset();
    __testReset();
    assert.equal(getCachedIndexStatus(), null);
    assert.equal(getIndexingPromise(), null);
  });
});

// ── Section 4: BABEL_SKIP_KG_INDEX guard ────────────────────────────────────

test('BABEL_SKIP_KG_INDEX guard', async (t) => {
  await t.test('returns early when BABEL_SKIP_KG_INDEX is set to 1', () => {
    process.env['BABEL_SKIP_KG_INDEX'] = '1';
    startBackgroundIndexing();
    assert.equal(getIndexingPromise(), null);
  });

  await t.test('returns early when BABEL_SKIP_KG_INDEX is set to true', () => {
    process.env['BABEL_SKIP_KG_INDEX'] = 'true';
    startBackgroundIndexing();
    assert.equal(getIndexingPromise(), null);
  });

  await t.test('returns early when BABEL_SKIP_KG_INDEX is set to any truthy', () => {
    process.env['BABEL_SKIP_KG_INDEX'] = 'yes';
    startBackgroundIndexing();
    assert.equal(getIndexingPromise(), null);
  });
});
