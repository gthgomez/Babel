#!/usr/bin/env node
/**
 * Dead-code ratchet for the CLI source tree.
 *
 * Runs the configured knip report (`babel-cli/knip.json`) and compares the set
 * of modules unreachable from all entry points with the committed baseline in
 * `config/architectural-budget/unused-modules.json`.
 *
 * The check fails when a new unreachable module appears, and also when a
 * baseline entry no longer exists or is no longer reported. Baseline membership
 * is recorded debt, not approval: removing an entry requires reachability
 * evidence (static importer, dynamic path string and test/script consumers).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const repoRoot = resolve(packageRoot, '..')
const baselinePath = resolve(repoRoot, 'config', 'architectural-budget', 'unused-modules.json')

function fail(lines) {
  console.error('[dead-code] check failed')
  for (const line of lines) console.error(`  ${line}`)
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
if (!Array.isArray(baseline.modules)) {
  fail([`${baselinePath} must contain a modules array`])
}
const expected = new Set(baseline.modules.map((entry) => entry.path))
for (const entry of baseline.modules) {
  if (typeof entry.path !== 'string' || typeof entry.category !== 'string') {
    fail(['every baseline entry needs path and category'])
  }
  if (!existsSync(resolve(packageRoot, entry.path))) {
    fail([`baseline entry no longer exists: ${entry.path} (remove it from ${baselinePath})`])
  }
}

// Run knip's JS entry with the current Node binary. Spawning npx.cmd would need a
// shell on Windows, so resolve the package bin directly and keep shell disabled.
const knipBin = resolve(packageRoot, 'node_modules', 'knip', 'bin', 'knip.js')
if (!existsSync(knipBin)) {
  fail([`knip is not installed at ${knipBin}; run npm ci in babel-cli`])
}
const run = spawnSync(process.execPath, [knipBin, '--no-progress', '--include', 'files', '--reporter', 'json'], {
  cwd: packageRoot,
  encoding: 'utf8',
  shell: false,
})

if (run.error) {
  fail([`could not run knip: ${run.error.message}`])
}

let report
try {
  report = JSON.parse(run.stdout)
} catch {
  // knip exits non-zero when it finds issues; only unparseable output is fatal.
  fail([
    `knip did not emit a JSON report (exit ${run.status})`,
    (run.stderr || run.stdout || '').trim().split('\n').slice(-5).join('\n  '),
  ])
}

const reported = new Set()
for (const issue of report.issues ?? []) {
  for (const file of issue.files ?? []) {
    if (typeof file.name === 'string') reported.add(file.name.replace(/\\/g, '/'))
  }
}

const added = [...reported].filter((file) => !expected.has(file)).sort()
const removed = [...expected].filter((file) => !reported.has(file)).sort()

if (added.length > 0) {
  fail([
    'new modules unreachable from every entry point:',
    ...added.map((file) => `  ${file}`),
    'Wire the module into an entry point, or add it to the baseline with a category and reason.',
  ])
}

if (removed.length > 0) {
  fail([
    'baseline modules are no longer reported as unreachable:',
    ...removed.map((file) => `  ${file}`),
    `Update ${baselinePath} so the ratchet stays exact.`,
  ])
}

console.log(`[dead-code] ok: ${reported.size} known unreferenced module(s), no new dead modules`)
