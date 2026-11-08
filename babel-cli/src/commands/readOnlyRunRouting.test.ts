import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseReadOnlyRunQuestionPath } from './workflowCommands.js';

const base = { explicitMode: false, hasAllowedTools: false, hasDisallowedTools: false, hasLock: false };

test('read-only routing keeps explanatory questions on the fast path', () => {
  for (const task of [
    'Where is the authentication middleware configured?',
    'What does this function do?',
    'Explain the test failure.',
    'Explain how to run the tests.',
    'Summarize the request flow in this repository.',
    'Show me the code that parses the config.',
  ]) {
    assert.equal(shouldUseReadOnlyRunQuestionPath({ ...base, task }), true, task);
  }
});

test('read-only routing refuses actionable coding requests', () => {
  for (const task of [
    'Find the bug in my authentication flow, fix it, run the relevant tests, and explain what you changed.',
    'Fix the failing test.',
    'Can you update the README and explain your change?',
    'Please add a regression test for this bug.',
    'Investigate the failure, then repair the implementation.',
    'Run the relevant tests and verify the result.',
  ]) {
    assert.equal(shouldUseReadOnlyRunQuestionPath({ ...base, task }), false, task);
  }
});

test('explicit mode, tool policy, or a lock always bypass the read-only shortcut', () => {
  const task = 'Explain the authentication flow.';
  assert.equal(shouldUseReadOnlyRunQuestionPath({ ...base, task, explicitMode: true }), false);
  assert.equal(shouldUseReadOnlyRunQuestionPath({ ...base, task, hasAllowedTools: true }), false);
  assert.equal(shouldUseReadOnlyRunQuestionPath({ ...base, task, hasDisallowedTools: true }), false);
  assert.equal(shouldUseReadOnlyRunQuestionPath({ ...base, task, hasLock: true }), false);
});
