// Run from a built source checkout: node docs/assets/showcase/capture-offline.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const folder = dirname(fileURLToPath(import.meta.url))
const root = resolve(folder, '../../..')
const cli = join(root, 'babel-cli/dist/index.js')
assert.ok(existsSync(cli), 'Build first: npm --prefix babel-cli run build')
const sandbox = mkdtempSync(join(tmpdir(), 'babel-showcase-'))
const env = {
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: join(sandbox, 'home'), USERPROFILE: join(sandbox, 'home'),
  XDG_CACHE_HOME: join(sandbox, 'xdg-cache'),
  XDG_CONFIG_HOME: join(sandbox, 'xdg-config'),
  XDG_DATA_HOME: join(sandbox, 'xdg-data'),
  BABEL_ROOT: root,
  BABEL_CONFIG_DIR: join(sandbox, 'config'),
  BABEL_STATE_DIR: join(sandbox, 'state'),
  BABEL_CACHE_DIR: join(sandbox, 'cache'),
  BABEL_RUNS_DIR: join(sandbox, 'runs'),
  BABEL_PROJECT_ROOT: join(sandbox, 'project'),
  BABEL_TESTS_ALLOW_INFERENCE: '0',
  NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', COLUMNS: '100',
}
for (const value of Object.entries(env).filter(([key]) =>
  /^(HOME|USERPROFILE|XDG_|BABEL_(CONFIG|STATE|CACHE|RUNS|PROJECT))/.test(key)
).map(([, value]) => value)) mkdirSync(value, { recursive: true })
const normalize = text => {
  for (const [path, label] of [[root, '<BABEL_SOURCE>'], [dirname(root), '<WORKSPACE>'], [sandbox, '<TEMPORARY_PROFILE>']]) {
    text = text.replaceAll(JSON.stringify(path).slice(1, -1), label).replaceAll(path, label)
  }
  return text
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
assert.equal(revision.status, 0, 'Cannot establish source revision')
const commands = []
const execute = (args, file) => {
  const result = spawnSync(process.execPath, ['--import', join(folder, 'offline-guard.mjs'), cli, ...args], {
    cwd: env.BABEL_PROJECT_ROOT, env, encoding: 'utf8', timeout: 60_000,
  })
  if (result.error) throw new Error(`Capture command could not run: ${result.error.code ?? result.error.name}`)
  assert.equal(result.status, 0, `Capture command failed: ${args.join(' ')} (exit ${result.status})`)
  const diagnostics = normalize(result.stderr).trim().replace(/\(node:\d+\)/g, '(node:<PID>)')
  assert.ok(!diagnostics || /^\(node:<PID>\) ExperimentalWarning: Importing WebAssembly module instances is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/.test(diagnostics),
    'Unexpected command diagnostics; inspect locally before publishing')
  const output = normalize(result.stdout).replace(/\n+$/, '\n')
  writeFileSync(join(folder, file), output)
  let stderr
  if (diagnostics) {
    stderr = `${file}.stderr.txt`
    writeFileSync(join(folder, stderr), diagnostics + '\n')
  }
  commands.push({ argv: ['node', '--import', '<BABEL_SOURCE>/docs/assets/showcase/offline-guard.mjs', '<BABEL_SOURCE>/babel-cli/dist/index.js', ...args], cwd: '<TEMPORARY_PROFILE>/project', exitCode: result.status, stdout: file, sha256: hash(join(folder, file)),
    ...(stderr ? { stderr, stderrSha256: hash(join(folder, stderr)) } : {}) })
  return output
}
try {
  const version = execute(['--version'], 'version.txt').trim()
  const help = execute(['--help'], 'help.txt')
  assert.ok(help.includes('interactive'), 'Expected interactive entrypoint in help')
  assert.ok(help.includes('plan'), 'Expected Plan entrypoint in help')
  assert.ok(help.includes('deep'), 'Expected Deep entrypoint in help')
  execute(['doctor', '--scope', 'env'], 'doctor.txt')
  const doctorText = execute(['doctor', '--scope', 'env', '--json'], 'doctor.json')
  const doctor = JSON.parse(doctorText)
  assert.equal(doctor.scope, 'env')
  const credentialCheck = doctor.checks.find(check => check.id === 'env.provider.any_key_present')
  assert.equal(credentialCheck?.status, 'warn', 'Credentials must be absent in this isolated demo')
  const packageJson = JSON.parse(readFileSync(join(root, 'babel-cli/package.json'), 'utf8'))
  writeFileSync(join(folder, 'capture.json'), JSON.stringify({
    schemaVersion: 1, capturedAt: new Date().toISOString(),
    sourceRepository: 'https://github.com/gthgomez/Babel', sourceRevision: revision.stdout.trim(),
    packageName: packageJson.name, packageVersion: packageJson.version, reportedVersion: version,
    nodeVersion: process.version, platform: process.platform,
    captureKind: 'paced playback of real offline CLI stdout; no model session',
    isolation: 'Temporary home, project, config, state, cache, and runs; allowlisted environment without credentials; network-denying preload',
    pathNormalization: ['source checkout => <BABEL_SOURCE>', 'parent workspace => <WORKSPACE>', 'temporary profile => <TEMPORARY_PROFILE>', 'Node executable => node', 'Node warning process ID => <PID>', 'trailing blank lines => one final newline'],
    sourceEntrySha256: hash(cli), networkGuardSha256: hash(join(folder, 'offline-guard.mjs')),
    captureScriptSha256: hash(fileURLToPath(import.meta.url)),
    commands, doctorStatus: doctor.status, doctorSummary: doctor.summary,
  }, null, 2) + '\n')
  console.log(`Captured Babel ${version}: help, version, and environment doctor (${doctor.status}).`)
  console.log('No credentials, provider calls, code edits, or verification of a coding task.')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
