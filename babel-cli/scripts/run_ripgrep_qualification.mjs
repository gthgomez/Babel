// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeRequiredTap } from './summarize_required_tap.mjs'

const mode = process.argv[2]
assert.ok(['native', 'fallback'].includes(mode), 'Choose native or fallback qualification')
const env = { ...process.env }
let rgVersion = 'not-present'
if (mode === 'native') {
  const probe = spawnSync('rg', ['--version'], { encoding: 'utf8', windowsHide: true })
  assert.equal(probe.status, 0, 'Native qualification requires a real rg executable')
  assert.match(probe.stdout, /^ripgrep 15\.1\.0(?:\s|$)/, 'Native qualification requires pinned ripgrep 15.1.0')
  rgVersion = '15.1.0'
  env.BABEL_REQUIRE_NATIVE_RG = '1'
} else { env.PATH = ''; delete env.BABEL_REQUIRE_NATIVE_RG }
const directory = resolve('artifacts/native-rg-' + mode)
mkdirSync(directory, { recursive: true })
env.BABEL_TAP_EXECUTION_PATH = resolve(directory, 'execution.json')
const file = 'src/tools/ripgrep.test.ts'
const runnerCommand = 'node scripts/run_ripgrep_qualification.mjs ' + mode
writeFileSync(resolve(directory, 'selection.json'), JSON.stringify({ schemaVersion: 1, suite: 'native-rg', nodeVersion: process.version,
  platform: process.platform, arch: process.arch, rgVersion, runnerCommand,
  runnerScriptSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  packageScriptSha256: createHash('sha256').update(runnerCommand).digest('hex'),
  files: [{ path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }] }))
const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--no-warnings=ExperimentalWarning',
  '--import', './src/testinfra/register-no-ambient-inference.mjs', '--test-reporter=./scripts/required_tap_reporter.mjs',
  ...(mode === 'fallback' ? ['--test-name-pattern=grepContent|globPaths|buildWorkspaceMap'] : []), '--test', file],
{ env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120000 })
writeFileSync(resolve(directory, 'full.tap'), result.stdout || '')
const summary = summarizeRequiredTap('native-rg', directory)
assert.equal(result.status, 0, result.stderr)
assert.equal(summary.status, 'complete', summary.errors.join(', '))
if (mode === 'native') {
  const cases = summary.tests.filter(t => t.id.startsWith('ripgrep wrapper (when available) /'))
  assert.equal(cases.length, 6, 'All six native cases must execute')
  assert.ok(cases.every(t => t.result === 'passed'), 'Native cases must assert, rather than skip')
}
console.log(JSON.stringify({ mode, passed: summary.passed, skipped: summary.skipped }))
