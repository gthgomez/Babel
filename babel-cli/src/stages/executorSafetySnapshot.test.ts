import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hashProjectFileForEvidence, snapshotProjectFilesForSafety } from './executorHelpers.js'
import { guardedSafetySnapshot } from './guardedSafetySnapshot.js'

test('safety snapshot does not read dotenv or traverse an outside junction', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-safety-snapshot-'))
  try {
    const project = join(root, 'project'); const outside = join(root, 'outside')
    fs.mkdirSync(project); fs.mkdirSync(outside)
    const secret = join(project, '.env'); const external = join(outside, 'outside.txt')
    fs.writeFileSync(secret, 'SYNTHETIC_PRIVATE_VALUE'); fs.writeFileSync(external, 'SYNTHETIC_OUTSIDE_VALUE')
    fs.writeFileSync(join(project, 'safe.txt'), 'safe')
    fs.symlinkSync(outside, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const original = fs.readFileSync; const unsafeReads: string[] = []
    const originalOpen = fs.openSync
    t.mock.method(fs, 'readFileSync', ((...args: unknown[]) => {
      const path = String(args[0]).toLowerCase()
      if (path === secret.toLowerCase() || path.includes('linked') || path === external.toLowerCase()) unsafeReads.push(path)
      return Reflect.apply(original, fs, args)
    }) as typeof fs.readFileSync)
    t.mock.method(fs, 'openSync', ((...args: unknown[]) => {
      const path = String(args[0]).toLowerCase()
      if (path === secret.toLowerCase() || path.includes('linked') || path === external.toLowerCase()) unsafeReads.push(path)
      return Reflect.apply(originalOpen, fs, args)
    }) as typeof fs.openSync)
    syncBuiltinESMExports()
    const snapshot = await guardedSafetySnapshot(project)
    assert.deepEqual(unsafeReads, [])
    assert.equal(snapshot.truncated, true, 'omitted paths cannot prove full preservation')
    assert.ok(snapshot.files['safe.txt'])
    assert.equal(Object.hasOwn(snapshot.files, '.env'), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('unqualified safety snapshot reports incomplete evidence without scanning', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-snapshot-contained-'))
  try {
    fs.writeFileSync(join(root, '.env'), 'SYNTHETIC_PRIVATE_VALUE')
    const original = fs.readFileSync; let reads = 0
    t.mock.method(fs, 'readFileSync', ((...args: unknown[]) => { reads++; return Reflect.apply(original, fs, args) }) as typeof fs.readFileSync)
    syncBuiltinESMExports()
    const snapshot = snapshotProjectFilesForSafety(root)
    assert.equal(reads, 0)
    assert.equal(snapshot.truncated, true)
    assert.equal(snapshot.file_count, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('target evidence hashes never read dotenv or an outside junction', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-target-hash-private-'))
  try {
    const project = join(root, 'project'); const outside = join(root, 'outside')
    fs.mkdirSync(project); fs.mkdirSync(outside)
    fs.writeFileSync(join(project, '.env.local'), 'SYNTHETIC_PRIVATE_VALUE')
    fs.writeFileSync(join(project, 'safe.txt'), 'safe')
    fs.writeFileSync(join(outside, 'outside.txt'), 'SYNTHETIC_OUTSIDE_VALUE')
    fs.symlinkSync(outside, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const original = fs.readFileSync; let reads = 0
    t.mock.method(fs, 'readFileSync', ((...args: unknown[]) => { reads++; return Reflect.apply(original, fs, args) }) as typeof fs.readFileSync)
    syncBuiltinESMExports()
    assert.equal(hashProjectFileForEvidence(project, '.env.local'), null)
    assert.equal(hashProjectFileForEvidence(project, 'linked/outside.txt'), null)
    assert.equal(reads, 0)
    const safeHash = hashProjectFileForEvidence(project, 'safe.txt')
    assert.match(safeHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal(hashProjectFileForEvidence(project, join(project, 'safe.txt')), safeHash)
    assert.equal(hashProjectFileForEvidence(project, '/project/safe.txt'), safeHash)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded safety snapshot hashes safe files while omitting protected and linked paths', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-snapshot-'))
  try {
    const project = join(root, 'project'); const outside = join(root, 'outside')
    fs.mkdirSync(join(project, 'src'), { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(project, 'src', 'safe.txt'), 'safe')
    fs.writeFileSync(join(project, '.env'), 'SYNTHETIC_PRIVATE_VALUE')
    fs.writeFileSync(join(outside, 'outside.txt'), 'SYNTHETIC_OUTSIDE_VALUE')
    fs.symlinkSync(outside, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const snapshot = await guardedSafetySnapshot(project)
    assert.match(snapshot.files['src/safe.txt'] ?? '', /^[a-f0-9]{64}$/)
    assert.equal(snapshot.truncated, true)
    assert.equal(Object.hasOwn(snapshot.files, '.env'), false)
    assert.equal(Object.hasOwn(snapshot.files, 'linked/outside.txt'), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('complete guarded snapshots detect an in-project file change', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-snapshot-change-'))
  try {
    const file = join(root, 'safe.txt'); fs.writeFileSync(file, 'before')
    const before = await guardedSafetySnapshot(root)
    fs.writeFileSync(file, 'after')
    const after = await guardedSafetySnapshot(root)
    assert.equal(before.truncated, false); assert.equal(after.truncated, false)
    assert.notEqual(before.files['safe.txt'], after.files['safe.txt'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded snapshots distinguish a replaced project at the same path', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-snapshot-root-identity-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'same.txt'), 'same')
    const before = await guardedSafetySnapshot(project)
    fs.renameSync(project, join(root, 'old-project')); fs.mkdirSync(project); fs.writeFileSync(join(project, 'same.txt'), 'same')
    const after = await guardedSafetySnapshot(project)
    assert.ok(before.root_identity); assert.ok(after.root_identity)
    assert.notEqual(before.root_identity, after.root_identity)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded safety snapshot does not hash an outside swap-and-restore directory', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-guarded-snapshot-race-'))
  try {
    const project = join(root, 'project'); const source = join(project, 'src'); const outside = join(root, 'outside')
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(outside)
    fs.writeFileSync(join(source, 'safe.txt'), 'safe'); fs.writeFileSync(join(outside, 'SYNTHETIC_OUTSIDE_NAME'), 'private')
    const original = fs.opendirSync; let attempted = false
    t.mock.method(fs, 'opendirSync', ((...args: unknown[]) => {
      if (!attempted && typeof args[0] === 'string' && (args[0] === source || /^\/(?:proc\/self|dev)\/fd\//.test(args[0]))) {
        attempted = true; const backup = join(project, 'src-before')
        fs.renameSync(source, backup); fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
        // Keep the swap in place across the subsequent directory read so the
        // anchored snapshot must observe and reject it as truncated.
        return Reflect.apply(original, fs, args)
      }
      return Reflect.apply(original, fs, args)
    }) as typeof fs.opendirSync)
    syncBuiltinESMExports()
    const snapshot = await guardedSafetySnapshot(project)
    assert.equal(attempted, true)
    assert.doesNotMatch(JSON.stringify(snapshot), /SYNTHETIC_OUTSIDE_NAME/)
    assert.equal(snapshot.truncated, true)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('cancelled guarded safety snapshot releases directory ownership', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-snapshot-abort-'))
  try {
    const project = join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(join(project, 'safe.txt'), 'safe')
    const controller = new AbortController()
    const pending = guardedSafetySnapshot(project, controller.signal)
    controller.abort()
    await assert.rejects(pending, /abort/i)
    fs.renameSync(project, join(root, 'released'))
    assert.equal(fs.existsSync(join(root, 'released', 'safe.txt')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('guarded safety snapshot bounds directory enumeration even for omitted entries', async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-snapshot-entry-bound-'))
  try {
    for (let index = 0; index < 4105; index++) fs.writeFileSync(join(root, `.env.fixture-${index}`), 'SYNTHETIC_PRIVATE_VALUE')
    const original = fs.Dir.prototype.readSync; let reads = 0
    t.mock.method(fs.Dir.prototype, 'readSync', function (this: fs.Dir, ...args: unknown[]) { reads++; return Reflect.apply(original, this, args) } as typeof original)
    const snapshot = await guardedSafetySnapshot(root)
    assert.equal(snapshot.truncated, true)
    assert.equal(snapshot.file_count, 0)
    assert.ok(reads <= 4001, `enumerated ${reads} entries`)
  } finally { t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('safety snapshot discards observations when its owned Windows guard dies', async t => {
  if (process.platform !== 'win32') { t.skip('Windows directory helper'); return }
  const root = fs.mkdtempSync(join(tmpdir(), 'babel-snapshot-guard-exit-'))
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
    const snapshot = await guardedSafetySnapshot(root)
    assert.equal(snapshot.truncated, true)
    assert.equal(snapshot.file_count, 0)
    assert.deepEqual(snapshot.files, {})
  } finally { childProcess.spawn = spawn; fs.opendirSync = opendir; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) }
})
