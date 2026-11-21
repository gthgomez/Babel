import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { isProcessAlive } from './processTree.js'
import { spawnCommandAsync } from './sandboxSpawnCommandAsync.js'
import { buildOwnedWindowsInvocation } from './windowsProcessSettlement.js'

test('owned Windows launch preserves CRT arguments and verbatim cmd payloads', () => {
  assert.deepEqual(buildOwnedWindowsInvocation('C:\\Program Files\\node.exe', ['', 'a b', 'c" d'], 'C:\\Windows'), {
    executable: 'C:\\Program Files\\node.exe',
    command: '"C:\\Program Files\\node.exe" "" "a b" "c\\" d"',
  })
  for (const suffix of ['cmd', 'bat']) {
    const payload = `"C:\\Windows\\System32\\cmd.exe" /d /s /c ""C:\\Program Files\\fixture.${suffix}" "two words""`
    const actual = buildOwnedWindowsInvocation(`C:\\Program Files\\fixture.${suffix}`, ['two words'], 'C:\\Windows')
    assert.equal(actual.command, payload.replace('"C:\\Windows\\System32\\cmd.exe"', 'C:\\Windows\\System32\\cmd.exe'))
  }
  assert.equal(buildOwnedWindowsInvocation('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"node ""'], 'C:\\Windows').command,
    'C:\\Windows\\System32\\cmd.exe /d /s /c "node ""')
})

test('Windows supervisor preserves argv, stdout, stderr and the target exit status', {
  skip: process.platform !== 'win32' && 'requires native Windows',
  timeout: 150_000,
}, async () => {
  const args = ['', 'two words', 'f"oo', 'trail \\']
  const result = await spawnCommandAsync(process.execPath, [
    '-e', 'console.log(JSON.stringify(process.argv.slice(1))); console.error("fixture stderr"); process.exitCode = 7',
    '--', ...args,
  ], { cwd: process.cwd(), env: process.env, timeoutMs: 15_000 })
  assert.ifError(result.error)
  assert.equal(result.processStarted, true)
  assert.equal(result.status, 7)
  assert.deepEqual(JSON.parse(result.stdout), args)
  assert.equal(result.stderr.trim(), 'fixture stderr')

  const rejected = await spawnCommandAsync(process.execPath, ['-e', 'console.log("must not run")'], {
    cwd: process.cwd(), env: process.env, timeoutMs: 15_000,
    validateExecutable: () => false,
  })
  assert.equal(rejected.processStarted, false)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.error?.message ?? '', /identity could not be confirmed/)
  assert.equal(rejected.stdout, '')
})

test('killing the Windows supervisor closes the whole job and leaves unrelated work alone', {
  skip: process.platform !== 'win32' && 'requires native Windows',
  timeout: 100_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-owned-supervisor-fixture-'))
  const childEntry = join(root, 'controller.mjs')
  const fixtureEntry = join(root, 'fixture.cjs')
  const childPidPath = join(root, 'child-pid')
  const grandchildPidPath = join(root, 'grandchild-pid')
  const stopPath = join(root, 'release')
  writeFileSync(fixtureEntry, `
const { spawn } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const [role, childPidPath, grandchildPidPath, stopPath] = process.argv.slice(2);
if (role === 'child') {
  const child = spawn(process.execPath, [__filename, 'grandchild', childPidPath, grandchildPidPath, stopPath], {stdio:'ignore',windowsHide:true});
  child.unref();
}
writeFileSync(role === 'child' ? childPidPath : grandchildPidPath, String(process.pid));
const hold = setInterval(() => { if (existsSync(stopPath)) clearInterval(hold); }, 25);
`)
  writeFileSync(childEntry, `
import { spawnCommandAsync } from ${JSON.stringify(new URL('./sandboxSpawnCommandAsync.js', import.meta.url).href)};
await spawnCommandAsync(process.execPath, ${JSON.stringify([fixtureEntry, 'child', childPidPath, grandchildPidPath, stopPath])},
  {cwd:${JSON.stringify(root)},env:process.env,timeoutMs:0});
`)
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)'], { stdio: 'ignore', windowsHide: true })
  const controller = spawn(process.execPath, [...process.execArgv.filter(arg => !arg.startsWith('--test')), childEntry], {
    stdio: 'ignore', windowsHide: true,
  })
  try {
    const deadline = Date.now() + 75_000
    while (!existsSync(childPidPath) || !existsSync(grandchildPidPath)) {
      assert.ok(Date.now() < deadline && controller.exitCode === null, 'supervised child and grandchild must start')
      await delay(25)
    }
    const pids = [childPidPath, grandchildPidPath].map(path => Number(readFileSync(path, 'utf8')))
    assert.ok(pids.every(pid => Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)))
    assert.equal(controller.kill(), true)
    const settleBy = Date.now() + 10_000
    while (pids.some(pid => isProcessAlive(pid))) {
      assert.ok(Date.now() < settleBy, 'supervisor loss must terminate the owned job')
      await delay(25)
    }
    assert.equal(unrelated.exitCode, null)
    assert.ok(unrelated.pid && isProcessAlive(unrelated.pid))
  } finally {
    controller.kill()
    unrelated.kill()
    writeFileSync(stopPath, '')
    await delay(100)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
