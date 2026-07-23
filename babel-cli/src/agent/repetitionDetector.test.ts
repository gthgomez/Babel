import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RepetitionDetector, buildFingerprint } from './repetitionDetector.js';

describe('RepetitionDetector', () => {
  test('returns { loop: false } from empty history', () => {
    const d = new RepetitionDetector();
    assert.equal(d.detect().loop, false);
  });

  test('returns { loop: false } with fewer than 3 calls', () => {
    const d = new RepetitionDetector();
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    const result = d.detect();
    assert.equal(result.loop, false);
  });

  test('detects loop with 3 identical write_file calls', () => {
    const d = new RepetitionDetector();
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    const r = d.detect();
    assert.equal(r.loop, true);
    assert.equal(r.tool, 'write_file');
    assert.equal(r.count, 3);
  });

  test('detects loop with 5 identical run_command calls', () => {
    const d = new RepetitionDetector();
    for (let i = 0; i < 5; i++) {
      d.record({ type: 'run_command', fingerprint: buildFingerprint('run_command', 'npm test') });
    }
    const r = d.detect();
    assert.equal(r.loop, true);
    assert.equal(r.tool, 'run_command');
    assert.equal(r.count, 5);
  });

  test('message format matches spec example', () => {
    const d = new RepetitionDetector();
    for (let i = 0; i < 5; i++) {
      d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'test-gemma-utils.ts') });
    }
    const r = d.detect();
    assert.equal(r.loop, true);
    assert.equal(r.count, 5);
    assert.match(r.message ?? '', /Same write_file to test-gemma-utils\.ts repeated 5 times/);
  });

  test('detects loop with finish tool (empty target)', () => {
    const d = new RepetitionDetector();
    for (let i = 0; i < 4; i++) {
      d.record({ type: 'finish', fingerprint: 'finish:' });
    }
    const r = d.detect();
    assert.equal(r.loop, true);
    assert.equal(r.tool, 'finish');
    assert.equal(r.count, 4);
  });

  test('finish loop message omits empty target gracefully', () => {
    const d = new RepetitionDetector();
    for (let i = 0; i < 3; i++) {
      d.record({ type: 'finish', fingerprint: 'finish:' });
    }
    const r = d.detect();
    assert.match(r.message ?? '', /Same finish repeated 3 times/);
  });

  test('detects no loop when tool differs', () => {
    const d = new RepetitionDetector();
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    d.record({ type: 'grep', fingerprint: buildFingerprint('grep', 'something') });
    assert.equal(d.detect().loop, false);
  });

  test('detects no loop when target/path differs', () => {
    const d = new RepetitionDetector();
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'foo.ts') });
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'bar.ts') });
    // Last 3 are NOT identical — foo.ts, foo.ts, bar.ts
    assert.equal(d.detect().loop, false);
  });

  test('reset clears history', () => {
    const d = new RepetitionDetector();
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    assert.equal(d.detect().loop, true);
    d.reset();
    assert.equal(d.detect().loop, false);
  });

  test('interleaved different calls break the streak but detect new streak', () => {
    const d = new RepetitionDetector();
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    d.record({ type: 'grep', fingerprint: buildFingerprint('grep', 'foo') }); // breaks streak
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', 'a.ts') });
    const r = d.detect();
    // Last 3 are read_file:a.ts → loop detected
    assert.equal(r.loop, true);
    assert.equal(r.count, 3);
  });

  test('detects loop with str_replace on same file_path', () => {
    const d = new RepetitionDetector();
    for (let i = 0; i < 3; i++) {
      d.record({ type: 'str_replace', fingerprint: buildFingerprint('str_replace', 'src/main.ts') });
    }
    const r = d.detect();
    assert.equal(r.loop, true);
    assert.equal(r.tool, 'str_replace');
    assert.match(r.message ?? '', /Same str_replace to src\/main\.ts repeated 3 times/);
  });

  test('detects loop with grep on same pattern', () => {
    const d = new RepetitionDetector();
    for (let i = 0; i < 4; i++) {
      d.record({ type: 'grep', fingerprint: buildFingerprint('grep', 'TODO') });
    }
    const r = d.detect();
    assert.equal(r.loop, true);
    assert.equal(r.count, 4);
  });

  test('detects loop with glob on same pattern', () => {
    const d = new RepetitionDetector();
    d.record({ type: 'glob', fingerprint: buildFingerprint('glob', '**/*.ts') });
    d.record({ type: 'glob', fingerprint: buildFingerprint('glob', '**/*.ts') });
    d.record({ type: 'glob', fingerprint: buildFingerprint('glob', '**/*.ts') });
    assert.equal(d.detect().loop, true);
  });

  test('history respects maxHistory', () => {
    const d = new RepetitionDetector(5);
    assert.equal(d.getHistory().length, 0);
    for (let i = 0; i < 10; i++) {
      d.record({ type: 'read_file', fingerprint: buildFingerprint('read_file', `file${i}.ts`) });
    }
    // Only the last 5 should be kept
    assert.equal(d.getHistory().length, 5);
    assert.equal(d.getHistory()[0]!.fingerprint, 'read_file:file5.ts');
  });

  test('maxHistory is never below 3', () => {
    const d = new RepetitionDetector(1); // clamped to 3
    assert.equal(d.getHistory().length, 0);
    for (let i = 0; i < 5; i++) {
      d.record({ type: 'x', fingerprint: `x:${i}` });
    }
    assert.equal(d.getHistory().length, 3);
  });

  test('detect returns correct consecutive count from longer history', () => {
    const d = new RepetitionDetector(10);
    // Two of one tool, then 5 of another
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'a.ts') });
    d.record({ type: 'write_file', fingerprint: buildFingerprint('write_file', 'a.ts') });
    for (let i = 0; i < 5; i++) {
      d.record({ type: 'run_command', fingerprint: buildFingerprint('run_command', 'npm test') });
    }
    const r = d.detect();
    assert.equal(r.loop, true);
    assert.equal(r.tool, 'run_command');
    assert.equal(r.count, 5);
  });
});
