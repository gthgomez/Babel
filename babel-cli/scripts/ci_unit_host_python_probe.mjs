// Host Python probe for unit shards: record resolution for governed static_check probes.
// Does not install interpreters; mirrors resolvePythonInterpreter candidate order.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Integration tests that require a real host Python static_check (exit 0), not static_check_unavailable. */
export const HOST_PYTHON_UNIT_PATHS = Object.freeze([
  'src/agent/chatRecoveryImport.integration.test.ts',
])

function probe(bin, prefixArgs = []) {
  const result = spawnSync(bin, [...prefixArgs, '-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'], {
    encoding: 'utf-8',
    timeout: 5_000,
    windowsHide: true,
  })
  return !result.error && result.status === 0
}

/** Direct interpreter path suitable for BABEL_WORKSPACE_PYTHON (excludes py launcher). */
export function discoverDirectHostPythonBin(parentEnv = process.env) {
  const configured =
    parentEnv.BABEL_WORKSPACE_PYTHON?.trim() || parentEnv.BABEL_PYTHON?.trim() || ''
  if (configured) return configured
  for (const candidate of candidates()) {
    if (candidate.bin === 'py') continue
    if (probe(candidate.bin, candidate.args ?? [])) return candidate.bin
  }
  return null
}

function candidates() {
  if (process.platform === 'win32') {
    return [
      { label: 'py -3', bin: 'py', args: ['-3'] },
      { label: 'python', bin: 'python' },
      { label: 'python3', bin: 'python3' },
    ]
  }
  return [
    { label: 'python3', bin: 'python3' },
    { label: 'python', bin: 'python' },
  ]
}

/**
 * @param {readonly string[]} selected
 * @param {NodeJS.ProcessEnv} [parentEnv]
 * @returns {{ env: Record<string, string>, record: object }}
 */
export function probeUnitShardHostPython(selected, parentEnv = process.env) {
  const needs = selected.filter(path => HOST_PYTHON_UNIT_PATHS.includes(path))
  if (needs.length === 0) {
    return { env: {}, record: { required: false, selected: [] } }
  }
  const configured =
    parentEnv.BABEL_WORKSPACE_PYTHON?.trim() || parentEnv.BABEL_PYTHON?.trim() || ''
  const tried = []
  if (configured) {
    tried.push(`env:${configured}`)
    const configuredWorks = probe(configured)
    const record = {
      required: true,
      selected: needs,
      platform: process.platform,
      configuredInterpreter: configured,
      configuredWorks,
      resolved: configuredWorks ? `env:${configured}` : null,
      tried,
      coordinatorProtectedWorkflow: '.github/workflows/typecheck.yml',
      coordinatorAction: configuredWorks
        ? null
        : 'Configured BABEL_WORKSPACE_PYTHON/BABEL_PYTHON is not executable; fix operator binding before auto-probe.',
      whyAllowedPathInsufficient: configuredWorks
        ? null
        : 'Explicit interpreter binding must remain authoritative; probe does not override a broken configured path.',
    }
    return { env: {}, record }
  }
  let resolved = null
  for (const candidate of candidates()) {
    tried.push(candidate.label)
    if (probe(candidate.bin, candidate.args ?? [])) {
      resolved = candidate
      break
    }
  }
  const record = {
    required: true,
    selected: needs,
    platform: process.platform,
    configuredInterpreter: null,
    configuredWorks: null,
    resolved: resolved?.label ?? null,
    tried,
    coordinatorProtectedWorkflow: '.github/workflows/typecheck.yml',
    coordinatorAction: resolved
      ? null
      : 'Mirror chat-truth Windows setup-python (@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0, python-version 3.12, if runner.os == Windows) onto unit-shards after checkout.',
    whyAllowedPathInsufficient: resolved
      ? null
      : 'BABEL_WORKSPACE_PYTHON and resolvePythonInterpreter only bind existing executables; unit-shards has no setup-python step and no allowed script installs Python on GHA runners.',
  }
  const env = {}
  if (resolved && resolved.bin !== 'py') {
    env.BABEL_WORKSPACE_PYTHON = resolved.bin
  }
  return { env, record }
}

export function writeHostPythonProbeRecord(packageRoot, record) {
  const path = join(packageRoot, 'artifacts', 'ci-unit', 'host-python-probe.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...record }, null, 2) + '\n')
}
