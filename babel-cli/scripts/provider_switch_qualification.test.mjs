import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { prepare, qualify, checkTrace } from './provider_switch_qualification.mjs'
import { prepareUnitShard } from './run_ci_unit_shard.mjs'

const fixture = fileURLToPath(new URL('../src/fixtures/provider-switch/', import.meta.url))
const pristine = readFileSync(join(fixture, 'workspace/current/ledger.mjs'), 'utf8')
const corrected = pristine.replace('(entry.amount > 0 ? entry.amount : 0)', 'entry.amount')
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

test('the actual CI shard selector discovers both qualification and accounting regressions', () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  const selection = prepareUnitShard(packageRoot, 0, 4)
  assert.ok(selection.inventory.includes('src/providerSwitchQualification.test.ts'))
  assert.ok(selection.inventory.includes('src/interactive/projection/accountingTitle.test.ts'))
  assert.ok(selection.inventory.includes('src/interactive/testing/providerSwitchContinuity.test.ts'))
})
function cell(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-switch ü space-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'candidate 项目')
  const evidence = join(root, 'evidence')
  const challenge = prepare(workspace, evidence, { provider: 'openrouter', model: 'deterministic-test-only' })
  const ledger = join(workspace, 'current/ledger.mjs')
  return { root, workspace, evidence, challenge, ledger }
}
function trace(challenge) {
  const base = { schema_version: 1, session_id: 'session', turn_id: 'turn', ts: new Date().toISOString() }
  return [
    { kind: 'user_submitted', task_preview: JSON.parse(readFileSync(join(fixture, 'manifest.json'))).task, project_root: challenge.workspace },
    { kind: 'model_input_receipt', inference_id: 'request-1' },
    { kind: 'model_invocation_phase', inference_id: 'request-1', phase: 'request_dispatched' },
    { kind: 'model_result_delivery', inference_id: 'request-1', status: 'delivered' },
    { kind: 'tool_started', tool_call_id: 'tool' },
    { kind: 'tool_completed', tool_call_id: 'tool' },
    { kind: 'model_input_receipt', inference_id: 'request-2' },
    { kind: 'model_invocation_phase', inference_id: 'request-2', phase: 'request_dispatched' },
    { kind: 'model_result_delivery', inference_id: 'request-2', status: 'delivered' },
  ].map((event, seq) => ({ ...base, provider: 'openrouter', model: 'deterministic-test-only', sent_model_id: 'deterministic-test-only', seq, ...event }))
}

test('correct equivalent repairs pass functional checks; missing provider trace never qualifies a cell', (t) => {
  for (const repair of [corrected, corrected.replace('entries.reduce((sum, entry) => sum + entry.amount, 0)', 'entries.map(e => e.amount).reduce((a, b) => a + b, 0)')]) {
    const c = cell(t)
    writeFileSync(c.ledger, repair)
    const before = hash(join(fixture, 'workspace/current/ledger.mjs'))
    const result = qualify(c.evidence)
    assert.equal(result.functionalPass, true)
    assert.equal(result.providerCellPass, false)
    assert.equal(hash(join(fixture, 'workspace/current/ledger.mjs')), before)
  }
})

test('wrong-but-green hardcoded repair, pristine bug, unchanged ledger, mutation, child crash, malformed output and timeout fail', (t) => {
  for (const [name, source] of [
    ['pristine unchanged', pristine],
    ['hardcoded green', 'export function total(entries) { return entries?.length === 0 ? 0 : 150 }'],
    ['input mutation', corrected.replace('return entries.reduce', 'entries.reverse(); return entries.reduce')],
    ['field mutation', corrected.replace('return entries.reduce', 'entries.forEach(e => delete e.label); return entries.reduce')],
    ['child crash', 'process.exit(9)'],
    ['malformed output', `console.log('not-json');\n${corrected}`],
    ['timeout', 'while (true) {}'],
  ]) {
    const c = cell(t)
    writeFileSync(c.ledger, source)
    if (name === 'hardcoded green') {
      const tests = spawnSync(process.execPath, ['--test', 'ledger.test.mjs'], { cwd: join(c.workspace, 'current'), timeout: 3000 })
      assert.equal(tests.status, 0, 'negative control must pass the original project tests')
    }
    const result = qualify(c.evidence)
    assert.equal(result.functionalPass, false, name)
    assert.equal(result.providerCellPass, false, name)
  }
})

test('altered and deleted project tests are rejected independently of evaluator verdict', (t) => {
  for (const deleted of [false, true]) {
    const c = cell(t)
    writeFileSync(c.ledger, corrected)
    const tests = join(c.workspace, 'current/ledger.test.mjs')
    if (deleted) rmSync(tests)
    else writeFileSync(tests, '// all tests removed')
    assert.throws(() => qualify(c.evidence), /Protected candidate files changed/)
  }
})

test('candidate cannot forge probe results by replacing JSON serialization', (t) => {
  const c = cell(t)
  writeFileSync(c.ledger, `
    const original = JSON.stringify
    JSON.stringify = (value, ...args) => value?.nonce
      ? original({ nonce: value.nonce, results: [150,0,0,15,15,-13,-13,0,0,2,2,150], preserved: [true,true,true,true,true] })
      : original(value, ...args)
    export function total(entries) { return entries?.length === 0 ? 0 : 150 }
  `)
  assert.equal(qualify(c.evidence).functionalPass, false)
})

test('candidate prototype hooks and nonnumeric results cannot forge the oracle protocol', (t) => {
  for (const source of [
    `Object.prototype.toJSON = function () { return this.nonce ? {nonce:this.nonce,results:[150,0,0,15,15,-13,-13,0,0,2,2,150],preserved:[true,true,true,true,true]} : this }; export function total(entries) { return entries?.length === 0 ? 0 : 150 }`,
    `Array.prototype.push = function () { return this.length }; export function total(entries) { return entries?.length === 0 ? 0 : 150 }`,
    `const original = process.stdout._write; process.stdout._write = function(chunk, encoding, callback) { try { const value = JSON.parse(chunk.toString()); if (value.nonce) chunk = JSON.stringify({nonce:value.nonce,results:[150,0,0,15,15,-13,-13,0,0,2,2,150],preserved:[true,true,true,true,true]}) } catch {} return original.call(this,chunk,encoding,callback) }; export function total(entries) { return entries?.length === 0 ? 0 : 150 }`,
    'export function total(entries) { if (!entries) return 150; if (!entries.length) return 0; return { toJSON: () => entries.reduce((sum, e) => sum + e.amount, 0) } }',
    corrected.replace('return entries.reduce', 'if (entries.length) entries[0].amount = 999; return entries.reduce'),
  ]) {
    const c = cell(t)
    writeFileSync(c.ledger, source)
    assert.equal(qualify(c.evidence).functionalPass, false)
  }
})

test('ordinary Babel runtime state is allowed, and additional project tests still run', (t) => {
  const c = cell(t)
  writeFileSync(c.ledger, corrected)
  mkdirSync(join(c.workspace, '.babel'))
  writeFileSync(join(c.workspace, '.babel', 'runtime-state.json'), '{}')
  assert.equal(qualify(c.evidence).functionalPass, true)
  const failing = cell(t)
  writeFileSync(failing.ledger, corrected)
  writeFileSync(join(failing.workspace, 'current', 'extra.test.mjs'), 'throw new Error("failing additional test")')
  assert.equal(qualify(failing.evidence).functionalPass, false)
})

test('evaluator rejects absent/malformed hashes and absent/relative/protected/stale verdict paths from arbitrary cwd', (t) => {
  const c = cell(t)
  writeFileSync(c.ledger, corrected)
  const evaluator = join(fixture, 'evaluator/verify.mjs')
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
    CANDIDATE_WORKSPACE: c.workspace, VERDICT_PATH: join(c.evidence, 'direct.json'), RUN_NONCE: c.challenge.nonce,
    EVALUATOR_SHA256: hash(evaluator), ORACLE_SHA256: hash(join(fixture, 'evaluator/probe.mjs')),
    PRISTINE_LEDGER_SHA256: hash(join(fixture, 'workspace/current/ledger.mjs')),
  }
  const bad = []
  for (const key of ['EVALUATOR_SHA256', 'ORACLE_SHA256', 'PRISTINE_LEDGER_SHA256']) {
    bad.push({ ...env, [key]: undefined }, { ...env, [key]: 'invalid' })
  }
  bad.push(...[undefined, 'relative.json', join(c.workspace, 'verdict.json'), join(fixture, 'evaluator/verdict.json')]
    .map((VERDICT_PATH) => ({ ...env, VERDICT_PATH })))
  writeFileSync(join(c.evidence, 'stale.json'), '{"pass":true}')
  bad.push({ ...env, VERDICT_PATH: join(c.evidence, 'stale.json') })
  for (const input of bad) {
    const run = spawnSync(process.execPath, [evaluator], { env: input, cwd: c.root, encoding: 'utf8', timeout: 10000 })
    assert.equal(run.status, 1)
  }
  const plan = spawnSync(process.execPath, [evaluator, '--plan'], { env: {}, cwd: c.root, encoding: 'utf8' })
  assert.equal(plan.status, 0)
  assert.equal(JSON.parse(plan.stdout).pass, false)
  assert.equal(JSON.parse(plan.stdout).authoritative, false)
})

test('trusted runner detects changed evaluator and oracle; snapshots under test are disposable', (t) => {
  const c = cell(t)
  const copy = join(c.root, 'trusted copy')
  mkdirSync(join(copy, 'scripts'), { recursive: true })
  mkdirSync(join(copy, 'src/fixtures'), { recursive: true })
  cpSync(fixture, join(copy, 'src/fixtures/provider-switch'), { recursive: true })
  cpSync(fileURLToPath(new URL('./provider_switch_qualification.mjs', import.meta.url)), join(copy, 'scripts/provider_switch_qualification.mjs'))
  for (const target of ['evaluator/verify.mjs', 'evaluator/probe.mjs']) {
    const ws = join(c.root, `copy-${target.includes('verify') ? 'evaluator' : 'oracle'}`)
    const ev = `${ws}-evidence`
    const runner = join(copy, 'scripts/provider_switch_qualification.mjs')
    const prepareRun = spawnSync(process.execPath, [runner, '--prepare', ws, ev, 'openrouter', 'deterministic-test-only'], { cwd: c.root, encoding: 'utf8' })
    assert.equal(prepareRun.status, 0, prepareRun.stderr)
    const path = join(copy, 'src/fixtures/provider-switch', target)
    const original = readFileSync(path)
    writeFileSync(path, 'process.stdout.write(JSON.stringify({pass:true})); process.exit(0)')
    const verifyRun = spawnSync(process.execPath, [runner, '--verify', ev], { cwd: c.root, encoding: 'utf8' })
    assert.equal(verifyRun.status, 1)
    assert.match(verifyRun.stderr, /Trusted fixture changed/)
    writeFileSync(path, original)
  }
})

test('stale verdict rejected; manifest request minimum and intervening tool evidence enforced', (t) => {
  const c = cell(t)
  writeFileSync(c.ledger, corrected)
  writeFileSync(join(c.evidence, 'verdict.json'), JSON.stringify({ pass: true, nonce: 'old' }))
  assert.throws(() => qualify(c.evidence), /Existing verdict rejected/)
  const events = trace(c.challenge)
  const task = JSON.parse(readFileSync(join(fixture, 'manifest.json'))).task
  assert.equal(checkTrace(events, c.challenge, task), true)
  assert.equal(checkTrace(events.filter(e => e.inference_id !== 'request-2'), c.challenge, task), false)
  assert.equal(checkTrace(events.filter(e => e.kind !== 'tool_completed'), c.challenge, task), false)
  assert.equal(checkTrace(events.map(e => ({ ...e, provider: 'commandcode' })), c.challenge, task), false)
  const extra = events.slice(6).map((event, i) => ({ ...event, inference_id: 'extra', seq: events.length + i }))
  assert.equal(checkTrace([...events, ...extra.map(e => ({ ...e, provider: 'commandcode' }))], c.challenge, task), false)
  assert.equal(checkTrace([...events, ...extra.filter(e => e.kind !== 'model_result_delivery')], c.challenge, task), false)
  assert.equal(checkTrace(events.map(e => ({ ...e, ts: '2000-01-01T00:00:00Z' })), c.challenge, task), false)
  assert.equal(checkTrace(events.map(e => e.seq === 0 ? { ...e, task_preview: 'unrelated' } : e), c.challenge, task), false)
  // Deterministic validator control only: this is not a live provider receipt.
  const valid = cell(t)
  writeFileSync(valid.ledger, corrected)
  const captured = join(valid.evidence, 'synthetic-test-events.jsonl')
  writeFileSync(captured, trace(valid.challenge).map(e => JSON.stringify(e)).join('\n'))
  assert.equal(qualify(valid.evidence, captured).providerCellPass, true)
})
