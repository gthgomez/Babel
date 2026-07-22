import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from './extractJson.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parse(raw: string): unknown {
  return extractJson(raw);
}

function throws(raw: string): Error {
  try {
    extractJson(raw);
    throw new Error('Expected extractJson to throw but it did not');
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Expected')) throw e;
    return e as Error;
  }
}

// ─── Pass 1: Markdown fence extraction ───────────────────────────────────────

describe('extractJson — markdown fence extraction', () => {

  it('extracts object from ```json fence', () => {
    const raw = '```json\n{"a":1}\n```';
    assert.deepEqual(parse(raw), { a: 1 });
  });

  it('extracts object from plain ``` fence', () => {
    const raw = '```\n{"b":2}\n```';
    assert.deepEqual(parse(raw), { b: 2 });
  });

  it('extracts array from fence', () => {
    const raw = '```json\n[1,2,3]\n```';
    assert.deepEqual(parse(raw), [1, 2, 3]);
  });

  it('skips invalid fence and falls through to brace scan', () => {
    // First fence is invalid JSON, second valid JSON sits inline
    const raw = '```json\nnot-json\n```\nsome text {"ok":true}';
    assert.deepEqual(parse(raw), { ok: true });
  });

  it('handles fence with no newline before content', () => {
    const raw = '```json{"c":3}```';
    assert.deepEqual(parse(raw), { c: 3 });
  });

  it('extracts from fence surrounded by prose', () => {
    const raw = 'Here is the result:\n```json\n{"status":"ok"}\n```\nDone.';
    assert.deepEqual(parse(raw), { status: 'ok' });
  });

});

// ─── Pass 2: Balanced-brace extraction ───────────────────────────────────────

describe('extractJson — balanced-brace extraction', () => {

  it('extracts bare object', () => {
    assert.deepEqual(parse('{"x":1}'), { x: 1 });
  });

  it('extracts bare array', () => {
    assert.deepEqual(parse('[1,2,3]'), [1, 2, 3]);
  });

  it('extracts object preceded by prose', () => {
    assert.deepEqual(parse('Here is the plan: {"step":1}'), { step: 1 });
  });

  it('extracts first object when multiple are present', () => {
    assert.deepEqual(parse('{"first":1} {"second":2}'), { first: 1 });
  });

  it('handles deeply nested objects', () => {
    const raw = '{"a":{"b":{"c":{"d":42}}}}';
    assert.deepEqual(parse(raw), { a: { b: { c: { d: 42 } } } });
  });

  it('handles embedded strings with braces', () => {
    const raw = '{"msg":"use {curly} braces"}';
    assert.deepEqual(parse(raw), { msg: 'use {curly} braces' });
  });

  it('handles embedded strings with escaped quotes', () => {
    const raw = '{"msg":"say \\"hello\\""}';
    assert.deepEqual(parse(raw), { msg: 'say "hello"' });
  });

  it('handles embedded strings with backslashes', () => {
    const raw = '{"path":"segments\\\\with\\\\backslashes"}';
    assert.deepEqual(parse(raw), { path: 'segments\\with\\backslashes' });
  });

  it('skips unquoted-key object and finds next valid JSON', () => {
    // {key: value} is invalid JSON; the valid one comes after
    const raw = '{key: value} {"valid":true}';
    assert.deepEqual(parse(raw), { valid: true });
  });

  it('handles array of objects', () => {
    const raw = '[{"a":1},{"b":2}]';
    assert.deepEqual(parse(raw), [{ a: 1 }, { b: 2 }]);
  });

  it('handles unicode values', () => {
    const raw = '{"emoji":"🚀","cjk":"中文"}';
    assert.deepEqual(parse(raw), { emoji: '🚀', cjk: '中文' });
  });

  it('handles large realistic JSON object', () => {
    const obj = { status: 'COMPLETE', steps: Array.from({ length: 20 }, (_, i) => ({ step: i + 1, tool: 'file_read', target: `src/file${i}.ts` })) };
    assert.deepEqual(parse(JSON.stringify(obj)), obj);
  });

});

// ─── ANSI stripping ───────────────────────────────────────────────────────────

describe('extractJson — ANSI noise stripping', () => {

  it('strips SGR colour codes before extraction', () => {
    const raw = '\x1b[32m{"ansi":true}\x1b[0m';
    assert.deepEqual(parse(raw), { ansi: true });
  });

  it('strips OSC sequences', () => {
    const raw = '\x1b]0;window title\x07{"osc":1}';
    assert.deepEqual(parse(raw), { osc: 1 });
  });

  it('strips cursor movement codes', () => {
    const raw = '\x1b[2J\x1b[H{"cursor":1}';
    assert.deepEqual(parse(raw), { cursor: 1 });
  });

  it('strips spinner / progress prefix noise', () => {
    const raw = '\x1b[?25l⠙ Thinking...\x1b[?25h\n{"result":"done"}';
    assert.deepEqual(parse(raw), { result: 'done' });
  });

});

// ─── Truncated / malformed output ────────────────────────────────────────────

describe('extractJson — truncated and error cases', () => {

  it('throws on completely empty string', () => {
    const err = throws('');
    assert.match(err.message, /No valid JSON found/);
  });

  it('throws on prose-only string', () => {
    const err = throws('I cannot complete this task.');
    assert.match(err.message, /No valid JSON found/);
  });

  it('throws on truncated object (no closing brace)', () => {
    const err = throws('{"truncated": true');
    assert.match(err.message, /No valid JSON found/);
  });

  it('throws on truncated array', () => {
    const err = throws('[1, 2, 3');
    assert.match(err.message, /No valid JSON found/);
  });

  it('includes output preview in error message', () => {
    const err = throws('this is not json at all');
    assert.match(err.message, /Output preview/);
  });

  it('throws on invalid fence with no fallback JSON', () => {
    const err = throws('```json\nnot-json\n```');
    assert.match(err.message, /No valid JSON found/);
  });

});
