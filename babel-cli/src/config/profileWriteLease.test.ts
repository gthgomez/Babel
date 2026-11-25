import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { acquireProfileWriteLease, ProfileWriteLeaseError } from './profileWriteLease.js'

const interrupted = 17
const busy = 19
const moduleUrl = new URL('./profileWriteLease.ts', import.meta.url).href
const guardUrl = new URL('../testinfra/register-no-ambient-inference.mjs', import.meta.url).href

const childSource = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { acquireProfileWriteLease, ProfileWriteLeaseError } from ${JSON.stringify(moduleUrl)};
  const [target, action] = process.argv.slice(1);
  const marker = target + '.babel-lock';
  function after(operation, when) {
    const real = fs[operation];
    fs[operation] = (...args) => {
      const value = real(...args);
      if (when(...args)) process.exit(${interrupted});
      return value;
    };
  }
  if (action === 'create-guard') after('openSync', path => path === marker + '.sqlite');
  if (action === 'before-link') fs.linkSync = () => process.exit(${interrupted});
  if (action === 'after-link') after('linkSync', (_, path) => path === marker);
  if (action.startsWith('fallback')) {
    fs.linkSync = () => { throw Object.assign(new Error('Fixture hard link unavailable'), { code: 'ENOTSUP' }); };
    const windows = process.platform === 'win32';
    if (action === 'fallback-before') {
      if (windows) after('openSync', path => String(path).includes('.babel-lock.stage-'));
      else fs.symlinkSync = () => process.exit(${interrupted});
    }
    if (action === 'fallback-after') after(windows ? 'renameSync' : 'symlinkSync', (_, path) => path === marker);
    if (action === 'fallback-release') after('unlinkSync', path => windows ? String(path).includes('.babel-lock.retired-') : path === marker);
  }
  syncBuiltinESMExports();
  let release;
  try { release = acquireProfileWriteLease(target); }
  catch (error) {
    if (error instanceof ProfileWriteLeaseError && error.reason === 'busy') process.exit(${busy});
    throw error;
  }
  try {
    if (action === 'fallback-shape') {
      const info = fs.lstatSync(marker);
      assert.equal(process.platform === 'win32' ? info.isDirectory() : info.isSymbolicLink(), true);
    }
    if (action === 'rewrite' || action === 'before-rename' || action === 'after-rename') {
      const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
      const staging = target + '.fixture-update-' + process.pid;
      fs.writeFileSync(staging, JSON.stringify({ revision: previous.revision + 1 }), { flag: 'wx', mode: 0o600 });
      if (action === 'before-rename') process.exit(${interrupted});
      fs.renameSync(staging, target);
      if (action === 'after-rename') process.exit(${interrupted});
    }
  } finally { release(); }
`

function fixture(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'babel lease é '))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const target = join(directory, 'preferences.json')
  writeFileSync(target, JSON.stringify({ revision: 0 }), { mode: 0o600 })
  return target
}

function run(target: string, action: string, status = 0): void {
  const directory = dirname(target)
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', TMPDIR: directory, TMP: directory, TEMP: directory }
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    if (process.env.WINDIR) env.WINDIR = process.env.WINDIR
  }
  const child = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--import', guardUrl, '--input-type=module', '-e', childSource, target, action,
  ], { cwd: directory, env, timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(child.status, status, `${action} must finish at its expected boundary (${child.error?.name ?? child.signal ?? 'child exit'})`)
}

function markerPresent(target: string): boolean {
  return readdirSync(dirname(target)).includes(`${basename(target)}.babel-lock`)
}

function stagedUpdates(target: string): string[] {
  const directory = dirname(target)
  const prefix = `${basename(target)}.fixture-update-`
  return readdirSync(directory).filter(path => path.startsWith(prefix)).map(path => join(directory, path))
}

function revision(target: string): number {
  return JSON.parse(readFileSync(target, 'utf8')).revision
}

test('contending writers cannot replace settings, then retry from the newly saved revision', t => {
  const target = fixture(t)
  const release = acquireProfileWriteLease(target)
  try {
    const staging = target + '.first-update'
    writeFileSync(staging, JSON.stringify({ revision: 1 }), { flag: 'wx', mode: 0o600 })
    run(target, 'rewrite', busy)
    assert.equal(revision(target), 0)
    assert.deepEqual(stagedUpdates(target), [])
    renameSync(staging, target)
    run(target, 'rewrite', busy)
    assert.equal(revision(target), 1)
  } finally { release() }
  run(target, 'rewrite')
  release()
  assert.equal(revision(target), 2)
  assert.equal(markerPresent(target), false)
})

for (const [boundary, saved] of [['before-rename', 0], ['after-rename', 1]] as const) {
  test(`a writer exit ${boundary} preserves the complete settings revision and allows a restart`, t => {
    const target = fixture(t)
    run(target, boundary, interrupted)
    assert.equal(revision(target), saved)
    const abandoned = stagedUpdates(target)
    assert.equal(abandoned.length, boundary === 'before-rename' ? 1 : 0)
    run(target, 'rewrite')
    assert.equal(revision(target), saved + 1)
    assert.deepEqual(stagedUpdates(target), abandoned)
    if (abandoned.length) assert.equal(revision(abandoned[0]!), 1)
    assert.equal(markerPresent(target), false)
  })
}

for (const boundary of ['create-guard', 'before-link', 'after-link', 'fallback-before', 'fallback-after', 'fallback-release']) {
  test(`a new settings writer can acquire after process exit at ${boundary}`, t => {
    const target = fixture(t)
    run(target, boundary, interrupted)
    assert.equal(revision(target), 0)
    run(target, 'rewrite')
    assert.equal(revision(target), 1)
    assert.equal(markerPresent(target), false)
  })
}

test('the native fallback marker releases cleanly when hard links are unavailable', t => {
  const target = fixture(t)
  run(target, 'fallback-shape')
  assert.equal(markerPresent(target), false)
  run(target, 'rewrite')
  assert.equal(revision(target), 1)
})

test('unrecognized regular or directory markers are preserved', t => {
  const target = fixture(t)
  const marker = `${target}.babel-lock`
  writeFileSync(marker, 'unrelated owner', { flag: 'wx' })
  assert.throws(() => acquireProfileWriteLease(target), ProfileWriteLeaseError)
  assert.equal(readFileSync(marker, 'utf8'), 'unrelated owner')
  rmSync(marker)
  acquireProfileWriteLease(target)()
  mkdirSync(marker, { mode: 0o700 })
  const foreign = join(marker, 'foreign-owner')
  writeFileSync(foreign, 'unrecognized directory entry')
  assert.throws(() => acquireProfileWriteLease(target), ProfileWriteLeaseError)
  assert.equal(readFileSync(foreign, 'utf8'), 'unrecognized directory entry')
  assert.equal(revision(target), 0)
})

test('release refuses a substituted marker and still closes the writer lease', t => {
  const target = fixture(t)
  const marker = `${target}.babel-lock`
  const release = acquireProfileWriteLease(target)
  renameSync(marker, `${marker}.saved-fixture`)
  writeFileSync(marker, 'unrelated replacement', { flag: 'wx' })
  assert.throws(release, ProfileWriteLeaseError)
  assert.equal(readFileSync(marker, 'utf8'), 'unrelated replacement')
  rmSync(marker)
  run(target, 'rewrite')
  assert.equal(revision(target), 1)
  assert.equal(existsSync(`${marker}.saved-fixture`), true)
})

test('a foreign guard sidecar is preserved and blocks mutation', t => {
  const target = fixture(t)
  acquireProfileWriteLease(target)()
  const sidecar = `${target}.babel-lock.sqlite-wal`
  writeFileSync(sidecar, 'unrecognized sidecar', { flag: 'wx', mode: 0o600 })
  assert.throws(() => acquireProfileWriteLease(target), ProfileWriteLeaseError)
  assert.equal(readFileSync(sidecar, 'utf8'), 'unrecognized sidecar')
  assert.equal(revision(target), 0)
})
