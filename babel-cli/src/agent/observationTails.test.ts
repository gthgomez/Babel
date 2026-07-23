import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ObservationTailBuffer,
  resolveObservationTailChars,
} from './observationTails.js';

describe('ObservationTailBuffer', () => {
  test('records and retrieves entries in order', () => {
    const buf = new ObservationTailBuffer();
    buf.record('read_file', 'src/foo.ts', 'file content', 0);
    buf.record('grep', 'src/', 'some matches', 0);

    const all = buf.all();
    assert.equal(all.length, 2);
    assert.equal(all[0]?.tool, 'read_file');
    assert.equal(all[0]?.target, 'src/foo.ts');
    assert.equal(all[1]?.tool, 'grep');
  });

  test('ring buffer keeps only last N', () => {
    const buf = new ObservationTailBuffer({ maxEntries: 3 });
    buf.record('a', 't1', 'obs1');
    buf.record('b', 't2', 'obs2');
    buf.record('c', 't3', 'obs3');
    buf.record('d', 't4', 'obs4');

    const all = buf.all();
    assert.equal(all.length, 3);
    assert.equal(all[0]?.tool, 'b');
    assert.equal(all[1]?.tool, 'c');
    assert.equal(all[2]?.tool, 'd');
  });

  test('empty observations are skipped', () => {
    const buf = new ObservationTailBuffer();
    buf.record('read_file', 'src/foo.ts', '', 0);
    buf.record('grep', 'src/', '  ', 0);

    assert.equal(buf.all().length, 0);
  });

  test('secret patterns are redacted', () => {
    const buf = new ObservationTailBuffer();
    const fakeKey = 'sk-abc123xyz456def789ghi012jkl345';
    buf.record('run_command', 'echo key', `output: ${fakeKey}`, 0);

    const entry = buf.all()[0]!;
    assert.doesNotMatch(entry.tail, /sk-abc123xyz456def789ghi012jkl345/);
    assert.match(entry.tail, /\[REDACTED_API_KEY\]/);
  });

  test('long text is truncated to tailChars', () => {
    const buf = new ObservationTailBuffer({ tailChars: 50 });
    // Use characters that won't match secret patterns (punctuation + digits)
    const longObs = '-=#'.repeat(70); // 210 chars, no letter run over 40
    buf.record('read_file', 'long.txt', longObs, 0);

    const entry = buf.all()[0]!;
    assert.ok(entry.tail.length <= 50);
    // Should start with ellipsis since we took the tail
    assert.match(entry.tail, /^…/);
  });

  test('clear empties the buffer', () => {
    const buf = new ObservationTailBuffer();
    buf.record('a', 't1', 'obs1');
    buf.record('b', 't2', 'obs2');
    assert.equal(buf.all().length, 2);

    buf.clear();
    assert.equal(buf.all().length, 0);
  });
});

describe('resolveObservationTailChars', () => {
  test('returns default when env is unset', () => {
    assert.equal(resolveObservationTailChars({}), 2048);
  });

  test('parses positive integer from env', () => {
    assert.equal(resolveObservationTailChars({ BABEL_CHAT_OBSERVATION_TAIL_CHARS: '4096' }), 4096);
  });

  test('returns default for invalid env value', () => {
    assert.equal(resolveObservationTailChars({ BABEL_CHAT_OBSERVATION_TAIL_CHARS: 'abc' }), 2048);
    assert.equal(resolveObservationTailChars({ BABEL_CHAT_OBSERVATION_TAIL_CHARS: '0' }), 2048);
    assert.equal(resolveObservationTailChars({ BABEL_CHAT_OBSERVATION_TAIL_CHARS: '-5' }), 2048);
  });
});
