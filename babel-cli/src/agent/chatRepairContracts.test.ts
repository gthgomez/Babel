import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyChatTaskIntent } from './chatEngineTaskIntent.js'
import { resolveTaskShape } from '../config/chatTaskClass.js'
import { rewriteArgv } from '../cli/argv.js'

test('scoped file prohibitions preserve a separate requested implementation', () => {
  for (const task of [
    'Implement numeric addition in math.js. Do not modify the test file. Run npm test.',
    'Fix the bug. Do not edit math.test.js.',
    'Make status.js emit accessible markup. Keep tests unchanged.',
    'Order catalog.js items cheapest first. Run npm test.',
  ]) {
    assert.equal(classifyChatTaskIntent(task), 'execute', task)
    assert.notEqual(resolveTaskShape(task).operation, 'READ_ONLY', task)
  }
})

test('global denials and standalone scoped denials stay read-only', () => {
  for (const task of [
    'Fix it without modifying any files.',
    'Do not modify the test file.',
    'Review the change. Do not edit math.test.js.',
    'Implement it. Do not modify the filesystem.',
    'Explain this change: ```diff\n+fix()\n```',
    'Explain the sort order in catalog.js',
    'Review the order of middleware',
    'Explain sort order and how it works',
    'Explain how add works in math.js',
    'Review the add function in math.js',
    'Explain how add and remove work in list.js',
    'Review add and remove behavior in list.js',
  ]) assert.equal(classifyChatTaskIntent(task), 'explain', task)
  for (const task of ['Explain the sort order in catalog.js', 'Review the order of middleware',
    'Explain how add works in math.js', 'Review the add function in math.js',
    'Explain how add and remove work in list.js', 'Review add and remove behavior in list.js'])
    assert.equal(resolveTaskShape(task).operation, 'READ_ONLY', task)
})

test('resume option keeps its spaced value separate from a multiword task', () => {
  for (const args of [
    ['run', 'explain', 'this', '--resume-chat', 'chat-123'],
    ['run', '--resume-chat', 'chat-123', 'explain', 'this'],
  ]) assert.deepEqual(rewriteArgv(['node', 'babel', ...args]),
    ['node', 'babel', 'run', '--resume-chat', 'chat-123', 'explain this'])
})
