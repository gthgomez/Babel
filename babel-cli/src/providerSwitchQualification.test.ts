import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('provider-switch qualification controls run in the canonical unit inventory', { timeout: 45_000 }, () => {
  const suite = fileURLToPath(new URL('../scripts/provider_switch_qualification.test.mjs', import.meta.url))
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', suite], {
    encoding: 'utf8', timeout: 35_000, maxBuffer: 128 * 1024, windowsHide: true,
    env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], TEMP: process.env['TEMP'], TMP: process.env['TMP'] },
  })
  assert.equal(run.error === undefined, true, 'qualification controls must finish within the child bound')
  assert.equal(run.status, 0, run.stderr || run.stdout.slice(-2000))
})
