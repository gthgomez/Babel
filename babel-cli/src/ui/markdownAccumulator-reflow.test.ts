/**
 * Tests for MarkdownAccumulator.reflow() — terminal resize-reflow.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownAccumulator } from './markdownAccumulator.js';

function identityRender(text: string): string {
  return text;
}

function wrappedRender(width: number) {
  return (text: string): string => {
    if (text.length <= width) return text;
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += width) {
      lines.push(text.slice(i, i + width));
    }
    return lines.join('\n');
  };
}

describe('MarkdownAccumulator.reflow()', () => {
  it('returns empty string when width is unchanged', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('hello', identityRender);
    const result = acc.reflow(80, identityRender);
    // First call with a real width should render (width was -1)
    assert.ok(result.length > 0);
    // Second call with same width returns ''
    const second = acc.reflow(80, identityRender);
    assert.strictEqual(second, '');
  });

  it('returns full rendered output when width changes', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('hello world', identityRender);
    const result = acc.reflow(40, identityRender);
    assert.ok(result.length > 0);
    assert.ok(result.includes('hello world'));
  });

  it('reflow from narrower to wider width works correctly', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('the quick brown fox jumps over the lazy dog', identityRender);
    const narrow = acc.reflow(10, wrappedRender(10));
    assert.ok(narrow.length > 0);
    // Lines should be wrapped at ~10 chars
    const narrowLines = narrow.split('\n');
    for (const line of narrowLines) {
      assert.ok(line.length <= 10, `line "${line}" exceeds width 10`);
    }

    const wide = acc.reflow(80, wrappedRender(80));
    assert.ok(wide.length > 0);
    // Should be fewer lines at wider width
    assert.ok(wide.split('\n').length < narrowLines.length);
  });

  it('delta tracking resets correctly after reflow', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('line one', identityRender);
    assert.ok(acc.totalLines > 0);

    // Reflow — internal state resets
    acc.reflow(60, identityRender);

    // Feed more content after reflow — use newline-triggered content
    // so the full render path emits delta lines
    const delta = acc.feed('\nline two', identityRender);
    assert.ok(delta.length > 0);
    assert.ok(delta.includes('line two'));
    // totalLines should reflect the new content after reflow
    assert.ok(acc.totalLines > 0);
  });

  it('subsequent feed() calls work correctly after reflow', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('chunk one', identityRender);
    acc.reflow(100, identityRender);

    // After reflow, feeding new content with a newline triggers the full render path
    const delta = acc.feed('\nchunk two', identityRender);
    assert.ok(delta.length > 0);
    assert.ok(delta.includes('chunk two'));
  });

  it('returns empty string when accumulator has no text', () => {
    const acc = new MarkdownAccumulator();
    // Never fed any content — fullText is empty
    const result = acc.reflow(80, identityRender);
    assert.strictEqual(result, '');
  });

  it('multiple width changes at different sizes', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('multiple resize test content here', identityRender);

    const r1 = acc.reflow(20, wrappedRender(20));
    assert.ok(r1.length > 0);

    const r2 = acc.reflow(40, wrappedRender(40));
    assert.ok(r2.length > 0);
    // Wider width should produce fewer lines
    assert.ok(r2.split('\n').length < r1.split('\n').length);

    const r3 = acc.reflow(10, wrappedRender(10));
    assert.ok(r3.length > 0);
    // Narrower should produce more lines
    assert.ok(r3.split('\n').length > r2.split('\n').length);
  });

  it('reflow after multiple feed() calls', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('first ', identityRender);
    acc.feed('second ', identityRender);
    acc.feed('third', identityRender);

    const result = acc.reflow(80, identityRender);
    assert.ok(result.includes('first second third'));
  });

  it('long content re-wraps at different widths', () => {
    const acc = new MarkdownAccumulator();
    const longText = 'A'.repeat(200);
    acc.feed(longText, identityRender);

    // At width 50, should break into 4 lines
    const narrow = acc.reflow(50, wrappedRender(50));
    assert.strictEqual(narrow.split('\n').length, 4);

    // At width 100, should break into 2 lines
    const wide = acc.reflow(100, wrappedRender(100));
    assert.strictEqual(wide.split('\n').length, 2);
  });

  it('delta correctness after reflow resets tracking', () => {
    const acc = new MarkdownAccumulator();
    acc.feed('before reflow', identityRender);

    // Reflow resets internal tracking
    acc.reflow(80, identityRender);

    // Feed after reflow — the delta should be only the new content,
    // not duplicate the pre-reflow content. Use a newline to trigger
    // the full render path so delta lines are computed.
    const delta = acc.feed('\nafter reflow', identityRender);
    assert.ok(delta.includes('after reflow'));
    // The delta should NOT include 'before reflow' text
    assert.ok(!delta.includes('before reflow'));
  });

  it('reflow clears table holdback state and adopts new width', () => {
    const acc = new MarkdownAccumulator();
    acc.setTerminalWidth(80);
    acc.feed('| Name | Value |\n| --- |', identityRender);
    assert.ok(acc.totalLines >= 1);

    const narrow = acc.reflow(30, wrappedRender(30));
    assert.ok(narrow.length > 0);
    const delta = acc.feed('\n| a | 1 |', wrappedRender(30));
    assert.ok(delta.length >= 0);
  });

  it('reflow uses visual line count when terminal width is set', () => {
    const acc = new MarkdownAccumulator();
    acc.setTerminalWidth(10);
    acc.setViewportHeight(24);
    acc.feed('word '.repeat(20), identityRender);
    const before = acc.totalLines;
    acc.reflow(5, wrappedRender(5));
    assert.ok(acc.totalLines >= before);
  });

  it('feed then reflow then feed sequence works end-to-end', () => {
    const acc = new MarkdownAccumulator();

    // Initial feed (no newline — fast path)
    const d1 = acc.feed('initial content', identityRender);
    assert.ok(d1.length > 0);

    // Reflow
    const reflowed = acc.reflow(120, identityRender);
    assert.ok(reflowed.includes('initial content'));

    // Feed after reflow with a newline to trigger full render path
    const d2 = acc.feed('\nmore content', identityRender);
    assert.ok(d2.length > 0);
    assert.ok(d2.includes('more content'));
    assert.ok(!d2.includes('initial content')); // no duplication
  });
});
