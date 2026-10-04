/** Synthetic provider tests use a fresh process; no host credentials enter it. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, delimiter, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const fixtureKey = 'BABEL_SYNTHETIC_PROVIDER_FIXTURE_ROOT'
const readyKey = Symbol.for('babel.syntheticProviderFixture.ready')
const babelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const helperBytes = "process.stdout.write('synthetic-go-credential')\n"
const ownedRoots = new Map()
const allowedNames = new Set([
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
  'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'BABEL_ROOT', 'BABEL_CONFIG_DIR',
  'BABEL_STATE_DIR', 'BABEL_CACHE_DIR', 'BABEL_RUNS_DIR', 'BABEL_PROJECT_ROOT',
  'BABEL_OPENCODE_GO_HELPER', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY',
  fixtureKey, 'NODE_TEST_CONTEXT', 'FORCE_COLOR',
])

/** Project only scalar test facts; arbitrary child output never reaches diagnostics. */
export function summarizeSyntheticProviderOutput(output, code) {
  const count = label => {
    const matches = [...String(output).matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, 'gm'))]
    return matches.length ? Number(matches.at(-1)[1]) : null
  }
  return JSON.stringify({
    exitCode: Number.isInteger(code) ? code : null,
    tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'),
    isolationRejected: String(output).includes('SYNTHETIC_PROVIDER_FIXTURE_ISOLATION_INVALID'),
    networkDispatchBlocked: String(output).includes('SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED'),
  })
}

/** Build an allowlisted environment without copying or enumerating host secrets. */
export function prepareSyntheticProviderFixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-synthetic-provider-'))
  ownedRoots.set(root, realpathSync(root))
  for (const name of ['home', 'config', 'state', 'cache', 'runs', 'tmp', 'workspace']) {
    mkdirSync(join(root, name))
  }
  const helper = join(root, 'auth-helper.cjs')
  writeFileSync(helper, helperBytes)
  const systemRoot = process.platform === 'win32'
    ? process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows'
    : undefined
  const env = {
    PATH: [dirname(process.execPath), ...(systemRoot ? [join(systemRoot, 'System32')] : [])].join(delimiter),
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    BABEL_ROOT: babelRoot, BABEL_CONFIG_DIR: join(root, 'config'),
    BABEL_STATE_DIR: join(root, 'state'), BABEL_CACHE_DIR: join(root, 'cache'),
    BABEL_RUNS_DIR: join(root, 'runs'), BABEL_PROJECT_ROOT: join(root, 'workspace'),
    BABEL_OPENCODE_GO_HELPER: helper,
    OPENROUTER_API_KEY: 'synthetic-router-credential',
    DEEPSEEK_API_KEY: 'synthetic-deepseek-credential',
    [fixtureKey]: root,
  }
  if (systemRoot) {
    env.SystemRoot = systemRoot
    env.WINDIR = systemRoot
    env.ComSpec = join(systemRoot, 'System32', 'cmd.exe')
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
  }
  return { root, cwd: join(root, 'workspace'), env }
}

/** Remove only the unchanged absolute fixture directory created by this process. */
export function removeSyntheticProviderFixture(root) {
  requireCondition(isAbsolute(root) && ownedRoots.get(root) === realpathSync(root))
  requireCondition(/babel-synthetic-provider-[^\\/]+$/.test(root))
  rmSync(root, { recursive: true, force: true })
  ownedRoots.delete(root)
}

function requireCondition(condition) {
  if (!condition) throw new Error('SYNTHETIC_PROVIDER_FIXTURE_ISOLATION_INVALID')
}

function insideRoot(root, target) {
  const rel = relative(realpathSync(root), realpathSync(target))
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

function installFixtureBoundary() {
  const root = process.env[fixtureKey]
  if (root === undefined) return
  requireCondition(isAbsolute(root) && dirname(root) !== root && /babel-synthetic-provider-[^\\/]+$/.test(root))
  // Windows injects these identity/home variables even into an explicit child
  // environment. Remove them before Babel imports; fresh USERPROFILE/HOME are
  // still validated below. Other unexpected fields, including credentials,
  // remain fail-closed instead of being silently discarded.
  if (process.platform === 'win32') {
    for (const name of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME']) {
      delete process.env[name]
    }
  }
  for (const name of Object.keys(process.env)) requireCondition(allowedNames.has(name.toUpperCase()))
  const paths = {
    HOME: 'home', USERPROFILE: 'home', APPDATA: 'config', LOCALAPPDATA: 'state',
    XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache',
    TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp', BABEL_CONFIG_DIR: 'config',
    BABEL_STATE_DIR: 'state', BABEL_CACHE_DIR: 'cache', BABEL_RUNS_DIR: 'runs',
    BABEL_PROJECT_ROOT: 'workspace',
  }
  for (const [name, suffix] of Object.entries(paths)) {
    requireCondition(process.env[name] === join(root, suffix) && insideRoot(root, join(root, suffix)))
  }
  requireCondition(process.env['BABEL_ROOT'] === babelRoot)
  requireCondition(process.env['OPENROUTER_API_KEY'] === 'synthetic-router-credential')
  requireCondition(process.env['DEEPSEEK_API_KEY'] === 'synthetic-deepseek-credential')
  requireCondition(process.env['BABEL_OPENCODE_GO_HELPER'] === join(root, 'auth-helper.cjs'))
  requireCondition(insideRoot(root, join(root, 'auth-helper.cjs')))
  requireCondition(readFileSync(join(root, 'auth-helper.cjs'), 'utf8') === helperBytes)
  const denied = () => { throw new Error('SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED') }
  globalThis.fetch = async () => denied()
  // Fetch mocks may replace only the fixture fetch; alternate HTTP/socket paths stay denied.
  http.request = denied
  http.get = denied
  https.request = denied
  https.get = denied
  net.connect = denied
  net.createConnection = denied
  net.Socket.prototype.connect = denied
  tls.connect = denied
  syncBuiltinESMExports()
  globalThis[readyKey] = true
}

/** Refuse Babel imports unless the child bootstrap verified its fixture boundary. */
export function isSyntheticProviderFixtureReady() {
  return globalThis[readyKey] === true
}

installFixtureBoundary()
