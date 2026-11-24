import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { readUserSettings, updateUserSettings, userSettingsPath, type UserSettingsCommitContext } from './userSettings.js'
import { prepareProfileAccountKey, readProviderKeyReference, recoverProfileAccountTransaction } from './providerAccountKeys.js'
import { runProviderSetup } from '../services/providerSetup.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-account-transaction-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    BABEL_CONFIG_DIR: join(root, 'config'), BABEL_STATE_DIR: join(root, 'state'), BABEL_PROJECT_ROOT: project }
  return { root, project, env, account: join(root, 'config', '.env.accounts'), journal: `${userSettingsPath(env)}.account-transaction` }
}

function crashDuringSetup(f: ReturnType<typeof fixture>, point: 'before-settings' | 'after-settings' | 'before-account-rename', provider: 'openrouter' | 'openai-compatible' = 'openrouter') {
  const settings = pathToFileURL(resolve('src/config/userSettings.ts')).href
  const accounts = pathToFileURL(resolve('src/config/providerAccountKeys.ts')).href
  const accountPath = JSON.stringify(f.account)
  const injectRename = point === 'before-account-rename' ? `
    const fs = (await import('node:fs')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const original = fs.renameSync;
    fs.renameSync = (from, to) => { if (String(to) === ${accountPath}) process.exit(17); return original(from, to) };
    syncBuiltinESMExports();` : ''
  const callback = point === 'after-settings' ? 'commit(); process.exit(17)' : 'process.exit(17)'
  const baseUrl = provider === 'openai-compatible' ? 'https://fixture.example/v1' : undefined
  const connection = { id: 'named', provider, ...(baseUrl ? { baseUrl } : {}) }
  const source = `import { updateUserSettings } from ${JSON.stringify(settings)};
    import { prepareProfileAccountKey } from ${JSON.stringify(accounts)};
    ${injectRename}
    const entry = prepareProfileAccountKey(${JSON.stringify(provider)}, ${JSON.stringify(baseUrl)}, 'synthetic-transaction-fixture-key', process.env, process.env.BABEL_PROJECT_ROOT);
    updateUserSettings({ connections: { named: { ...${JSON.stringify(connection)}, apiKeyEnvVar: entry.reference } } },
      { env: process.env, commitWith: (commit, context) => entry.commitWith(() => { ${callback} }, context) });`
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '--import', './src/testinfra/register-no-ambient-inference.mjs', '--input-type=module', '-e', source],
    { cwd: process.cwd(), env: f.env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(child.status, 17, `child must reach the injected transaction crash (error: ${(child.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'}, signal: ${child.signal ?? 'none'})`)
}

test('an account staged before preferences commit is removed on recovery', () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'before-settings')
    assert.equal(existsSync(f.account), true)
    assert.equal(Object.hasOwn(readUserSettings({ env: f.env }).connections, 'named'), false)
    assert.equal(recoverProfileAccountTransaction(f.env, f.project), true)
    assert.equal(existsSync(f.account), false)
    assert.equal(existsSync(f.journal), false)
    assert.equal(readdirSync(f.env.BABEL_STATE_DIR).some(name => name.endsWith('.tmp')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a committed connection and account survive recovery after a crash', () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'after-settings')
    assert.equal(Object.hasOwn(readUserSettings({ env: f.env }).connections, 'named'), true)
    assert.equal(recoverProfileAccountTransaction(f.env, f.project), true)
    assert.equal(existsSync(f.account), true)
    assert.equal(Object.hasOwn(readUserSettings({ env: f.env }).connections, 'named'), true)
    assert.equal(existsSync(f.journal), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('recovery refuses a committed account with an altered endpoint binding', () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'after-settings', 'openai-compatible')
    const reference = readUserSettings({ env: f.env }).connections['named']?.apiKeyEnvVar
    assert.ok(reference)
    writeFileSync(f.account, `${reference}=synthetic-transaction-fixture-key\n${reference}_ENDPOINT=${'f'.repeat(64)}\n`, { mode: 0o600 })
    assert.throws(() => recoverProfileAccountTransaction(f.env, f.project))
    assert.equal(existsSync(f.journal), true)
    assert.equal(Object.hasOwn(readUserSettings({ env: f.env }).connections, 'named'), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('recovery refuses a committed connection whose endpoint changed', () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'after-settings', 'openai-compatible')
    const saved = readUserSettings({ env: f.env }).connections['named']
    assert.ok(saved)
    updateUserSettings({ connections: { named: { ...saved, baseUrl: 'https://different.example/v1' } } }, { env: f.env })
    assert.throws(() => recoverProfileAccountTransaction(f.env, f.project))
    assert.equal(existsSync(f.journal), true)
    assert.equal(readUserSettings({ env: f.env }).connections['named']?.baseUrl, 'https://different.example/v1')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('recovery refuses a committed connection whose provider changed', () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'after-settings')
    const saved = readUserSettings({ env: f.env }).connections['named']
    assert.ok(saved)
    updateUserSettings({ connections: { named: { ...saved, provider: 'anthropic' } } }, { env: f.env })
    assert.throws(() => recoverProfileAccountTransaction(f.env, f.project))
    assert.equal(existsSync(f.journal), true)
    assert.equal(readUserSettings({ env: f.env }).connections['named']?.provider, 'anthropic')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a crash before the account rename removes the owned temporary file', () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'before-account-rename')
    assert.equal(existsSync(f.account), false)
    assert.equal(readdirSync(f.env.BABEL_CONFIG_DIR).some(name => name.endsWith('.tmp')), true)
    assert.equal(recoverProfileAccountTransaction(f.env, f.project), true)
    assert.equal(readdirSync(f.env.BABEL_CONFIG_DIR).some(name => name.endsWith('.tmp')), false)
    assert.equal(existsSync(f.journal), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('unrecognized recovery records are preserved and fail closed', () => {
  const f = fixture()
  try {
    mkdirSync(f.env.BABEL_STATE_DIR, { recursive: true })
    writeFileSync(f.journal, 'unrecognized', { flag: 'wx', mode: 0o600 })
    assert.throws(() => recoverProfileAccountTransaction(f.env, f.project))
    assert.equal(existsSync(f.journal), true)
    assert.equal(existsSync(f.account), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a pending record cannot be applied to a different account profile', () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'before-settings')
    const otherEnv = { ...f.env, BABEL_CONFIG_DIR: join(f.root, 'different-config') }
    assert.throws(() => recoverProfileAccountTransaction(otherEnv, f.project))
    assert.equal(existsSync(f.journal), true)
    assert.equal(existsSync(f.account), true)
    assert.equal(existsSync(otherEnv.BABEL_CONFIG_DIR), false)
    assert.equal(recoverProfileAccountTransaction(f.env, f.project), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('setup recovers a pending account before offering the next steps', async () => {
  const f = fixture()
  try {
    crashDuringSetup(f, 'before-settings')
    let output = ''
    const result = await runProviderSetup({ env: f.env, projectRoot: f.project, interactive: false, write: text => { output += text } })
    assert.equal(result.failed, undefined)
    assert.match(output, /recovered an interrupted account update/i)
    assert.equal(output.includes('synthetic-transaction-fixture-key'), false)
    assert.equal(existsSync(f.account), false)
    assert.equal(existsSync(f.journal), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('interrupted recovery can be repeated without losing a previous account', () => {
  const f = fixture()
  try {
    const prior = prepareProfileAccountKey('openrouter', undefined, 'synthetic-prior-account-key', f.env, f.project)
    prior.commitWith(() => {})
    updateUserSettings({ connections: { prior: { id: 'prior', provider: 'openrouter', apiKeyEnvVar: prior.reference } } }, { env: f.env })
    crashDuringSetup(f, 'before-settings')
    const accounts = pathToFileURL(resolve('src/config/providerAccountKeys.ts')).href
    const source = `import { recoverProfileAccountTransaction } from ${JSON.stringify(accounts)};
      const fs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const original = fs.renameSync;
      fs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(f.account)}) process.exit(17); return original(from, to) };
      syncBuiltinESMExports(); recoverProfileAccountTransaction(process.env, process.env.BABEL_PROJECT_ROOT);`
    const child = spawnSync(process.execPath,
      ['--import', 'tsx', '--import', './src/testinfra/register-no-ambient-inference.mjs', '--input-type=module', '-e', source],
      { cwd: process.cwd(), env: f.env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    assert.equal(child.status, 17, `recovery must reach the injected crash (error: ${(child.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'}, signal: ${child.signal ?? 'none'})`)
    assert.equal(existsSync(f.journal), true)
    assert.equal(recoverProfileAccountTransaction(f.env, f.project), true)
    assert.equal(Boolean(readProviderKeyReference('openrouter', prior.reference, f.env)), true)
    assert.equal(Object.hasOwn(readUserSettings({ env: f.env }).connections, 'prior'), true)
    assert.equal(Object.hasOwn(readUserSettings({ env: f.env }).connections, 'named'), false)
    assert.equal(existsSync(f.journal), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a fabricated or expired commit context cannot authorize a transaction', () => {
  const f = fixture()
  try {
    const entry = prepareProfileAccountKey('openrouter', undefined, 'synthetic-context-fixture-key', f.env, f.project)
    const path = userSettingsPath(f.env)
    const fake = { path, temporary: `${path}.00000000-0000-0000-0000-000000000000.tmp` }
    assert.throws(() => entry.commitWith(() => {}, fake))
    assert.equal(existsSync(f.account), false)
    let expired: UserSettingsCommitContext | undefined
    updateUserSettings({}, { env: f.env, commitWith: (commit, context) => { expired = context; commit() } })
    assert.ok(expired)
    assert.throws(() => entry.commitWith(() => {}, expired))
    assert.equal(existsSync(f.account), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a pre-existing temporary path is preserved rather than treated as owned', () => {
  const f = fixture()
  const original = crypto.randomUUID
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'] as const
  let index = 0
  try {
    crypto.randomUUID = (() => ids[index++] ?? (() => { throw new Error('Unexpected identifier request') })()) as typeof crypto.randomUUID
    syncBuiltinESMExports()
    const entry = prepareProfileAccountKey('openrouter', undefined, 'synthetic-collision-fixture-key', f.env, f.project)
    mkdirSync(f.env.BABEL_CONFIG_DIR, { recursive: true })
    const occupied = `${f.account}.${ids[2]}.tmp`
    writeFileSync(occupied, 'fixture-owned-data', { flag: 'wx', mode: 0o600 })
    assert.throws(() => updateUserSettings({ connections: { named: { id: 'named', provider: 'openrouter', apiKeyEnvVar: entry.reference } } },
      { env: f.env, commitWith: entry.commitWith }))
    assert.equal(existsSync(occupied), true)
    assert.equal(statSync(occupied).size, 'fixture-owned-data'.length)
    assert.equal(existsSync(f.journal), false)
  } finally {
    crypto.randomUUID = original
    syncBuiltinESMExports()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('a failed account flush leaves no staged key file and can be recovered', () => {
  const f = fixture()
  const original = fs.fsyncSync
  let journalFlushed = false
  let injected = false
  try {
    const entry = prepareProfileAccountKey('openrouter', undefined, 'synthetic-flush-fixture-key', f.env, f.project)
    fs.fsyncSync = ((fd: number) => {
      if (existsSync(f.journal)) {
        if (journalFlushed) {
          injected = true
          throw Object.assign(new Error('Injected flush failure'), { code: 'EIO' })
        }
        journalFlushed = true
      }
      return original(fd)
    }) as typeof fs.fsyncSync
    syncBuiltinESMExports()
    assert.throws(() => updateUserSettings({ connections: { named: { id: 'named', provider: 'openrouter', apiKeyEnvVar: entry.reference } } },
      { env: f.env, commitWith: entry.commitWith }))
    fs.fsyncSync = original
    syncBuiltinESMExports()
    assert.equal(injected, true)
    assert.equal(existsSync(f.account), false)
    assert.equal(readdirSync(f.env.BABEL_CONFIG_DIR).some(name => name.endsWith('.tmp')), false)
    assert.equal(existsSync(f.journal), true)
    assert.equal(recoverProfileAccountTransaction(f.env, f.project), true)
    assert.equal(existsSync(f.journal), false)
  } finally {
    fs.fsyncSync = original
    syncBuiltinESMExports()
    rmSync(f.root, { recursive: true, force: true })
  }
})
