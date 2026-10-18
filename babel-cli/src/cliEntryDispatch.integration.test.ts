import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

function spawnWithQualifyingNode(entry: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(qualification.execPath, [...nodeWasmArgs, entry, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      BABEL_SKIP_RESUME_PICKER: '1',
      BABEL_SKIP_KG_INDEX: '1',
      ...env,
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
    windowsHide: true,
  })
}

function envLoadedViaExecutableEntry(entry: string): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), 'babel-entry-probe-'))
  const hookPath = join(probeDir, 'entry-probe-hook.mjs')
  writeFileSync(
    hookPath,
    `process.on('exit', () => {
  if (process.env.BABEL_ENTRY_PROBE === '1') {
    process.stdout.write('\\n__BABEL_PROBE__:' + (process.env.BABEL_ENV_LOADED ?? 'missing') + '\\n');
  }
});`,
    'utf8',
  )
  const child = spawnWithQualifyingNode(entry, ['--help'], {
    BABEL_ENTRY_PROBE: '1',
    NODE_OPTIONS: `--import=${hookPath}`,
    BABEL_ENV_LOADED: undefined,
  })
  if ((child.status ?? 1) !== 0) return false
  const marker = String(child.stdout).match(/__BABEL_PROBE__:(.+)/)?.[1]?.trim()
  return marker === 'true'
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

test('bin/babel.js dispatches through startCli on normal startup', (t) => {
  requireQualifyingRuntime(t)
  const help = spawnWithQualifyingNode(binEntry, ['--help'])
  assert.equal(help.error, undefined, help.stderr)
  assert.equal(help.status, 0, help.stderr)
  assert.equal(envLoadedViaExecutableEntry(binEntry), true, 'bin/babel.js must initialize env via startCli')
})

test('unix npm-style symlink name dispatches through startCli on normal startup', (t) => {
  requireQualifyingRuntime(t)
  const linkDir = mkdtempSync(join(tmpdir(), 'babel-cli-bin-link-'))
  const symlinkEntry = join(linkDir, 'babel-agent')
  symlinkSync(binEntry, symlinkEntry)
  const help = spawnWithQualifyingNode(symlinkEntry, ['--help'])
  assert.equal(help.error, undefined, help.stderr)
  assert.equal(help.status, 0, help.stderr)
  assert.equal(
    envLoadedViaExecutableEntry(symlinkEntry),
    true,
    'npm-style symlink must initialize env via startCli (argv[1] does not end with babel.js)',
  )
})

test('executable entries keep desktop capability probe before env bootstrap', (t) => {
  requireQualifyingRuntime(t)
  const linkDir = mkdtempSync(join(tmpdir(), 'babel-cli-probe-link-'))
  const symlinkEntry = join(linkDir, 'babel-harness')
  symlinkSync(binEntry, symlinkEntry)
  const probe = spawnSync(
    qualification.execPath,
    [
      '--input-type=module',
      '-e',
      `import { spawnSync } from 'node:child_process';
const entry = ${JSON.stringify(symlinkEntry)};
const credentials = ${JSON.stringify(join(packageRoot, 'must-not-inspect-credentials'))};
process.env.BABEL_PROJECT_CREDENTIALS_DIR = credentials;
process.env.BABEL_LEGACY_CLI_ENV = '1';
const child = spawnSync(${JSON.stringify(qualification.execPath)}, ['--experimental-wasm-modules', entry, '--desktop-capabilities'], {
  cwd: ${JSON.stringify(packageRoot)},
  encoding: 'utf8',
  env: process.env,
});
let capabilities;
try { capabilities = JSON.parse(child.stdout); } catch {}
if (process.env.BABEL_ENV_LOADED !== undefined) process.exit(9);
if ((child.status ?? 1) !== 0 || capabilities?.schemaVersion !== 1) {
  process.stderr.write(child.stderr ?? '');
  process.stderr.write(child.stdout ?? '');
  process.exit(8);
}
process.exit(0);`,
    ],
    { cwd: packageRoot, encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024, timeout: 30_000, windowsHide: true },
  )
  assert.equal(probe.error, undefined, probe.stderr)
  assert.equal(probe.status, 0, probe.stderr || probe.stdout)
})

test('direct dist/index.js entry still uses startCli when invoked as main', (t) => {
  requireQualifyingRuntime(t)
  const help = spawnWithQualifyingNode(distIndex, ['--help'])
  assert.equal(help.error, undefined, help.stderr)
  assert.equal(help.status, 0, help.stderr)
  assert.equal(envLoadedViaExecutableEntry(distIndex), true, 'dist/index.js main entry must load env via startCli')
})
