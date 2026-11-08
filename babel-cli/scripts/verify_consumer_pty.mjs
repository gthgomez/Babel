#!/usr/bin/env node
/**
 * Real PTY acceptance for the installed CLI's default Chat TUI.
 *
 * Launches the packed/installed executable on an actual pseudo-terminal,
 * drives a read → edit → verify turn, resizes mid-turn, exits, and asserts the
 * observed terminal output and the real workspace mutation. Artifacts are
 * written under artifacts/pty/.
 *
 *   node scripts/verify_consumer_pty.mjs --bin bin/babel.js
 *   node scripts/verify_consumer_pty.mjs --archive babel-harness-0.2.1.tgz
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const artifactDir = join(repoRoot, 'artifacts', 'pty')

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message, detail) {
  console.error(JSON.stringify({ ok: false, error: message, detail }, null, 2))
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'babel-pty-accept-'))
const workspace = join(root, 'workspace')
for (const dir of ['home', 'config', 'state', 'cache', 'runs', 'workspace']) {
  mkdirSync(join(root, dir), { recursive: true })
}
writeFileSync(join(root, 'state', 'preferences.json'), JSON.stringify({
  schemaVersion: 1,
  connections: {
    openrouter: {
      id: 'openrouter', provider: 'openrouter', model: 'glm-5.3-flash',
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
    },
  },
  defaults: { connection: 'openrouter', model: 'glm-5.3-flash' },
  setup: { completed: true },
}))

const git = (args) => {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' })
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`, result.stderr)
}
git(['init', '-q'])
git(['config', 'user.email', 'accept@example.test'])
git(['config', 'user.name', 'Acceptance'])
writeFileSync(join(workspace, 'package.json'), JSON.stringify({
  name: 'pty-acceptance', type: 'module', scripts: { test: 'node --test test.mjs' },
}, null, 2))
writeFileSync(join(workspace, 'math.js'), 'export const add = (a, b) => a - b\n')
writeFileSync(join(workspace, 'test.mjs'), [
  "import test from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { add } from './math.js'",
  "test('adds', () => assert.equal(add(1, 2), 3))",
  '',
].join('\n'))
git(['add', '.'])
git(['commit', '-qm', 'fixture'])

writeFileSync(join(root, 'preload.mjs'), `
globalThis.__calls = 0
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  const n = ++globalThis.__calls
  const tool = (name, args) => ({ index: 0, id: 'native-' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  let delta, finish
  if (n === 1) { delta = { tool_calls: [tool('read_file', { path: 'math.js' })] }; finish = 'tool_calls' }
  else if (n === 2) { delta = { tool_calls: [tool('str_replace', { file_path: 'math.js', old_str: 'a - b', new_str: 'a + b' })] }; finish = 'tool_calls' }
  else if (n === 3) { delta = { tool_calls: [tool('test_run', { command: 'npm test' })] }; finish = 'tool_calls' }
  else if (n === 4) { delta = { content: 'Fixed math.js and ran npm test.' }; finish = 'stop' }
  else { delta = { content: 'Second task acknowledged.' }; finish = 'stop' }
  if (body.stream) return new Response('data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
  return Response.json({ model: body.model, choices: [{ message: { role: 'assistant', content: delta.content ?? '' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
}
`)

const steps = [
  { sleep_ms: 2500 },
  { send: 'Fix the failing test in math.js. `npm test` must pass.' },
  { key: 'enter' },
  // Submitted while the first turn is active: the shell must queue it and run
  // it exactly once after the first turn settles.
  { send: 'Summarize the change in one sentence.' },
  { key: 'enter' },
  { wait_for: 'Fixed math.js', timeout_ms: 90000 },
  { wait_for: 'Second task acknowledged.', timeout_ms: 90000 },
  { sleep_ms: 1500 },
  { resize: [30, 120] },
  { sleep_ms: 800 },
  { resize: [40, 160] },
  { sleep_ms: 800 },
  { send: '/exit' },
  { key: 'enter' },
  { sleep_ms: 1500 },
]
writeFileSync(join(root, 'script.json'), JSON.stringify(steps))

let bin = arg('bin') ? resolve(arg('bin')) : join(repoRoot, 'bin', 'babel.js')
const archive = arg('archive')
if (archive) {
  const prefix = join(root, 'install')
  const installed = spawnSync('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', resolve(archive)], { encoding: 'utf8' })
  if (installed.status !== 0) fail('npm install of archive failed', installed.stderr)
  bin = join(prefix, 'node_modules', 'babel-harness', 'bin', 'babel.js')
}
if (!existsSync(bin)) fail(`CLI entry not found: ${bin}`)

const env = {
  ...process.env,
  HOME: join(root, 'home'),
  BABEL_CONFIG_DIR: join(root, 'config'),
  BABEL_STATE_DIR: join(root, 'state'),
  BABEL_CACHE_DIR: join(root, 'cache'),
  BABEL_RUNS_DIR: join(root, 'runs'),
  BABEL_PROJECT_ROOT: workspace,
  BABEL_ALLOW_HOST_FALLBACK: '1',
  BABEL_LIVE: 'true',
  OPENROUTER_API_KEY: 'synthetic-router-credential',
  TERM: 'xterm-256color',
}
// This is a real PTY journey. A CI/headless marker inherited from the runner
// would deliberately select the non-interactive fallback and hide the very
// renderer, composer queue and tool cells this test exists to qualify.
for (const name of ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION', 'NO_COLOR', 'BABEL_HEADLESS']) {
  delete env[name]
}
const driver = spawnSync('python3', [
  join(here, 'pty_driver.py'),
  '--script', join(root, 'script.json'),
  '--cwd', workspace,
  '--rows', '24', '--cols', '80',
  '--transcript', join(root, 'transcript.txt'),
  '--', process.execPath, '--import', new URL(`file://${join(root, 'preload.mjs')}`).href, bin,
], { encoding: 'utf8', env, timeout: 180000 })

let result
try { result = JSON.parse(driver.stdout) } catch { fail('PTY driver did not return JSON', { stdout: driver.stdout, stderr: driver.stderr }) }
const transcript = existsSync(join(root, 'transcript.txt'))
  ? readFileSync(join(root, 'transcript.txt'), 'utf8')
  : result.transcript_tail ?? ''
mkdirSync(artifactDir, { recursive: true })
writeFileSync(join(artifactDir, 'chat-journey.json'), JSON.stringify({ ...result, root, bin }, null, 2))
if (existsSync(join(root, 'transcript.txt'))) {
  writeFileSync(join(artifactDir, 'chat-journey.txt'), readFileSync(join(root, 'transcript.txt'), 'utf8'))
}

const firstAnswerAt = transcript.indexOf('Fixed math.js')
const secondAnswerAt = transcript.indexOf('Second task acknowledged.')
const checks = {
  driver_ok: result.ok === true,
  clean_exit: result.exit_code === 0,
  // first_output_ms is now the first rendered byte, not answer arrival.
  first_byte_measured: Number.isFinite(result.first_byte_ms) && result.first_byte_ms >= 0 && result.first_byte_ms < 8000,
  first_byte_before_answer: result.answer_ms === null || result.first_byte_ms <= result.answer_ms,
  rendered_read: /read_file\s+math\.js/.test(transcript),
  rendered_edit: /str_replace\s+math\.js/.test(transcript),
  rendered_verifier: /test_run\s+npm test/.test(transcript),
  rendered_answer: firstAnswerAt >= 0,
  completion_status_visible: /(VERIFIED_COMPLETE|UNVERIFIED_PATCH|Complete\s+—\s+(?:verified|unverified)|Unverified model response)/i.test(transcript),
  queued_followup_admitted: transcript.includes('Queued (Tab)'),
  // A queued message must run after the active turn settles, not inside it.
  queued_followup_ran_after_first: firstAnswerAt >= 0 && secondAnswerAt > firstAnswerAt,
  resize_applied: result.events.some(event => event.resize?.[1] === 160) &&
    result.events.some(event => event.resize?.[1] === 120),
  cursor_restored: result.cursor_restored === true,
  no_unhandled_rejection: !transcript.includes('Unhandled Rejection'),
  real_mutation: readFileSync(join(workspace, 'math.js'), 'utf8').includes('a + b'),
  verifier_not_dry_run: !transcript.includes('[DRY RUN] Would run tests'),
}
const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key)
const summary = {
  ok: failed.length === 0,
  bin,
  first_output_ms: result.first_output_ms,
  answer_ms: result.answer_ms,
  duration_ms: result.duration_ms,
  checks,
  failed,
  artifact: join(artifactDir, 'chat-journey.json'),
}
console.log(JSON.stringify(summary, null, 2))
if (failed.length > 0) process.exit(1)
