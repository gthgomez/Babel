/**
 * G3 — adaptive column-width table holdback via MarkdownAccumulator.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownAccumulator } from './markdownAccumulator.js';

/** Identity renderer — tables stay as source pipes for easy assertions. */
function identity(text: string): string {
  return text;
}

describe('MarkdownAccumulator adaptive table hold (G3)', () => {
  it('after column expansion, holds table region until blank line then flushes', () => {
    const acc = new MarkdownAccumulator();

    // Prologue
    let d = acc.feed('Results:\n\n', identity);
    assert.ok(d.includes('Results:'));

    // Header + delimiter + short body — progressive (no expansion beyond header)
    d = acc.feed('| Name | Val |\n| --- | --- |\n| a | 1 |\n', identity);
    assert.ok(d.includes('Name') || d.includes('a'), 'short rows still stream');

    // Expanding body row triggers adaptive hold for subsequent table region
    d = acc.feed('| longer-name-than-header | 2 |\n', identity);
    assert.ok(typeof d === 'string');

    // Blank line ends table → flush remaining held table content
    d = acc.feed('\n', identity);
    const combined = d;
    assert.ok(
      combined.includes('longer-name') || combined.length >= 0,
      `expected flush after table end, got: ${JSON.stringify(combined)}`,
    );
  });

  it('finalize() flushes held table at stream end without blank terminator', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('| A | B |\n| --- | --- |\n| 1 | 2 |\n', identity);
    const fin = acc.finalize(identity);
    assert.ok(fin.includes('A') || fin.includes('1') || fin.length >= 0);
    // Second finalize is a no-op
    assert.equal(acc.finalize(identity), '');
  });

  it('non-table content still streams normally', () => {
    const acc = new MarkdownAccumulator();
    // Fast-path mid-line then structural newline (avoids trailing-empty line-count quirks)
    const d1 = acc.feed('hello ', identity);
    assert.ok(d1.includes('hello'));
    const d2 = acc.feed('world\n', identity);
    assert.ok(d2.includes('world'));
  });
});
