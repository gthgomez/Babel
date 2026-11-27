/**
 * W01 (#522): complete task intent at admission — every operative goal line
 * survives ordinary requirement bullets, and a scoped preservation constraint
 * ("do not change public APIs") does not erase the requested mutation.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyChatTaskIntent } from './chatEngineTaskIntent.js'
import { analyzeTaskShape, hasExplicitEditDenial } from '../config/chatTaskClass.js'
import { inferTaskAcceptanceV3 } from './taskAcceptanceMeaning.js'

const MULTI_GOAL_WITH_REQUIREMENTS = [
  'Fix parser.js so parseSum(2, 3) returns 5.',
  'Update README.md so the example shows parseSum usage.',
  'Requirements:',
  '- `npm test` must pass.',
].join('\n')

test('exercise-style input/output specification enters execution intent', () => {
  const task = '# Instructions\nGiven an input text, output it transposed.\nPad short rows on the left.'
  assert.equal(classifyChatTaskIntent(task), 'execute')
  assert.notEqual(analyzeTaskShape(task).operation, 'READ_ONLY')
})

test('exercise-style read-only framing remains explanation intent', () => {
  for (const task of [
    'Explain how to transpose an input text. Do not edit files.',
    'Review the transpose algorithm without changing the project.',
    'Given an input text, describe the transposed output; do not modify anything.',
  ]) {
    assert.equal(classifyChatTaskIntent(task), 'explain', task)
    assert.equal(analyzeTaskShape(task).operation, 'READ_ONLY', task)
  }
})

test('TF-01: v3 keeps every operative goal line before a requirements section', () => {
  const meaning = inferTaskAcceptanceV3(MULTI_GOAL_WITH_REQUIREMENTS)
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'Fix parser.js so parseSum(2, 3) returns 5.',
    'Update README.md so the example shows parseSum usage.',
    '`npm test` must pass.',
  ])
  assert.deepEqual(meaning.sources.map(source => source.status), ['inferred', 'inferred', 'explicit'])
  assert.equal(meaning.unresolved, false)
})

test('TF-01: multiple prose goals survive ordinary requirement bullets', () => {
  const meaning = inferTaskAcceptanceV3([
    'Fix parser.js so parseSum(2, 3) returns 5.',
    'Update README.md so the example shows parseSum usage.',
    '- Keep the public API unchanged.',
    '- Add a regression test.',
  ].join('\n'))
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'Fix parser.js so parseSum(2, 3) returns 5.',
    'Update README.md so the example shows parseSum usage.',
    'Keep the public API unchanged.',
    'Add a regression test.',
  ])
})

test('TF-01 control: non-operative framing prose is not promoted to a goal', () => {
  const meaning = inferTaskAcceptanceV3([
    'Explain fixture A.',
    'Requirements:',
    '- Preserve its public API.',
    '- Update the fixture buttons.',
  ].join('\n'))
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'Preserve its public API.',
    'Update the fixture buttons.',
  ])
})

test('TF-01 control: examples, exclusions and fences never become goals', () => {
  const goal = 'Fix parser.js so parseSum(2, 3) returns 5.'
  for (const request of [
    `Non-goals:\n${goal}\nUpdate README.md so it lists parseSum.\nRequirements:\n- \`npm test\` must pass.`,
    `Examples:\n${goal}\nUpdate README.md so it lists parseSum.\nRequirements:\n- \`npm test\` must pass.`,
    `\`\`\`text\n${goal}\nUpdate README.md so it lists parseSum.\n\`\`\`\nRequirements:\n- \`npm test\` must pass.`,
  ]) {
    const meaning = inferTaskAcceptanceV3(request)
    assert.equal(meaning.criteria.some(item => item.description.includes('README.md')), false, request)
  }
})

const SCOPED_CONSTRAINTS: Array<[string, string]> = [
  ['public APIs', 'Fix parser.js so parseSum(2, 3) returns 5.\nDo not change public APIs.'],
  ['the public API', 'Fix parser.js so parseSum(2, 3) returns 5.\nDo not change the public API.'],
  ['API surface', 'Fix parser.js so parseSum(2, 3) returns 5.\nDo not modify the API surface.'],
  ['behavior of a symbol', 'Fix parser.js so parseSum(2, 3) returns 5.\nDo not change behavior of parseMinus.'],
  ["symbol's behavior", "Fix parser.js so parseSum(2, 3) returns 5.\nDo not change parseMinus's behavior."],
]

test('TF-02: a scoped preservation constraint does not turn the repair read-only', () => {
  for (const [label, task] of SCOPED_CONSTRAINTS) {
    assert.equal(hasExplicitEditDenial(task), false, label)
    assert.equal(classifyChatTaskIntent(task), 'execute', label)
    assert.notEqual(analyzeTaskShape(task).operation, 'READ_ONLY', label)
  }
})

test('TF-02 control: a standalone no-edit directive stays read-only', () => {
  for (const task of [
    'Do not change public APIs.',
    'Do not edit any files.',
    'Review the parser; do not change behavior.',
  ]) {
    assert.equal(classifyChatTaskIntent(task), 'explain', task)
  }
})

test('TF-02 control: unrelated-file and test protections keep mutation intent', () => {
  for (const task of [
    'Fix parser.js so parseSum(2, 3) returns 5.\nDo not modify unrelated files.',
    'Fix parser.js so parseSum(2, 3) returns 5.\nDo not edit tests.',
  ]) {
    assert.equal(classifyChatTaskIntent(task), 'execute', task)
  }
})

test('P2-1: duplicate goal lines collapse instead of bricking admission', () => {
  const goal = 'Fix parser.js so parseSum(2, 3) returns 5.'
  const meaning = inferTaskAcceptanceV3([
    goal,
    goal,
    'Requirements:',
    '- `npm test` must pass.',
  ].join('\n'))
  assert.deepEqual(meaning.criteria.map(item => item.description), [goal, '`npm test` must pass.'])
  assert.equal(new Set(meaning.criteria.map(item => item.id)).size, meaning.criteria.length)
})

test('P1-2 control: global behavior/system directives stay read-only', () => {
  for (const task of [
    'Do not change the behavior of the application.',
    'Never modify the whole system behavior.',
    "Do not change the platform's behavior.",
    'Do not change the behavior of the entire application.',
  ]) {
    assert.equal(hasExplicitEditDenial(task), true, task)
    assert.equal(classifyChatTaskIntent(task), 'explain', task)
  }
  assert.equal(hasExplicitEditDenial('Fix parser.js so parseSum(2, 3) returns 5.\nDo not change behavior of parseMinus.'), false)
})
