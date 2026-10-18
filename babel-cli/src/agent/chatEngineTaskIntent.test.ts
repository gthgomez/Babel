import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyChatTaskIntent } from './chatEngineTaskIntent.js'
import { analyzeTaskShape, resolveTaskShape } from '../config/chatTaskClass.js'

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
    'review the auth module and fix any bugs',
    'run npm test',
    'create a helper',
  ]) {
    assert.equal(classifyChatTaskIntent(task), 'execute', task)
  }
  for (const task of ['hello!', 'thanks', '?', '...']) {
    assert.equal(classifyChatTaskIntent(task), 'explain', task)
  }
})


test('coordinated repair predicates accept ordinary nouns and paths without turning topics into commands',()=>{
  for(const task of ['Review parser.js and fix bugs.','Explain the failure and fix parser.js.',
    'Review authentication and repair login.','Explain caching and resolve races.'])
    assert.equal(classifyChatTaskIntent(task),'execute',task)
  for(const task of ['Explain add and remove behavior','Review add and remove behavior in list.js',
    'Explain fix and repair behavior','Explain how to fix bugs and repair parser.js.',
    'Review parser.js and fix bugs. Do not edit files.'])
    assert.equal(classifyChatTaskIntent(task),'explain',task)
})


for(const edit of ['update documentation','add validation','remove dead code','refactor parser.js',
  'change defaults','write logs','create helpers','modify configuration','rename exports','replace delimiters'])
test(`a coordinated ${edit} request retains explicit change intent`,()=>{
  const task='Review parser.js and '+edit+'.'
  assert.equal(classifyChatTaskIntent(task),'execute')
  assert.equal(analyzeTaskShape(task).operation,'HYBRID')
})

test('ordinary API names in coordinated topics do not grant edits',()=>{
  for(const task of ['Explain read and write semantics','Review get and remove behavior',
    'Explain how to update documentation and remove dead code.']){
    assert.equal(classifyChatTaskIntent(task),'explain',task)
    assert.equal(analyzeTaskShape(task).operation,'READ_ONLY',task)
  }
})

test('API topics preserve later coordinated edit requests', () => {
  for (const topic of ['Review add and remove behavior in list.js',
    'Explain read and write semantics', 'Review get and remove behavior']) {
    for (const edit of ['update documentation', 'add validation', 'remove dead code',
      'refactor parser.js', 'change defaults', 'write logs', 'create helpers',
      'modify configuration', 'rename exports', 'replace delimiters']) {
      const task = `${topic} and ${edit}.`;
      assert.equal(classifyChatTaskIntent(task), 'execute', task);
      assert.equal(analyzeTaskShape(task).operation, 'HYBRID', task);
      const denied = `${task} Do not edit files.`;
      assert.equal(classifyChatTaskIntent(denied), 'explain', denied);
      assert.equal(resolveTaskShape(denied).operation, 'READ_ONLY', denied);
    }
  }
})
