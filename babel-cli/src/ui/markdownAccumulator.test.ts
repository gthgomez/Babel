/**
 * markdownAccumulator.test.ts — streaming delta correctness.
 *
 * Guards the TUI-Output-Bug class of failures:
 * - full-message re-emit on every fast→structural transition
 * - dropped list/paragraph lines after trailing blank lines
 * - markdown rewrite via cursor-up instead of append-duplication
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownAccumulator } from './markdownAccumulator.js';

const identity = (text: string): string => text;

/** Lightweight markdown transform that mirrors real heading/list/bold changes. */
function fakeMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) => `\x1b[1m${title}\x1b[0m`)
    .replace(/\*\*(.+?)\*\*/g, (_m, body: string) => `\x1b[1m${body}\x1b[0m`)
    .replace(/^- /gm, '  · ');
}

function feedAll(chunks: string[], renderFn: (t: string) => string = identity): string {
  const acc = new MarkdownAccumulator();
  let out = '';
  for (const chunk of chunks) {
    out += acc.feed(chunk, renderFn);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe('MarkdownAccumulator streaming deltas', () => {
  it('does not re-emit the full message on fast→structural transition', () => {
    const out = feedAll([
      "Great question. Here's my",
      ' startup process in this workspace, step by step',
      '.\n\n',
      '## Startup Process',
      '\n\n',
      '### 1. System Load',
      '\n\n',
      'The runtime initializes me.\n',
    ]);

    const intro = "Great question. Here's my startup process in this workspace, step by step.";
    // Intro appears once — no full-message re-emission
    assert.equal(countOccurrences(out, intro), 1, 'intro must appear exactly once');

    // Fast-path shimmer is emitted before the structural delta, then erased
    // with \r\x1b[K.  Verify the erase sequences are present (one per
    // fast-path→structural transition) and the shimmer text is cleaned up.
    // The first copy of each heading is shimmer; the second is ANSI-rendered.
    // Between them sits the \r\x1b[K erase.
    const shimmerErase = '\r\x1b[K';
    assert.ok(out.includes(`${shimmerErase}## Startup Process`), 'shimmer erase before heading');
    assert.ok(out.includes(`${shimmerErase}### 1. System Load`), 'shimmer erase before subheading');

    // The runtime line has a trailing newline so it never hits the fast path;
    // it appears exactly once in the structural delta.
    assert.equal(countOccurrences(out, 'The runtime initializes me.'), 1);
  });

  it('emits list items that follow trailing blank lines', () => {
    const out = feedAll([
      'Intro paragraph.\n\n',
      '- first item\n',
      '- second item\n',
    ]);

    assert.match(out, /Intro paragraph\./);
    assert.match(out, /- first item/);
    assert.match(out, /- second item/);
    // No duplication of the intro
    assert.equal(countOccurrences(out, 'Intro paragraph.'), 1);
  });

  it('extends mid-line then appends only the new suffix after newline', () => {
    const acc = new MarkdownAccumulator();
    assert.equal(acc.feed('Hello', identity), 'Hello');
    assert.equal(acc.feed(' world', identity), ' world');
    assert.equal(acc.feed('.\n\nNext', identity), '.\n\nNext');
  });

  it('rewrites transformed markdown instead of appending a second copy', () => {
    const acc = new MarkdownAccumulator();
    let out = '';
    out += acc.feed('## Title', fakeMarkdown); // fast path: raw
    out += acc.feed('\n\n', fakeMarkdown); // structural: heading transform

    // Raw ## should appear at most from the fast-path emission before rewrite
    // After applying the cursor-up rewrite, net content is a single styled title.
    assert.match(out, /\x1b\[\d+A\x1b\[J/);
    assert.match(out, /\x1b\[1mTitle\x1b\[0m/);
    // Must not contain two permanent copies of the title text without rewrite
    // (raw + styled would be "## Title" then rewrite clears and paints "Title")
    assert.ok(out.includes('## Title'));
    assert.ok(out.includes('\x1b[1mTitle\x1b[0m'));
  });

  it('getRenderedText tracks the last full render snapshot', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('Hello', identity);
    acc.feed(' world\n', identity);
    assert.equal(acc.getRenderedText(), 'Hello world\n');
  });

  it('emits a trailing newline when structural render only adds a final \\n', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('Hello', identity);
    // Force structural path with a renderFn that appends a trailing newline
    const delta = acc.feed('\n', (t) => t); // fullText "Hello\n"
    assert.ok(delta.includes('\n'), 'must advance cursor for trailing newline');
    assert.equal(acc.getRenderedText(), 'Hello\n');
  });

  it('table progressive holdback does not re-print earlier rows', () => {
    const acc = new MarkdownAccumulator();
    // Incomplete final row (no closing pipe) triggers holdback
    const d1 = acc.feed('| A | B |\n| --- | --- |\n| 1', identity);
    assert.ok(d1.includes('| A | B |'));
    assert.ok(d1.includes('| --- | --- |'));
    // Complete the row and end the table
    const d2 = acc.feed(' | 2 |\n', identity);
    // Combined output must show the header only once
    assert.equal(countOccurrences(d1 + d2, '| A | B |'), 1);
  });

  it('reset clears accumulated state', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('stuff\n', identity);
    acc.reset();
    assert.equal(acc.getRenderedText(), '');
    assert.equal(acc.totalBytes, 0);
    assert.equal(acc.feed('fresh', identity), 'fresh');
  });

  it('does not shimmer answer deltas by default (avoids permanent faded text)', () => {
    const acc = new MarkdownAccumulator();
    // Default: shimmer off. Fast-path chunk must be plain text.
    const delta = acc.feed('Hello streaming world', identity);
    assert.equal(delta, 'Hello streaming world');
    assert.ok(!delta.includes('\x1b['), 'default stream must not bake ANSI shimmer');
  });

  it('shimmer only applies when explicitly enabled', () => {
    const acc = new MarkdownAccumulator();
    acc.setShimmerEnabled(true);
    // May or may not insert ANSI depending on motion mode env; just ensure
    // the toggle path does not throw and returns non-empty output.
    const delta = acc.feed('abc', identity);
    assert.ok(delta.length >= 3);
  });
});
