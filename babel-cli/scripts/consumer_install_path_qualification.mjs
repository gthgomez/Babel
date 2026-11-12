// License: Apache-2.0 — see LICENSE
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/** @typedef {{
 *   installPrefix: string
 *   artifact: string
 *   npmCli: string
 *   project: string
 *   env: Record<string, string | undefined>
 *   scratch: string
 *   phase: string
 *   timeoutMs?: number
 * }} NpmInstallProbeInput */

/** @param {string} installPrefix */
export function installPathClass(installPrefix) {
  return /[^\x00-\x7f]|\s/.test(installPrefix) ? 'unicode_install_prefix' : 'ascii_install_prefix_control'
}

/**
 * Windows diagnostic only: npm --prefix must be ASCII on the full absolute path (no Unicode/space ancestors).
 * @param {string} installPrefix
 */
export function validateAsciiInstallControlPrefix(installPrefix) {
  const resolved = resolve(installPrefix)
  const cls = installPathClass(resolved)
  if (cls !== 'ascii_install_prefix_control') {
    const err = new Error(
      `ASCII install-path control requires full absolute path with only ASCII segments; ` +
        `got ${cls} for ${resolved}`,
    )
    err.code = 'INVALID_ASCII_INSTALL_CONTROL_PATH'
    throw err
  }
  return resolved
}

/** @param {string} projectPath */
export function runtimeProjectPathClass(projectPath) {
  return /[^\x00-\x7f]|\s/.test(projectPath) ? 'unicode_project_with_space' : 'ascii_project_path'
}

/**
 * Non-throwing npm install probe for install-path A/B diagnostics.
 *
 * @param {NpmInstallProbeInput} input
 */
export function npmInstallProbe(input) {
  const timeoutMs = input.timeoutMs ?? 300000
  mkdirSync(input.installPrefix, { recursive: true })
  const started = Date.now()
  const installEnv = {
    ...input.env,
    npm_config_cache: `${input.scratch}/npm-cache`,
    npm_config_prefer_offline: 'true',
  }
  const result = spawnSync(
    process.execPath,
    [input.npmCli, 'install', '--prefix', input.installPrefix, '--omit=dev', '--no-audit', '--no-fund', input.artifact],
    {
      cwd: input.project,
      env: installEnv,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  )
  return {
    phase: input.phase,
    install_prefix: input.installPrefix,
    install_path_class: installPathClass(input.installPrefix),
    elapsed_ms: Date.now() - started,
    timeout_ms: timeoutMs,
    npm_config_cache: installEnv.npm_config_cache,
    error: result.error
      ? { message: result.error.message, code: result.error.code, errno: result.error.errno }
      : null,
    status: result.status,
    signal: result.signal,
    success: !result.error && result.status === 0,
    stdout_tail: String(result.stdout ?? '').slice(-4000),
    stderr_tail: String(result.stderr ?? '').slice(-4000),
  }
}

/**
 * @param {{ unicodeProbe: ReturnType<typeof npmInstallProbe>, asciiProbe?: ReturnType<typeof npmInstallProbe> | null, baselineEvidence: string }} input
 */
export function buildInstallPathComparison(input) {
  return {
    schema: 'consumer-artifact/install-path-comparison/v1',
    root_cause: 'unestablished',
    interpretation:
      'Unicode vs ASCII control at identical timeout; outcomes are not equivalent qualifications. ' +
      'ASCII control must use a separate scratch root with an ASCII-only full install path (not nested under Unicode qualification scratch). ' +
      'Config/state Unicode alone does not qualify install path.',
    ascii_control_path_policy: 'full_absolute_path_ascii_only',
    not_equivalent_to: ['consumer_environment_unicode_config_only'],
    baseline_evidence: input.baselineEvidence,
    invalidated_prior_comparison:
      'fixtures/consumer-artifact/evidence/install-path-ab-invalid-nested-under-unicode-scratch.json',
    unicode_path: input.unicodeProbe,
    ascii_control: input.asciiProbe ?? null,
  }
}
