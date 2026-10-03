// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(packageRoot, '../artifacts/consumer-package')
const scratch = mkdtempSync(join(tmpdir(), 'babel consumer é-'))
const project = join(scratch, 'project 空 space')
const prefix = join(scratch, 'install prefix é')
const user = join(scratch, 'user space')
for (const dir of [output, project, user]) mkdirSync(dir, { recursive: true })
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const guard = resolve(packageRoot, 'scripts/block_consumer_network.mjs')
const npmCli = process.env.npm_execpath
assert.ok(npmCli && existsSync(npmCli), 'Run through npm run test:consumer-artifact')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:BABEL_|OPENCODE_|.*(?:API_KEY|TOKEN|SECRET|PASSWORD)|NODE_OPTIONS|NODE_ENV|CI)$/i.test(key)))
Object.assign(env, { HOME: user, USERPROFILE: user, NODE_ENV: 'production',
  BABEL_CONFIG_DIR: join(scratch, 'config area ü'), BABEL_STATE_DIR: join(scratch, 'state area ü'),
  BABEL_CACHE_DIR: join(scratch, 'cache area ü'), BABEL_DRY_RUN: '1',
  BABEL_ROOT: join(scratch, 'invalid source override'), BABEL_SKIP_RESUME_PICKER: '1',
  TMPDIR: scratch, TMP: scratch, TEMP: scratch })
env.npm_config_cache = process.env.npm_config_cache || join(scratch, 'npm-cache')
const guardedEnv = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` }
const records = []
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: project, env, encoding: 'utf8',
    timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options })
  assert.ifError(result.error)
  assert.ok((options.codes ?? [0]).includes(result.status), `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result
}
function npm(args, options = {}) { return command(process.execPath, [npmCli, ...args], { timeout: 300000, ...options }) }
const installed = join(prefix, 'node_modules', ...pkg.name.split('/'))
const bin = join(installed, pkg.bin['babel-agent'])
const cli = (args, options = {}) => command(process.execPath, [bin, ...args], { env: guardedEnv, ...options })
const json = args => JSON.parse(cli(args, { codes: [0, 1] }).stdout)
function treeDigest(dir) {
  const entries = []
  function walk(path, base = '') {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const rel = base + item.name
      if (item.isDirectory()) walk(join(path, item.name), rel + '/')
      else if (item.isFile()) entries.push([rel, sha(readFileSync(join(path, item.name)))])
    }
  }
  walk(dir)
  return sha(JSON.stringify(entries.sort()))
}
function fixtureSnapshot() {
  const entries = []
  function walk(dir, relative, depth) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      const stat = statSync(path)
      const name = relative + item.name
      entries.push({ path: name, directory: item.isDirectory(), bytes: stat.size, modified: stat.mtimeMs })
      if (item.isDirectory() && depth < 3) walk(path, name + '/', depth + 1)
    }
  }
  for (const entry of readdirSync(project)) if (entry.startsWith('mechanics-')) walk(join(project, entry), entry + '/', 0)
  return entries
}
function readonly(dir, value) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) readonly(path, value)
    const executable = item.isDirectory() || (statSync(path).mode & 0o111) !== 0
    chmodSync(path, value ? (executable ? 0o555 : 0o444) : (executable ? 0o755 : 0o644))
  }
  chmodSync(dir, value ? 0o555 : 0o755)
}
async function tui() {
  const child = spawn(process.execPath, [bin, 'interactive'], { cwd: project, env: guardedEnv, windowsHide: true })
  let transcript = ''
  let sent = false
  const timer = setTimeout(() => child.kill(), 20000)
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.on('error', reject)
      child.on('exit', resolveExit)
      child.stderr.on('data', data => { transcript += data })
      child.stdout.on('data', data => {
        transcript += data
        if (!sent && /babel[^\r\n]*[>❯]|type.*(?:message|help)|Babel session/i.test(transcript)) {
          sent = true
          child.stdin.write('/doctor\n/exit\n')
        }
      })
    })
    assert.equal(code, 0, transcript)
    assert.ok(sent, 'TUI advertised startup before exit was sent')
    assert.match(transcript, /session ended/i)
    assert.match(transcript, /Docker server (?:available|unavailable)/)
    const daemonPid = Number(transcript.match(/Auto-spawned daemon ready\. PID: (\d+)/)?.[1])
    assert.ok(daemonPid > 0, 'Production installed startup spawned its own daemon: ' + transcript)
    assert.throws(() => process.kill(daemonPid, 0), /ESRCH/, 'Owned daemon exited before successful UI termination')
    records.push({ check: 'TUI start/doctor/exit and owned daemon cleanup', status: 'pass', transport: 'pipes; PTY qualification separately recorded' })
  } finally { clearTimeout(timer); child.kill() }
}
try {
  const packOutput = npm(['pack', '--json', '--pack-destination', output], { cwd: packageRoot }).stdout
  const packed = JSON.parse(packOutput.slice(packOutput.indexOf('[\n')))[0]
  const files = packed.files.map(file => file.path).sort()
  for (const path of files) {
    assert.match(path, /^(?:package\.json|README\.md|LICENSE|bin\/babel\.js|dist\/.*\.js|dist\/services\/playbooks\/.*\.json|resources\/.*)$/)
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env[^/]*|node_modules|runs|cache|logs|testinfra|__snapshots__)(?:\/|$)|\.test\.js$|\.(?:map|ts|sqlite|log|tgz)$/)
  }
  assert.ok(files.includes('resources/prompt_catalog.yaml'))
  assert.ok(files.includes('LICENSE'))
  const artifact = join(output, packed.filename)
  const identity = { sourceSha: command('git', ['rev-parse', 'HEAD'], { cwd: packageRoot }).stdout.trim(),
    name: pkg.name, version: pkg.version, node: process.version, platform: process.platform, arch: process.arch,
    tarball: packed.filename, sha256: sha(readFileSync(artifact)), manifest: packed.files }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(identity, null, 2) + '\n')
  writeFileSync(join(output, 'SHA256SUMS'), `${identity.sha256}  ${packed.filename}\n`)
  npm(['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', artifact])
  assert.ok(!existsSync(join(prefix, 'node_modules/tsx')), 'No development runner installed')
  const original = treeDigest(installed)
  readonly(installed, true)
  if (process.platform !== 'win32') assert.throws(() => writeFileSync(join(installed, 'write-probe'), 'denied'), { code: 'EACCES' })
  assert.match(cli(['--help']).stdout, /Babel|babel-agent/)
  assert.equal(cli(['--version']).stdout.trim(), pkg.version)
  const shim = join(prefix, process.platform === 'win32' ? 'node_modules/.bin/babel-agent.cmd' : 'node_modules/.bin/babel-agent')
  assert.ok(existsSync(shim), 'npm installed the unambiguous executable')
  const shimVersion = process.platform === 'win32'
    ? command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`], { env: guardedEnv, windowsVerbatimArguments: true })
    : command(shim, ['--version'], { env: guardedEnv })
  assert.equal(shimVersion.stdout.trim(), pkg.version)
  const setup = json(['setup', '--json'])
  assert.equal(setup.mutates_workspace, false)
  const doctor = json(['doctor', '--json'])
  assert.ok(doctor.checks.some(check => /docker/i.test(check.id)), 'Docker diagnostic included')
  assert.ok(doctor.checks.some(check => /provider/i.test(check.id) && check.status !== 'pass'), 'Missing provider diagnosed')
  assert.ok(!doctor.checks.some(check => /powershell|workspace.?map|sibling/i.test(check.id)))
  writeFileSync(join(project, 'README.md'), 'Synthetic installed context, café 空\n')
  const context = json(['context', 'preview', '@file', 'README.md', '--json'])
  assert.match(JSON.stringify(context), /Synthetic installed context/)
  const stack = json(['resolve', '--task-category', 'backend', '--project', 'global', '--json'])
  assert.ok(!stack.error, JSON.stringify(stack))
  const mcp = json(['mcp', 'add', 'consumer-fixture', 'node', '--json'])
  assert.equal(mcp.status, 'ok')
  assert.equal(mcp.config_path, join(env.BABEL_CONFIG_DIR, 'mcp_servers.json'))
  assert.equal(json(['mcp', 'remove', 'consumer-fixture', '--json']).status, 'ok')
  assert.equal(json(['plugins', 'disable', 'consumer-fixture', '--json']).status, 'ok')
  assert.ok(existsSync(join(env.BABEL_CONFIG_DIR, 'plugins.json')))
  // Built-in operations are scripted; no provider or child inference is involved.
  const spec = join(scratch, 'agent-team.json')
  writeFileSync(spec, JSON.stringify({ schema_version: 1, id: 'consumer-team', project_root: project,
    isolation: 'copy', agents: [{ id: 'reviewer', role: 'reviewer', task: 'Record a fixture note',
      allowed_tools: ['file_read'], disallowed_tools: ['file_write'], write_scope: [],
      merge_strategy: 'review_only', operations: [{ type: 'note', note: 'No write needed.' }] }] }))
  const team = json(['agents', 'run', spec, '--json'])
  assert.equal(team.status, 'no_changes', JSON.stringify(team))
  assert.ok(team.agents.every(agent => agent.status === 'success' && agent.changed_files.length === 0))
  assert.ok(existsSync(join(env.BABEL_STATE_DIR, 'runs/agents')))
  const mcpRequest = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'babel_catalog_inspect', arguments: {} } })
  const framed = `Content-Length: ${Buffer.byteLength(mcpRequest)}\r\n\r\n${mcpRequest}`
  const mcpOutput = cli(['mcp', 'serve'], { input: framed }).stdout
  assert.match(mcpOutput, /^Content-Length: \d+\r\n\r\n/)
  const catalogReply = JSON.parse(mcpOutput.slice(mcpOutput.indexOf('\r\n\r\n') + 4))
  assert.ok(catalogReply.result && !catalogReply.result.isError, JSON.stringify(catalogReply))
  const missing = cli(['run', '--mode', 'chat-headless', 'Explain this synthetic project', '--json'], { codes: [1] })
  assert.match(missing.stdout + missing.stderr, /credential|API.key|provider|model/i)
  assert.doesNotMatch(missing.stdout + missing.stderr, /Add it to babel-cli\/\.env/)
  cli(['skill', 'create', 'preview-fixture'], { codes: [1] })
  assert.match(cli(['run', '--benchmark', 'fixture'], { codes: [1] }).stderr, /contributor checkout/)
  cli(['dry', 'on', '--json'])
  assert.ok(existsSync(join(env.BABEL_CONFIG_DIR, 'runtime-flags.json')))
  await tui()
  const stateProbe = join(scratch, 'state-probe.mjs')
  const installedModule = relativePath => JSON.stringify(pathToFileURL(join(installed, relativePath)).href)
  writeFileSync(stateProbe, `
    import assert from 'node:assert/strict';
    import {saveSessionState,loadSessionState} from ${installedModule('dist/interactive/session.js')};
    import {resolveTokenDbPath,TokenHistoryDb} from ${installedModule('dist/services/tokenHistoryDb.js')};
    import {resolveMemoryRoot} from ${installedModule('dist/services/memory/memoryStore.js')};
    saveSessionState({state:{mode:'chat'},turnCounter:0});
    assert.equal(loadSessionState()?.mode,'chat');
    assert.equal(resolveTokenDbPath(), ${JSON.stringify(join(env.BABEL_STATE_DIR, 'token_history.db'))});
    const db = new TokenHistoryDb();
    db.recordTurn('consumer-fixture',Date.now(),1,1,0,'scripted',${JSON.stringify(project)});
    db.close();
    assert.ok(resolveMemoryRoot(${JSON.stringify(project)})?.startsWith(${JSON.stringify(join(env.BABEL_STATE_DIR, 'projects'))}));
  `)
  command(process.execPath, [stateProbe], { env: guardedEnv })
  assert.ok(existsSync(join(env.BABEL_STATE_DIR, 'session.json')))
  assert.ok(existsSync(join(env.BABEL_STATE_DIR, 'token-history.json')))
  assert.ok(existsSync(join(env.BABEL_STATE_DIR, 'token_history.db')))
  assert.ok(!existsSync(join(user, '.babel')), 'State override was genuinely distinct from HOME')
  // Separate child avoids source-package resolution and installs the guard before any runtime import.
  const runner = join(scratch, 'journey.mjs')
  writeFileSync(runner, `import {runInstalledMechanics} from ${JSON.stringify(pathToFileURL(join(packageRoot,'scripts/installed_mechanics.mjs')).href)};\nconsole.log('MECHANICS_RESULT '+JSON.stringify(await runInstalledMechanics(${JSON.stringify(installed)},${JSON.stringify(project)})));\n`)
  const mechanics = command(process.execPath, [runner], { env: guardedEnv })
  const evidence = JSON.parse(mechanics.stdout.match(/MECHANICS_RESULT (.+)/)?.[1] ?? 'null')
  assert.ok(evidence, mechanics.stdout)
  const fixtureBeforeCleanup = fixtureSnapshot()
  // One owner removes the exact fixture after the child exits and releases its handles.
  assert.equal(dirname(evidence.fixtureRoot), realpathSync(project), 'Fixture belongs to this private target')
  assert.ok(basename(evidence.fixtureRoot).startsWith('mechanics-'))
  assert.ok(existsSync(evidence.fixtureRoot), 'Child retains its fixture for parent-owned cleanup')
  rmSync(evidence.fixtureRoot, { recursive: true, maxRetries: 5, retryDelay: 100 })
  assert.ok(!readdirSync(project).some(entry => entry.startsWith('mechanics-')), JSON.stringify({ phase: 'immediate fixture cleanup', fixtureBeforeCleanup, remaining: fixtureSnapshot() }))
  records.push({ check: 'scripted installed mechanics', status: 'pass', evidence })
  assert.equal(treeDigest(installed), original, 'Installation remained immutable')
  assert.ok(!existsSync(env.BABEL_ROOT), 'Installed operation ignored the source-root override for state')
  readonly(installed, false)
  const saved = readFileSync(join(env.BABEL_CONFIG_DIR, 'runtime-flags.json'), 'utf8')
  npm(['uninstall', '--prefix', prefix, '--no-audit', '--no-fund', pkg.name])
  assert.ok(!existsSync(installed))
  assert.equal(readFileSync(join(env.BABEL_CONFIG_DIR, 'runtime-flags.json'), 'utf8'), saved)
  npm(['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', artifact])
  assert.equal(cli(['--version']).stdout.trim(), pkg.version)
  assert.equal(readFileSync(join(env.BABEL_CONFIG_DIR, 'runtime-flags.json'), 'utf8'), saved)
  assert.deepEqual(readdirSync(project).sort(), ['.babel_history', 'README.md'].filter(path => existsSync(join(project, path))).sort(), JSON.stringify({ phase: 'after reinstall', fixtureBeforeCleanup, remaining: fixtureSnapshot() }))
  records.push({ check: 'consumer commands, immutable install, isolated state, uninstall/reinstall', status: 'pass' },
    { check: 'read-only installation enforcement', status: process.platform === 'win32' ? 'not qualified' : 'pass', reason: process.platform === 'win32' ? 'chmod does not establish Windows ACL restrictions; immutable digest checked' : 'OS denied write probe' },
    { check: 'live-model quality', status: 'not run', reason: 'Scored provider route/credentials/protocol pending; scripted mechanics only' },
    { check: 'native vectors', status: 'optional', reason: 'sqlite-vec availability depends on OS/architecture' })
  writeFileSync(join(output, 'verification.json'), JSON.stringify({ ...identity, checks: records, doctor }, null, 2) + '\n')
  console.log(JSON.stringify({ tarball: packed.filename, sha256: identity.sha256, sourceSha: identity.sourceSha, checks: records }, null, 2))
} finally {
  if (existsSync(installed)) readonly(installed, false)
  rmSync(scratch, { recursive: true, force: true })
}
