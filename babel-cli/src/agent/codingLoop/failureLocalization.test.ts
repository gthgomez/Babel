import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { advanceFailureLocalization, captureLocalizationCandidates, captureLocalizationTestHints, discoverTestCandidates, startFailureLocalization } from './failureLocalization.js'
import { captureChatVerifierReceipt } from '../chatEngineVerifierAdapter.js'
import { applyWorkingStateEvent, createWorkingState, restoreWorkingStateSnapshot, type RecoveryEvidenceProvenance } from './workingState.js'
import { createSessionEventLog, parseSessionEventLog, recordWorkingStateSnapshot, serializeSessionEventLog } from '../sessionEvents.js'
import { ingestVerifierResult } from './chatBindings.js'

const binding = {
  schemaVersion: 1 as const, taskId: 'task', contractHash: 'contract',
  repositoryIdentity: '/repo', workspaceRevision: 'rev',
}

test('a named failing test can localize its called relative import after both content reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-import-recovery-'))
  try {
    const testSource = "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {add} from './math.js'; test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(0,7),7)});"
    const source = 'export function add(a,b) { return a-b }'
    writeFileSync(join(root, 'math.test.js'), testSource)
    writeFileSync(join(root, 'math.js'), source)
    const candidates = [{path: 'math.test.js', relation: 'addition', source: 'test_identity' as const, line:1, column:testSource.indexOf('assert.equal')+1}]
    let state = advanceFailureLocalization(startFailureLocalization('red', binding, candidates), {
      type: 'read_file', target: 'math.test.js', content: testSource, succeeded: true, projectRoot: root,
    })
    assert.equal(state.acceptedPath, 'math.test.js')
    const rangeOnly = advanceFailureLocalization(state, {
      type:'read_range',target:'math.js',content:'export function add(a,b) { return a-b }',
      startLine:2,succeeded:true,projectRoot:root,
    })
    assert.notEqual(rangeOnly.acceptedPath,'math.js','partial lexical context cannot corroborate an import')
    const atCapacity = advanceFailureLocalization({...state,candidates:[...state.candidates,
      ...Array.from({length:7},(_,i)=>({path:`other${i}.js`,relation:'other',source:'structured_location' as const}))]}, {
      type:'read_file',target:'math.js',content:source,succeeded:true,projectRoot:root,
    })
    assert.equal(atCapacity.candidates.length,8)
    assert.ok(atCapacity.candidates.some(candidate=>candidate.path===atCapacity.acceptedPath))
    state = advanceFailureLocalization(state, {
      type: 'read_file', target: 'math.js', content: source, succeeded: true, projectRoot: root,
    })
    assert.equal(state.acceptedPath, 'math.js')
    assert.equal(state.calls, 2)
    assert.equal(state.rounds, 2)
  } finally { rmSync(root, {recursive:true, force:true}) }
})

test('import bridge evidence cannot reopen consumed permits or accept stale, repeated or unrelated observations', () => {
  const localized = {
    ...startFailureLocalization('red', binding, [
      {path:'math.test.js',relation:'addition',source:'test_identity' as const},
      {path:'math.js',relation:'add',source:'import_call' as const,fromTestPath:'math.test.js'},
    ]),
    phase:'localized' as const, calls:2,rounds:2,acceptedPath:'math.js',observationDigest:'fresh-source',
  }
  let state = applyWorkingStateEvent(createWorkingState('repair'), {
    type:'recovery_gate',failureSignature:'red',binding,requiredEvidence:'inspect',failingTargets:['math.test.js'],
  })
  state = applyWorkingStateEvent(state,{type:'add_evidence',evidence:'read test',discriminating:true,
    provenance:{tool:'read_file',target:'math.test.js',failureSignature:'red',binding,observationDigest:'fresh-test'}})
  state = applyWorkingStateEvent(state,{type:'localization_update',localization:localized})
  const provenance:RecoveryEvidenceProvenance = {tool:'read_file',target:'math.js',failureSignature:'red',binding,observationDigest:'fresh-source'}
  const accepted = applyWorkingStateEvent(state,{type:'localization_import_evidence',provenance})
  assert.deepEqual(accepted.recoveryGate?.failingTargets,['math.test.js','math.js'])
  assert.equal(accepted.recoveryGate?.observedKeys?.length,2)
  assert.equal(applyWorkingStateEvent(accepted,{type:'localization_import_evidence',provenance}).recoveryGate?.observedKeys?.length,2)
  for (const alteration of [
    {tool:'read_range'}, {failureSignature:'other'}, {target:'unrelated.js'}, {observationDigest:'old'},
    {binding:{...binding,workspaceRevision:'stale'}},
  ]) {
    const rejected=applyWorkingStateEvent(state,{type:'localization_import_evidence',provenance:{...provenance,...alteration}})
    assert.deepEqual(rejected.recoveryGate,state.recoveryGate)
  }
  for (const flags of [{permitConsumed:true},{planAdmitted:true}]) {
    const locked={...state,recoveryGate:{...state.recoveryGate!,...flags}}
    assert.deepEqual(applyWorkingStateEvent(locked,{type:'localization_import_evidence',provenance}).recoveryGate,locked.recoveryGate)
  }
  const exhausted={...state,localization:{...localized,phase:'exhausted' as const}}
  assert.deepEqual(applyWorkingStateEvent(exhausted,{type:'localization_import_evidence',provenance}).recoveryGate,state.recoveryGate)
})

test('a failed stylesheet assertion requires both fresh full reads before admitting its exact data file', () => {
  const root=mkdtempSync(join(tmpdir(),'babel-css-localize-'))
  try {
    const source="import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('busy style',()=>assert.match(readFileSync(new URL('./styles.css',import.meta.url),'utf8'),/opacity/));"
    writeFileSync(join(root,'render.test.js'),source);writeFileSync(join(root,'styles.css'),'.status {}')
    const candidates=captureLocalizationCandidates({projectRoot:root,tool:'test_run',command:'npm test',stderr:'',
      stdout:`✖ busy style (1ms)\nAssertionError [ERR_ASSERTION]: The input did not match\n    at TestContext.<anonymous> (file:///app/render.test.js:1:${source.indexOf('assert.match')+1})`})
    let loc=advanceFailureLocalization(startFailureLocalization('red',binding,candidates),
      {type:'read_file',target:'render.test.js',content:source,succeeded:true,projectRoot:root})
    assert.equal(loc.importCandidates?.[0]?.source,'file_read')
    const partial=advanceFailureLocalization(loc,{type:'read_range',target:'styles.css',content:'.status {}',succeeded:true,projectRoot:root})
    assert.notEqual(partial.acceptedPath,'styles.css')
    loc=advanceFailureLocalization(loc,{type:'read_file',target:'styles.css',content:'1│.status {}',succeeded:true,projectRoot:root})
    assert.equal(loc.acceptedPath,'styles.css');assert.equal(loc.rounds,2)
    let state=applyWorkingStateEvent(createWorkingState('repair'),{type:'recovery_gate',failureSignature:'red',binding,requiredEvidence:'inspect',failingTargets:['render.test.js']})
    state=applyWorkingStateEvent(state,{type:'add_evidence',evidence:'fresh test',discriminating:true,
      provenance:{tool:'read_file',target:'render.test.js',failureSignature:'red',binding,observationDigest:'test'}})
    state=applyWorkingStateEvent(state,{type:'localization_update',localization:loc})
    const admitted=applyWorkingStateEvent(state,{type:'localization_import_evidence',provenance:{tool:'read_file',target:'styles.css',failureSignature:'red',binding,observationDigest:loc.observationDigest!}})
    assert.deepEqual(admitted.recoveryGate?.failingTargets,['render.test.js','styles.css'])
    assert.equal(admitted.recoveryGate?.observedKeys?.length,2)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('Node assertion labels and sandbox file URLs corroborate the actual test read', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-node-assert-'))
  try {
    const content = "import { test } from 'node:test'\ntest('adds numbers', () => { assert.equal(add(2, 3), 5) })\n"
    writeFileSync(join(root, 'math.test.js'), content)
    const candidates = captureLocalizationCandidates({ projectRoot: root, tool: 'test_run', command: 'npm test',
      stdout: "✖ adds numbers (1ms)\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal\n    at TestContext.<anonymous> (file:///app/math.test.js:2:39)", stderr: '' })
    assert.equal(candidates[0]?.path, 'math.test.js')
    const state = advanceFailureLocalization(startFailureLocalization('red', binding, candidates), {
      type: 'read_file', target: 'math.test.js', content, succeeded: true,
    })
    assert.equal(state.phase, 'localized')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a production throw uses its stack function rather than the caller test label', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-production-throw-'))
  try {
    const content = 'export function add(a,b) {\n throw new TypeError("bad")\n}\n'
    writeFileSync(join(root, 'math.js'), content)
    const candidates = captureLocalizationCandidates({ projectRoot: root, tool: 'test_run', command: 'npm test',
      stdout: '✖ adds numbers (1ms)\nTypeError: bad\n    at add (file:///app/math.js:2:3)', stderr: '' })
    const state = advanceFailureLocalization(startFailureLocalization('red', binding, candidates), {
      type: 'read_file', target: 'math.js', content, succeeded: true,
    })
    assert.equal(state.phase, 'localized')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a diagnostic symbol is not corroborated by a substring in a different identifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-symbol-boundary-'))
  try {
    const content = 'export function address() {}\n'
    writeFileSync(join(root, 'math.js'), content)
    const candidates = captureLocalizationCandidates({ projectRoot: root, tool: 'test_run', command: 'npm test',
      stdout: '✖ adds numbers (1ms)\nTypeError: bad\n    at add (file:///app/math.js:1:3)', stderr: '' })
    const state = advanceFailureLocalization(startFailureLocalization('red', binding, candidates), {
      type: 'read_file', target: 'math.js', content, succeeded: true,
    })
    assert.equal(state.phase, 'LOCALIZE_FAILURE')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('test labels and filename hints retain token boundaries while punctuation is literal', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-test-label-boundary-'))
  try {
    for (const [relation, content, expected] of [
      ['add', "test('address validation', () => {})", 'LOCALIZE_FAILURE'],
      ['adds numbers?', "test('adds numbers?', () => {})", 'localized'],
    ]) {
      writeFileSync(join(root, 'add.test.js'), content!)
      const candidate = { path: 'add.test.js', relation: relation!, source: 'test_identity' as const }
      const state = advanceFailureLocalization(startFailureLocalization('red', binding, [candidate]), {
        type: 'read_file', target: 'add.test.js', content: content!, succeeded: true,
      })
      assert.equal(state.phase, expected)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('captured stack location is only a candidate until a related content read', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-localize-stack-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'parser.js'), 'export function parseToken() {\n  throw Error("bad")\n}\n')
    const candidates = captureLocalizationCandidates({
      projectRoot: root, tool: 'test_run', command: 'node test.js', stdout: '',
      stderr: 'TypeError: bad\n    at parseToken (src/parser.js:2:3)',
    })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.path, 'src/parser.js')
    let state = startFailureLocalization('red', binding, candidates)
    state = advanceFailureLocalization(state, { type: 'read_file', target: 'src/parser.js', content: 'unrelated content', succeeded: true })
    assert.equal(state.phase, 'LOCALIZE_FAILURE')
    state = advanceFailureLocalization(state, { type: 'read_file', target: 'src/parser.js', content: 'export function parseToken() {\n throw Error("bad")\n}', succeeded: true })
    assert.equal(state.phase, 'localized')
    assert.equal(state.acceptedPath, 'src/parser.js')
    assert.ok(state.observationDigest)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('external and fabricated paths never become candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-localize-scope-'))
  const outside = mkdtempSync(join(tmpdir(), 'babel-localize-outside-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'other.js'), 'export const unrelated = 1\n')
    writeFileSync(join(outside, 'evil.js'), 'function parseToken() {}\n')
    const candidates = captureLocalizationCandidates({
      projectRoot: root, tool: 'test_run', command: 'node test.js', stdout: '',
      stderr: `TypeError: bad\n    at parseToken (${join(outside, 'evil.js')}:1:1)\n    at parseToken (src/other.js:1:1)`,
    })
    assert.equal(candidates.some((candidate) => candidate.path.includes('evil')), false)
    let state = startFailureLocalization('red', binding, candidates)
    state = advanceFailureLocalization(state, { type: 'grep', target: 'src/other.js', content: 'parseToken', succeeded: true })
    assert.equal(state.phase, 'LOCALIZE_FAILURE', 'a fake location must not be promoted by search output alone')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('an existing but unrelated stack path cannot establish localization scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-localize-fake-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'unrelated.ts'), 'export const unrelated = 1\n')
    const candidates = captureLocalizationCandidates({
      projectRoot: root, tool: 'test_run', command: 'npm test', stdout: '',
      stderr: 'TypeError: bad\n    at parseToken (src/unrelated.ts:1:1)',
    })
    assert.equal(candidates.length, 1)
    const state = advanceFailureLocalization(startFailureLocalization('red', binding, candidates), {
      type: 'read_file', target: 'src/unrelated.ts', content: 'export const unrelated = 1\n', succeeded: true,
    })
    assert.equal(state.phase, 'LOCALIZE_FAILURE')
    assert.equal(state.acceptedPath, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('search and listing calls consume a durable four-call allowance', () => {
  let state = startFailureLocalization('red', binding, [])
  for (let i = 0; i < 4; i += 1) {
    state = advanceFailureLocalization(state, { type: 'glob', target: '**/*', content: 'src/parser.ts', succeeded: true })
  }
  assert.equal(state.phase, 'exhausted')
  assert.equal(state.calls, 4)
  assert.equal(advanceFailureLocalization(state, { type: 'read_file', target: 'src/parser.ts', content: 'parser', succeeded: true }).calls, 4)
})

test('captured test identity can seed a bounded glob but a read must confirm it', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-localize-testname-'))
  try {
    mkdirSync(join(root, 'tests'))
    writeFileSync(join(root, 'tests', 'parser.test.ts'), 'test("parser handles tokens", () => {})\n')
    const hints = captureLocalizationTestHints({
      stdout: 'Tests: 1 failed', stderr: '', tool: 'test_run', command: 'npm test -- parser.test.ts',
    })
    assert.ok(hints.includes('parser'))
    let state = startFailureLocalization('red', binding, [], hints)
    state = discoverTestCandidates(state, root, '**/*parser*.test.ts', 'tests/parser.test.ts')
    assert.deepEqual(state.candidates.map((candidate) => candidate.path), ['tests/parser.test.ts'])
    state = advanceFailureLocalization(state, { type: 'glob', target: '', content: 'tests/parser.test.ts', succeeded: true })
    assert.equal(state.phase, 'LOCALIZE_FAILURE')
    state = advanceFailureLocalization(state, {
      type: 'read_file', target: 'tests/parser.test.ts', content: 'test("parser handles tokens", () => {})', succeeded: true,
    })
    assert.equal(state.phase, 'localized')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a diagnostic symbol can be corroborated by a bounded declaration read', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-localize-symbol-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'parser.ts'), 'export function parseExpression(input: string) { return 1 }\n')
    const hints = captureLocalizationTestHints({
      stdout: '', stderr: 'parseExpression("1+2") => -1 (expected 3)',
      tool: 'test_run', command: 'npm test',
    })
    assert.ok(hints.includes('parseExpression'))
    let state = startFailureLocalization('red', binding, [], hints)
    state = advanceFailureLocalization(state, {
      type: 'read_file', target: 'src/parser.ts', projectRoot: root,
      content: 'export function parseExpression(input: string) { return 1 }\n', succeeded: true,
    })
    assert.equal(state.phase, 'localized')
    assert.equal(state.candidates[0]?.source, 'diagnostic_symbol')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('empty-scope red baseline can bind repository recovery while green still cannot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-localize-baseline-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
    writeFileSync(join(root, 'parser.js'), 'export const parseToken = () => 1\n')
    execFileSync('git', ['add', 'parser.js'], { cwd: root, windowsHide: true })
    execFileSync('git', ['-c', 'user.name=Babel Test', '-c', 'user.email=babel-test@example.com', 'commit', '-qm', 'fixture'], { cwd: root, windowsHide: true })
    const base = {
      projectRoot: root, command: 'npm test', summary: 'test result', mutationPaths: [],
      allowRepositoryScopeForRedRecovery: true,
    }
    const red = await captureChatVerifierReceipt({ ...base, exitCode: 1 })
    assert.equal(red?.boundRevision?.scope?.kind, 'repository')
    await assert.rejects(() => captureChatVerifierReceipt({ ...base, exitCode: 0 }), /Revision-bound file scope must not be empty/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cold resume retains spent localization calls and cannot reset the allowance', () => {
  let loc = startFailureLocalization('red', binding, [])
  for (let i = 0; i < 3; i += 1) {
    loc = advanceFailureLocalization(loc, { type: 'glob', target: '**/*', succeeded: true })
  }
  const gated = applyWorkingStateEvent(createWorkingState('repair parser'), {
    type: 'recovery_gate', failureSignature: 'red', requiredEvidence: 'localize', binding,
  })
  const state = applyWorkingStateEvent(gated, {
    type: 'localization_begin', localization: loc,
  })
  const log = createSessionEventLog('localization-resume')
  recordWorkingStateSnapshot(log, state, 'turn-1')
  const restoredLog = parseSessionEventLog(serializeSessionEventLog(log), 'localization-resume')
  const event = restoredLog.events.at(-1)
  assert.equal(event?.kind, 'working_state_snapshot')
  if (event?.kind !== 'working_state_snapshot') return
  const restored = restoreWorkingStateSnapshot(event.state)
  assert.equal(restored?.localization?.calls, 3)
  const fourth = advanceFailureLocalization(restored!.localization!, { type: 'glob', target: '**/*', succeeded: true })
  assert.equal(fourth.phase, 'exhausted')
  assert.equal(fourth.calls, 4)
})

test('identical red verifier re-observation cannot reset spent localization allowance', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-localize-reobserve-'))
  try {
    const red = (state: ReturnType<typeof createWorkingState>) => ingestVerifierResult({
      state, tool: 'test_run', target: 'npm test', exitCode: 1,
      stdout: 'Expected 2, received 1', stderr: '', summary: 'assertion red',
      recoveryBinding: binding, recoveryProjectRoot: root,
    }).state
    let state = red(createWorkingState('repair unknown failure'))
    assert.ok(state.localization)
    let loc = state.localization
    for (let i = 0; i < 4; i += 1) {
      loc = advanceFailureLocalization(loc, { type: 'glob', target: '**/*', succeeded: true })
    }
    assert.equal(loc.phase, 'exhausted')
    state = applyWorkingStateEvent(state, { type: 'localization_update', localization: loc })
    const repeated = red(state)
    assert.equal(repeated.failureSurface?.errorSignature, state.failureSurface?.errorSignature)
    assert.equal(repeated.localization?.calls, 4)
    assert.equal(repeated.localization?.phase, 'exhausted')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
