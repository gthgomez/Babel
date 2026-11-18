// W11 UX-03: daemon lifecycle notices and ownership must never corrupt the
// machine-readable envelope of a JSON command, and a background queue request
// must not hold the foreground CLI open or leak an unowned daemon.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cliEntry = fileURLToPath(new URL('../index.ts', import.meta.url))
const CREDENTIAL_NAMES = [
  'OPENROUTER_API_KEY', 'DEEPINFRA_API_KEY', 'DEEPSEEK_API_KEY', 'COMMAND_CODE_API_KEY',
  'BABEL_OPENCODE_GO_API_KEY', 'BABEL_COMPACTION_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENCODE_API_KEY',
  'BABEL_COMPATIBLE_API_KEY', 'DEEPINFRA_TOKEN',
]

/** Isolate the daemon socket, pid/state roots and provider credentials. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-w11-daemon-json-'))
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of CREDENTIAL_NAMES) delete env[name]
  delete env['BABEL_DAEMON']; delete env['BABEL_DESKTOP_IPC']; delete env['BABEL_DESKTOP_CREDENTIALS_RESOLVED']
  Object.assign(env, {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    BABEL_STATE_DIR: join(root, 'state'),
    BABEL_RUNS_DIR: join(root, 'runs'),
    BABEL_OPENCLAW_APPROVED_ROOTS: root,
    BABEL_DAEMON_ENABLED: 'true',
    BABEL_DAEMON_AUTO_SPAWN_TIMEOUT_MS: '20000',
    BABEL_OFFLINE: '1',
  })
  writeFileSync(join(root, 'a.js'), 'export const value = 1\n')
  for (const dir of ['home', 'tmp']) mkdirSync(join(root, dir), { recursive: true })
  return { root, env, pidFile: join(root, 'runs', 'daemon', 'daemon.pid') }
}

async function stopDaemon(pidFile: string): Promise<void> {
  let pid = 0
  try { pid = Number(readFileSync(pidFile, 'utf8').trim()) } catch { return }
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cliEntry, ...args], {
    cwd, env, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  })
}

test('exec --background --json keeps daemon notices off stdout, exits promptly, and leaves one owned daemon', { timeout: 90_000 }, async () => {
  const fixtureRoot = fixture()
  try {
    const started = Date.now()
    const child = runCli(['exec', 'Inspect a.js', '--background', '--json'], fixtureRoot.root, fixtureRoot.env)
    const elapsed = Date.now() - started
    assert.equal(child.error, undefined)
    assert.equal(child.status, 0, child.stderr.slice(-2_000))
    assert.doesNotMatch(String(child.stdout), /^\s*\[/, 'stdout must begin with its JSON envelope')
    assert.equal(JSON.parse(String(child.stdout)).status, 'queued')
    assert.doesNotMatch(String(child.stdout), /\[daemon\]|Auto-spawned/, 'daemon notices belong on stderr')
    assert.ok(elapsed < 30_000, `the foreground CLI must settle instead of waiting on its daemon (elapsed ${elapsed}ms)`)
    assert.equal(existsSync(fixtureRoot.pidFile), true, 'the background daemon must be running')
    const pid = Number(readFileSync(fixtureRoot.pidFile, 'utf8').trim())
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    assert.doesNotThrow(() => process.kill(pid, 0), 'the daemon is detached and still owns its process')
    if (process.platform !== 'win32') {
      const logPath = join(fixtureRoot.root, 'runs', 'daemon', 'daemon.log')
      assert.equal(existsSync(logPath), true, 'the detached daemon keeps its output in the daemon directory')
      assert.equal(statSync(logPath).mode & 0o077, 0, 'the daemon log is private to the user')
    }
  } finally {
    await stopDaemon(fixtureRoot.pidFile)
    rmSync(fixtureRoot.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('deep --json rejects quarantined daemon execution as parseable JSON without spawning a daemon', { timeout: 90_000 }, async () => {
  const fixtureRoot = fixture()
  try {
    const child = runCli(['deep', 'Inspect a.js', '--project-root', fixtureRoot.root, '--json'], fixtureRoot.root, fixtureRoot.env)
    assert.equal(child.error, undefined)
    assert.equal(child.status, 1)
    const payload = JSON.parse(String(child.stdout))
    assert.equal(payload.status, 'EXECUTOR_HALTED')
    assert.match(String(payload.error), /UNSUPPORTED_OPERATION.*quarantined/)
    assert.equal(existsSync(fixtureRoot.pidFile), false, 'the daemon path must be rejected before spawn')
  } finally {
    await stopDaemon(fixtureRoot.pidFile)
    rmSync(fixtureRoot.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('a detached daemon spawn error fails fast with the daemon log location', { timeout: 60_000 }, async () => {
  const fixtureRoot = fixture()
  try {
    const clientUrl = new URL('./client.ts', import.meta.url).href
    const script = `
      const { EventEmitter } = await import('node:events')
      const { daemonAutoSpawn } = await import(${JSON.stringify(clientUrl)})
      const child = new EventEmitter()
      Object.assign(child, { stdio: [], exitCode: null, unref() {}, kill() {} })
      setTimeout(() => child.emit('error', new Error('synthetic daemon spawn failure')), 50)
      try {
        await daemonAutoSpawn({ spawnProcess: () => child })
        console.log('UNEXPECTED_SUCCESS')
      } catch (error) {
        console.log('REJECTED:' + error.message)
      }
    `
    const child = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
      cwd: fixtureRoot.root, env: fixtureRoot.env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    })
    assert.equal(child.error, undefined)
    assert.equal(child.status, 0, String(child.stderr).slice(-2_000))
    assert.doesNotMatch(String(child.stdout), /UNEXPECTED_SUCCESS/)
    assert.match(String(child.stdout), /REJECTED:.*synthetic daemon spawn failure/s)
    assert.match(String(child.stdout), /Daemon log: .*daemon\.log/)
  } finally {
    await stopDaemon(fixtureRoot.pidFile)
    rmSync(fixtureRoot.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
