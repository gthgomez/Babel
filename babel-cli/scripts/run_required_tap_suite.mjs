#!/usr/bin/env node
// License: Apache-2.0 - see LICENSE
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const result = spawnSync('npm', ['run', rawScript], {
  cwd: cliRoot,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
  shell: false,
})

const tap = result.stdout ?? ''
writeFileSync(tapPath, tap, 'utf8')
process.stdout.write(tap)
process.stderr.write(result.stderr ?? '')

const inventory = parseRequiredTapInventory(tap, suite)
const childFailed = (result.status ?? 0) !== 0
const failed =
  childFailed ||
  inventory.status === 'failed' ||
  inventory.failed > 0 ||
  (inventory.status !== 'complete' && inventory.errors.length > 0)

if (failed) {
  console.error(
    `${suite} TAP gate: status=${inventory.status} failed=${inventory.failed} errors=${inventory.errors.join(',')}`,
  )
  process.exit(1)
}

process.exit(result.status ?? 0)
