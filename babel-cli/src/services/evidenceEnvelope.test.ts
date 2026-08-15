import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceEnvelope, extractTestName } from './evidenceEnvelope.js';

test('envelope: parses a jest-style failing run', () => {
  const out = [
    'FAIL tests/unicode.spec.ts',
    '  ● test_unicode_offset › should handle offset',
    '    Expected: 2, Received: 1',
    'Tests: 3 failed, 12 passed, 15 total',
    'Test Suites: 1 failed, 2 passed, 3 total',
  ].join('\n');
  const e = buildEvidenceEnvelope({ output: out, exitCode: 1, command: 'npx jest', rawRef: 'evidence://run/23/verifier/1' });
  assert.equal(e.runner, 'jest');
  assert.equal(e.failedCount, 3);
  assert.equal(e.passedCount, 12);
  assert.equal(e.exitCode, 1);
  assert.equal(e.degraded, false);
  assert.ok(e.summary.includes('3 failed'));
  assert.ok(e.summary.includes('evidence://run/23/verifier/1'));
  assert.equal(e.rawRef, 'evidence://run/23/verifier/1');
});

test('envelope: parses a pytest-style summary', () => {
  const out = [
    'tests/test_api.py::test_login PASSED',
    'tests/test_api.py::test_auth FAILED',
    '===== 1 passed, 1 failed, 2 skipped in 1.20s =====',
  ].join('\n');
  const e = buildEvidenceEnvelope({ output: out, exitCode: 1, command: 'pytest', rawRef: 'obs:abc' });
  assert.equal(e.runner, 'pytest');
  assert.equal(e.failedCount, 1);
  assert.equal(e.passedCount, 1);
  assert.equal(e.skippedCount, 2);
});

test('envelope: unrecognized output degrades but never loses the raw ref', () => {
  const e = buildEvidenceEnvelope({ output: 'some opaque error text', exitCode: 1, command: 'node x.mjs', rawRef: 'obs:xyz' });
  assert.equal(e.degraded, true);
  assert.equal(e.passedCount, null);
  assert.equal(e.failedCount, null);
  assert.ok(e.summary.includes('obs:xyz'));
  assert.equal(e.rawRef, 'obs:xyz');
  assert.equal(e.failures.length, 0);
});

test('envelope: never throws on pathological input', () => {
  const e = buildEvidenceEnvelope({ output: '', exitCode: null, rawRef: 'obs:empty' });
  assert.equal(e.degraded, true);
  assert.ok(e.summary.length > 0);
});

test('envelope: failure lines are captured with source refs', () => {
  const out = ['✕ test_auth fails', '✕ test_b fails', 'Tests: 2 failed, 0 passed'].join('\n');
  const e = buildEvidenceEnvelope({ output: out, exitCode: 1, command: 'npx vitest', rawRef: 'obs:f' });
  assert.equal(e.failures.length, 2);
  assert.equal(e.failures[0]!.test, 'test_auth fails');
  assert.equal(e.failures[0]!.sourceRef, 'obs:f');
});

test('envelope: test name extraction for inline probes', () => {
  assert.equal(extractTestName("test('unicode_index_contract', () => {})"), 'unicode_index_contract');
  assert.equal(extractTestName('no test here'), null);
});
