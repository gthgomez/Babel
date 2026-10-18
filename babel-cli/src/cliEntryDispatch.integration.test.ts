import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const binEntry = join(packageRoot, 'bin', 'babel.js')
const distIndex = join(packageRoot, 'dist', 'index.js')
const nodeWasmArgs = ['--experimental-wasm-modules'] as const

function isSupportedNodeVersion(major: number, minor: number, patch: number): boolean {
  return (
    (major === 22 && minor >= 19) ||
    (major === 24 && (minor > 13 || (minor === 13 && patch >= 1)))
  )
}

function parseNodeVersionLabel(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function resolveQualificationNodeExec(): { execPath: string; versionLabel: string; hostNote?: string } {
  const candidates: string[] = []
  if (process.env.BABEL_CLI_ENTRY_NODE) candidates.push(process.env.BABEL_CLI_ENTRY_NODE)
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmRoot)) {
    for (const entry of readdirSync(nvmRoot)) {
      candidates.push(join(nvmRoot, entry, 'bin', 'node'))
    }
  }
  candidates.push(process.execPath)

  for (const execPath of candidates) {
    if (!execPath || !existsSync(execPath)) continue
    const probe = spawnSync(execPath, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true })
    if ((probe.status ?? 1) !== 0) continue
    const parts = parseNodeVersionLabel(String(probe.stdout))
    if (!parts) continue
    if (isSupportedNodeVersion(...parts)) {
      return { execPath, versionLabel: `v${parts.join('.')}` }
    }
  }

  const hostParts = parseNodeVersionLabel(process.versions.node)
  const hostSupported = hostParts ? isSupportedNodeVersion(...hostParts) : false
  if (hostSupported) {
    return { execPath: process.execPath, versionLabel: process.versions.node }
  }
  return {
    execPath: process.execPath,
    versionLabel: process.versions.node,
    hostNote: `Host Node ${process.versions.node} is below the supported minimum for bin/babel.js (^22.19.0 or ^24.13.1). Install a supported runtime (CI uses 22.19.0 / 24.13.1) or set BABEL_CLI_ENTRY_NODE to a qualifying node binary. Executable entry qualification cannot run on this host.`,
  }
}

const qualification = resolveQualificationNodeExec()

function childStartupHookPath(kind: 'env_loaded' | 'capability_canary'): string {
  const probeDir = mkdtempSync(join(tmpdir(), 'babel-entry-probe-'))
  const hookPath = join(probeDir, 'entry-probe-hook.mjs')
  const body =
    kind === 'env_loaded'
      ? `process.on('exit', () => {
  process.stdout.write('\\n__CHILD_ENV_LOADED__:' + (process.env.BABEL_ENV_LOADED ?? 'unset') + '\\n');
});`
      : `process.on('exit', () => {
  process.stderr.write('__CHILD_ENV_LOADED__:' + (process.env.BABEL_ENV_LOADED ?? 'unset') + '\\n');
  process.stderr.write('__CHILD_CANARY__:' + (process.env.BABEL_CAPABILITY_PROBE_CANARY ?? 'unset') + '\\n');
});`
  writeFileSync(hookPath, body, 'utf8')
  return hookPath
}

function spawnInstrumentedExecutable(
  entry: string,
  args: string[],
  hookKind: 'env_loaded' | 'capability_canary',
  extraEnv: Record<string, string | undefined> = {},
) {
  const hookPath = childStartupHookPath(hookKind)
  const env = {
    ...process.env,
    CI: '1',
    BABEL_SKIP_RESUME_PICKER: '1',
    BABEL_SKIP_KG_INDEX: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(hookPath).href}`,
    BABEL_ENV_LOADED: undefined,
    ...extraEnv,
  }
  return spawnSync(qualification.execPath, [...nodeWasmArgs, entry, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
    windowsHide: true,
  })
}

function requireQualifyingRuntime(t: { diagnostic: (message: string) => void }) {
  if (qualification.hostNote) {
    t.diagnostic(qualification.hostNote)
    assert.fail(qualification.hostNote)
  }
  t.diagnostic(
    `Qualifying executable entries with Node ${qualification.versionLabel} (${qualification.execPath})`,
  )
  assert.equal(existsSync(binEntry), true, 'bin/babel.js must exist')
  assert.equal(existsSync(distIndex), true, 'dist build required for entry dispatch tests')
}

function childEnvLoadedMarker(stdout: string): string | undefined {
  return String(stdout).match(/__CHILD_ENV_LOADED__:(.+)/)?.[1]?.trim()
}

function parseCapabilityChild(stderr: string): { envLoaded: string; canary: string } {
  const envLoaded = stderr.match(/__CHILD_ENV_LOADED__:(.+)/)?.[1]?.trim()
  const canary = stderr.match(/__CHILD_CANARY__:(.+)/)?.[1]?.trim()
  assert.equal(typeof envLoaded, 'string', 'child must report env bootstrap instrumentation')
  assert.equal(typeof canary, 'string', 'child must report capability canary instrumentation')
  return { envLoaded: envLoaded!, canary: canary! }
}

for (const [label, entryResolver] of [
  ['bin/babel.js', () => binEntry],
  ['npm-style symlink', () => {
    const linkDir = mkdtempSync(join(tmpdir(), 'babel-cli-bin-link-'))
    const link = join(linkDir, 'babel-agent')
    symlinkSync(binEntry, link)
    return link
  }],
] as const) {
  test(`${label} dispatches through startCli on normal startup`, (t) => {
    requireQualifyingRuntime(t)
    const entry = entryResolver()
    const child = spawnInstrumentedExecutable(entry, ['--help'], 'env_loaded')
    assert.equal(child.error, undefined, child.stderr)
    assert.equal(child.status, 0, child.stderr)
    assert.equal(childEnvLoadedMarker(child.stdout), 'true', `${label} child must set BABEL_ENV_LOADED via startCli`)
  })

  test(`${label} keeps desktop capability probe before env bootstrap in the child`, (t) => {
    requireQualifyingRuntime(t)
    const entry = entryResolver()
    const credentialsDir = join(packageRoot, 'must-not-inspect-credentials')
    const configDir = mkdtempSync(join(tmpdir(), 'babel-entry-config-'))
    writeFileSync(
      join(configDir, '.env'),
      'BABEL_CAPABILITY_PROBE_CANARY=synthetic-legacy-value\n',
      { mode: 0o600 },
    )
    const child = spawnInstrumentedExecutable(entry, ['--desktop-capabilities'], 'capability_canary', {
      BABEL_CONFIG_DIR: configDir,
      BABEL_PROJECT_CREDENTIALS_DIR: credentialsDir,
      BABEL_LEGACY_CLI_ENV: '1',
      BABEL_CAPABILITY_PROBE_CANARY: undefined,
    })
    assert.equal(child.error, undefined, child.stderr)
    assert.equal(child.status, 0, child.stderr || child.stdout)
    const instrumentation = parseCapabilityChild(child.stderr)
    assert.equal(instrumentation.envLoaded, 'unset', 'capability probe must not set BABEL_ENV_LOADED in child')
    assert.equal(instrumentation.canary, 'unset', 'capability probe must not load credential bootstrap in child')
    let capabilities: unknown
    try {
      capabilities = JSON.parse(String(child.stdout).trim())
    } catch {
      assert.fail(`capability stdout must be JSON: ${child.stdout}`)
    }
    assert.deepEqual(capabilities, { schemaVersion: 1, credentialEnvironment: 'native-resolved-v1' })
  })
}

test('direct dist/index.js entry uses startCli when invoked as main', (t) => {
  requireQualifyingRuntime(t)
  const child = spawnInstrumentedExecutable(distIndex, ['--help'], 'env_loaded')
  assert.equal(child.error, undefined, child.stderr)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(childEnvLoadedMarker(child.stdout), 'true', 'dist/index.js child must set BABEL_ENV_LOADED via startCli')
})

test('direct dist/index.js capability probe stays early in the child', (t) => {
  requireQualifyingRuntime(t)
  const configDir = mkdtempSync(join(tmpdir(), 'babel-index-config-'))
  writeFileSync(
    join(configDir, '.env'),
    'BABEL_CAPABILITY_PROBE_CANARY=synthetic-legacy-value\n',
    { mode: 0o600 },
  )
  const child = spawnInstrumentedExecutable(distIndex, ['--desktop-capabilities'], 'capability_canary', {
    BABEL_CONFIG_DIR: configDir,
    BABEL_PROJECT_CREDENTIALS_DIR: join(packageRoot, 'must-not-inspect-credentials'),
    BABEL_LEGACY_CLI_ENV: '1',
    BABEL_CAPABILITY_PROBE_CANARY: undefined,
  })
  assert.equal(child.status, 0, child.stderr || child.stdout)
  const instrumentation = parseCapabilityChild(child.stderr)
  assert.equal(instrumentation.envLoaded, 'unset')
  assert.equal(instrumentation.canary, 'unset')
})
