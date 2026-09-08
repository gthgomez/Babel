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
