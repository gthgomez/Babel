/** TF-10 — an empty structured Ask object is a typed non-success. */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AskAnswerSchema,
  EMPTY_ASK_ANSWER_MESSAGE,
  type AskAnswer,
} from '../schemas/agentContracts.js';
import { ensureUsableAskAnswer, safeParseAskAnswer } from './askAnswer.js';
import { buildAskResultPayload } from '../cli/structuredOutput.js';
import { getUserFacingStatus } from '../cli/userFacingStatus.js';

const emptyVerification = {
  status: 'not_required' as const,
  commands: [] as string[],
  skipped_reason: null as string | null,
};

test('schema-parsed empty Ask object cannot be ANSWER_READY', () => {
  const parsed = AskAnswerSchema.parse({ schema_version: 1, status: 'ANSWER_READY' });
  assert.equal(parsed.status, 'ASK_FAILED');
  assert.equal(parsed.summary, EMPTY_ASK_ANSWER_MESSAGE);
  assert.equal(parsed.answer, EMPTY_ASK_ANSWER_MESSAGE);
});

test('safe parse of an empty object is ASK_FAILED with a truthful message', () => {
  const parsed = safeParseAskAnswer({});
  assert.equal(parsed.status, 'ASK_FAILED');
  assert.equal(parsed.answer, EMPTY_ASK_ANSWER_MESSAGE);
  assert.equal(parsed.summary, EMPTY_ASK_ANSWER_MESSAGE);
});

test('whitespace-only answer is downgraded by the defense-in-depth guard', () => {
  const answer: AskAnswer = {
    schema_version: 1,
    status: 'ANSWER_READY',
    summary: '   ',
    answer: ' \n\t ',
    facts: [],
    assumptions: [],
    evidence: [],
    next: [],
  };
  const guarded = ensureUsableAskAnswer(answer);
  assert.equal(guarded.status, 'ASK_FAILED');
  assert.equal(guarded.answer, EMPTY_ASK_ANSWER_MESSAGE);
});

test('empty Ask payload exits non-success and reports failed user_status', () => {
  const answer = AskAnswerSchema.parse({ schema_version: 1, status: 'ANSWER_READY' });
  const payload = buildAskResultPayload({ answer, task: 'explain this repository' });
  assert.equal(payload.status, 'ASK_FAILED');
  assert.equal(payload.user_status, 'failed');
  assert.equal(payload.answer.answer, EMPTY_ASK_ANSWER_MESSAGE);
  assert.equal(
    getUserFacingStatus({
      status: payload.status,
      verification: emptyVerification,
      changedFiles: [],
    }),
    'failed',
  );
});

test('positive control: a substantive structured answer remains ANSWER_READY', () => {
  const answer = AskAnswerSchema.parse({
    schema_version: 1,
    status: 'ANSWER_READY',
    summary: 'The CLI entry point is src/index.ts.',
    answer: 'The CLI entry point is src/index.ts.',
    facts: ['src/index.ts exists.'],
    assumptions: [],
    evidence: [],
    next: [],
  });
  assert.equal(answer.status, 'ANSWER_READY');
  const payload = buildAskResultPayload({ answer, task: 'what is the entry point?' });
  assert.equal(payload.status, 'ANSWER_READY');
  assert.equal(payload.user_status, 'success');
});
