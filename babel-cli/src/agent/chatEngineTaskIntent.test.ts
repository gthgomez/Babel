import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyChatTaskIntent } from './chatEngineTaskIntent.js'

test('keeps evidence and read-only directives from granting execution authority', () => {
  for (const task of [
    'fix this without editing files',
    'review the repair module and report findings',
    'read the code and explain the failure',
    'inspect this without changing files: ```typescript\nconst fix = true\n```',
  ])
    assert.equal(classifyChatTaskIntent(task), 'explain', task)
})

test('recognizes actionable work attached to a greeting or review request', () => {
  for (const task of [
    'hi — fix the bug',
    'review and fix it',
    'run npm test',
    'create a helper',
  ]) {
    assert.equal(classifyChatTaskIntent(task), 'execute', task)
  }
  for (const task of ['hello!', 'thanks', '?', '...']) {
    assert.equal(classifyChatTaskIntent(task), 'explain', task)
  }
})
