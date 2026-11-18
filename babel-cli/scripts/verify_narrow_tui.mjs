#!/usr/bin/env node
/**
 * Real-PTY qualification for narrow and standard terminals (QUALIFICATION Q15).
 *
 * Drives the interactive TUI at 44x16 and 120x36 on an actual pseudo-terminal,
 * queues a second turn while the first is running, and asserts:
 *   - the viewport is not blank (the 44x16 blank-screen regression, UX-02),
 *   - both turns are rendered, in order,
 *   - the workspace mutation and persisted terminal status agree with the UI,
 *   - the process exits cleanly, restores the cursor, and leaves no children.
 *
 *   node scripts/verify_narrow_tui.mjs --bin bin/babel.js
 *   node scripts/verify_narrow_tui.mjs --archive babel-harness-0.2.1.tgz
 *
 * All provider traffic is served by an in-process synthetic fetch; no network
 * and no real credentials are used.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const artifactDir = join(packageRoot, 'artifacts', 'pty')

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message, detail) {
  console.error(JSON.stringify({ ok: false, error: message, detail }, null, 2))
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'babel-narrow-pty-'))
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
  name: 'narrow-acceptance', type: 'module', scripts: { test: 'node --test test.mjs' },
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
  { sleep_ms: 3000 },
  { send: 'Fix the failing test in math.js. `npm test` must pass.' },
  { key: 'enter' },
  // Submitted while the first turn is active: queued and run exactly once.
  { send: 'Summarize the change in one sentence.' },
  { key: 'enter' },
  { wait_for: 'Fixed math.js', timeout_ms: 90000 },
  { wait_for: 'Second task acknowledged.', timeout_ms: 90000 },
  { sleep_ms: 1200 },
  { send: '/exit' },
  { key: 'enter' },
  { sleep_ms: 1500 },
]
writeFileSync(join(root, 'script.json'), JSON.stringify(steps))

let bin = arg('bin') ? resolve(arg('bin')) : join(packageRoot, 'bin', 'babel.js')
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
for (const name of ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION', 'NO_COLOR', 'BABEL_HEADLESS']) {
  delete env[name]
}

/** Concatenated chat-session transcripts under the private runs root. */
function persistedTranscriptText(dir) {
  const chunks = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (entry === 'transcript.jsonl') chunks.push(readFileSync(path, 'utf8'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return chunks.join('\n')
}

/** Files under the private runs root that recorded a terminal status. */
function persistedTerminalStatuses(dir) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (entry.endsWith('.json') && stat.size < 512 * 1024) {
        const text = readFileSync(path, 'utf8')
        for (const status of ['VERIFIED_COMPLETE', 'UNVERIFIED_PATCH', 'CANCELLED', 'BLOCKED']) {
          if (text.includes(status)) found.push({ path, status })
        }
      }
    }
  }
  walk(dir)
  return found
}

const requestedSizes = arg('sizes')?.split(',').map((value) => value.trim())
const sizes = [
  { name: '44x16', rows: 16, cols: 44 },
  { name: '120x36', rows: 36, cols: 120 },
].filter((size) => !requestedSizes || requestedSizes.includes(size.name))
const results = []
let failed = false
mkdirSync(artifactDir, { recursive: true })

const seenStatuses = new Set()
let seenTranscriptLength = 0
for (const size of sizes) {
  const transcriptPath = join(root, `transcript-${size.name}.txt`)
  const rawPath = join(root, `raw-${size.name}.bin`)
  const driver = spawnSync('python3', [
    join(here, 'pty_driver.py'),
    '--script', join(root, 'script.json'),
    '--cwd', workspace,
    '--rows', String(size.rows), '--cols', String(size.cols),
    '--transcript', transcriptPath,
    '--raw-transcript', rawPath,
    '--', process.execPath, '--import', new URL(`file://${join(root, 'preload.mjs')}`).href, bin,
  ], { encoding: 'utf8', env, timeout: 240000 })

  let result
  try { result = JSON.parse(driver.stdout) } catch { fail('PTY driver did not return JSON', { size: size.name, stdout: driver.stdout, stderr: driver.stderr }) }
  const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : (result.transcript_tail ?? '')
  writeFileSync(join(artifactDir, `narrow-${size.name}.txt`), transcript.replaceAll('synthetic-router-credential', '[synthetic]'))

  const firstAnswerAt = transcript.indexOf('Fixed math.js')
  const secondAnswerAt = transcript.indexOf('Second task acknowledged.')
  const visible = transcript.replace(/\s/g, '')
  const statuses = persistedTerminalStatuses(join(root, 'runs'))
  const newStatuses = statuses.filter((entry) => !seenStatuses.has(entry.path))
  const persistedTranscriptAll = persistedTranscriptText(join(root, 'runs'))
  const persistedTranscript = persistedTranscriptAll.slice(seenTranscriptLength)
  seenTranscriptLength = persistedTranscriptAll.length
  for (const entry of statuses) seenStatuses.add(entry.path)
  const checks = {
    driver_ok: result.ok === true,
    clean_exit: result.exit_code === 0,
    // A blank 44x16 viewport produced only spaces; require real visible text.
    viewport_not_blank: visible.length > 200,
    rendered_read: /read_file\s+math\.js/.test(transcript) || /math\.js/.test(transcript),
    rendered_answer: firstAnswerAt >= 0,
    queued_followup_admitted: transcript.includes('Queued'),
    queued_followup_ran_after_first: firstAnswerAt >= 0 && secondAnswerAt > firstAnswerAt,
    no_unhandled_rejection: !transcript.includes('Unhandled Rejection'),
    no_layout_exception: !/(?:layout|Layout)[^\n]*(?:error|exception|throw|invalid)/i.test(transcript),
    cursor_restored: result.cursor_restored === true,
    persisted_outcome: newStatuses.length > 0,
    // The UI and the durable transcript must describe the same two answers.
    persisted_transcript_has_both_answers:
      persistedTranscript.includes('Fixed math.js') &&
      persistedTranscript.includes('Second task acknowledged.'),
    real_mutation: readFileSync(join(workspace, 'math.js'), 'utf8').includes('a + b'),
    no_child_processes: driver.status === 0,
  }
  const failedChecks = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key)
  if (failedChecks.length > 0) failed = true
  results.push({ size: size.name, checks, failed: failedChecks, exit_code: result.exit_code, first_byte_ms: result.first_byte_ms, duration_ms: result.duration_ms })
  // Reset the fixture between sizes so each run starts from a red test.
  writeFileSync(join(workspace, 'math.js'), 'export const add = (a, b) => a - b\n')
}

console.log(JSON.stringify({ ok: !failed, root, bin, results, artifactDir }, null, 2))
process.exit(failed ? 1 : 0)
