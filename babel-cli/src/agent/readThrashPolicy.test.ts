import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildReadThrashFuseMessage,
  isExplorationBudgetTool,
  isReadExplorationTool,
  nextReadOnlyStreak,
  normalizeReadCacheKey,
  shouldFireReadThrashFuse,
  shouldSkipFullReread,
} from './readThrashPolicy.js';

describe('readThrashPolicy', () => {
  test('normalizeReadCacheKey unifies slash and relative forms', () => {
    const root = '/tmp/proj';
    const a = normalizeReadCacheKey('src/foo.ts', root);
    const b = normalizeReadCacheKey('/tmp/proj/src/foo.ts', root);
    const c = normalizeReadCacheKey('/tmp/proj\\src\\foo.ts', root);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('read thrash fuse fires at budget', () => {
    assert.equal(
      shouldFireReadThrashFuse({
        executeIntent: true,
        consecutiveReadOnlyTools: 12,
        budget: 12,
      }),
      true,
    );
    assert.equal(
      shouldFireReadThrashFuse({
        executeIntent: true,
        consecutiveReadOnlyTools: 11,
        budget: 12,
      }),
      false,
    );
    assert.equal(
      shouldFireReadThrashFuse({
        executeIntent: false,
        consecutiveReadOnlyTools: 100,
        budget: 12,
      }),
      false,
    );
  });

  test('full reread skip after max', () => {
    assert.equal(shouldSkipFullReread({ fullReadCount: 2, maxFullReads: 2 }), true);
    assert.equal(shouldSkipFullReread({ fullReadCount: 1, maxFullReads: 2 }), false);
  });

  test('exploration tools classified', () => {
    assert.equal(isReadExplorationTool('read_file'), true);
    assert.equal(isReadExplorationTool('grep'), true);
    assert.equal(isReadExplorationTool('str_replace'), false);
  });

  test('zero-write shell thrash counts against exploration budget', () => {
    assert.equal(isExplorationBudgetTool('run_command', false), true);
    assert.equal(isExplorationBudgetTool('test_run', false), true);
    assert.equal(isExplorationBudgetTool('run_command', true), false);
    assert.equal(isExplorationBudgetTool('read_file', true), true);
  });

  test('nextReadOnlyStreak increments on zero-write shell', () => {
    assert.equal(nextReadOnlyStreak(0, 'run_command', { hasSuccessfulWrites: false }), 1);
    assert.equal(nextReadOnlyStreak(3, 'run_command', { hasSuccessfulWrites: true }), 3);
    assert.equal(nextReadOnlyStreak(2, 'str_replace'), 0);
  });

  test('fuse message is actionable', () => {
    assert.match(buildReadThrashFuseMessage(12), /READ_THRASH\s*FUSE/);
    assert.match(buildReadThrashFuseMessage(12), /str_replace/);
  });
});
