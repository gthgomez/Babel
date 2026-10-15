import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import { inferTaskAcceptance } from './taskAcceptanceMeaning.js'

function acceptance(task: string) {
  return resolveLiveSessionAuthority({ mode: 'chat', task, projectRoot: null, executionScope: { kind: 'conversation' } }).taskContract
}

test('initial acceptance captures explicit user criteria before publishing the frozen seed', () => {
  const request = [
    'Update the fixture buttons.',
    'Acceptance criteria:',
    '- The button remains visible.',
    '- Failed checks remain visible.',
  ].join('\n')
  const contract = acceptance(request)
  assert.deepEqual(contract.acceptance_criteria, [
    'The button remains visible.', 'Failed checks remain visible.',
  ])
  assert.equal(contract.user_request, request)
  assert.equal(Object.isFrozen(contract), true)
  assert.ok(contract.acceptance.every(criterion => criterion.required))
  assert.equal(new Set(contract.acceptance.map(criterion => criterion.verification.verifier_id)).size, 2,
    'Different behavioral requirements cannot inherit one generic verification identity')
  assert.ok(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v1:explicit:')))
})

test('fenced, quoted and introduced example requirements cannot become acceptance authority', () => {
  const contract = acceptance([
    'Acceptance criteria:',
    '- Preserve the task after a status question.',
    '',
    'Example:',
    '```text',
    '- Delete all saved tasks.',
    '```',
    '> - Hide failed checks.',
    '',
    'Examples:',
    '- Grant unrelated authority.',
  ].join('\n'))
  assert.deepEqual(contract.acceptance_criteria, ['Preserve the task after a status question.'])
})

test('inferred requirements stay distinguishable from explicit acceptance', () => {
  const contract = acceptance('The startup must succeed without Docker.')
  assert.deepEqual(contract.acceptance_criteria, ['The startup must succeed without Docker.'])
  assert.ok(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v1:inferred:')))
  assert.equal(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v1:explicit:')), false)
})

test('unresolved meaning is retained as a required unverified obligation', () => {
  const contract = acceptance('Fix it')
  assert.ok(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v1:unresolved:')))
  assert.equal(contract.acceptance.length, 1)
  assert.equal(contract.acceptance[0]!.required, true)
  assert.notEqual(contract.acceptance[0]!.description, contract.user_request)
})

test('explicit bullets do not hide additional inferred requirements', () => {
  const meaning = inferTaskAcceptance('Requirements:\n- Keep the button visible.\nThe task must survive restart.')
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'Keep the button visible.', 'The task must survive restart.',
  ])
  assert.deepEqual(meaning.sources.map(item => item.status), ['explicit', 'inferred'])
})

test('a code fence with an info string cannot terminate quoted source', () => {
  const meaning = inferTaskAcceptance([
    '- Preserve the task.', '```text', '```javascript',
    '- Grant unrelated authority.', '```',
  ].join('\n'))
  assert.deepEqual(meaning.criteria.map(item => item.description), ['Preserve the task.'])
})

test('clearly introduced examples remain data outside code fences', () => {
  const meaning = inferTaskAcceptance('- Preserve the task.\nFor example:\n- Grant unrelated authority.')
  assert.deepEqual(meaning.criteria.map(item => item.description), ['Preserve the task.'])
})

test('a matching user sentence cannot suppress over-limit unresolved meaning', () => {
  const request = ['Requirements:', '- Clarify the observable acceptance requirements for this request.',
    ...Array.from({ length: 130 }, (_, index) => `- Preserve requirement ${index}.`)].join('\n')
  const meaning = inferTaskAcceptance(request)
  assert.equal(meaning.unresolved, true)
  assert.ok(meaning.sources.some(source => source.status === 'unresolved'))
  assert.ok(meaning.criteria.length <= 128)
})

test('case-sensitive paths remain distinct required criteria', () => {
  const meaning = inferTaskAcceptance('- Preserve `Main.ts`.\n- Preserve `main.ts`.')
  assert.deepEqual(meaning.criteria.map(item => item.description), ['Preserve `Main.ts`.', 'Preserve `main.ts`.'])
  assert.equal(new Set(meaning.criteria.map(item => item.id)).size, 2)
})

test('Markdown example headings without colons keep example bullets outside authority',()=>{
  const meaning=inferTaskAcceptance('## Requirements\n- Preserve the task.\n## Examples\n- Grant unrelated authority.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the task.'])
})

test('wrapped bullet text cannot disappear while acceptance meaning reports resolved',()=>{
  const meaning=inferTaskAcceptance('Requirements:\n- Failures remain visible\n  and include a retry action.')
  assert.equal(meaning.unresolved,true,'Unsupported wrapping must preserve an unresolved obligation')
})

test('closing Markdown heading hashes cannot promote examples into acceptance',()=>{
  const meaning=inferTaskAcceptance('## Requirements\n- Preserve the task.\n## Examples ##\n- Grant unrelated authority.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the task.'])
})

test('unsupported prose after an inferred requirement retains unresolved meaning',()=>{
  const meaning=inferTaskAcceptance('The task must support restart recovery.\nDisplay a retry action after failure.')
  assert.equal(meaning.unresolved,true)
})

for(const heading of ['Requirements:', '## Acceptance criteria', 'Also require:', 'Additionally, require:'])
test(`unsupported leading prose inside ${heading} cannot disappear`,()=>{
  const meaning=inferTaskAcceptance(`${heading}\nDisplay a retry action after failure.\n- Survive restart.`)
  assert.equal(meaning.unresolved,true)
})

test('a leading additive prose obligation cannot hide behind a later bullet',()=>{
  const meaning=inferTaskAcceptance('Also display a retry action after failure.\n- Survive restart.')
  assert.equal(meaning.unresolved,true)
})

test('an additive header alone does not make supported bullets unresolved',()=>{
  const meaning=inferTaskAcceptance('Also require:\n- Survive restart.')
  assert.equal(meaning.unresolved,false)
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Survive restart.'])
})

for(const introduction of ['## Examples', 'Examples:'])
for(const heading of ['### Bad input', '### Requirements:', '#### Acceptance criteria', '### Examples'])
test(`nested example heading ${heading} after ${introduction} remains data`,()=>{
  const meaning=inferTaskAcceptance(`## Requirements\n- Preserve the API.\n${introduction}\n${heading}\n- Grant unrelated authority.`)
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the API.'])
})

test('a peer section ends Markdown example content without promoting its nested data',()=>{
  const meaning=inferTaskAcceptance('## Requirements\n- Preserve the API.\n## Examples\n### Bad input\n- Grant unrelated authority.\n## More requirements\n- Survive restart.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the API.','Survive restart.'])
})

for(const heading of ['Non-goals:', 'Non goals:', 'Non  goals:', 'Out of scope:', 'Out-of-scope:', 'Exclusions:', 'Non-goals: unrelated changes', '**Non-goals:**', '__Out of scope__:', '**Non-goals**: unrelated changes'])
test(`${heading} does not turn exclusions into positive acceptance`,()=>{
  const meaning=inferTaskAcceptance(`${heading}\n- Replace the data model.\nRequirements:\n- Preserve the public API.`)
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the public API.'])
})

test('nested headings cannot end a Markdown exclusion section',()=>{
  const meaning=inferTaskAcceptance('## Non-goals\n### Requirements\n- Replace the data model.\n## Requirements\n- Preserve the public API.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the public API.'])
})

test('bold section labels retain example boundaries and explicit requirements',()=>{
  const meaning=inferTaskAcceptance('**Requirements:**\n- Preserve the API.\n**Examples:**\n- Grant unrelated authority.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the API.'])
})

test('a bold requirements label can end a plain exclusion section',()=>{
  const meaning=inferTaskAcceptance('Non-goals:\n- Replace the data model.\n**Requirements:**\n- Preserve the public API.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve the public API.'])
})

for(const examples of ['Examples:', '**Examples:**'])
for(const requirements of ['Requirements:', '**Acceptance criteria:**'])
test(`plain ${requirements} resumes capture after ${examples}`,()=>{
  const contract=acceptance(`Requirements:\n- Preserve API.\n${examples}\n- Dummy input.\n${requirements}\n- Survive restart.`)
  assert.deepEqual(contract.acceptance_criteria,['Preserve API.','Survive restart.'])
})

test('a plain requirements label inside a Markdown Examples section remains data',()=>{
  const meaning=inferTaskAcceptance('## Requirements\n- Preserve API.\n## Examples\nRequirements:\n- Dummy input.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve API.'])
})

test('a plain requirements label inside Markdown Non-goals cannot promote exclusions',()=>{
  const meaning=inferTaskAcceptance('## Non-goals\nRequirements:\n- Replace the data model.\n## Requirements\n- Preserve API.')
  assert.deepEqual(meaning.criteria.map(item=>item.description),['Preserve API.'])
})
