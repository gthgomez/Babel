import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUnseenDividerPill, renderScrollAwayHint } from './unseenDivider.js';
import { stripAnsi } from './theme.js';
import { ScrollbackBuffer } from './scrollback.js';

// ═══════════════════════════════════════════════════════════════════════════════
// renderUnseenDividerPill
// ═══════════════════════════════════════════════════════════════════════════════

test('renderUnseenDividerPill: empty string for count <= 0', () => {
  assert.equal(renderUnseenDividerPill(0), '');
  assert.equal(renderUnseenDividerPill(-1), '');
});

test('renderUnseenDividerPill: shows count for single message', () => {
  const result = renderUnseenDividerPill(1);
  assert.ok(result.length > 0, 'Pill should not be empty');
  const stripped = stripAnsi(result);
  assert.match(stripped, /1 new message/);
  assert.match(stripped, /↓/);
});

test('renderUnseenDividerPill: pluralizes for multiple messages', () => {
  const result = renderUnseenDividerPill(3);
  assert.ok(result.length > 0, 'Pill should not be empty');
  const stripped = stripAnsi(result);
  assert.match(stripped, /3 new messages/);
});

test('renderUnseenDividerPill: renders correctly for large counts', () => {
  const result = renderUnseenDividerPill(100);
  const stripped = stripAnsi(result);
  assert.match(stripped, /100 new messages/);
});

test('renderUnseenDividerPill: includes decorative separators', () => {
  const result = renderUnseenDividerPill(5);
  const stripped = stripAnsi(result);
  // Should have some visual structure around the count text
  assert.ok(stripped.includes('5'), 'Pill should contain the count');
  assert.ok(stripped.includes('new messages'), 'Pill should contain label');
});

// ═══════════════════════════════════════════════════════════════════════════════
// renderScrollAwayHint
// ═══════════════════════════════════════════════════════════════════════════════

test('renderScrollAwayHint: empty when neither direction has content', () => {
  assert.equal(renderScrollAwayHint(false, false), '');
});

test('renderScrollAwayHint: shows up arrow when items above', () => {
  const result = renderScrollAwayHint(true, false);
  const stripped = stripAnsi(result);
  assert.match(stripped, /↑/);
  assert.doesNotMatch(stripped, /↓/);
});

test('renderScrollAwayHint: shows down arrow when items below', () => {
  const result = renderScrollAwayHint(false, true);
  const stripped = stripAnsi(result);
  assert.match(stripped, /↓/);
  assert.doesNotMatch(stripped, /↑/);
});

test('renderScrollAwayHint: shows both arrows when both directions', () => {
  const result = renderScrollAwayHint(true, true);
  const stripped = stripAnsi(result);
  assert.match(stripped, /↑/);
  assert.match(stripped, /↓/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ScrollbackBuffer unseen tracking
// ═══════════════════════════════════════════════════════════════════════════════

test('ScrollbackBuffer: unseenSinceLastView starts at 0', () => {
  const buf = new ScrollbackBuffer(100);
  assert.equal(buf.unseenSinceLastView, 0);
});

test('ScrollbackBuffer: pushing lines while at bottom does not increment unseen', () => {
  const buf = new ScrollbackBuffer(100);
  // At bottom (offset=0), pushing should not increment unseen
  buf.push('line 1');
  buf.push('line 2');
  buf.push('line 3');
  assert.equal(buf.unseenSinceLastView, 0);
});

test('ScrollbackBuffer: pushing lines while scrolled up increments unseen', () => {
  const buf = new ScrollbackBuffer(100);
  // Push enough lines first
  buf.push('line 1');
  buf.push('line 2');
  buf.push('line 3');
  assert.equal(buf.unseenSinceLastView, 0, 'no unseen while at bottom');

  // Scroll up
  buf.setViewportOffset(2);
  assert.equal(buf.getScrollInfo().isAtBottom, false);

  // Push while scrolled up
  buf.push('line 4');
  assert.equal(buf.unseenSinceLastView, 1, 'one unseen line after push while scrolled up');

  buf.push('line 5');
  assert.equal(buf.unseenSinceLastView, 2, 'two unseen lines after second push');
});

test('ScrollbackBuffer: scrollToBottom resets unseen count', () => {
  const buf = new ScrollbackBuffer(100);
  buf.push('line 1');
  buf.push('line 2');
  buf.push('line 3');
  buf.setViewportOffset(1);
  buf.push('line 4');
  assert.equal(buf.unseenSinceLastView, 1, 'unseen after push while scrolled up');

  // Scroll to bottom — should reset unseen
  buf.scrollToBottom();
  assert.equal(buf.unseenSinceLastView, 0, 'unseen reset after scrollToBottom');
  assert.equal(buf.getScrollInfo().isAtBottom, true, 'is at bottom after scrollToBottom');
});

test('ScrollbackBuffer: setViewportOffset(0) does NOT reset unseen', () => {
  const buf = new ScrollbackBuffer(100);
  buf.push('line 1');
  buf.push('line 2');
  buf.push('line 3');
  buf.setViewportOffset(1);
  buf.push('line 4');
  assert.equal(buf.unseenSinceLastView, 1);

  // setViewportOffset(0) does NOT reset via this method, only scrollToBottom does
  buf.setViewportOffset(0);
  // The unseen count should remain until scrollToBottom is called
  // (setViewportOffset is a raw setter; scrollToBottom resets state)
  assert.equal(buf.unseenSinceLastView, 1, 'setViewportOffset(0) should not reset unseen');
});

test('ScrollbackBuffer: reset clears unseen count', () => {
  const buf = new ScrollbackBuffer(100);
  buf.push('line 1');
  buf.push('line 2');
  buf.push('line 3');
  // Now lineCount=3, maxOffset=2 — setViewportOffset(1) will work
  buf.setViewportOffset(1);
  buf.push('line 4');
  assert.equal(buf.unseenSinceLastView, 1);

  buf.reset();
  assert.equal(buf.unseenSinceLastView, 0, 'reset clears unseen count');
  assert.equal(buf.totalLines, 0, 'reset clears all lines');
});

test('ScrollbackBuffer: getScrollInfo includes unseenSinceLastView', () => {
  const buf = new ScrollbackBuffer(100);
  buf.push('line 1');
  buf.push('line 2');
  buf.setViewportOffset(1);
  buf.push('line 3');

  const info = buf.getScrollInfo();
  assert.equal(info.unseenSinceLastView, 1);
  assert.equal(info.isAtBottom, false);
  assert.equal(info.offset, 1);
  assert.equal(info.totalLines, 3);
});

test('ScrollbackBuffer: pushing at offset 0 does not accumulate unseen', () => {
  const buf = new ScrollbackBuffer(100);
  // Start at bottom
  for (let i = 0; i < 10; i++) buf.push(`line ${i + 1}`);
  assert.equal(buf.unseenSinceLastView, 0, 'no unseen when at bottom');

  // Scroll up, push, scroll down, push — only pushes while scrolled up count
  buf.setViewportOffset(5);
  buf.push('line 11');
  assert.equal(buf.unseenSinceLastView, 1, 'one unseen while scrolled up');

  // Return to bottom (via scrollToBottom)
  buf.scrollToBottom();
  assert.equal(buf.unseenSinceLastView, 0, 'reset after scrollToBottom');

  // Push while at bottom
  buf.push('line 12');
  assert.equal(buf.unseenSinceLastView, 0, 'no unseen when back at bottom');
});

test('ScrollbackBuffer: large unseen count accumulates correctly', () => {
  const buf = new ScrollbackBuffer(100);
  // Push at least 2 lines so maxOffset >= 1
  buf.push('line 1');
  buf.push('line 2');
  buf.setViewportOffset(1);

  const count = 50;
  for (let i = 0; i < count; i++) {
    buf.push(`line ${i}`);
  }
  assert.equal(buf.unseenSinceLastView, count, `unseen count should be ${count}`);
});
