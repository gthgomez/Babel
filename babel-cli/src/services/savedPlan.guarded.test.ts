import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadSavedPlan, PlanSaveUncertainError, savePlanGuarded } from './savedPlan.js'

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-save-plan-guarded-')); const project = join(root, 'project'); const state = join(root, 'state')
  fs.mkdirSync(project); fs.mkdirSync(state); fs.writeFileSync(join(project, 'safe.txt'), 'safe source')
  const older = '20260610T180000Z-plan-abc123def456'; const newer = '20260610T180001Z-plan-abc123def457'
  for (const [id, body] of [[older, 'SYNTHETIC_FULL_PLAN_A'], [newer, 'SYNTHETIC_FULL_PLAN_B']] as const) {
    const run = join(project, 'runs', 'babel-lite', id); fs.mkdirSync(run, { recursive: true })
    fs.writeFileSync(join(run, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['safe.txt'], required_reads: [] }))
    fs.writeFileSync(join(run, 'model_plan.json'), JSON.stringify({ summary: body }))
    fs.writeFileSync(join(run, 'plan.md'), body)
  }
  return { root, project, state, older, cleanup() { fs.rmSync(root, { recursive: true, force: true }) } }
}

test('guarded Plan store retains the complete explicitly selected older Plan', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded candidate'); return }
  const f = fixture()
  try {
    const env = { ...process.env, BABEL_STATE_DIR: f.state }
    const saved = await savePlanGuarded({ projectRoot: f.project, task: 'inspect safe.txt', body: 'SYNTHETIC_FULL_PLAN_A', sourceRunId: f.older }, env)
    const loaded = loadSavedPlan(saved.id, env)
    assert.equal(loaded.body, 'SYNTHETIC_FULL_PLAN_A'); assert.equal(loaded.sourceRunId, f.older)
    assert.match(loaded.sourceDigest ?? '', /^[a-f0-9]{64}$/); assert.match(loaded.sourceProjectIdentity ?? '', /^[a-f0-9]{64}$/)
    assert.doesNotMatch(JSON.stringify(loaded), /SYNTHETIC_FULL_PLAN_B/)
  } finally { f.cleanup() }
})

test('guarded Plan store rejects a body that differs from its source before writing', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded candidate'); return }
  const f = fixture()
  try {
    await assert.rejects(savePlanGuarded({ projectRoot: f.project, task: 'inspect safe.txt', body: 'different plan', sourceRunId: f.older }, { ...process.env, BABEL_STATE_DIR: f.state }), /does not match/)
    assert.equal(fs.existsSync(join(f.state, 'plans')), false)
  } finally { f.cleanup() }
})

test('guarded Plan store retains identity when commit acknowledgement is lost', async t => {
  if (process.platform !== 'win32') { t.skip('Windows guarded candidate'); return }
  const f = fixture(); const original = childProcess.spawn; let killed = false
  try {
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = original(...args)
      child.stdout?.on('data', chunk => { if (!killed && String(chunk).includes('COMMITTED')) { killed = true; child.kill() } })
      return child
    }) as typeof childProcess.spawn
    syncBuiltinESMExports()
    let failure: unknown
    try { await savePlanGuarded({ projectRoot: f.project, task: 'inspect safe.txt', body: 'SYNTHETIC_FULL_PLAN_A', sourceRunId: f.older }, { ...process.env, BABEL_STATE_DIR: f.state }) } catch (error) { failure = error }
    assert.equal(killed, true); assert.ok(failure instanceof PlanSaveUncertainError)
    const bytes = fs.readFileSync(failure.path, 'utf8'); const saved = JSON.parse(bytes)
    assert.equal(saved.id, failure.planId); assert.equal(saved.body, 'SYNTHETIC_FULL_PLAN_A')
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); f.cleanup() }
})
