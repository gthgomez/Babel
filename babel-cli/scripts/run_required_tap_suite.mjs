#!/usr/bin/env node
// License: Apache-2.0 - see LICENSE
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureRequiredTapSelection } from './capture_required_tap_selection.mjs'
import { parseRequiredTapInventory } from './summarize_required_tap.mjs'

const suite = process.argv[2]
const rawScripts = {
  'chat-truth': 'test:chat-truth:raw',
  'harness-runtime': 'test:harness-runtime:raw',
}
const rawScript = rawScripts[suite]
if (!rawScript) {
  console.error(`Unsupported required TAP suite: ${suite}`)
  process.exit(2)
}

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactDir = resolve(cliRoot, 'artifacts', suite)
mkdirSync(artifactDir, { recursive: true })
const tapPath = resolve(artifactDir, 'full.tap')
const executionPath = resolve(artifactDir, 'execution.json')

captureRequiredTapSelection(suite, artifactDir)

/** npm lifecycle lines must not be treated as TAP (they break inventory typing). */
function isolateTap(stdout) {
  const marker = 'TAP version 13\n'
  const start = stdout.lastIndexOf(marker)
  if (start === -1) return stdout
  return stdout.slice(start)
}

const result = spawnSync('npm', ['run', '--silent', rawScript], {
  cwd: cliRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    BABEL_TAP_EXECUTION_PATH: executionPath,
  },
  maxBuffer: 64 * 1024 * 1024,
  shell: false,
})

const tap = isolateTap(result.stdout ?? '')
writeFileSync(tapPath, tap, 'utf8')
process.stdout.write(tap)
process.stderr.write(result.stderr ?? '')

const inventory = parseRequiredTapInventory(tap, suite)
const childSpawnError = result.error ?? null
const childSignal = result.signal ?? null
const childExitCode = result.status
// Do not treat null status as success: a signaled child can emit a full TAP footer first.
const childFailed =
  childSpawnError != null ||
  childSignal != null ||
  childExitCode !== 0
const inventoryFailed =
  inventory.status === 'failed' ||
  inventory.failed > 0 ||
  (inventory.status !== 'complete' && inventory.errors.length > 0)
const failed = childFailed || inventoryFailed

if (failed) {
  if (childSpawnError) {
    console.error(`${suite} TAP gate: child spawn error: ${childSpawnError.message}`)
  }
  if (childSignal) {
    console.error(`${suite} TAP gate: child terminated by signal ${childSignal}`)
  }
  if (childExitCode !== 0 && childExitCode != null) {
    console.error(`${suite} TAP gate: child exit code ${childExitCode}`)
  } else if (childExitCode == null && !childSignal && !childSpawnError) {
    console.error(`${suite} TAP gate: child exit code missing`)
  }
  console.error(
    `${suite} TAP gate: status=${inventory.status} failed=${inventory.failed} errors=${inventory.errors.join(',')}`,
  )
  process.exit(1)
}

process.exit(0)
