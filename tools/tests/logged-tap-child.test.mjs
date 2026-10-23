import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runLoggedTapChild } from '../../babel-cli/scripts/run_logged_tap_child.mjs'

test('producer progress is visible before exit, full logs survive, and nonzero exit is preserved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-logged-tap-'))
  const stdout = new PassThrough(), stderr = new PassThrough()
  const marker = join(root, 'observed')
  const tapPath = join(root, 'full.tap')
  let observed = ''
  stdout.on('data', chunk => { observed += chunk.toString(); if (observed.includes('first')) writeFileSync(marker, '') })
  stderr.resume()
  try {
    const source = 'const fs=require("node:fs");console.log("first");console.error("diagnostic");const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);console.log("last");process.exitCode=7}},10);setTimeout(()=>{clearInterval(t)},1000).unref()'
    const result = await runLoggedTapChild(process.execPath, ['-e', source, marker], { cwd: root, tapPath, stdout, stderr })
    assert.equal(result.status, 7)
    assert.equal(result.error, undefined)
    assert.equal(result.stdout, 'first\nlast\n')
    assert.equal(observed, result.stdout)
    assert.equal(readFileSync(tapPath + '.stderr.log', 'utf8'), 'diagnostic\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a missing producer returns a failed spawn outcome rather than success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-logged-tap-missing-'))
  try {
    const output = new PassThrough(); output.resume()
    const result = await runLoggedTapChild(join(root, 'nonexistent-producer'), [], { cwd: root, tapPath: join(root, 'full.tap'), stdout: output, stderr: output })
    assert.equal(result.status, null)
    assert.ok(result.error)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a continuously noisy producer is stopped at the combined output budget', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-logged-tap-overflow-'))
  const tapPath = join(root, 'full.tap')
  const output = new PassThrough(); output.resume()
  try {
    const result = await runLoggedTapChild(process.execPath, ['-e', 'setInterval(()=>{process.stdout.write("x".repeat(900));process.stderr.write("y".repeat(900))},10)'], {
      cwd: root, tapPath, stdout: output, stderr: output, maxLogBytes: 1024, signal: t.signal,
    })
    assert.match(result.error?.message, /output limit exceeded/)
    assert.ok(statSync(tapPath).size + statSync(tapPath + '.stderr.log').size <= 1024)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cancellation terminates the owned producer tree and returns failed evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-logged-tap-cancel-'))
  const output = new PassThrough(), controller = new AbortController()
  let grandchild
  output.on('data', chunk => { grandchild = Number(chunk.toString().trim()); controller.abort() })
  const errors = new PassThrough(); errors.resume()
  try {
    const source = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)'
    const result = await runLoggedTapChild(process.execPath, ['-e', source], {
      cwd: root, tapPath: join(root, 'full.tap'), stdout: output, stderr: errors, signal: controller.signal,
    })
    assert.equal(result.signal, 'SIGTERM')
    assert.match(result.error?.message, /interrupted/)
    assert.ok(Number.isInteger(grandchild) && grandchild > 0)
    // A terminated POSIX descendant may briefly remain as a reaped zombie;
    // Windows taskkill waits for its owned /T process tree to terminate.
    if (process.platform === 'win32') assert.throws(() => process.kill(grandchild, 0), /ESRCH/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('descendants retaining pipes cannot hang capture after their producer exits', { timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-logged-tap-orphan-'))
  const output = new PassThrough(), errors = new PassThrough(), controller = new AbortController()
  errors.resume()
  let descendant, timer
  output.on('data', chunk => {
    descendant = Number(chunk.toString().trim())
    timer = setTimeout(() => controller.abort(), 250)
  })
  // The direct producer exits immediately; cancellation is intentionally later.
  try {
    const source = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});console.log(c.pid);process.exit(0)'
    const result = await runLoggedTapChild(process.execPath, ['-e', source], {
      cwd: root, tapPath: join(root, 'full.tap'), stdout: output, stderr: errors, signal: AbortSignal.any([controller.signal, t.signal]),
    })
    assert.ok(Number.isInteger(descendant) && descendant > 0)
    if (process.platform === 'win32') {
      assert.equal(result.status, 0)
      assert.throws(() => process.kill(descendant, 0), /ESRCH/)
    } else {
      assert.equal(result.signal, 'SIGTERM')
      assert.match(result.error?.message, /interrupted/)
    }
  } finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }) }
})
