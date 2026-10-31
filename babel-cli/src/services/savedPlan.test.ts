import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
  assert.equal(shouldAutoApplyPlan('Fix it', true, true), false)
})


test('saved preference cannot override current read-only policy and application is single use', async () => {
  const { savePlan, withSavedPlanApplication, loadSavedPlan } = await import('./savedPlan.js')
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-plan-once-'))
  const env = { BABEL_STATE_DIR: mkdtempSync(join(tmpdir(), 'babel-plan-profile-')), BABEL_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'babel-plan-config-')) }
  const plan = savePlan({ projectRoot, task: 'Implement requested edit', body: 'Implement it' }, env)
  let calls = 0
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env: { ...env, BABEL_DRY_RUN: '1' }, execute: async () => { calls++ } }), /read-only/)
  assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, operatorMode: 'hard_plan', execute: async () => { calls++ } }), /read-only/)
  assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  await withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++ } })
  await assert.rejects(withSavedPlanApplication(plan.id, { projectRoot, env, execute: async () => { calls++ } }), /already started/)
  assert.equal(calls, 1); assert.equal(loadSavedPlan(plan.id, env).state, 'applied')
})
