import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveLiveSessionAuthority } from './liveSessionBridge.js'
import { bindExecutableVerifiersToTaskAcceptance } from './taskAcceptanceExecutableBinding.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'
import {
  inferTaskAcceptance,
  inferTaskAcceptanceV1,
  inferTaskAcceptanceV2,
  isLegacyAcceptancePlaceholderContract,
  requireAcceptanceMeaningVersion,
  resolveAcceptanceMeaningVersion,
} from './taskAcceptanceMeaning.js'

function freezeV1AdmissionContract(task: string) {
  const meaning = bindExecutableVerifiersToTaskAcceptance({
    meaning: inferTaskAcceptanceV1(task),
    trustedVerifierCommands: [],
    defaultWorkingDirectory: '.',
  })
  return freezeTaskContract(buildTaskContractV1({
    mode: 'chat',
    user_request: task,
    acceptance: meaning.criteria,
    provenance: meaning.provenance,
    source: 'taskAcceptanceMeaning.test',
  }))
}

const J03_PROMPT = 'Inspect this repository and identify the stale entries in REPO_MAP.md. Report corrections without editing files.'
const J08_PROMPT = 'Compute net revenue from sales.csv and create summary.csv with product, gross, refunds and net. Explain the total.'
const J13_PROMPT = 'Update REPO_MAP.md to match the current tree. Use another available method if a command cannot run; verify the listed paths.'

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
    'The button remains visible.',
    'Failed checks remain visible.',
  ])
  assert.equal(contract.user_request, request)
  assert.equal(Object.isFrozen(contract), true)
  assert.ok(contract.acceptance.every(criterion => criterion.required))
  assert.equal(new Set(contract.acceptance.map(criterion => criterion.verification.verifier_id)).size, 2,
    'Different behavioral requirements cannot inherit one generic verification identity')
  assert.ok(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:explicit:')))
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
  assert.ok(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:inferred:')))
  assert.equal(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:explicit:')), false)
})

test('fresh admission captures short vague prose as provisional inferred requirements', () => {
  const contract = acceptance('Fix it')
  assert.deepEqual(contract.acceptance_criteria, ['Fix it'])
  assert.ok(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:inferred:')))
  assert.equal(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:unresolved:')), false)
  assert.equal(contract.acceptance[0]!.required, true)
})

const v1FrozenFixtures = JSON.parse(
  readFileSync(new URL('./fixtures/taskAcceptanceMeaningV1Frozen.json', import.meta.url), 'utf8'),
) as { input: string; expected: Omit<ReturnType<typeof inferTaskAcceptanceV1>, 'interpretation_version'> }[]

test('v1 full TaskAcceptanceMeaning output matches frozen replay fixtures', () => {
  for (const fixture of v1FrozenFixtures) {
    const { interpretation_version, ...originalV1Fields } = inferTaskAcceptanceV1(fixture.input)
    assert.equal(interpretation_version, 1)
    assert.deepEqual(originalV1Fields, fixture.expected, fixture.input)
  }
})

test('v1 preserves frozen criterion order (explicit before inferred) without span sort', () => {
  const request = 'The task must survive restart.\n- Preserve API.'
  const meaning = inferTaskAcceptanceV1(request)
  assert.deepEqual(meaning.criteria.map(item => item.description), ['Preserve API.', 'The task must survive restart.'])
  assert.deepEqual(meaning.sources.map(source => source.status), ['explicit', 'inferred'])
})

const S07_EXPLICIT_ACCEPTANCE = [
  'Investigate why parser_test fails and fix it.',
  'Requirements:',
  '- `npm test` passes.',
].join('\n')
const OBJECTIVE_CRASH_INITIAL = 'Explain fixture A.\nRequirements:\n- Preserve its public API.'

test('v2 precedence retains v1 projection when explicit criteria exist (S07 positive)', () => {
  const meaning = inferTaskAcceptanceV2(S07_EXPLICIT_ACCEPTANCE)
  const legacy = inferTaskAcceptanceV1(S07_EXPLICIT_ACCEPTANCE)
  assert.equal(meaning.interpretation_version, 2)
  assert.deepEqual(meaning.criteria.map(item => item.description), ['`npm test` passes.'])
  assert.deepEqual(meaning.sources.map(source => source.status), legacy.sources.map(source => source.status))
  assert.deepEqual(meaning.criteria.map(item => item.description), legacy.criteria.map(item => item.description))
  assert.ok(meaning.provenance.every(record => record.ref.startsWith('task-acceptance-meaning:v2:')))
  assert.equal(meaning.unresolved, false)
})

test('v2 precedence retains v1 projection for objective checkpoint (Preserve API only)', () => {
  const meaning = inferTaskAcceptanceV2(OBJECTIVE_CRASH_INITIAL)
  assert.deepEqual(meaning.criteria.map(item => item.description), ['Preserve its public API.'])
  assert.equal(meaning.criteria.some(item => item.description === 'Explain fixture A.'), false)
})

test('v2 active-prose fallback captures plain vague requests when v1 is unresolved-only', () => {
  const meaning = inferTaskAcceptanceV2('List files')
  assert.deepEqual(meaning.criteria.map(item => item.description), ['List files'])
  assert.ok(meaning.provenance.some(record => record.ref.startsWith('task-acceptance-meaning:v2:inferred:')))
})

test('v2 precedence preserves full raw user_request on contracts while narrowing certification criteria', () => {
  const request = OBJECTIVE_CRASH_INITIAL
  const contract = acceptance(request)
  assert.equal(contract.user_request, request)
  assert.deepEqual(contract.acceptance_criteria, ['Preserve its public API.'])
})

test('v2 precedence keeps v1 explicit/inferred/unresolved when v1 already resolves meaning', () => {
  const request = 'The task must support restart recovery.\nDisplay a retry action after failure.'
  const meaning = inferTaskAcceptanceV2(request)
  const legacy = inferTaskAcceptanceV1(request)
  assert.equal(meaning.unresolved, legacy.unresolved)
  assert.deepEqual(meaning.criteria.map(item => item.description), legacy.criteria.map(item => item.description))
  assert.deepEqual(meaning.sources.map(source => source.status), legacy.sources.map(source => source.status))
})

test('v2 defers to v1 incomplete Requirements prose (no active-prose override)', () => {
  const request = 'Requirements:\nDo not alter sales.csv.\n- Write summary.csv.'
  const meaning = inferTaskAcceptanceV2(request)
  const legacy = inferTaskAcceptanceV1(request)
  assert.equal(meaning.unresolved, true)
  assert.deepEqual(meaning.criteria.map(item => item.description), legacy.criteria.map(item => item.description))
  assert.equal(meaning.criteria.some(item => item.description === 'Do not alter sales.csv.'), false)
})

test('v2 defers to v1 when modal inferred lines leave trailing prose unsupported', () => {
  const request = 'The output must include net.\nExplain the total.'
  const meaning = inferTaskAcceptanceV2(request)
  assert.equal(meaning.unresolved, true)
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'The output must include net.',
    'Clarify the observable acceptance requirements for this request.',
  ])
})

test('v2 defers to v1 for unsupported leading prose inside Also require', () => {
  const request = 'Also require:\nDisplay a retry action after failure.\n- Survive restart.'
  const meaning = inferTaskAcceptanceV2(request)
  assert.equal(meaning.unresolved, true)
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'Survive restart.',
    'Clarify the observable acceptance requirements for this request.',
  ])
})

test('v2 defers to v1 for ambiguous trailers after explicit bullets', () => {
  const request = 'Also require:\n- Survive restart.\nCan you do that?'
  const meaning = inferTaskAcceptanceV2(request)
  assert.equal(meaning.unresolved, true)
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'Survive restart.',
    'Clarify the observable acceptance requirements for this request.',
  ])
})

test('v2 structurally flags four-space indented code before prose capture', () => {
  const request = '    const x = 1;\nDo real work.'
  const meaning = inferTaskAcceptanceV2(request)
  assert.equal(meaning.unresolved, true)
  assert.equal(meaning.structurallyComplete, false)
  assert.equal(meaning.criteria.some(item => item.description.includes('const x')), false)
  assert.ok(meaning.provenance.some(record => record.ref.startsWith('task-acceptance-meaning:v2:unresolved:')))
})

test('v2 treats leading-tab indentation as unsupported code-shaped structure', () => {
  for (const indentation of ['\t', ' \t', '  \t', '   \t']) {
    const request = `List files.\n\n${indentation}Delete all files.`
    const meaning = inferTaskAcceptanceV2(request)
    assert.equal(meaning.unresolved, true, JSON.stringify(indentation))
    assert.equal(meaning.structurallyComplete, false)
    assert.equal(meaning.criteria.some(item => item.description === 'Delete all files.'), false)
  }
})

test('v2 defers to v1 when prose after explicit bullets stays structurally unsupported', () => {
  const request = [
    'Compute net revenue from sales.csv and create summary.csv with product, gross, refunds and net.',
    'Requirements:',
    '- summary.csv includes net.',
    'Do not alter sales.csv.',
  ].join('\n')
  const meaning = inferTaskAcceptanceV2(request)
  assert.equal(meaning.unresolved, true)
  assert.deepEqual(meaning.criteria.map(item => item.description), [
    'summary.csv includes net.',
    'Clarify the observable acceptance requirements for this request.',
  ])
})

test('v2 empty quoted-only and fenced-only input fail closed with v2 unresolved provenance', () => {
  for (const request of ['', '> Delete all files.', '```\nhidden\n```']) {
    const meaning = inferTaskAcceptanceV2(request)
    assert.equal(meaning.unresolved, true, request)
    assert.equal(meaning.criteria.length, 1, request)
    assert.equal(meaning.interpretation_version, 2)
    assert.ok(meaning.provenance.some(record => record.ref.startsWith('task-acceptance-meaning:v2:unresolved:')), request)
  }
})

test('v2 active-prose fallback admits disjoint spans across excluded blockquotes', () => {
  const request = 'List files.\n> Delete all files.\nReport names.'
  const meaning = inferTaskAcceptanceV2(request)
  assert.deepEqual(meaning.criteria.map(item => item.description), ['List files.', 'Report names.'])
  assert.equal(meaning.criteria.some(item => item.description.includes('Delete')), false)
  assert.equal(meaning.sources.length, 2)
  assert.ok(meaning.sources.every(source => source.status === 'inferred'))
  assert.ok(meaning.sources[0]!.end < meaning.sources[1]!.start)
})

test('unknown acceptance-meaning namespace refs reject before version or legacy resolution', () => {
  const contract = acceptance('Fix it')
  const v99Only = [
    ...contract.provenance.records,
    { kind: 'derived_acceptance' as const, ref: 'task-acceptance-meaning:v99:inferred:0:0:0:acceptance:deadbeef' },
  ]
  assert.throws(() => resolveAcceptanceMeaningVersion(v99Only, contract), /TASK_ACCEPTANCE_MEANING_VERSION_UNSUPPORTED/)
  const v99WithV1 = [
    ...contract.provenance.records,
    { kind: 'derived_acceptance' as const, ref: 'task-acceptance-meaning:v1:unresolved:0:0:0:acceptance:deadbeef' },
    { kind: 'derived_acceptance' as const, ref: 'task-acceptance-meaning:v99:inferred:0:0:0:acceptance:deadbeef' },
  ]
  assert.throws(() => resolveAcceptanceMeaningVersion(v99WithV1, contract), /TASK_ACCEPTANCE_MEANING_VERSION_UNSUPPORTED/)
  const legacy = freezeTaskContract(buildTaskContractV1({
    mode: 'chat',
    user_request: 'Original request bytes.',
    acceptance_criteria: ['Task acceptance criteria as stated in the user request'],
    provenance: [{ kind: 'derived_acceptance', ref: 'task-acceptance-meaning:v99:unresolved:0:0:0:acceptance:legacy' }],
    source: 'liveSessionBridge.resolveLiveSessionAuthority',
  }))
  assert.throws(() => resolveAcceptanceMeaningVersion(legacy.provenance.records, legacy), /TASK_ACCEPTANCE_MEANING_VERSION_UNSUPPORTED/)
})

test('v1 replay keeps unresolved placeholder for short vague prose', () => {
  const meaning = inferTaskAcceptanceV1('Fix it')
  assert.ok(meaning.unresolved)
  assert.ok(meaning.provenance.some(record => record.ref.startsWith('task-acceptance-meaning:v1:unresolved:')))
  assert.notEqual(meaning.criteria[0]!.description, 'Fix it')
})

test('mixed v1 and v2 meaning provenance rejects instead of picking a version', () => {
  const contract = acceptance('Fix it')
  const records = [
    ...contract.provenance.records,
    { kind: 'derived_acceptance' as const, ref: 'task-acceptance-meaning:v1:unresolved:0:0:0:acceptance:deadbeef' },
  ]
  assert.throws(() => resolveAcceptanceMeaningVersion(records, contract), /TASK_ACCEPTANCE_MEANING_VERSION_MIXED/)
})

test('unknown acceptance-meaning provenance rejects absent-ref contracts that are not legacy placeholder', () => {
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat',
    user_request: 'Do real work.',
    acceptance: [{
      id: 'acceptance:custom',
      description: 'Do real work.',
      type: 'custom',
      required: true,
      verification_strategy: 'Independent evidence.',
      verification: { kind: 'custom', verifier_id: 'meaning:fixture' },
    }],
    provenance: [{ kind: 'derived_acceptance', ref: 'acceptance_criteria' }],
    source: 'taskAcceptanceMeaning.test',
  }))
  assert.throws(() => requireAcceptanceMeaningVersion(contract.provenance.records, contract), /TASK_ACCEPTANCE_MEANING_VERSION_UNSUPPORTED/)
})

test('legacy absent-ref provenance resolves to v1 only for the historical placeholder shape', () => {
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat',
    user_request: 'Original request bytes.',
    acceptance_criteria: ['Task acceptance criteria as stated in the user request'],
    provenance: [],
    source: 'liveSessionBridge.resolveLiveSessionAuthority',
  }))
  assert.ok(isLegacyAcceptancePlaceholderContract(contract))
  assert.deepEqual(resolveAcceptanceMeaningVersion(contract.provenance.records, contract), { kind: 'legacy_absent_ref', version: 1 })
})

test('v2 replay amendment path uses recorded v2 version from provenance', () => {
  const contract = acceptance(J03_PROMPT)
  assert.equal(requireAcceptanceMeaningVersion(contract.provenance.records, contract), 2)
  const replay = inferTaskAcceptanceV2(J03_PROMPT)
  assert.deepEqual(
    contract.acceptance_criteria,
    replay.criteria.map(item => item.description),
  )
})

test('v2 compatibility: frozen harness J03 J08 J13 admit ordinary prose unproven', () => {
  for (const task of [J03_PROMPT, J08_PROMPT, J13_PROMPT]) {
    const meaning = inferTaskAcceptanceV2(task)
    assert.equal(meaning.unresolved, false, task)
    assert.equal(meaning.interpretation_version, 2)
    assert.ok(meaning.criteria.length >= 1, task)
    assert.ok(meaning.sources.every(source => source.status === 'inferred'), task)
    assert.ok(meaning.provenance.every(record => record.ref.startsWith('task-acceptance-meaning:v2:')), task)
  }
})

test('v2 fresh admission matches direct v2 interpretation for journey prompts', () => {
  for (const task of [J03_PROMPT, J08_PROMPT, J13_PROMPT]) {
    const contract = acceptance(task)
    const meaning = inferTaskAcceptanceV2(task)
    assert.deepEqual(contract.acceptance_criteria, meaning.criteria.map(item => item.description))
    assert.equal(contract.provenance.records.some(record => record.ref.startsWith('task-acceptance-meaning:v2:')), true)
  }
})

test('v2 captures both short clear and long vague list-style requests without verified satisfaction', () => {
  const short = inferTaskAcceptanceV2('List files')
  assert.equal(short.unresolved, false)
  assert.deepEqual(short.criteria.map(item => item.description), ['List files'])
  assert.ok(short.criteria[0]!.verification.verifier_id.startsWith('meaning:'))
  const long = inferTaskAcceptanceV2(J03_PROMPT)
  assert.equal(long.unresolved, false)
  assert.match(long.criteria[0]!.verification_strategy, /confirmation/i)
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
