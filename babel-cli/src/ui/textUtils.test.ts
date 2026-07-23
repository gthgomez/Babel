/**
 * textUtils.test.ts — CJK and wide-character tests for text utilities.
 *
 * Covers grapheme cluster counting, width-based truncation, and
 * CJK/emoji edge cases.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { graphemeLength, graphemeTruncate, graphemeTruncateToWidth, graphemeClusters } from './textUtils.js';
import { visibleLength } from './theme.js';

// ═══════════════════════════════════════════════════════════════════════════════
// graphemeClusters
// ═══════════════════════════════════════════════════════════════════════════════

describe('graphemeClusters', () => {
  it('splits ASCII text into characters', () => {
    const clusters = graphemeClusters('hello');
    assert.deepStrictEqual(clusters, ['h', 'e', 'l', 'l', 'o']);
  });

  it('handles empty string', () => {
    assert.deepStrictEqual(graphemeClusters(''), []);
  });

  it('handles CJK characters (each is one grapheme)', () => {
    const clusters = graphemeClusters('你好');
    assert.deepStrictEqual(clusters, ['你', '好']);
  });

  it('handles emoji as a single grapheme', () => {
    const clusters = graphemeClusters('👋');
    assert.equal(clusters.length, 1);
  });

  it('handles mixed CJK and ASCII', () => {
    const clusters = graphemeClusters('a你b好');
    assert.deepStrictEqual(clusters, ['a', '你', 'b', '好']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// graphemeLength
// ═══════════════════════════════════════════════════════════════════════════════

describe('graphemeLength', () => {
  it('counts ASCII correctly', () => {
    assert.equal(graphemeLength('hello'), 5);
  });

  it('counts CJK characters correctly', () => {
    assert.equal(graphemeLength('你好世界'), 4);
  });

  it('counts emoji as single grapheme', () => {
    assert.equal(graphemeLength('👋🌍'), 2);
  });

  it('counts mixed text correctly', () => {
    assert.equal(graphemeLength('hello你好'), 7);
  });

  it('returns 0 for empty string', () => {
    assert.equal(graphemeLength(''), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// graphemeTruncate
// ═══════════════════════════════════════════════════════════════════════════════

describe('graphemeTruncate', () => {
  it('returns full text when under limit', () => {
    assert.equal(graphemeTruncate('hello', 10), 'hello');
  });

  it('truncates and appends ellipsis', () => {
    const result = graphemeTruncate('hello world', 5);
    assert.ok(result.startsWith('hello'));
    assert.ok(result.includes('…'));
  });

  it('handles CJK truncation correctly', () => {
    const result = graphemeTruncate('你好世界', 2);
    assert.equal(result, '你好…');
  });

  it('returns ellipsis for zero maxClusters', () => {
    assert.equal(graphemeTruncate('hello', 0), '…');
  });

  it('handles negative maxClusters', () => {
    assert.equal(graphemeTruncate('hello', -1), '…');
  });

  it('preserves emoji in truncation', () => {
    const result = graphemeTruncate('👋🌍🚀', 2);
    assert.ok(result.startsWith('👋🌍'));
    assert.ok(result.includes('…'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// graphemeTruncateToWidth
// ═══════════════════════════════════════════════════════════════════════════════

describe('graphemeTruncateToWidth', () => {
  it('fits ASCII within width', () => {
    const result = graphemeTruncateToWidth('hello', 10);
    assert.equal(result, 'hello');
  });

  it('truncates ASCII when over width', () => {
    const result = graphemeTruncateToWidth('hello world', 5);
    assert.ok(result.length <= 6); // 5 chars + ellipsis
  });

  it('accounts for CJK double-width characters', () => {
    // '你好' = 4 columns wide (2 chars × 2 columns each)
    const result = graphemeTruncateToWidth('你好世界', 4);
    assert.equal(result, '你好…');
  });

  it('handles mixed CJK + ASCII width', () => {
    // 'a你' = 1 + 2 = 3 columns
    const result = graphemeTruncateToWidth('a你好', 3);
    assert.equal(result, 'a你…');
  });

  it('accounts for emoji double-width', () => {
    // 👋 = 2 columns
    const result = graphemeTruncateToWidth('👋👋👋', 4);
    assert.ok(result.startsWith('👋👋'));
    assert.ok(result.includes('…'));
  });

  it('returns ellipsis for zero maxWidth', () => {
    assert.equal(graphemeTruncateToWidth('hello', 0), '…');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// visibleLength with CJK
// ═══════════════════════════════════════════════════════════════════════════════

describe('visibleLength with CJK', () => {
  it('returns correct width for ASCII', () => {
    assert.equal(visibleLength('hello'), 5);
  });

  it('returns 2 per CJK character', () => {
    assert.equal(visibleLength('你好'), 4);
  });

  it('returns correct width for mixed text', () => {
    // 'a你b' = 1 + 2 + 1 = 4
    const width = visibleLength('a你b');
    assert.equal(width, 4);
  });

  it('returns 2 per emoji', () => {
    const width = visibleLength('👋');
    assert.equal(width, 2);
  });

  it('returns 0 for empty string', () => {
    assert.equal(visibleLength(''), 0);
  });

  it('strips ANSI before measuring', () => {
    const width = visibleLength('\x1b[32mhello\x1b[0m');
    assert.equal(width, 5);
  });
});
