import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBabelChatVerdict, parseBabelReviewJson } from './babelChatReview.js';

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

test('one whole-document JSON fence preserves verdict, blockers, scope and raw output', () => {
  const original = { verdict: 'BLOCK', uncertain: true, reviewed_files: scope, findings: ['src/a.ts:1 defect'], blocking_findings: ['Do not rewrite this blocker'] };
  for (const language of ['', 'json']) for (const newline of ['\n', '\r\n']) {
    const answer = ` \n\`\`\`${language}${newline}${JSON.stringify(original)}${newline}\`\`\`\n `;
    const value = { ...payload(), answer: { answer } };
    assert.deepEqual(parseBabelChatVerdict(value, scope), original);
    assert.equal(value.answer.answer, answer);
    assert.throws(() => parseBabelChatVerdict(value, ['other.ts']), /CHAT_REVIEW_SCOPE_MISMATCH/);
    assert.throws(() => parseBabelChatVerdict({ ...value, write_count: 1 }, scope), /CHAT_REVIEW_NOT_COMPLETED/);
  }
  const withBlocker = { ...original, verdict: 'APPROVE', uncertain: false };
  assert.equal(parseBabelChatVerdict({ ...payload(), answer: { answer: `\`\`\`json\n${JSON.stringify(withBlocker)}\n\`\`\`` } }, scope).verdict, 'BLOCK');
});

test('fence normalization rejects prose, extra fences, unknown languages and incomplete JSON', () => {
  const json = payload().answer.answer;
  const fence = `\`\`\`json\n${json}\n\`\`\``;
  for (const answer of [`Here is the review:\n${fence}`, `${fence}\nApproved`, `${fence}\n${fence}`, `\`\`\`typescript\n${json}\n\`\`\``, `\`\`\`JSON\n${json}\n\`\`\``, `\`\`\`json ${json}\`\`\``, `\`\`\`json\n${json}`, `\`\`\`json\n${json.slice(0, -1)}\n\`\`\``, `\`\`\`json\n${json}\n${json}\n\`\`\``, `~~~json\n${json}\n~~~`]) {
    assert.throws(() => parseBabelChatVerdict({ ...payload(), answer: { answer } }, scope), SyntaxError);
  }
  for (const value of [[], null, { verdict: 'APPROVE' }, { ...JSON.parse(json), unexpected: true }]) {
    assert.throws(() => parseBabelChatVerdict({ ...payload(), answer: { answer: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` } }, scope));
  }
  const literal = { text: 'Keep ```json\ninside data\n``` unchanged' };
  assert.deepEqual(parseBabelReviewJson(`\`\`\`json\n${JSON.stringify(literal)}\n\`\`\``), literal);
});
