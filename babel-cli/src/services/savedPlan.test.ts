import assert from 'node:assert/strict'
import test from 'node:test'
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

function writeFixtureContract(path: string): void {
  writeFileSync(join(path, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: [], required_reads: [] }))
}

test('saved plan replacement after stat is rejected before reading replacement', async t => {
  const { savePlan, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-saved-plan-race-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state }
    const plan = savePlan({ projectRoot, task: 'Inspect', body: 'Safe plan' }, env)
    const file = join(state, 'plans', `${plan.id}.json`); const replacement = join(root, 'replacement.json')
    writeFileSync(replacement, JSON.stringify({ ...plan, body: 'SYNTHETIC_REPLACEMENT_PLAN' }))
    const original = fs.lstatSync; let swapped = false
    t.mock.method(fs, 'lstatSync', ((...args: unknown[]) => {
      const info = Reflect.apply(original, fs, args)
      if (!swapped && args[0] === file) { swapped = true; renameSync(file, `${file}.old`); renameSync(replacement, file) }
      return info
    }) as typeof fs.lstatSync)
    syncBuiltinESMExports()
    assert.throws(() => loadSavedPlan(plan.id, env), /unsafe/i)
    assert.equal(swapped, true)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
})

test('source Plan replacement after stat cannot enter saved identity', async t => {
  const { savePlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-source-plan-race-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFixtureContract(source)
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe plan', likely_files: [] }))
    const file = join(source, 'plan.md'); const replacement = join(root, 'replacement.md')
    writeFileSync(file, 'Safe plan'); writeFileSync(replacement, 'SYNTHETIC_REPLACEMENT_PLAN')
    const original = fs.lstatSync; let swapped = false
    t.mock.method(fs, 'lstatSync', ((...args: unknown[]) => {
      const info = Reflect.apply(original, fs, args)
      if (!swapped && args[0] === file) { swapped = true; renameSync(file, `${file}.old`); renameSync(replacement, file) }
      return info
    }) as typeof fs.lstatSync)
    syncBuiltinESMExports()
    assert.throws(() => savePlan({ projectRoot, task: 'Inspect', body: 'Safe plan', sourceRunId }, { BABEL_STATE_DIR: state }), /unsafe/i)
    assert.equal(swapped, true)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
})

test('private saved plans reject hard-linked artifacts', async () => {
  const { savePlan, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-hardlink-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state }
    const plan = savePlan({ projectRoot, task: 'Inspect', body: 'Safe plan' }, env)
    const file = join(state, 'plans', `${plan.id}.json`)
    const outside = join(root, 'outside.json')
    writeFileSync(outside, JSON.stringify({ ...plan, body: 'SYNTHETIC_OUTSIDE_PLAN' }))
    unlinkSync(file); linkSync(outside, file)
    assert.throws(() => loadSavedPlan(plan.id, env), /unsafe/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('private saved plans reject a linked plans directory', async () => {
  const { savePlan, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-junction-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state }
    const plan = savePlan({ projectRoot, task: 'Inspect', body: 'Safe plan' }, env)
    const plans = join(state, 'plans'); const outside = join(root, 'outside')
    renameSync(plans, outside)
    symlinkSync(outside, plans, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => loadSavedPlan(plan.id, env), /unsafe/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy saved plan without source identity cannot dispatch or become applied', async () => {
  const { savePlan, loadSavedPlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-legacy-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const plan = savePlan({ projectRoot, task: 'Implement a change', body: 'Retained legacy plan' }, env)
    let dispatched = false
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { dispatched = true } }), /source/i)
    assert.equal(dispatched, false)
    assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy source without a persisted contract is retained and cannot dispatch', async () => {
  const { savePlan, loadSavedPlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-no-contract-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId); mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Legacy', likely_files: ['unapproved.ts'] })); writeFileSync(join(source, 'plan.md'), 'Legacy plan')
    const plan = savePlan({ projectRoot, task: 'Apply legacy', body: 'Legacy plan', sourceRunId }, env); let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /contract.*missing|contract.*unavailable/i)
    assert.equal(calls, 0); assert.equal(loadSavedPlan(plan.id, env).body, 'Legacy plan'); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('plan application rejects another project and changed scope before executing', async () => {
  const { savePlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-plan-project-'))
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-plan-state-')) }
  writeFileSync(join(projectRoot, 'file.txt'), 'original')
  const plan = savePlan({ projectRoot, task: 'Update file', body: 'Update file.txt carefully' }, env)
  let executed = false
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot: tmpdir(), env, execute: async () => { executed = true } }), /project|scope/i)
  writeFileSync(join(projectRoot, 'file.txt'), 'changed scope')
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { executed = true } }), /changed|stale/i)
  assert.equal(executed, false)
})

test('auto-apply requires the saved preference and explicit plan-only intent wins', async () => {
  const { shouldAutoApplyPlan } = await import('./savedPlan.js')
  assert.equal(shouldAutoApplyPlan('Fix it', false), false)
  assert.equal(shouldAutoApplyPlan('Fix it', true), true)
  assert.equal(shouldAutoApplyPlan('Plan only; do not implement', true), false)
  assert.equal(shouldAutoApplyPlan('Inspect the code. Do not modify any files.', true), false)
  assert.equal(shouldAutoApplyPlan('Inspect without writing any files.', true), false)
  assert.equal(shouldAutoApplyPlan('Fix it', true, true), false)
})


test('saved preference cannot override current read-only policy and application is single use', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-plan-once-'))
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-plan-profile-')), BABEL_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'babel-plan-config-')) }
  const sourceRunId = '20260610T180000Z-plan-abcdef01'
  const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
  mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Implement it' }))
  writeFileSync(join(source, 'plan.md'), 'Implement it')
  writeFixtureContract(source)
  const plan = savePlan({ projectRoot, task: 'Implement requested edit', body: 'Implement it', sourceRunId }, env)
  let calls = 0
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env: { ...env, BABEL_DRY_RUN: '1' }, execute: async () => { calls++ } }), /read-only/)
  assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, operatorMode: 'hard_plan', execute: async () => { calls++ } }), /read-only/)
  assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  await withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } })
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++ } }), /already started/)
  assert.equal(calls, 1); assert.equal(loadSavedPlan(plan.id, env).state, 'applied')
})

test('applying an older saved plan retains its exact source after a newer plan exists', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-identity-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceA = '20260610T180000Z-plan-abcdef01'; const sourceB = '20260610T180001Z-plan-abcdef02'
    for (const [id, summary] of [[sourceA, 'Plan A'], [sourceB, 'Plan B']] as const) {
      const path = join(projectRoot, 'runs', 'babel-lite', id)
      mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'model_plan.json'), JSON.stringify({ summary }))
      writeFileSync(join(path, 'plan.md'), `${summary} body`)
      writeFixtureContract(path)
    }
    const a = savePlan({ projectRoot, task: 'Implement A', body: 'Plan A body', sourceRunId: sourceA }, env)
    const b = savePlan({ projectRoot, task: 'Implement B', body: 'Plan B body', sourceRunId: sourceB }, env)
    let observed: { body: string; sourceRunId?: string | undefined } | undefined
    await withSavedPlanApplication(a.id, { projectRoot, env, execute: async plan => { observed = plan; return { status: 'COMPLETE', runDir: projectRoot } } })
    assert.equal(observed?.body, 'Plan A body'); assert.equal(observed?.sourceRunId, sourceA)
    assert.equal(loadSavedPlan(a.id, env).state, 'applied'); assert.equal(loadSavedPlan(b.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pre-dispatch Apply containment preserves the ready Plan and never starts an attempt', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-preflight-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Plan' })); writeFileSync(join(source, 'plan.md'), 'Plan body'); writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Implement', body: 'Plan body', sourceRunId }, env); let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, preflight: () => { throw new Error('Synthetic pre-dispatch refusal') }, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /pre-dispatch refusal/)
    const retained = loadSavedPlan(plan.id, env); assert.equal(retained.state, 'ready'); assert.equal(retained.attemptId, undefined); assert.equal(calls, 0)
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, preflight: async () => { await Promise.resolve(); throw new Error('Async pre-dispatch refusal') }, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /Async pre-dispatch refusal/)
    assert.equal(loadSavedPlan(plan.id, env).state, 'ready'); assert.equal(calls, 0)
    const savedPath = join(state, 'plans', `${plan.id}.json`)
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, preflight: async () => { writeFileSync(savedPath, JSON.stringify({ ...plan, body: 'Changed plan body' })) }, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /changed during Apply admission/)
    assert.equal(loadSavedPlan(plan.id, env).body, 'Changed plan body'); assert.equal(calls, 0)
    writeFileSync(savedPath, JSON.stringify(plan))
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, preflight: async () => { await Promise.resolve(); writeFileSync(join(projectRoot, 'changed.txt'), 'changed during admission') }, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /changed during Apply admission/)
    assert.equal(loadSavedPlan(plan.id, env).state, 'ready'); assert.equal(calls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Git freshness ignores new untracked Plan artifacts but retains source-change checks', async () => {
  const { savePlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-git-freshness-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectRoot, windowsHide: true, stdio: 'pipe' })
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test')
    const a = '20260610T180000Z-plan-abcdef01'; const b = '20260610T180001Z-plan-abcdef02'
    const pathA = join(projectRoot, 'runs', 'babel-lite', a); const pathB = join(projectRoot, 'runs', 'babel-lite', b)
    mkdirSync(pathA, { recursive: true }); mkdirSync(pathB, { recursive: true }); writeFileSync(join(pathB, 'source.ts'), 'tracked original'); writeFileSync(join(pathB, 'verification.json'), 'tracked verification')
    git('add', 'runs/babel-lite/' + b + '/source.ts', 'runs/babel-lite/' + b + '/verification.json'); git('commit', '-q', '-m', 'fixture')
    writeFileSync(join(pathA, 'model_plan.json'), JSON.stringify({ summary: 'Plan A' })); writeFileSync(join(pathA, 'plan.md'), 'Plan A')
    writeFixtureContract(pathA)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const first = savePlan({ projectRoot, task: 'Apply A', body: 'Plan A', sourceRunId: a }, env)
    writeFileSync(join(pathB, 'model_plan.json'), JSON.stringify({ summary: 'Plan B' })); writeFileSync(join(pathB, 'plan.md'), 'Plan B')
    for (const name of ['plan_session_loop.json', '00_ctx_lite_plan.md', 'lite_plan_answer.json', '04_execution_report.json', '05_waterfall_telemetry.json', 'cost_ledger.json']) writeFileSync(join(pathB, name), 'generated fixture')
    await withSavedPlanApplication(first.id, { projectRoot, env, execute: async () => ({ status: 'COMPLETE', runDir: projectRoot }) })
    const second = savePlan({ projectRoot, task: 'Apply A again', body: 'Plan A', sourceRunId: a }, env)
    writeFileSync(join(pathB, 'source.ts'), 'tracked changed')
    await assert.rejects(withSavedPlanApplication(second.id, { projectRoot, env, execute: async () => ({ status: 'COMPLETE', runDir: projectRoot }) }), /project changed/i)
    writeFileSync(join(pathB, 'source.ts'), 'tracked original')
    const third = savePlan({ projectRoot, task: 'Apply A once more', body: 'Plan A', sourceRunId: a }, env)
    writeFileSync(join(pathB, 'verification.json'), 'tracked verification changed')
    await assert.rejects(withSavedPlanApplication(third.id, { projectRoot, env, execute: async () => ({ status: 'COMPLETE', runDir: projectRoot }) }), /project changed/i)
    writeFileSync(join(pathB, 'verification.json'), 'tracked verification')
    const fourth = savePlan({ projectRoot, task: 'Apply A again later', body: 'Plan A', sourceRunId: a }, env)
    writeFileSync(join(pathB, 'unrelated.ts'), 'untracked source next to artifacts')
    await assert.rejects(withSavedPlanApplication(fourth.id, { projectRoot, env, execute: async () => ({ status: 'COMPLETE', runDir: projectRoot }) }), /project changed/i)
    unlinkSync(join(pathB, 'unrelated.ts'))
    const fifth = savePlan({ projectRoot, task: 'Apply A after review', body: 'Plan A', sourceRunId: a }, env)
    writeFileSync(join(projectRoot, 'new-source.ts'), 'untracked source')
    await assert.rejects(withSavedPlanApplication(fifth.id, { projectRoot, env, execute: async () => ({ status: 'COMPLETE', runDir: projectRoot }) }), /project changed/i)
    if (process.platform !== 'win32') {
      unlinkSync(join(projectRoot, 'new-source.ts'))
      const sixth = savePlan({ projectRoot, task: 'Apply A with case check', body: 'Plan A', sourceRunId: a }, env)
      const otherCase = join(projectRoot, 'Runs', 'babel-lite', b); mkdirSync(otherCase, { recursive: true }); writeFileSync(join(otherCase, 'plan.md'), 'ordinary source')
      await assert.rejects(withSavedPlanApplication(sixth.id, { projectRoot, env, execute: async () => ({ status: 'COMPLETE', runDir: projectRoot }) }), /project changed/i)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a credential-shaped Plan body is retained but cannot enter Apply execution', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-body-private-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    const body = 'OPENAI_API_KEY=SYNTHETIC_PLAN_BODY_SECRET'; mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe summary' })); writeFileSync(join(source, 'plan.md'), body)
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Implement', body, sourceRunId }, env)
    let executions = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { executions++; return { status: 'COMPLETE', runDir: projectRoot } } }), /sensitive|credential|unsafe/i)
    assert.equal(executions, 0); assert.equal(loadSavedPlan(plan.id, env).body, body); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('credential-shaped saved task metadata is retained but cannot enter Apply execution', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-task-private-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    const task = 'Implement with OPENAI_API_KEY=SYNTHETIC_TASK_SECRET'; mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe summary' })); writeFileSync(join(source, 'plan.md'), 'Safe plan')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task, body: 'Safe plan', sourceRunId }, env); let executions = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { executions++; return { status: 'COMPLETE', runDir: projectRoot } } }), /sensitive|credential|unsafe/i)
    assert.equal(executions, 0); assert.equal(loadSavedPlan(plan.id, env).task, task); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an ambiguous apply error remains unknown and cannot be replayed', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-unknown-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Apply' }))
    writeFileSync(join(source, 'plan.md'), 'Apply')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Apply', body: 'Apply', sourceRunId }, env)
    let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++; throw new Error('local timeout; remote effect unknown') } }), /timeout/)
    assert.equal(loadSavedPlan(plan.id, env).state, 'unknown')
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++ } }), /already started/)
    assert.equal(calls, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('application rejects a changed source artifact after the Plan was saved', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-source-change-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); const file = join(source, 'model_plan.json')
    writeFileSync(file, JSON.stringify({ summary: 'Approved A', likely_files: ['a.txt'] }))
    writeFileSync(join(source, 'plan.md'), 'Approved A')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Implement A', body: 'Approved A', sourceRunId }, env)
    writeFileSync(file, JSON.stringify({ summary: 'Different B', likely_files: ['b.txt'] }))
    let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++ } }), /source.*changed|source.*identity/i)
    assert.equal(calls, 0); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('application rejects changed Plan review or verification evidence', async () => {
  const { savePlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-review-identity-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId); mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe' })); writeFileSync(join(source, 'plan.md'), 'Safe plan')
    writeFileSync(join(source, 'plan_review.json'), JSON.stringify({ verdict: 'reviewed' })); writeFileSync(join(source, 'verification.json'), JSON.stringify({ status: 'pass' }))
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Apply', body: 'Safe plan', sourceRunId }, env)
    writeFileSync(join(source, 'plan_review.json'), JSON.stringify({ verdict: 'different' }))
    let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /source.*changed|identity/i)
    writeFileSync(join(source, 'plan_review.json'), JSON.stringify({ verdict: 'reviewed' }))
    writeFileSync(join(source, 'verification.json'), JSON.stringify({ status: 'different' }))
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /source.*changed|identity/i)
    assert.equal(calls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('application rejects a changed persisted Plan contract', async () => {
  const { savePlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-contract-identity-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId); mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe', likely_files: ['first.ts'] })); writeFileSync(join(source, 'plan.md'), 'Safe plan')
    writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['first.ts'], required_reads: [] }))
    const plan = savePlan({ projectRoot, task: 'Apply', body: 'Safe plan', sourceRunId }, env)
    writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: ['other.ts'], required_reads: [] }))
    let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /source.*changed|identity/i)
    assert.equal(calls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('older source digests without review evidence are rejected without discarding the Plan', async () => {
  const { savePlan, loadSavedPlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-old-digest-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId); mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe' })); writeFileSync(join(source, 'plan.md'), 'Safe plan')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Apply', body: 'Safe plan', sourceRunId }, env); const oldHash = createHash('sha256')
    for (const name of ['manifest.json', 'request.json', 'contract.json', 'model_plan.json', 'plan.md']) {
      try { const bytes = readFileSync(join(source, name)); oldHash.update(`${name}\0${bytes.length}\0`).update(bytes) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; oldHash.update(`${name}\0missing\0`) }
    }
    const path = join(state, 'plans', `${plan.id}.json`); writeFileSync(path, JSON.stringify({ ...plan, sourceDigest: oldHash.digest('hex') }))
    let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++; return { status: 'COMPLETE', runDir: projectRoot } } }), /source.*identity/i)
    assert.equal(calls, 0); assert.equal(loadSavedPlan(plan.id, env).body, 'Safe plan'); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy source-bound plans without a content digest are retained but cannot execute', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const { readFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-legacy-digest-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state')
    mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Legacy' }))
    writeFileSync(join(source, 'plan.md'), 'Legacy body')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Implement', body: 'Legacy body', sourceRunId }, env)
    const path = join(state, 'plans', `${plan.id}.json`); const legacy = JSON.parse(readFileSync(path, 'utf8')); delete legacy.sourceDigest
    writeFileSync(path, JSON.stringify(legacy))
    let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++ } }), /source identity/i)
    assert.equal(calls, 0); assert.equal(loadSavedPlan(plan.id, env).body, 'Legacy body'); assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('application rejects a changed human plan artifact and metadata', async () => {
  const { savePlan, withSavedPlanApplication } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-artifact-change-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Approved' }))
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ project_root: projectRoot, status: 'PLAN_READY' }))
    writeFileSync(join(source, 'plan.md'), 'Approved body')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Implement', body: 'Approved body', sourceRunId }, env)
    writeFileSync(join(source, 'plan.md'), 'Changed body')
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => {} }), /source.*changed|source.*identity/i)
    writeFileSync(join(source, 'plan.md'), 'Approved body')
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ project_root: projectRoot, status: 'PLAN_READY', task: 'Changed metadata' }))
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => {} }), /source.*changed|source.*identity/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('saved body must match the complete human Plan artifact when present', async () => {
  const { savePlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-body-mismatch-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Approved' }))
    writeFileSync(join(source, 'plan.md'), 'Complete approved body')
    assert.throws(() => savePlan({ projectRoot, task: 'Implement', body: 'Different display prose', sourceRunId }, env), /body.*source|source.*body/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a source without a complete human Plan is retained but cannot be applied', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-missing-body-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Legacy' }))
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Implement', body: 'Retained body', sourceRunId }, env)
    let calls = 0
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++ } }), /source identity|complete.*plan/i)
    assert.equal(calls, 0); assert.equal(loadSavedPlan(plan.id, env).body, 'Retained body')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('apply persists one attempt identity before dispatch and retains it on uncertainty', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-attempt-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Apply' })); writeFileSync(join(source, 'plan.md'), 'Apply')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Apply', body: 'Apply', sourceRunId }, env)
    let observed: string | undefined
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async attempt => {
      observed = attempt.attemptId
      assert.ok(observed); assert.equal(loadSavedPlan(plan.id, env).attemptId, observed)
      throw new Error('outcome unknown')
    } }), /outcome unknown/)
    const retained = loadSavedPlan(plan.id, env)
    assert.equal(retained.state, 'unknown'); assert.equal(retained.attemptId, observed)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('apply returns the actual unsuccessful result without marking the plan applied', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-result-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Apply' })); writeFileSync(join(source, 'plan.md'), 'Apply')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Apply', body: 'Apply', sourceRunId }, env)
    const outcome = { status: 'EXECUTOR_HALTED', runDir: join(root, 'actual-run'), detail: 'Verification did not pass' }
    const result = await withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => outcome })
    assert.deepEqual(result, outcome)
    const retained = loadSavedPlan(plan.id, env)
    assert.equal(retained.state, 'unknown'); assert.equal(retained.attemptRunDir, outcome.runDir); assert.equal(retained.attemptOutcome, outcome.status)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('apply never calls an empty callback result successful', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-empty-result-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Apply' })); writeFileSync(join(source, 'plan.md'), 'Apply')
    writeFixtureContract(source)
    const plan = savePlan({ projectRoot, task: 'Apply', body: 'Apply', sourceRunId }, env)
    await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => {} }), /no inspectable run result/i)
    assert.equal(loadSavedPlan(plan.id, env).state, 'unknown')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('hard-linked human Plan artifacts cannot enter saved Plan identity', async () => {
  const { savePlan } = await import('./savedPlan.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-body-link-'))
  try {
    const projectRoot = join(root, 'project'); const state = join(root, 'state'); mkdirSync(projectRoot); mkdirSync(state)
    const env = { BABEL_STATE_DIR: state, BABEL_CONFIG_DIR: join(root, 'config') }
    const sourceRunId = '20260610T180000Z-plan-abcdef01'; const source = join(projectRoot, 'runs', 'babel-lite', sourceRunId)
    mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Fixture' }))
    const outside = join(root, 'outside'); writeFileSync(outside, 'SYNTHETIC_PRIVATE_PLAN')
    linkSync(outside, join(source, 'plan.md'))
    assert.throws(() => savePlan({ projectRoot, task: 'Inspect', body: 'SYNTHETIC_PRIVATE_PLAN', sourceRunId }, env), /unsafe.*source/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
