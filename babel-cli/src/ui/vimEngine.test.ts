/**
 * G2 — vim operator + motion + text-object engine tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMotion,
  applyOperatorMotion,
  applyOperatorTextObject,
  applyLinewiseOperator,
  textObjectRange,
  feedVimKey,
  type BufferState,
  type PendingKind,
} from './vimEngine.js';

function st(text: string, line = 0, col = 0): BufferState {
  return { lines: text.split('\n'), cursor: { line, col } };
}

describe('vimEngine motions', () => {
  it('w and b move by words', () => {
    const lines = ['hello world foo'];
    const w = applyMotion(lines, { line: 0, col: 0 }, { kind: 'w', count: 1 });
    assert.equal(w.col, 6);
    const b = applyMotion(lines, { line: 0, col: 6 }, { kind: 'b', count: 1 });
    assert.equal(b.col, 0);
  });

  it('count multiplies motion', () => {
    const lines = ['a b c d e'];
    const p = applyMotion(lines, { line: 0, col: 0 }, { kind: 'w', count: 3 });
    assert.equal(p.col, 6); // start of 'd'
  });

  it('f finds character', () => {
    const lines = ['hello world'];
    const p = applyMotion(lines, { line: 0, col: 0 }, { kind: 'f', char: 'w', count: 1 });
    assert.equal(p.col, 6);
  });

  it('$ and 0', () => {
    const lines = ['abc'];
    assert.equal(applyMotion(lines, { line: 0, col: 1 }, { kind: '$', count: 1 }).col, 3);
    assert.equal(applyMotion(lines, { line: 0, col: 2 }, { kind: '0', count: 1 }).col, 0);
  });
});

describe('vimEngine text objects', () => {
  it('diw deletes inner word', () => {
    const state = st('hello world', 0, 1);
    const r = applyOperatorTextObject(state, 'd', 'iw');
    assert.ok(r);
    assert.equal(r!.lines[0], ' world');
    assert.equal(r!.yanked, 'hello');
  });

  it('da( deletes around parens', () => {
    const state = st('foo(bar)baz', 0, 5);
    const r = applyOperatorTextObject(state, 'd', 'a(');
    assert.ok(r);
    assert.equal(r!.lines[0], 'foobaz');
    assert.equal(r!.yanked, '(bar)');
  });

  it('yi" yanks inner quotes', () => {
    const state = st('say "hi" now', 0, 6);
    const r = applyOperatorTextObject(state, 'y', 'i"');
    assert.ok(r);
    assert.equal(r!.yanked, 'hi');
    assert.equal(r!.lines[0], 'say "hi" now');
  });

  it('textObjectRange iw at word start', () => {
    const range = textObjectRange(['abc def'], { line: 0, col: 0 }, 'iw');
    assert.ok(range);
    assert.equal(range!.start.col, 0);
    assert.equal(range!.end.col, 3);
  });
});

describe('vimEngine operators', () => {
  it('dw deletes word', () => {
    const state = st('hello world', 0, 0);
    const r = applyOperatorMotion(state, 'd', { kind: 'w', count: 1 });
    assert.equal(r.lines[0], 'world');
    assert.equal(r.yanked, 'hello ');
  });

  it('d$ deletes to end of line', () => {
    const state = st('hello world', 0, 5);
    const r = applyOperatorMotion(state, 'd', { kind: '$', count: 1 });
    assert.equal(r.lines[0], 'hello');
  });

  it('c enters insert', () => {
    const state = st('hello', 0, 0);
    const r = applyOperatorMotion(state, 'c', { kind: 'w', count: 1 });
    assert.equal(r.enterInsert, true);
    assert.equal(r.lines[0], '');
  });

  it('dd linewise delete', () => {
    const state = st('a\nb\nc', 1, 0);
    const r = applyLinewiseOperator(state, 'd', 1);
    assert.deepEqual(r.lines, ['a', 'c']);
    assert.ok(r.yanked.includes('b'));
  });

  it('3dd deletes three lines', () => {
    const state = st('a\nb\nc\nd', 0, 0);
    const r = applyLinewiseOperator(state, 'd', 3);
    assert.deepEqual(r.lines, ['d']);
  });
});

describe('vimEngine feedVimKey state machine', () => {
  it('builds count then motion', () => {
    let p: PendingKind = { type: 'none' };
    let step = feedVimKey(p, '3');
    p = step.pending;
    step = feedVimKey(p, 'w');
    assert.ok(step.motion);
    assert.equal(step.motion!.kind, 'w');
    assert.equal(step.motion!.count, 3);
  });

  it('d then w yields operator motion', () => {
    let p: PendingKind = { type: 'none' };
    let step = feedVimKey(p, 'd');
    p = step.pending;
    step = feedVimKey(p, 'w');
    assert.ok(step.op);
    assert.equal(step.op!.op, 'd');
    assert.equal(step.op!.motion?.kind, 'w');
  });

  it('d then i then w yields text object', () => {
    let p: PendingKind = { type: 'none' };
    p = feedVimKey(p, 'd').pending;
    p = feedVimKey(p, 'i').pending;
    const step = feedVimKey(p, 'w');
    assert.ok(step.op?.textObject === 'iw');
  });

  it('dd is linewise', () => {
    let p: PendingKind = { type: 'none' };
    p = feedVimKey(p, 'd').pending;
    const step = feedVimKey(p, 'd');
    assert.equal(step.op?.linewiseCount, 1);
  });

  it('f then char', () => {
    let p: PendingKind = { type: 'none' };
    p = feedVimKey(p, 'f').pending;
    const step = feedVimKey(p, 'x');
    assert.equal(step.motion?.kind, 'f');
    assert.equal(step.motion?.char, 'x');
  });
});
