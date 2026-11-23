import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { prepareProfileAccountKey, readProviderKeyReference } from './providerAccountKeys.js'
import { readUserSettings, updateUserSettings, userSettingsPath } from './userSettings.js'
import { CompatibleApiRunner } from '../runners/compatibleApi.js'
import { buildProviderRouteReport } from '../runners/providerRouteReport.js'

const key = 'synthetic-compatible-fixture-key'
const baseUrl = 'https://fixtures.example/v1'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'babel-account-file-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    BABEL_CONFIG_DIR: join(root, 'config'), BABEL_STATE_DIR: join(root, 'state') }
  const project = join(root, 'workspace')
  mkdirSync(project)
  return { root, env, project, path: join(env.BABEL_CONFIG_DIR, '.env.accounts') }
}

test('compatible account keys resolve only at their saved endpoint, including its base path', t => {
  const { env, project } = fixture(t)
  const entry = prepareProfileAccountKey('openai-compatible', baseUrl, key, env, project)
  entry.commitWith(() => {})
  const options = { env, apiKeyEnvVar: entry.reference }
  assert.equal(readProviderKeyReference('openai-compatible', entry.reference, env, `${baseUrl}/`) === key, true)
  assert.equal(Boolean(readProviderKeyReference('openai-compatible', entry.reference, env)), false)
  assert.doesNotThrow(() => new CompatibleApiRunner('fixture-model', { ...options, baseUrl }))
  for (const changed of ['https://elsewhere.example/v1', 'https://fixtures.example/other']) {
    assert.throws(() => new CompatibleApiRunner('fixture-model', { ...options, baseUrl: changed }), { code: 'PROVIDER_CREDENTIAL_MISSING' })
    const report = buildProviderRouteReport({ ...options, provider: 'openai-compatible', model: 'fixture-model', baseUrl: changed })
    assert.equal(report.credential.present, false)
  }
})

test('failed preference rename removes a new key or restores the previous store', t => {
  for (const existing of [false, true]) {
    const { env, project, path } = fixture(t)
    const previous = prepareProfileAccountKey('openrouter', undefined, 'synthetic-previous-account-key', env, project)
    if (existing) previous.commitWith(() => {})
    const entry = prepareProfileAccountKey('openrouter', undefined, key, env, project)
    const prefPath = userSettingsPath(env)
    assert.throws(() => updateUserSettings({
      connections: { named: { id: 'named', provider: 'openrouter', apiKeyEnvVar: entry.reference } },
    }, {
      env,
      commitWith: commit => entry.commitWith(() => {
        // A real rename failure, after the new private key was installed.
        assert.equal(readProviderKeyReference('openrouter', entry.reference, env) === key, true)
        mkdirSync(prefPath)
        try { commit() } finally { rmdirSync(prefPath) }
      }),
    }))
    assert.equal(Object.hasOwn(readUserSettings({ env }).connections, 'named'), false)
    assert.equal(existsSync(path), existing)
    assert.equal(Boolean(readProviderKeyReference('openrouter', entry.reference, env)), false)
    assert.equal(Boolean(readProviderKeyReference('openrouter', previous.reference, env)), existing)
    assert.equal(readdirSync(env.BABEL_STATE_DIR).length, 0)
    assert.equal(readdirSync(env.BABEL_CONFIG_DIR).length, existing ? 1 : 0)
  }
})

test('a non-regular credential destination is never opened or replaced', t => {
  const { root, env, project, path } = fixture(t)
  const entry = prepareProfileAccountKey('openrouter', undefined, key, env, project)
  mkdirSync(env.BABEL_CONFIG_DIR)
  const target = join(root, 'linked-directory')
  mkdirSync(target)
  writeFileSync(join(target, 'keep'), 'existing bytes')
  symlinkSync(target, path, 'junction')
  let committed = false
  assert.throws(() => entry.commitWith(() => { committed = true }), /unsafe/)
  assert.equal(committed, false)
  assert.equal(existsSync(join(path, 'keep')), true)
})
