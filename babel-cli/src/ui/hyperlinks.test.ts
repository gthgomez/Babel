/**
 * Tests for OSC 8 hyperlink support.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { osc8Hyperlink, findWebLinks, annotateText, stripOsc8 } from './hyperlinks.js';

// ─── OSC 8 hyperlink rendering ──────────────────────────────────────────────

test('osc8Hyperlink emits OSC 8 sequences for valid https URLs', () => {
  const result = osc8Hyperlink('https://example.com/path', 'click here');
  assert.ok(result.includes('\x1b]8;;'));
  assert.ok(result.includes('click here'));
  assert.ok(result.includes('https://example.com/path'));
});

test('osc8Hyperlink emits OSC 8 sequences for valid http URLs', () => {
  const result = osc8Hyperlink('http://localhost:3000/api', 'API');
  assert.ok(result.includes('\x1b]8;;'));
  assert.ok(result.includes('localhost:3000/api'));
});

test('osc8Hyperlink returns plain text for non-web destinations', () => {
  assert.equal(osc8Hyperlink('mailto:test@example.com', 'email'), 'email');
  assert.equal(osc8Hyperlink('file:///etc/passwd', 'file'), 'file');
});

test('osc8Hyperlink returns plain text for invalid URLs', () => {
  assert.equal(osc8Hyperlink('not-a-url', 'text'), 'text');
  assert.equal(osc8Hyperlink('', 'text'), 'text');
});

test('osc8Hyperlink sanitizes control characters from URL', () => {
  const result = osc8Hyperlink('https://example.com/\x07safe', 'link');
  assert.ok(result.includes('https://example.com/safe'));
  // The \x07 (BEL) in OSC 8 is the terminator; verify the sanitized URL
  // doesn't contain the control character before the terminator
  assert.ok(!result.includes('example.com/\x07safe'));
});

// ─── URL detection ──────────────────────────────────────────────────────────

test('findWebLinks discovers simple URLs', () => {
  const links = findWebLinks('See https://example.com/a');
  assert.equal(links.length, 1);
  assert.equal(links[0]!.destination, 'https://example.com/a');
});

test('findWebLinks discovers URLs in parentheses', () => {
  const links = findWebLinks('See (https://example.com/b).');
  assert.equal(links.length, 1);
  assert.equal(links[0]!.destination, 'https://example.com/b');
});

test('findWebLinks discovers multiple URLs', () => {
  const links = findWebLinks('https://a.com and https://b.com');
  assert.equal(links.length, 2);
});

test('findWebLinks returns empty for text without URLs', () => {
  const links = findWebLinks('Just plain text here');
  assert.equal(links.length, 0);
});

test('findWebLinks preserves balanced parentheses in URLs', () => {
  const links = findWebLinks('See https://en.wikipedia.org/wiki/Fun_(band)');
  assert.equal(links.length, 1);
  assert.ok(links[0]!.destination.includes('Fun_(band)'));
});

// ─── Text annotation ────────────────────────────────────────────────────────

test('annotateText wraps URLs in OSC 8 sequences', () => {
  const result = annotateText('Visit https://example.com now');
  assert.ok(result.includes('\x1b]8;;https://example.com\x07'));
});

test('annotateText returns plain text unchanged when no URLs', () => {
  const result = annotateText('Just plain text');
  assert.equal(result, 'Just plain text');
});

test('annotateText handles empty text', () => {
  assert.equal(annotateText(''), '');
});

// ─── OSC 8 stripping ────────────────────────────────────────────────────────

test('stripOsc8 removes OSC 8 sequences leaving visible text', () => {
  const original = osc8Hyperlink('https://example.com', 'click');
  const stripped = stripOsc8(original);
  assert.equal(stripped, 'click');
});

test('stripOsc8 preserves text without OSC 8 sequences', () => {
  assert.equal(stripOsc8('plain text'), 'plain text');
});

test('stripOsc8 handles text with both OSC 8 and plain segments', () => {
  const annotated = annotateText('Go to https://example.com for info');
  const stripped = stripOsc8(annotated);
  assert.ok(stripped.includes('Go to '));
  assert.ok(stripped.includes('example.com'));
  assert.ok(stripped.includes(' for info'));
  assert.ok(!stripped.includes('\x1b]8;'));
});
