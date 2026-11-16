import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedConnectionService } from './sharedConnectionService.js'
import { createSharedCredentialStore, type CredentialBackend } from './sharedCredentialStore.js'
import { resolveConnectionModelPolicy } from './connectionModelPolicy.js'
import { readUserSettings, userSettingsPath } from './userSettings.js'
import { resolveProviderCredential } from '../runners/credentialHub.js'
import { resolveChatModelPolicy } from '../agent/chatModelPolicy.js'

test('Desktop and CLI share one synthetic account through replacement and removal', async () => {
  // Dynamic URLs keep Desktop's plain ESM outside the CLI TypeScript build root.
  const desktopUrl = new URL('../../../babel-desktop/native/credentials.mjs', import.meta.url).href
  const fixtureUrl = new URL('../../../babel-desktop/test/credential-fixture.mjs', import.meta.url).href
  const desktop = await import(desktopUrl)
  const { fixtureProtection } = await import(fixtureUrl)
  const root = mkdtempSync(join(tmpdir(), 'babel-desktop-shared-integration-'))
  assert.equal(desktop.sharedUserPreferencesPath({ USERPROFILE: root }, root), userSettingsPath({ USERPROFILE: root }))
  const path = join(root, 'preferences.json'), configDirectory = join(root, 'config')
  const values = new Map<string, string>(); let next = 0
  const backend: CredentialBackend = { get: id => values.get(id) ?? null, set: (id, value) => { values.set(id, value) }, remove: id => values.delete(id) }
  const store = createSharedCredentialStore(backend, () => `${String(++next).padStart(8, '0')}-1111-4111-8111-111111111111`)
  const service = createSharedConnectionService({ path, store: () => store })
  desktop.configureCredentialProtection(fixtureProtection)
  desktop.configureSharedCredentialService(service)
  desktop.saveProviderCredential({ provider: 'openrouter', apiKey: 'fixtureKey01', configDirectory })
  const shared = desktop.shareProviderCredential({ provider: 'openrouter', model: 'vendor/model', configDirectory, confirm: true })
  const selected = () => resolveConnectionModelPolicy(undefined, { settings: readUserSettings({ path }) })!
  const envNames = ['BABEL_PREFERENCES_FILE', 'BABEL_CONNECTION', 'BABEL_MODEL', 'BABEL_DESKTOP_PROVIDER', 'BABEL_DESKTOP_MODEL_ROUTE', 'BABEL_DESKTOP_IPC', 'BABEL_OFFLINE'] as const
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
  try {
    process.env.BABEL_PREFERENCES_FILE = path; process.env.BABEL_CONNECTION = shared.connectionId; process.env.BABEL_MODEL = 'vendor/model'; process.env.BABEL_DESKTOP_IPC = '1'
    delete process.env.BABEL_DESKTOP_PROVIDER; delete process.env.BABEL_DESKTOP_MODEL_ROUTE; delete process.env.BABEL_OFFLINE
    const policy = resolveChatModelPolicy({}).policy
    assert.equal(policy.provider, 'openrouter'); assert.equal(policy.providerModelId, 'vendor/model'); assert.equal(policy.credentialRef, selected().credentialRef)
  } finally {
    for (const name of envNames) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]
  }
  const credential = () => resolveProviderCredential('openrouter', { credentialRef: selected().credentialRef!, env: { OPENROUTER_API_KEY: 'wrong-account' }, readSharedCredential: ref => store.read(ref) })
  assert.equal(credential(), 'fixtureKey01')
  service.replace(shared.connectionId, 'openrouter', 'fixtureKey02')
  const env: Record<string, string> = {}
  desktop.applyNativeCredentialEnvironment(env, { provider: 'openrouter', configDirectory })
  assert.equal(env.OPENROUTER_API_KEY, 'fixtureKey02')
  assert.equal(credential(), 'fixtureKey02')
  desktop.removeProviderCredential({ provider: 'openrouter', scope: 'private', configDirectory })
  assert.throws(credential, /missing/i)
  desktop.applyNativeCredentialEnvironment(env, { provider: 'openrouter', configDirectory })
  assert.equal(env.OPENROUTER_API_KEY, undefined)
})
