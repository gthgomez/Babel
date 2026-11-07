import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverProject, discoverProjectGuarded } from './prePlanningDiscovery.js'

test('discovery preview does not read a replacement after its stat', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-discovery-read-race-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project)
    const source = join(project, 'source.txt'); const replacement = join(root, 'replacement.txt')
    fs.writeFileSync(source, 'safe source'); fs.writeFileSync(replacement, 'SYNTHETIC_OUTSIDE_PREVIEW')
    const original = fs.lstatSync; let swapped = false
    t.mock.method(fs, 'lstatSync', ((...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args)
      if (!swapped && args[0] === source) { swapped = true; fs.renameSync(source, `${source}.old`); fs.renameSync(replacement, source) }
      return result
    }) as typeof fs.lstatSync)
    syncBuiltinESMExports()
    const inventory = await discoverProjectGuarded(project)
    assert.equal(swapped, true)
    assert.doesNotMatch(JSON.stringify(inventory), /SYNTHETIC_OUTSIDE_PREVIEW/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('legacy synchronous discovery is explicitly rejected', () => {
  assert.throws(() => discoverProject('.'), /synchronous discovery.*unavailable/i)
})

test('guarded discovery retains bounded in-project files and previews', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-discovery-'))
  try {
    fs.mkdirSync(join(root, 'src')); fs.writeFileSync(join(root, 'src', 'safe.txt'), 'safe source')
    const inventory = await discoverProjectGuarded(root)
    assert.ok(inventory)
    assert.ok(inventory.fileTree.includes('src/safe.txt'))
    assert.equal(inventory.sourceFiles.find(item => item.path === 'src/safe.txt')?.preview, 'safe source')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded discovery excludes outside names on a directory swap-and-restore', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-discovery-race-'))
  try {
    const project = join(root, 'project'); const source = join(project, 'src'); const outside = join(root, 'outside')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(source, 'safe.txt'), 'safe'); fs.writeFileSync(join(outside, 'SYNTHETIC_PRIVATE_NAME'), 'private')
    const original = fs.opendirSync; let attempted = false
    t.mock.method(fs, 'opendirSync', ((...args: unknown[]) => {
      if (!attempted && typeof args[0] === 'string' && (args[0] === source || /^\/(?:proc\/self|dev)\/fd\//.test(args[0]))) {
        attempted = true; const backup = join(project, 'src-before')
        fs.renameSync(source, backup); fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
        try { return Reflect.apply(original, fs, args) }
        finally { fs.unlinkSync(source); fs.renameSync(backup, source) }
      }
      return Reflect.apply(original, fs, args)
    }) as typeof fs.opendirSync)
    syncBuiltinESMExports()
    const inventory = await discoverProjectGuarded(project)
    assert.equal(attempted, true)
    assert.doesNotMatch(JSON.stringify(inventory), /SYNTHETIC_PRIVATE_NAME/)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('cancelled discovery settles and releases its directory handles', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-discovery-abort-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'safe.txt'), 'safe')
    const controller = new AbortController()
    const pending = discoverProjectGuarded(project, controller.signal)
    controller.abort()
    await assert.rejects(pending, /abort/i)
    fs.renameSync(project, join(root, 'released'))
    assert.equal(fs.existsSync(join(root, 'released', 'safe.txt')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded discovery reports bounded enumeration of protected entries', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-discovery-bound-'))
  try {
    for (let index = 0; index < 405; index++) fs.writeFileSync(join(root, `.env.fixture-${index}`), 'SYNTHETIC_PRIVATE_VALUE')
    const inventory = await discoverProjectGuarded(root)
    assert.ok(inventory)
    assert.equal(inventory.truncated, true)
    assert.equal(inventory.fileTree.length, 0)
    assert.doesNotMatch(JSON.stringify(inventory), /SYNTHETIC_PRIVATE_VALUE/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('discovery rejects inventory if its owned Windows guard dies during enumeration', async t => {
  if (process.platform !== 'win32') { t.skip('Windows directory helper'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-discovery-guard-exit-'))
  const opendir = fs.opendirSync; const spawn = childProcess.spawn
  let helper: ReturnType<typeof childProcess.spawn> | undefined
  try {
    fs.writeFileSync(join(root, 'safe.txt'), 'safe')
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => { const child = spawn(...args); helper = child; return child }) as typeof childProcess.spawn
    fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
      const dir = opendir(...args); const read = dir.readSync.bind(dir); let started = false
      dir.readSync = () => { if (!started) { started = true; assert.ok(helper?.pid); process.kill(helper.pid) }; return read() }
      return dir
    }) as typeof fs.opendirSync
    syncBuiltinESMExports()
    await assert.rejects(discoverProjectGuarded(root), /EFFECT_DIRECTORY_ANCHOR_LOST/)
  } finally { childProcess.spawn = spawn; fs.opendirSync = opendir; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('discovery preview holds its parent directory during the real file open', async t => {
  if (process.platform !== 'win32') { t.skip('Windows directory sharing semantics'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-discovery-preview-anchor-'))
  try {
    const parent = join(root, 'src'); const source = join(parent, 'safe.txt'); fs.mkdirSync(parent); fs.writeFileSync(source, 'safe preview')
    const original = fs.openSync; let attempted = false; let renamed = false
    t.mock.method(fs, 'openSync', ((path: fs.PathLike, ...args: unknown[]) => {
      if (!attempted && String(path).toLowerCase() === source.toLowerCase()) {
        attempted = true
        try { fs.renameSync(parent, join(root, 'moved')); renamed = true; fs.renameSync(join(root, 'moved'), parent) }
        catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      }
      return original(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    const inventory = await discoverProjectGuarded(root)
    assert.equal(attempted, true)
    assert.equal(renamed, false, 'preview parent must remain pinned during its file open')
    assert.equal(inventory?.sourceFiles.find(item => item.path === 'src/safe.txt')?.preview, 'safe preview')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('discovery rejects all previews if its owned Windows preview guard dies', async t => {
  if (process.platform !== 'win32') { t.skip('Windows directory helper'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-discovery-preview-guard-exit-'))
  const open = fs.openSync; const spawn = childProcess.spawn
  let helper: ReturnType<typeof childProcess.spawn> | undefined; let killed = false
  try {
    const parent = join(root, 'src'); const source = join(parent, 'safe.txt'); fs.mkdirSync(parent); fs.writeFileSync(source, 'safe preview')
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => { const child = spawn(...args); helper = child; return child }) as typeof childProcess.spawn
    fs.openSync = ((path: fs.PathLike, ...args: unknown[]) => {
      if (!killed && String(path).toLowerCase() === source.toLowerCase()) { killed = true; assert.ok(helper?.pid); process.kill(helper.pid) }
      return open(path, ...(args as [fs.OpenMode]))
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    await assert.rejects(discoverProjectGuarded(root), /EFFECT_DIRECTORY_ANCHOR_LOST/)
    assert.equal(killed, true)
  } finally { childProcess.spawn = spawn; fs.openSync = open; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})
