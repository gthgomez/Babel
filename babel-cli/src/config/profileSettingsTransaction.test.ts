import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { prepareUserSettingsUpdate, readUserSettings, resolveEffectiveSettings, updateUserSettings } from './userSettings.js'

const moduleUrl = new URL('./userSettings.ts', import.meta.url).href
const guardUrl = new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href
const childSource = `
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { updateUserSettings } from ${JSON.stringify(moduleUrl)};
  const [path, action] = process.argv.slice(1);
  if (action === 'before-rename' || action === 'after-rename') {
    const original = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === path && action === 'before-rename') process.exit(17);
      original(source, destination);
      if (destination === path) process.exit(17);
    };
    syncBuiltinESMExports();
  }
  try {
    updateUserSettings(() => {
      if (action === 'before-save') process.exit(17);
      fs.writeFileSync(path + '.fixture-callback', 'invoked');
      return { defaults: { review: 'thorough' } };
    }, { path });
  } catch (error) {
    if (error instanceof Error && error.message.includes('preferences are locked.')) process.exit(19);
    throw error;
  }
`

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'babel settings transaction é '))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'preferences.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, connections: {}, future: { enabled: true } }), { mode: 0o600 })
  return path
}

function child(path: string, action: string, expectedStatus: number): void {
  const directory = dirname(path)
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', TMPDIR: directory, TMP: directory, TEMP: directory }
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR
  }
  const result = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--import', guardUrl, '--input-type=module', '-e', childSource, path, action,
  ], { cwd: directory, env, windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(result.status, expectedStatus, `${action} fixture exited at an unexpected boundary (${result.error?.name ?? result.signal ?? 'child exit'})`)
}

function markerPresent(path: string): boolean {
  return readdirSync(dirname(path)).includes(`${basename(path)}.babel-lock`)
}

test('the settings callback and atomic commit exclude a competing process, which can retry without losing the first update', t => {
  const path = fixture(t)
  updateUserSettings(current => {
    assert.equal(current.defaults?.review, undefined)
    child(path, 'contender', 19)
    assert.equal(existsSync(`${path}.fixture-callback`), false)
    return { defaults: { workflow: 'plan' } }
  }, { path })
  child(path, 'retry', 0)
  const result = readUserSettings({ path })
  assert.deepEqual(result.defaults, { workflow: 'plan', review: 'thorough' })
  assert.deepEqual(result.future, { enabled: true })
  assert.equal(markerPresent(path), false)
})

for (const boundary of ['before-save', 'before-rename', 'after-rename']) {
  test(`the settings service can write again after a writer exits ${boundary}`, t => {
    const path = fixture(t)
    const before = readFileSync(path, 'utf8')
    child(path, boundary, 17)
    assert.equal(markerPresent(path), true)
    if (boundary === 'after-rename') assert.equal(readUserSettings({ path }).defaults?.review, 'thorough')
    else assert.equal(readFileSync(path, 'utf8'), before)
    const staged = () => readdirSync(dirname(path)).filter(name => name.startsWith(`${basename(path)}.`) && name.endsWith('.tmp'))
    const abandoned = staged()
    assert.equal(abandoned.length, boundary === 'before-rename' ? 1 : 0)
    updateUserSettings({ defaults: { workflow: 'plan' } }, { path })
    assert.equal(readUserSettings({ path }).defaults?.workflow, 'plan')
    assert.equal(readUserSettings({ path }).defaults?.review, boundary === 'after-rename' ? 'thorough' : undefined)
    assert.deepEqual(staged(), abandoned)
    assert.equal(markerPresent(path), false)
  })
}

test('invalid settings preserve the current bytes and release the writer lease', t => {
  const path = fixture(t)
  const before = readFileSync(path, 'utf8')
  assert.throws(() => updateUserSettings({ defaults: { workflow: 'invalid' } } as never, { path }), /Invalid Babel preference update/)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.equal(markerPresent(path), false)
  child(path, 'retry', 0)
  assert.equal(readUserSettings({ path }).defaults?.review, 'thorough')
})

test('an unidentified marker blocks settings mutation without reporting success or discarding the marker', t => {
  const path = fixture(t)
  const before = readFileSync(path, 'utf8')
  const marker = `${path}.babel-lock`
  writeFileSync(marker, 'unidentified owner', { flag: 'wx', mode: 0o600 })
  let entered = false
  assert.throws(() => updateUserSettings(() => {
    entered = true
    return { defaults: { workflow: 'plan' } }
  }, { path }), /If the lock persists, preserve the ownership record/)
  assert.equal(entered, false)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.equal(readFileSync(marker, 'utf8'), 'unidentified owner')
})

test('preview is read-only and a committed named account preserves independent profile preferences', t => {
  const path = fixture(t)
  const accounts = {
    personal: { id: 'personal', provider: 'openrouter' as const, model: 'Example/Personal' },
    office: { id: 'office', provider: 'openrouter' as const, model: 'Example/Office', apiKeyEnvVar: 'FIXTURE_OFFICE_KEY_REF' },
  }
  const initial = {
    schemaVersion: 1,
    connections: accounts,
    defaults: { connection: 'personal', model: accounts.personal.model, budgetUsd: 2 },
    projects: { workspace: { connection: 'personal' } },
  }
  writeFileSync(path, JSON.stringify(initial))
  const change = { defaults: { connection: 'office', model: accounts.office.model } }
  const before = readFileSync(path, 'utf8')
  const preview = prepareUserSettingsUpdate(readUserSettings({ path }), change)
  assert.equal(preview.defaults?.connection, 'office')
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.deepEqual(readdirSync(dirname(path)), [basename(path)])
  const saved = updateUserSettings(change, { path })
  child(path, 'retry', 0)
  const latest = readUserSettings({ path })
  assert.deepEqual(saved.connections, accounts)
  assert.deepEqual(latest.connections, accounts)
  assert.deepEqual(latest.projects, initial.projects)
  const effective = resolveEffectiveSettings({ settings: latest, env: {} })
  assert.equal(effective.connection.value?.id, 'office')
  assert.equal(effective.model.value, 'Example/Office')
  assert.equal(effective.budgetUsd.value, 2)
  assert.equal(effective.review.value, 'thorough')
  assert.equal(markerPresent(path), false)
})
