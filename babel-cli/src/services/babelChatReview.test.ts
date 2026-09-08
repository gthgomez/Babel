import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBabelChatVerdict } from './babelChatReview.js';

const scope = ['src/a.ts'];
function payload(verdict = 'APPROVE', uncertain = false) {
  return { mode: 'chat', write_count: 0, terminal_outcome: 'NO_CHANGE_REQUIRED', answer: { answer: JSON.stringify({ verdict, uncertain, reviewed_files: scope, findings: [], blocking_findings: [] }) } };
}
test('Babel chat review requires a separate exact-scope verdict', () => {
  assert.equal(parseBabelChatVerdict(payload(), scope).verdict, 'APPROVE');
  assert.equal(parseBabelChatVerdict(payload('APPROVE', true), scope).verdict, 'BLOCK');
  assert.throws(() => parseBabelChatVerdict(payload(), ['other.ts']));
  assert.throws(() => parseBabelChatVerdict({ ...payload(), terminal_outcome: 'UNVERIFIED_PATCH' }, scope));
  assert.throws(() => parseBabelChatVerdict({ ...payload(), mode: 'deep' }, scope));
  assert.throws(() => parseBabelChatVerdict({ ...payload(), write_count: 1 }, scope));
  assert.throws(() => parseBabelChatVerdict({ ...payload(), terminal_outcome: 'VERIFIED_COMPLETE' }, scope));
  assert.throws(() => parseBabelChatVerdict({ ...payload(), answer: { answer: 'looks good' } }, scope));
});

test('snapshot mount paths map only to exact expected scope without changing findings or blockers', () => {
  const original = { verdict: 'BLOCK', uncertain: false, reviewed_files: ['source/src/a.ts'], findings: ['source/src/a.ts:1 concrete defect'], blocking_findings: ['Preserve this blocker'] };
  const value = { ...payload(), answer: { answer: JSON.stringify(original) } };
  const result = parseBabelChatVerdict(value, scope);
  assert.deepEqual(result.reviewed_files, scope);
  assert.equal(result.verdict, 'BLOCK');
  assert.deepEqual(result.findings, original.findings);
  assert.deepEqual(result.blocking_findings, original.blocking_findings);
  assert.equal(JSON.parse(value.answer.answer).reviewed_files[0], 'source/src/a.ts');
  for (const paths of [['source/other.ts'], ['source/../src/a.ts'], ['/src/a.ts'], ['C:/src/a.ts'], ['source/SRC/a.ts'], ['source/src/a.ts', 'unknown.ts'], ['source/source/src/a.ts']]) {
    assert.throws(() => parseBabelChatVerdict({ ...value, answer: { answer: JSON.stringify({ ...original, reviewed_files: paths }) } }, scope), /CHAT_REVIEW_SCOPE_MISMATCH/);
  }
  assert.throws(() => parseBabelChatVerdict(value, ['src/a.ts', 'src/b.ts']), /CHAT_REVIEW_SCOPE_MISMATCH/);
});

test('real repository source directory is not stripped when it is already an exact scope member', () => {
  const paths = ['src/a.ts', 'source/src/a.ts'];
  const value = { ...payload(), answer: { answer: JSON.stringify({ verdict: 'APPROVE', uncertain: false, reviewed_files: paths, findings: [], blocking_findings: [] }) } };
  assert.deepEqual(parseBabelChatVerdict(value, paths).reviewed_files, paths);
  assert.throws(() => parseBabelChatVerdict({ ...value, answer: { answer: JSON.stringify({ verdict: 'APPROVE', uncertain: false, reviewed_files: ['source/src/a.ts', 'source/source/src/a.ts'], findings: [], blocking_findings: [] }) } }, paths), /CHAT_REVIEW_SCOPE_MISMATCH/);
});
