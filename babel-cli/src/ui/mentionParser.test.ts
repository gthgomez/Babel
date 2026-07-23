import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMentionTrigger } from './mentionParser.js';

// ─── MentionParser Tests ────────────────────────────────────────────────────

describe('detectMentionTrigger', () => {
  // ── Basic detection ────────────────────────────────────────────────────

  it('detects @ at start of line', () => {
    const result = detectMentionTrigger(['@src/main.ts'], 0, 12);
    assert.notEqual(result, null);
    assert.equal(result!.trigger, '@');
    assert.equal(result!.query, 'src/main.ts');
    assert.equal(result!.startCol, 1);
    assert.equal(result!.cursorLine, 0);
  });

  it('detects @ preceded by space', () => {
    // 'edit @src/main.ts' — indices: e0 d1 i2 t3 (4) @5 s6 r7 c8 /9 m10 a11 i12 n13 .14 t15 s16
    const result = detectMentionTrigger(['edit @src/main.ts'], 0, 17);
    assert.notEqual(result, null);
    assert.equal(result!.trigger, '@');
    assert.equal(result!.query, 'src/main.ts');
    assert.equal(result!.startCol, 6);
  });

  it('detects @ with partial query after it', () => {
    // 'open @src/' — o0 p1 e2 n3 (4) @5 s6 r7 c8 /9
    const result = detectMentionTrigger(['open @src/'], 0, 10);
    assert.notEqual(result, null);
    assert.equal(result!.query, 'src/');
  });

  it('detects @ at end of line with empty query', () => {
    const result = detectMentionTrigger(['edit @'], 0, 6);
    assert.notEqual(result, null);
    assert.equal(result!.trigger, '@');
    assert.equal(result!.query, '');
    assert.equal(result!.startCol, 6);
  });

  // ── Edge cases: no trigger ─────────────────────────────────────────────

  it('returns null when no @ on current line', () => {
    const result = detectMentionTrigger(['hello world'], 0, 11);
    assert.equal(result, null);
  });

  it('returns null on empty line', () => {
    const result = detectMentionTrigger(['hello', '', 'world'], 1, 0);
    assert.equal(result, null);
  });

  it('returns null on empty lines array', () => {
    const result = detectMentionTrigger([], 0, 0);
    assert.equal(result, null);
  });

  it('returns null when cursor is on a different line than @', () => {
    // @ is on line 0, cursor is on line 1
    const result = detectMentionTrigger(['@src/main.ts', 'other text'], 1, 5);
    assert.equal(result, null);
  });

  // ── Edge cases: non-trigger patterns ───────────────────────────────────

  it('returns null for @ in middle of word (email-like)', () => {
    const result = detectMentionTrigger(['foo@bar.com'], 0, 10);
    assert.equal(result, null);
  });

  it('returns null for @ preceded by non-space character', () => {
    const result = detectMentionTrigger(['path@src/main.ts'], 0, 16);
    assert.equal(result, null);
  });

  it('handles @@ — second @ starts a new trigger', () => {
    // 'contact @@admin' — c0 o1 n2 t3 a4 c5 t6 (7) @8 @9 a10 d11 m12 i13 n14
    // Scanning backward from cursorCol=15 finds @ at col 9, preceded by @ at col 8 → valid trigger
    const result = detectMentionTrigger(['contact @@admin'], 0, 15);
    assert.notEqual(result, null);
    assert.equal(result!.query, 'admin');
    assert.equal(result!.startCol, 10);
  });

  it('handles @@ where second @ starts after first', () => {
    // '@find @file' — @0 f1 i2 n3 d4 (5) @6 f7 i8 l9 e10
    const result = detectMentionTrigger(['@find @file'], 0, 11);
    assert.notEqual(result, null);
    // Scanning backward from col 11, we find @ at col 6, preceded by space at col 5
    assert.equal(result!.query, 'file');
    assert.equal(result!.startCol, 7);
  });

  // ── Cursor position ────────────────────────────────────────────────────

  it('only scans the current line for @', () => {
    // Line 1: 'but @file' — b0 u1 t2 (3) @4 f5 i6 l7 e8
    const result = detectMentionTrigger(['no @ here', 'but @file'], 1, 9);
    assert.notEqual(result, null);
    assert.equal(result!.query, 'file');
  });

  it('does not detect @ after the cursor position', () => {
    // @ is at col 0 but cursor is before it — can't really happen
    // unless cursor is at col 0 and @ is at col 0 — that's fine
    // This tests that scanning backward from cursor stops at cursor
    const result = detectMentionTrigger(['@abc'], 0, 0);
    assert.equal(result, null); // No backward chars to scan past
  });

  // ── Tab width / whitespace ─────────────────────────────────────────────

  it('detects @ preceded by tab', () => {
    const result = detectMentionTrigger(['\t@file.ts'], 0, 9);
    assert.notEqual(result, null);
    assert.equal(result!.query, 'file.ts');
  });

  it('detects @ at very start of line with single char', () => {
    const result = detectMentionTrigger(['@'], 0, 1);
    assert.notEqual(result, null);
    assert.equal(result!.query, '');
  });
});
