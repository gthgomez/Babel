import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { advanceFailureLocalization, captureLocalizationCandidates, captureLocalizationTestHints, discoverTestCandidates, startFailureLocalization } from './failureLocalization.js'
import { captureChatVerifierReceipt } from '../chatEngineVerifierAdapter.js'
import { applyWorkingStateEvent, createWorkingState, restoreWorkingStateSnapshot } from './workingState.js'
import { createSessionEventLog, parseSessionEventLog, recordWorkingStateSnapshot, serializeSessionEventLog } from '../sessionEvents.js'

const binding = {
  schemaVersion: 1 as const, taskId: 'task', contractHash: 'contract',
  repositoryIdentity: '/repo', workspaceRevision: 'rev',
}

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
