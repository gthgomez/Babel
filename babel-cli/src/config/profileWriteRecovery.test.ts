import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs, { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, type Mode, type OpenMode, type PathLike } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { prepareProfileAccountKey } from './providerAccountKeys.js'
import { readUserSettings, updateUserSettings } from './userSettings.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-profile-crash-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    BABEL_CONFIG_DIR: join(root, 'config'), BABEL_STATE_DIR: join(root, 'state'), BABEL_PROJECT_ROOT: project }
  return { root, project, env, settingsPath: join(root, 'state', 'preferences.json') }
}

function crashIn(source: string, env: NodeJS.ProcessEnv) {
  const child = spawnSync(process.execPath,
    ['--import', 'tsx', '--import', './src/testinfra/register-no-ambient-inference.mjs', '--input-type=module', '-e', source],
    { cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(child.status, 17, `child must reach the injected crash point (error: ${(child.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'}, signal: ${child.signal ?? 'none'})`)
}

test('preferences can be updated after their writer exits while holding the lock', () => {
  const f = fixture()
  try {
    const moduleUrl = pathToFileURL(resolve('src/config/userSettings.ts')).href
    crashIn(`import { updateUserSettings } from ${JSON.stringify(moduleUrl)}; updateUserSettings(() => process.exit(17));`, f.env)
    updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env })
    assert.equal(readUserSettings({ env: f.env }).defaults?.workflow, 'plan')
    assert.equal(existsSync(`${f.settingsPath}.babel-lock`), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a crash immediately after atomically publishing an owner marker is recoverable', () => {
  const f = fixture()
  try {
    const moduleUrl = pathToFileURL(resolve('src/config/userSettings.ts')).href
    const source = `import { updateUserSettings } from ${JSON.stringify(moduleUrl)};
      const fs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const original = fs.linkSync;
      fs.linkSync = (from, to) => { original(from, to); process.exit(17) };
      syncBuiltinESMExports(); updateUserSettings({ defaults: { workflow: 'work' } });`
    crashIn(source, f.env)
    updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env })
    assert.equal(readUserSettings({ env: f.env }).defaults?.workflow, 'plan')
    assert.equal(existsSync(`${f.settingsPath}.babel-lock`), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a crash before publishing an owner marker does not strand the lock', () => {
  const f = fixture()
  try {
    const moduleUrl = pathToFileURL(resolve('src/config/userSettings.ts')).href
    const source = `import { updateUserSettings } from ${JSON.stringify(moduleUrl)};
      const fs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      fs.linkSync = () => process.exit(17);
      syncBuiltinESMExports(); updateUserSettings({ defaults: { workflow: 'work' } });`
    crashIn(source, f.env)
    updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env })
    assert.equal(readUserSettings({ env: f.env }).defaults?.workflow, 'plan')
    assert.equal(existsSync(`${f.settingsPath}.babel-lock`), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an interrupted unsupported-filesystem fallback preserves an unrecognized directory', () => {
  const f = fixture()
  try {
    const moduleUrl = pathToFileURL(resolve('src/config/userSettings.ts')).href
    const source = `import { updateUserSettings } from ${JSON.stringify(moduleUrl)};
      const fs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const original = fs.openSync;
      fs.linkSync = () => { throw Object.assign(new Error('Unsupported link'), { code: 'ENOTSUP' }) };
      fs.openSync = (path, flags, ...rest) => { if (String(path).includes('.babel-lock/owner-')) process.exit(17); return original(path, flags, ...rest) };
      syncBuiltinESMExports(); updateUserSettings({ defaults: { workflow: 'work' } });`
    crashIn(source, f.env)
    const marker = `${f.settingsPath}.babel-lock`
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env }))
    assert.equal(statSync(marker).isDirectory(), true)
    assert.equal(readdirSync(marker).length, 0)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('account writers recover their lock after process exit', () => {
  const f = fixture()
  try {
    const moduleUrl = pathToFileURL(resolve('src/config/providerAccountKeys.ts')).href
    crashIn(`import { prepareProfileAccountKey } from ${JSON.stringify(moduleUrl)}; prepareProfileAccountKey('openrouter', undefined, 'synthetic-first-fixture-key', process.env, process.env.BABEL_PROJECT_ROOT).commitWith(() => process.exit(17));`, f.env)
    const entry = prepareProfileAccountKey('openrouter', undefined, 'synthetic-second-fixture-key', f.env, f.project)
    let committed = false
    entry.commitWith(() => { committed = true })
    assert.equal(committed, true)
    assert.equal(existsSync(join(f.env.BABEL_CONFIG_DIR, '.env.accounts.babel-lock')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('unidentified legacy locks remain untouched', () => {
  const f = fixture()
  try {
    mkdirSync(f.env.BABEL_STATE_DIR, { recursive: true })
    const lock = `${f.settingsPath}.babel-lock`
    writeFileSync(lock, '', { flag: 'wx' })
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'work' } }, { env: f.env }))
    assert.equal(existsSync(lock), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an unrecognized marker directory is not removed on repeated attempts', () => {
  const f = fixture()
  try {
    mkdirSync(f.env.BABEL_STATE_DIR, { recursive: true })
    const marker = `${f.settingsPath}.babel-lock`
    mkdirSync(marker)
    for (let i = 0; i < 2; i++) {
      assert.throws(() => updateUserSettings({ defaults: { workflow: 'work' } }, { env: f.env }))
      assert.equal(statSync(marker).isDirectory(), true)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an initialized guard never removes an unrecognized marker directory', () => {
  const f = fixture()
  try {
    updateUserSettings({ defaults: { workflow: 'work' } }, { env: f.env })
    const marker = `${f.settingsPath}.babel-lock`
    mkdirSync(marker)
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env }))
    assert.equal(statSync(marker).isDirectory(), true)
    assert.equal(readUserSettings({ env: f.env }).defaults?.workflow, 'work')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a marker with an unrelated owner file is preserved', () => {
  const f = fixture()
  try {
    updateUserSettings({ defaults: { workflow: 'work' } }, { env: f.env })
    const marker = `${f.settingsPath}.babel-lock`
    mkdirSync(marker)
    const unrelated = join(marker, `owner-${'a'.repeat(32)}`)
    writeFileSync(unrelated, '', { flag: 'wx', mode: 0o600 })
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env }))
    assert.equal(existsSync(unrelated), true)
    assert.equal(readUserSettings({ env: f.env }).defaults?.workflow, 'work')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an uninitialized guard is preserved and does not authorize recovery', () => {
  const f = fixture()
  try {
    mkdirSync(f.env.BABEL_STATE_DIR, { recursive: true })
    const guard = `${f.settingsPath}.babel-lock.sqlite`
    writeFileSync(guard, '', { flag: 'wx', mode: 0o600 })
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'work' } }, { env: f.env }), /ownership record is unavailable/)
    assert.equal(statSync(guard).size, 0)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an old writer arriving during guard creation cannot strand the new protocol', () => {
  const f = fixture()
  const marker = `${f.settingsPath}.babel-lock`
  const guard = `${marker}.sqlite`
  const originalOpen = fs.openSync
  let injected = false
  mkdirSync(f.env.BABEL_STATE_DIR, { recursive: true })
  try {
    fs.openSync = ((path: PathLike, flags: OpenMode, mode?: Mode) => {
      const fd = originalOpen(path, flags, mode)
      if (!injected && String(path) === guard && flags === 'wx') {
        injected = true
        writeFileSync(marker, '', { flag: 'wx' })
      }
      return fd
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'work' } }, { env: f.env }), /locked by another writer/)
    fs.openSync = originalOpen
    syncBuiltinESMExports()
    assert.equal(injected, true)
    assert.equal(existsSync(marker), true)
    assert.equal(existsSync(guard), false)
    rmSync(marker)
    updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env })
    assert.equal(readUserSettings({ env: f.env }).defaults?.workflow, 'plan')
  } finally {
    fs.openSync = originalOpen
    syncBuiltinESMExports()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('new markers exclude legacy writers and never follow a marker junction', () => {
  const f = fixture()
  try {
    const marker = `${f.settingsPath}.babel-lock`
    updateUserSettings(() => {
      assert.throws(() => { const fd = openSync(marker, 'wx'); closeSync(fd) }, { code: 'EEXIST' })
      return { defaults: { workflow: 'work' } }
    }, { env: f.env })
    const target = join(f.root, 'other-directory')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'fixture')
    symlinkSync(target, marker, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env }))
    assert.equal(existsSync(join(target, 'keep')), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an active writer excludes another process, then a crashed writer can be replaced', async () => {
  const f = fixture()
  const moduleUrl = pathToFileURL(resolve('src/config/userSettings.ts')).href
  const source = `import { updateUserSettings } from ${JSON.stringify(moduleUrl)}; updateUserSettings(() => { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); return {}; });`
  const child = spawn(process.execPath,
    ['--import', 'tsx', '--import', './src/testinfra/register-no-ambient-inference.mjs', '--input-type=module', '-e', source],
    { cwd: process.cwd(), env: f.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = new Promise<void>(resolveExit => {
    child.once('exit', () => resolveExit())
    child.once('error', () => resolveExit())
  })
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('writer did not acquire its lock')), 20_000)
      child.stdout.once('data', () => { clearTimeout(timer); resolveReady() })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('writer exited before signalling lock ownership')) })
    })
    assert.throws(() => updateUserSettings({ defaults: { workflow: 'work' } }, { env: f.env }), /locked by another writer/)
    child.kill()
    await exited
    updateUserSettings({ defaults: { workflow: 'plan' } }, { env: f.env })
    assert.equal(readUserSettings({ env: f.env }).defaults?.workflow, 'plan')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    rmSync(f.root, { recursive: true, force: true })
  }
})
