import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
