#!/usr/bin/env node
// License: Apache-2.0 - see LICENSE
import { existsSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoggedTapChild } from './run_logged_tap_child.mjs'
import { captureRequiredTapSelection } from './capture_required_tap_selection.mjs'
import { requiredTapSuiteGate } from './required_tap_suite_gate.mjs'

export { requiredTapSuiteGate } from './required_tap_suite_gate.mjs'

const rawScripts = {
  'chat-truth': 'test:chat-truth:raw',
  'harness-runtime': 'test:harness-runtime:raw',
}

const suite = process.argv[2]
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

const tapEnv = {
  ...process.env,
  BABEL_TAP_EXECUTION_PATH: executionPath,
}
const npmCli = process.env.npm_execpath

async function captureTap(command, args) {
  return runLoggedTapChild(command, args, { cwd: cliRoot, env: tapEnv, tapPath, label: suite })
}

const result =
  process.platform === 'win32'
    ? await (async () => {
        if (!npmCli || !existsSync(npmCli)) {
          return {
            stdout: '',
            stderr: 'Required TAP runner needs npm_execpath on Windows (invoke via npm run).\n',
            status: 1,
            error: undefined,
            signal: null,
          }
        }
        return captureTap(process.execPath, [npmCli, 'run', '--silent', rawScript])
      })()
    : await captureTap('npm', ['run', '--silent', rawScript])

const gate = requiredTapSuiteGate(suite, result.stdout, {
  error: result.error,
  signal: result.signal,
  status: result.status,
})

if (!existsSync(tapPath)) writeFileSync(tapPath, gate.tap, 'utf8')

function finish(exitCode) {
  const stderrChunk = result.stderr ?? ''
  if (stderrChunk) {
    process.stderr.write(stderrChunk)
  }

  if (gate.failed) {
    if (gate.childSpawnError) {
      console.error(`${suite} TAP gate: child spawn error: ${gate.childSpawnError.message}`)
    }
    if (gate.childSignal) {
      console.error(`${suite} TAP gate: child terminated by signal ${gate.childSignal}`)
    }
    if (gate.childExitCode !== 0 && gate.childExitCode != null) {
      console.error(`${suite} TAP gate: child exit code ${gate.childExitCode}`)
    } else if (gate.childExitCode == null && !gate.childSignal && !gate.childSpawnError) {
      console.error(`${suite} TAP gate: child exit code missing`)
    }
    console.error(
      `${suite} TAP gate: status=${gate.inventory.status} failed=${gate.inventory.failed} errors=${gate.inventory.errors.join(',')}`,
    )
  }

  process.exitCode = exitCode
}

if (gate.failed) {
  finish(1)
} else {
  finish(0)
}
