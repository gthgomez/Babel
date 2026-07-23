/**
 * Tests for URL-aware text wrapping in textUtils.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { textContainsUrlLike, urlAwareWrapText, graphemeLength } from './textUtils.js';

// ─── URL detection ──────────────────────────────────────────────────────────

test('textContainsUrlLike detects https URLs', () => {
  assert.equal(textContainsUrlLike('See https://example.com/path for details'), true);
});

test('textContainsUrlLike detects bare domain URLs with path', () => {
  assert.equal(textContainsUrlLike('Visit example.com/path now'), true);
});

test('textContainsUrlLike detects www domains', () => {
  assert.equal(textContainsUrlLike('Go to www.example.com'), true);
});

test('textContainsUrlLike detects localhost URLs', () => {
  assert.equal(textContainsUrlLike('API at localhost:3000/api/v1'), true);
});

test('textContainsUrlLike detects IPv4 URLs', () => {
  assert.equal(textContainsUrlLike('Server at 127.0.0.1:8080/health'), true);
});

test('textContainsUrlLike detects ftp URLs', () => {
  assert.equal(textContainsUrlLike('Download ftp://files.example.com/data'), true);
});

test('textContainsUrlLike detects URLs in parentheses', () => {
  assert.equal(textContainsUrlLike('See (https://example.com) for info'), true);
});

test('textContainsUrlLike rejects file paths', () => {
  assert.equal(textContainsUrlLike('Import from src/main.rs'), false);
  assert.equal(textContainsUrlLike('Run foo/bar/baz'), false);
});

test('textContainsUrlLike rejects plain words with dots', () => {
  assert.equal(textContainsUrlLike('Just hello.world text'), false);
});

test('textContainsUrlLike rejects invalid ports', () => {
  assert.equal(textContainsUrlLike('Connect to example.com:99999/path'), false);
});

// ─── URL-aware wrapping ─────────────────────────────────────────────────────

test('urlAwareWrapText preserves URL on a single line when wider than maxWidth', () => {
  const url = 'https://example.com/a-very-long-path-with-many-segments/and/query?x=1&y=2';
  const result = urlAwareWrapText(url, 20);
  assert.equal(result.length, 1, 'URL should remain on a single line');
  assert.equal(result[0], url);
});

test('urlAwareWrapText wraps prose normally when no URLs', () => {
  const result = urlAwareWrapText('The quick brown fox jumps over the lazy dog', 20);
  assert.ok(result.length > 1, 'prose should wrap at word boundaries');
  assert.ok(
    result.every((line) => graphemeLength(line) <= 20),
    'all lines within width',
  );
});

test('urlAwareWrapText wraps mixed prose + URL preserving URL intact', () => {
  const text = 'see https://example.com/path for details about the project';
  const result = urlAwareWrapText(text, 36);
  // The URL should appear intact in one of the lines
  const allText = result.join(' ');
  assert.ok(allText.includes('https://example.com/path'), 'URL preserved intact');
});

test('urlAwareWrapText handles text without URLs same as standard wrapping', () => {
  const text = 'Hello world this is a test of wrapping';
  const result = urlAwareWrapText(text, 10);
  assert.ok(result.length > 1);
  assert.ok(result.every((line) => graphemeLength(line) <= 10));
});

test('urlAwareWrapText returns empty array element for empty text', () => {
  const result = urlAwareWrapText('', 20);
  assert.deepEqual(result, ['']);
});

test('urlAwareWrapText handles zero maxWidth', () => {
  const result = urlAwareWrapText('Hello world', 0);
  assert.deepEqual(result, ['Hello world']);
});

test('urlAwareWrapText preserves text with multiple URLs', () => {
  const text = 'See https://a.com and also https://b.com/path';
  const result = urlAwareWrapText(text, 80);
  const allText = result.join(' ');
  assert.ok(allText.includes('https://a.com'));
  assert.ok(allText.includes('https://b.com/path'));
});

test('urlAwareWrapText handles custom scheme URLs', () => {
  const text = 'Open customapp://settings/theme/dark for config';
  const result = urlAwareWrapText(text, 50);
  const allText = result.join(' ');
  assert.ok(allText.includes('customapp://settings/theme/dark'));
});
