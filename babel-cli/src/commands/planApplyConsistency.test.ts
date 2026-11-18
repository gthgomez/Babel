// W11 UX-14: every Plan surface must describe the same capability. Automatic
// application is unavailable; the guarded saved-Plan route is the only route
// that advertises confirmation, while explicit --run / --plan <path> values
// remain a separately named legacy manual-bridge lane. The bare-directory
// apply-plan route fails closed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareSyntheticProviderFixture, removeSyntheticProviderFixture } from '../testinfra/synthetic-provider-fixture.mjs'

const cliEntry = fileURLToPath(new URL('../index.ts', import.meta.url))

async function saveFixturePlan(fixture: ReturnType<typeof prepareSyntheticProviderFixture>, env: NodeJS.ProcessEnv) {
  const { savePlan } = await import('../services/savedPlan.js')
  const { updateUserSettings } = await import('../config/userSettings.js')
  updateUserSettings({
    connections: { fixture: { id: 'fixture', provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } },
    defaults: { connection: 'fixture', budgetUsd: 'unlimited' },
  }, { env })
  const sourceRunId = '20260610T180000Z-plan-abcdef01'
  const source = join(fixture.cwd, 'runs', 'babel-lite', sourceRunId)
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'contract.json'), JSON.stringify({ schema_version: 1, mode: 'babel-lite-plan', likely_files: [], required_reads: [] }))
  writeFileSync(join(source, 'model_plan.json'), JSON.stringify({ summary: 'Safe fixture summary' }))
  writeFileSync(join(source, 'plan.md'), 'Safe plan')
  return savePlan({ projectRoot: fixture.cwd, task: 'Implement fixture', body: 'Safe plan', sourceRunId }, env)
}

function dispatchPreload(fixture: ReturnType<typeof prepareSyntheticProviderFixture>, name: string) {
  const marker = join(fixture.root, name)
  const preload = join(fixture.root, `${name}.mjs`)
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
    process.env.BABEL_OPENCLAW_APPROVED_ROOTS = ${JSON.stringify(fixture.cwd)};
    globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('synthetic dispatch'); };`)
  return { marker, preload }
}

test('the legacy bare-plan-directory route fails closed instead of bypassing saved Plan guards', () => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    const source = join(fixture.cwd, 'runs', 'babel-lite', '20260610T180000Z-plan-abcdef01')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'plan.md'), 'legacy plan fixture')
    const { marker, preload } = dispatchPreload(fixture, 'legacy-apply-dispatch')
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules',
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'),
      '--import', pathToFileURL(preload).href,
      cliEntry, 'apply-plan', source,
    ], { cwd: fixture.cwd, env: fixture.env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    assert.equal(child.error, undefined)
    assert.notEqual(child.status, 0)
    assert.match(`${child.stdout}${child.stderr}`, /UNSUPPORTED_OPERATION.*bare Plan directory/i)
    assert.match(`${child.stdout}${child.stderr}`, /apply --plan <saved-plan-id>/)
    assert.equal(existsSync(marker), false, 'the legacy route must not dispatch a provider request')
  } finally { removeSyntheticProviderFixture(fixture.root) }
})

test('a saved Plan apply refuses without confirmation before provider dispatch and leaves no lock', async () => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    const env = { ...fixture.env, BABEL_STATE_DIR: join(fixture.root, 'state'), BABEL_CONFIG_DIR: join(fixture.root, 'config'), BABEL_LIVE: '1' }
    const plan = await saveFixturePlan(fixture, env)
    const { marker, preload } = dispatchPreload(fixture, 'unconfirmed-apply-dispatch')
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules',
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'),
      '--import', pathToFileURL(preload).href,
      cliEntry, 'apply', '--plan', plan.id,
    ], { cwd: fixture.cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    assert.equal(child.error, undefined)
    assert.notEqual(child.status, 0)
    assert.match(`${child.stdout}${child.stderr}`, /not confirmed; no files were changed/i)
    assert.equal(existsSync(marker), false, 'an unconfirmed apply must not call the provider')
    const { loadSavedPlan } = await import('../services/savedPlan.js')
    assert.equal(loadSavedPlan(plan.id, env).state, 'ready', 'a refused confirmation leaves the Plan reusable')
    const lockPath = join(env.BABEL_STATE_DIR as string, 'plans', `${plan.id}.json.lock`)
    assert.equal(existsSync(lockPath), false, 'an interrupted/refused confirmation must not leave the apply lock')
  } finally { removeSyntheticProviderFixture(fixture.root) }
})

test('explicit apply capability is suppressed under read-only permissions', async () => {
  const { planApplyCapability } = await import('./workflowCommands.js')
  const base = { BABEL_RUNTIME_MODE: 'act', BABEL_STATE_DIR: join('/tmp', 'babel-w11-plan-capability') }
  assert.deepEqual(planApplyCapability(null, base), { available: false, reason: null })
  assert.deepEqual(planApplyCapability('plan_fixture', base), { available: true, reason: null })
  for (const env of [
    { ...base, BABEL_READ_ONLY: 'true' },
    { ...base, BABEL_DRY_RUN: '1' },
    { ...base, BABEL_RUNTIME_MODE: 'plan' },
  ]) {
    const capability = planApplyCapability('plan_fixture', env)
    assert.equal(capability.available, false)
    assert.match(String(capability.reason), /read-only/i)
  }
})

test('explicit --yes clears the confirmation gate and reaches guarded execution', async () => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    const env = { ...fixture.env, BABEL_STATE_DIR: join(fixture.root, 'state'), BABEL_CONFIG_DIR: join(fixture.root, 'config'), BABEL_LIVE: '1' }
    const plan = await saveFixturePlan(fixture, env)
    const { marker, preload } = dispatchPreload(fixture, 'confirmed-apply-dispatch')
    const child = spawnSync(process.execPath, [
      '--experimental-wasm-modules',
      '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'),
      '--import', pathToFileURL(preload).href,
      cliEntry, 'apply', '--plan', plan.id, '--yes',
    ], { cwd: fixture.cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    assert.equal(child.error, undefined)
    const output = `${child.stdout}${child.stderr}`
    assert.doesNotMatch(output, /not confirmed; no files were changed/i)
    assert.equal(existsSync(marker), true, 'an explicitly confirmed apply reaches guarded execution')
    assert.match(output, /Auto-approved via --yes/i)
    const { loadSavedPlan } = await import('../services/savedPlan.js')
    assert.notEqual(loadSavedPlan(plan.id, env).state, 'ready', 'admission consumed the saved Plan state')
  } finally { removeSyntheticProviderFixture(fixture.root) }
})

test('confirmation runs before the apply lock is acquired', async () => {
  const fixture = prepareSyntheticProviderFixture()
  try {
    const env = { ...fixture.env, BABEL_STATE_DIR: join(fixture.root, 'state'), BABEL_CONFIG_DIR: join(fixture.root, 'config') }
    const plan = await saveFixturePlan(fixture, env)
    const { withSavedPlanApplication, loadSavedPlan } = await import('../services/savedPlan.js')
    const lockPath = join(env.BABEL_STATE_DIR, 'plans', `${plan.id}.json.lock`)
    let lockAtPrompt: boolean | null = null
    await assert.rejects(
      () => withSavedPlanApplication(plan.id, {
        projectRoot: fixture.cwd,
        env,
        preflight: () => { lockAtPrompt = existsSync(lockPath); throw new Error('synthetic confirmation stop') },
        execute: async () => { throw new Error('execution must not start') },
      }),
      /synthetic confirmation stop/,
    )
    assert.equal(lockAtPrompt, false, 'the confirmation prompt must run before the lock exists')
    assert.equal(existsSync(lockPath), false, 'a stopped confirmation leaves no lock')
    assert.equal(loadSavedPlan(plan.id, env).state, 'ready')
  } finally { removeSyntheticProviderFixture(fixture.root) }
})
