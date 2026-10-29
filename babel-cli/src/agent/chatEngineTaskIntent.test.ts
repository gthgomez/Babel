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

test('implementation with a third-party dependency constraint retains mutation intent', () => {
  const task = 'Implement the requested function. Create solution.py. Do not add third-party dependencies.'
  assert.equal(classifyChatTaskIntent(task), 'execute')
  assert.equal(resolveTaskShape(task).operation, 'HYBRID')
  assert.equal(classifyChatTaskIntent('Do not add third-party dependencies.'), 'explain')
  assert.equal(classifyChatTaskIntent('Implement the function. Do not edit files.'), 'explain')
})

test('scoped regression and safety preservation clauses retain explicit repair intent', () => {
  for (const objects of ['regression tests or unrelated code',
    'the regression tests, permissions, verification gates, dependencies, or unrelated code',
    'regression tests, permission or verification gates, provider accounting, dependencies, or unrelated code']) {
    const constraint = `Do not change ${objects}.`
    assert.equal(classifyChatTaskIntent(`Fix the implementation. ${constraint}`), 'execute', objects)
    assert.equal(classifyChatTaskIntent(constraint), 'explain', objects)
    assert.equal(classifyChatTaskIntent(`Explain the failure. ${constraint}`), 'explain', objects)
    assert.equal(classifyChatTaskIntent(`Fix the implementation. ${constraint} Do not edit files.`), 'explain', objects)
    assert.equal(classifyChatTaskIntent(`Inspect the source. ${constraint}\n\`\`\`\nfix the implementation\n\`\`\``), 'explain', objects)
  }
})

test('scoped prohibitions and fenced repair examples alone stay read-only', () => {
  for (const example of ['~~~\nfix the implementation\n~~~', '~~~\nfix the implementation',
    '~~~text~~~\nfix the implementation\n~~~',
    '````text\n```\nfix the implementation\n```\n````',
    '~~~~text\n~~~\nfix the implementation\n~~~\n~~~~',
    '```text\nliteral ``` marker\nfix the implementation\n```']) {
    const task = `Do not modify permissions.\n${example}`
    assert.equal(classifyChatTaskIntent(task), 'explain', task)
    assert.equal(classifyChatTaskIntent(`Fix src/main.js. ${task}`), 'execute', task)
  }
})

test('Markdown boundaries cannot hide denials or create repair intent', () => {
  for (const example of ['```text\n\t```\nfix the implementation\n```',
    '```text\n> ```\nfix the implementation\n```',
    '> ```text\n> fix the implementation\n> ```',
    '- ```text\n  fix the implementation\n  ```',
    '```text\rliteral ``` marker\rfix the implementation\r```']) {
    assert.equal(classifyChatTaskIntent(`Inspect source. Do not modify permissions.\n${example}`), 'explain', example)
  }
  assert.equal(classifyChatTaskIntent('Fix main.js. Example: ```\nsample\n``` Do not edit files.'), 'explain')
  assert.equal(classifyChatTaskIntent('Explain this example.\n> ```text\n> sample\n> ```\nFix main.js.'), 'execute')
})

test('HTML wrappers neither expose fenced repair examples nor hide prose denials', () => {
  for (const [open, close] of [['<pre>', '</pre>'], ['<!--', '-->'], ['<div>', '</div>']]) {
    const example = `${open}\n\`\`\`text\nfix the implementation\n\`\`\`\n${close}`
    assert.equal(classifyChatTaskIntent(`Inspect source. Do not modify permissions.\n\n${example}`), 'explain', open)
    assert.equal(classifyChatTaskIntent(`Fix main.js.\n${example}\n${open}Do not edit files.${close}`), 'explain', open)
  }
})

test('ordinary quoted path constraints retain their scope alongside fenced examples', () => {
  for (const quote of ['`', '``']) {
    // The existing object grammar admits one quoting delimiter, not two.
    const expected = quote.length === 1 ? 'execute' : 'explain'
    const plain = `Fix main.js. Do not edit ${quote}main.test.js${quote}.`
    assert.equal(classifyChatTaskIntent(plain), expected, quote)
    assert.equal(classifyChatTaskIntent(`${plain}\n\`\`\`text\nsample\n\`\`\``), expected, quote)
  }
})

test('formatting cannot manufacture a fence that hides a global denial', () => {
  const task = 'Fix main.js. ~**~**~ Do not edit files.\n```text\nsample\n```'
  assert.equal(classifyChatTaskIntent(task), 'explain')
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
