#!/usr/bin/env node
/** Offline installed-CLI verification replays. The grader never runs in the agent workspace. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [executable, scenario, evidenceDir] = process.argv.slice(2)
const scenarios = ['warehouse', 'wrong-add', 'wrong-domain', 'right-add', 'prohibited', 'resume']
assert.ok(executable && scenarios.includes(scenario),
  `usage: node scripts/replay_consumer_verification.mjs <installed babel> <${scenarios.join('|')}> [evidence directory]`)
const babel = resolve(executable)
const root = mkdtempSync(join(tmpdir(), 'babel-verification-replay-'))
const workspace = join(root, 'workspace')
const profile = join(root, 'state')
const runs = join(root, 'runs')
const grader = join(root, 'grader')
const model = 'glm-5.3-flash'
const exporterCommand = 'python3 export_warehouse.py warehouse.json warehouse.csv'
const warehousePrompt = 'Add export_warehouse.py, a Python 3 standard-library CLI taking an input JSON file and an output CSV path. It should export every record in warehouse.json, sorted by warehouse and then sku (ascending exact string order), with the headers warehouse,sku,quantity,notes in that order. Use UTF-8 and LF line endings. Keep zero quantities, empty notes, commas, quotes, embedded line breaks, and non-ASCII text intact using standard CSV quoting. Run the exporter to create warehouse.csv from warehouse.json and leave both the exporter and generated CSV in the repository. Leave warehouse.json unchanged. Show the verification you performed.'
const addGoal = 'Repair addition in math.js so it correctly adds any two numbers.'
const input = JSON.stringify([
  { warehouse: '東京', sku: 'B', quantity: 4, notes: 'café' },
  { warehouse: 'A', sku: 'Z', quantity: 0, notes: '' },
  { warehouse: 'A', sku: 'P', quantity: 2, notes: 'line 1\nline 2' },
  { warehouse: 'A', sku: 'C', quantity: 1, notes: 'comma, and "quotes"' },
])
const expected = 'warehouse,sku,quantity,notes\nA,C,1,"comma, and ""quotes"""\nA,P,2,"line 1\nline 2"\nA,Z,0,\n東京,B,4,café\n'
const exporter = [
  'import csv, json, sys',
  'with open(sys.argv[1], encoding="utf-8") as source:',
  '    rows = json.load(source)',
  'with open(sys.argv[2], "w", encoding="utf-8", newline="") as output:',
  '    writer = csv.DictWriter(output, fieldnames=["warehouse", "sku", "quantity", "notes"], lineterminator="\\n")',
  '    writer.writeheader()',
  '    writer.writerows(sorted(rows, key=lambda row: (row["warehouse"], row["sku"])))',
  '',
].join('\n')

const controlledEnv = {
  PATH: process.env.PATH,
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'data'),
  BABEL_CONFIG_DIR: join(root, 'config'),
  BABEL_STATE_DIR: profile,
  BABEL_CACHE_DIR: join(root, 'cache'),
  BABEL_RUNS_DIR: runs,
  OPENROUTER_API_KEY: 'synthetic-router-credential',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GIT_TERMINAL_PROMPT: '0',
  TERM: 'xterm-256color',
  LANG: 'C.UTF-8',
}
const invoke = (file, args, cwd) => spawnSync(file, args, {
  cwd, env: controlledEnv, encoding: 'utf8', timeout: 30_000,
})
function git(...args) {
  const result = invoke('git', args, workspace)
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
}

const tool = (name, args) => ({ name, args })
const wrongPatch = scenario === 'wrong-add' || scenario === 'wrong-domain' || scenario === 'resume'
const steps = scenario === 'warehouse' ? [
  tool('read_file', { path: 'warehouse.json' }),
  tool('write_file', { path: 'export_warehouse.py', content: exporter }),
  tool('run_command', { command: exporterCommand }),
  tool('write_file', { path: 'warehouse.csv', content: expected }),
  'Created the exporter and CSV.',
] : [
  tool('read_file', { path: 'math.js' }),
  tool('str_replace', { file_path: 'math.js', old_str: 'a - b', new_str: wrongPatch ? '5' : 'a + b' }),
  ...(scenario === 'prohibited' ? [] : [tool('test_run', { command: 'npm test' })]),
  'Fixed addition in math.js.',
]
const goals = {
  'wrong-domain': 'Fix math.js so add correctly adds any two integers, for example add(2, 3) returns 5.',
  'right-add': 'Fix math.js so add(2, 3) returns 5.',
}
const prompt = scenario === 'warehouse' ? warehousePrompt
  : scenario === 'prohibited' ? addGoal + ' Do not run any shell commands or tests.'
    : (goals[scenario] ?? addGoal) + '\nRequirements: npm test must pass'
const readEvents = () => readdirSync(runs, { recursive: true })
  .filter(path => path.endsWith('session-events.jsonl'))
  .flatMap(path => readFileSync(join(runs, path), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))

try {
  for (const directory of [workspace, profile, runs, grader, controlledEnv.HOME, controlledEnv.XDG_CONFIG_HOME,
    controlledEnv.XDG_DATA_HOME, controlledEnv.XDG_CACHE_HOME]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(profile, 'preferences.json'), JSON.stringify({
    schemaVersion: 1,
    connections: { openrouter: { id: 'openrouter', provider: 'openrouter', model, apiKeyEnvVar: 'OPENROUTER_API_KEY' } },
    defaults: { connection: 'openrouter', model },
    setup: { completed: true },
  }))
  if (scenario === 'warehouse') {
    writeFileSync(join(workspace, 'warehouse.json'), input)
  } else {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({
      name: 'verification-replay', type: 'module', scripts: { test: 'node --test visible.test.mjs' },
    }))
    writeFileSync(join(workspace, 'math.js'), 'export const add = (a, b) => a - b\n')
    writeFileSync(join(workspace, 'visible.test.mjs'), [
      'import test from "node:test"',
      'import assert from "node:assert/strict"',
      'import { add } from "./math.js"',
      'test("one visible case", () => assert.equal(add(2, 3), 5))',
      '',
    ].join('\n'))
  }
  git('init', '-q')
  git('add', '--all')
  git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-qm', 'Replay input')

  const replay = join(root, 'provider.mjs')
  const providerTrace = join(root, 'provider.jsonl')
  writeFileSync(replay, `
    import { appendFileSync } from 'node:fs'
    const steps = ${JSON.stringify(steps)}
    let index = 0
    globalThis.fetch = async (resource, init) => {
      if (String(resource) !== 'https://openrouter.ai/api/v1/chat/completions') {
        throw new Error('Unexpected network request in offline replay')
      }
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (!body.stream) {
        return Response.json({
          model: body.model, choices: [{ message: { role: 'assistant',
            content: JSON.stringify({ verdict: 'pass', confidence: 1, reasons: ['Scripted auxiliary response'] }) },
            finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        })
      }
      if (${JSON.stringify(scenario)} === 'resume' && index === 2) {
        return new Promise((_resolve, reject) => {
          const cancel = () => reject(new DOMException('Interrupted fixture response', 'AbortError'))
          if (init?.signal?.aborted) cancel()
          else init?.signal?.addEventListener('abort', cancel, { once: true })
        })
      }
      const step = steps[Math.min(index, steps.length - 1)]
      appendFileSync(${JSON.stringify(providerTrace)}, JSON.stringify({ index, tool: step.name ?? null }) + '\\n')
      const current = index++
      const delta = typeof step === 'string' ? { content: step } : { tool_calls: [{
        index: 0, id: 'replay-' + current, type: 'function',
        function: { name: step.name, arguments: JSON.stringify(step.args) },
      }] }
      return new Response('data: ' + JSON.stringify({
        model: body.model, choices: [{ index: 0, delta, finish_reason: typeof step === 'string' ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
    }
  `)

  const exitSteps = [{ send: '/exit' }, { key: 'enter' }]
  const launchPty = (name, inputs) => {
    const script = join(root, name + '.json')
    const transcriptPath = join(root, name + '.txt')
    writeFileSync(script, JSON.stringify(inputs))
    const result = spawnSync('python3', [
      fileURLToPath(new URL('./pty_driver.py', import.meta.url)), '--script', script,
      '--cwd', workspace, '--rows', '42', '--cols', '160', '--transcript', transcriptPath,
      '--', ...(statSync(babel).mode & 0o111 ? [babel] : [process.execPath, babel]),
    ], {
      encoding: 'utf8', timeout: 35_000,
      env: { ...controlledEnv, NODE_OPTIONS: '--import=' + pathToFileURL(replay).href },
    })
    const output = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : ''
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true })
      writeFileSync(join(evidenceDir, name + '.terminal.txt'), output)
    }
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout || result.stderr)
    return output
  }
  const transcript = launchPty(scenario, [
    { sleep_ms: 2100 },
    { send: '\x1b[200~' + prompt + '\x1b[201~' },
    { key: 'enter' },
    ...(scenario === 'resume' ? [
      { wait_for: 'str_replace', timeout_ms: 20_000 }, { sleep_ms: 900 },
      { key: 'ctrl-c' }, { wait_for: 'Cancelled', timeout_ms: 5000 },
    ] : [
      { wait_for: scenario === 'warehouse' ? 'Not run' : 'Fixed addition', timeout_ms: 20_000 },
    ]),
    { sleep_ms: 1800 },
    ...exitSteps,
  ])
  const events = readEvents()
  const terminals = events.filter(event => event.kind === 'turn_ended')
  const trace = existsSync(providerTrace) ? readFileSync(providerTrace, 'utf8').trim().split('\n').map(JSON.parse) : []
  if (evidenceDir) {
    writeFileSync(join(evidenceDir, scenario + '.events.json'), JSON.stringify(events, null, 2))
    writeFileSync(join(evidenceDir, scenario + '.provider.json'), JSON.stringify(trace, null, 2))
  }
  assert.equal(terminals.length, 1)
  const terminal = terminals[0]

  if (scenario === 'warehouse') {
    assert.equal(readFileSync(join(workspace, 'warehouse.json'), 'utf8'), input)
    const proposal = events.find(event => event.kind === 'tool_proposed' && event.target_summary === exporterCommand)
    assert.ok(proposal, 'the replay must reach the exact exporter command')
    const commandEvents = events.filter(event => event.tool_call_id === proposal.tool_call_id)
    assert.ok(commandEvents.some(event => event.preDispatchNoEffect === true))
    assert.ok(commandEvents.every(event => event.kind !== 'tool_started'))
    assert.doesNotMatch(transcript, /approve once|allow once|approval required/i)

    // Run the generated exporter independently against a private copy, after Babel has exited.
    writeFileSync(join(grader, 'export.py'), readFileSync(join(workspace, 'export_warehouse.py')))
    writeFileSync(join(grader, 'input.json'), input)
    const grade = invoke('python3', ['export.py', 'input.json', 'result.csv'], grader)
    assert.ifError(grade.error)
    assert.equal(grade.status, 0, grade.stderr)
    const csv = readFileSync(join(grader, 'result.csv'))
    assert.equal(csv.toString('utf8'), expected)
    console.log(JSON.stringify({ scenario, terminal: terminal.outcome, reason: terminal.reason_code,
      providerTurns: trace.length, babelExporterStarted: false, graderCsvSha256: createHash('sha256').update(csv).digest('hex') }))
    assert.equal(terminal.outcome, 'BLOCKED_POLICY')
    assert.equal(terminal.reason_code, 'permission_denied')
    assert.match(transcript, /denied before dispatch/i)
    assert.equal(existsSync(join(workspace, 'warehouse.csv')), false, 'do not substitute a hand-written CSV for execution')
    assert.equal(trace.length, 3, 'the hard denial should settle without another provider turn')
  } else {
    const graderFile = join(grader, 'check.mjs')
    writeFileSync(graderFile, [
      'import assert from "node:assert/strict"',
      'import { add } from ' + JSON.stringify(pathToFileURL(join(workspace, 'math.js')).href),
      'for (const [a,b,expected] of [[2,3,5],[-4,7,3],[0,0,0],[8,-11,-3],[0.25,0.5,0.75]]) {',
      '  assert.equal(add(a,b),expected)',
      '}',
      '',
    ].join('\n'))
    const grade = invoke(process.execPath, [graderFile], grader)
    assert.ifError(grade.error)
    const npmStarted = events.some(event => event.kind === 'tool_started' && event.target_summary === 'npm test')
    const npmGreen = events.some(event => event.kind === 'verifier_attempt' && event.command_preview === 'npm test' && event.exit_code === 0)
    console.log(JSON.stringify({ scenario, terminal: terminal.outcome, reason: terminal.reason_code,
      babelTestStarted: npmStarted, babelTestGreen: npmGreen, graderPassed: grade.status === 0 }))
    assert.equal(grade.status === 0, !wrongPatch)
    if (scenario === 'resume') {
      assert.equal(terminal.outcome, 'CANCELLED')
      assert.equal(npmStarted, false)
      const resumed = launchPty('resume-fresh-process', [
        { sleep_ms: 2100 }, { send: '/resume ' + terminal.session_id }, { key: 'enter' },
        { wait_for: 'Resumed session', timeout_ms: 12_000 }, { sleep_ms: 600 }, ...exitSteps,
      ])
      assert.match(resumed, /Latest turn is not verified\./)
      assert.deepEqual(readEvents().filter(event => event.kind === 'turn_ended'), terminals)
      assert.equal(readFileSync(join(root, 'provider.jsonl'), 'utf8').trim().split('\n').length, trace.length)
    } else if (scenario === 'prohibited') {
      assert.ok(events.every(event => event.kind !== 'tool_started' || !['run_command', 'test_run'].includes(event.tool_name)))
    } else {
      assert.equal(npmStarted, true)
      assert.equal(npmGreen, true)
    }
    if (wrongPatch) assert.notEqual(terminal.outcome, 'VERIFIED_COMPLETE')
    if (scenario === 'right-add') assert.equal(terminal.outcome, 'VERIFIED_COMPLETE')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
