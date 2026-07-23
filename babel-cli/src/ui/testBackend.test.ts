/**
 * Tests for VT100-style test output backend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TestOutputBuffer } from './testBackend.js';

// ─── Basic output capture ───────────────────────────────────────────────────

test('TestOutputBuffer captures writes', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello ');
  buf.write('World');
  const output = buf.getOutput();
  assert.equal(output, 'Hello World');
});

test('TestOutputBuffer captures multi-line output', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Line 1\n');
  buf.write('Line 2\n');
  buf.write('Line 3');
  const lines = buf.getLines();
  assert.equal(lines.length, 3);
});

test('TestOutputBuffer ignores writes when broken', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Before');
  buf.markBroken();
  buf.write('After');
  assert.equal(buf.canWrite, false);
  const output = buf.getOutput();
  assert.ok(!output.includes('After'));
});

// ─── Line access ────────────────────────────────────────────────────────────

test('getPlainOutput strips ANSI sequences', () => {
  const buf = TestOutputBuffer.create();
  buf.write('\x1b[1mBold\x1b[22m Normal');
  const plain = buf.getPlainOutput();
  assert.equal(plain, 'Bold Normal');
});

test('getPlainLines strips ANSI and splits', () => {
  const buf = TestOutputBuffer.create();
  buf.write('\x1b[31mRed\x1b[0m\n\x1b[32mGreen\x1b[0m');
  const lines = buf.getPlainLines();
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Red');
  assert.equal(lines[1], 'Green');
});

// ─── Assertions ─────────────────────────────────────────────────────────────

test('assertContains passes for matching text', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello World');
  buf.assertContains('Hello');
  assert.ok(true); // didn't throw
});

test('assertContains throws for non-matching text', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello World');
  assert.throws(() => buf.assertContains('Missing'));
});

test('assertNotContains passes when text is absent', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello World');
  buf.assertNotContains('Missing');
  assert.ok(true); // didn't throw
});

test('assertNotContains throws when text present', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello World');
  assert.throws(() => buf.assertNotContains('Hello'));
});

test('assertLineMatches passes when regex matches', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello World\nFoo Bar');
  buf.assertLineMatches(0, /Hello/);
  buf.assertLineMatches(1, /Bar/);
  assert.ok(true);
});

test('assertLineMatches throws for non-matching regex', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello World');
  assert.throws(() => buf.assertLineMatches(0, /^Missing$/));
});

test('assertLineMatches throws for out-of-range index', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Hello');
  assert.throws(() => buf.assertLineMatches(5, /test/));
});

test('assertLineCount passes for correct count', () => {
  const buf = TestOutputBuffer.create();
  buf.write('A\nB\nC');
  buf.assertLineCount(3);
  assert.ok(true);
});

test('assertLineCount throws for wrong count', () => {
  const buf = TestOutputBuffer.create();
  buf.write('A\nB\nC');
  assert.throws(() => buf.assertLineCount(2));
});

test('assertOutput passes for exact match', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Exact text');
  buf.assertOutput('Exact text');
  assert.ok(true);
});

test('assertOutput throws for mismatch', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Actual text');
  assert.throws(() => buf.assertOutput('Expected text'));
});

// ─── Lifecycle ──────────────────────────────────────────────────────────────

test('reset clears the buffer', () => {
  const buf = TestOutputBuffer.create();
  buf.write('Some data');
  buf.reset();
  assert.equal(buf.getOutput(), '');
  assert.equal(buf.getLines().length, 1); // empty split gives ['']
});

// ─── Hyperlink capture ─────────────────────────────────────────────────────

test('writeHyperlink emits OSC 8 for valid URLs', () => {
  const buf = TestOutputBuffer.create();
  buf.writeHyperlink('https://example.com', 'click here');
  const output = buf.getOutput();
  assert.ok(output.includes('\x1b]8;;https://example.com\x07'));
  assert.ok(output.includes('click here'));
});

test('writeHyperlink writes plain text for non-web URIs', () => {
  const buf = TestOutputBuffer.create();
  buf.writeHyperlink('mailto:test@test.com', 'email');
  const output = buf.getOutput();
  assert.equal(output, 'email');
});
