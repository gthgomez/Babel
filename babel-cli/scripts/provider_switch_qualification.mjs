// Run this from a trusted checkout outside candidate write authority. Preparation
// precedes candidate execution; only workspace/ is materialized for the agent.
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const fixture = fileURLToPath(new URL('../src/fixtures/provider-switch/', import.meta.url))
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const within = (root, path) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
function snapshot(root, prefix = '') {
  const result = {}
  for (const name of readdirSync(join(root, prefix))) {
    const key = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(join(root, key))
    if (stat.isSymbolicLink()) throw new Error('Links are not permitted in qualification inputs')
    if (stat.isDirectory()) Object.assign(result, snapshot(root, key))
    else result[key] = hash(join(root, key))
  }
  return result
}
const same = (left, right) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
function protectedInputsMatch(workspace, expected) {
  return Object.entries(expected).every(([name, expectedHash]) => {
    const file = join(workspace, name)
    try {
      return lstatSync(file).isFile() && realpathSync(file) === file && hash(file) === expectedHash
    } catch { return false }
  })
}
function externalDirectory(path, workspace) {
  if (!isAbsolute(path)) throw new Error('Absolute evidence directory required')
  const parent = realpathSync(dirname(path))
  const target = existsSync(path) ? realpathSync(path) : join(parent, relative(dirname(path), path))
  if (within(realpathSync(fixture), target) || within(workspace, target) || within(target, workspace)) {
    throw new Error('Evidence must be outside fixture and candidate content')
  }
  mkdirSync(target, { recursive: true })
  return realpathSync(target)
}

/** Freeze trusted inputs before launching the candidate, never after its repair. */
export function prepare(workspace, evidence, expectedRoute) {
  if (!['openrouter', 'commandcode'].includes(expectedRoute?.provider) ||
      typeof expectedRoute.model !== 'string' || !expectedRoute.model.trim()) throw new Error('Exact expected gateway and model required')
  if (!isAbsolute(workspace) || existsSync(workspace)) throw new Error('New absolute workspace required')
  const parent = realpathSync(dirname(workspace))
  if (within(realpathSync(fixture), parent)) throw new Error('Cannot materialize inside shipped fixture')
  const destination = join(parent, relative(dirname(workspace), workspace))
  evidence = externalDirectory(evidence, destination)
  const frozen = snapshot(fixture)
  cpSync(join(fixture, 'workspace'), destination, { recursive: true, errorOnExist: true, force: false })
  const challenge = {
    schemaVersion: 1, nonce: randomBytes(32).toString('hex'), createdAt: Date.now(),
    workspace: realpathSync(destination), frozen, expectedRoute,
  }
  writeFileSync(join(evidence, 'challenge.json'), JSON.stringify(challenge, null, 2), { flag: 'wx' })
  return challenge
}

/** Enforce manifest requirements using a trusted host-captured Babel session log. */
export function checkTrace(events, challenge, task) {
  const submitted = events.filter((event) => event.kind === 'user_submitted')
  if (submitted.length !== 1) return false
  const user = submitted[0]
  if (user.task_preview !== task || typeof user.project_root !== 'string' ||
      realpathSync(user.project_root) !== challenge.workspace || !user.turn_id || !user.session_id) return false
  if (!events.every((event, i) => event.session_id === user.session_id && event.turn_id === user.turn_id &&
      Number.isInteger(event.seq) && (i === 0 || event.seq > events[i - 1].seq) &&
      Number.isFinite(Date.parse(event.ts)) && Date.parse(event.ts) >= challenge.createdAt && Date.parse(event.ts) <= Date.now())) return false
  const dispatched = events.filter((event) => event.kind === 'model_invocation_phase' && event.phase === 'request_dispatched')
  // A cell certifies this exact route, not a matching subset of a mixed session.
  // Unsettled dispatches cannot be silently omitted from qualification either.
  if (!dispatched.every((event) =>
    event.provider === challenge.expectedRoute?.provider && event.model === challenge.expectedRoute?.model &&
    typeof event.provider === 'string' && event.provider.length > 0 && typeof event.model === 'string' && event.model.length > 0 &&
    events.some((input) => input.kind === 'model_input_receipt' && input.inference_id === event.inference_id && input.seq < event.seq &&
      input.provider === event.provider && input.sent_model_id === event.model) &&
    events.some((result) => result.kind === 'model_result_delivery' && result.inference_id === event.inference_id &&
      result.provider === event.provider && result.model === event.model && result.status === 'delivered' && result.seq > event.seq))) return false
  if (new Set(dispatched.map((event) => event.inference_id)).size < 2) return false
  return dispatched.some((first) => dispatched.some((second) => second.inference_id !== first.inference_id &&
    events.some((tool) => tool.kind === 'tool_completed' && tool.seq > first.seq && tool.seq < second.seq &&
      events.some((start) => start.kind === 'tool_started' && start.tool_call_id === tool.tool_call_id && start.seq < tool.seq && start.seq > first.seq))))
}

/** Validate a fresh evaluator verdict, protected files and real request/tool evidence. */
export function qualify(evidence, eventsPath) {
  const challenge = JSON.parse(readFileSync(join(evidence, 'challenge.json'), 'utf8'))
  const workspace = realpathSync(challenge.workspace)
  evidence = externalDirectory(evidence, workspace)
  if (challenge.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
      !Number.isFinite(challenge.createdAt) || challenge.createdAt > Date.now()) throw new Error('Invalid challenge')
  if (!same(snapshot(fixture), challenge.frozen)) throw new Error('Trusted fixture changed since preparation')
  const expected = Object.fromEntries(Object.entries(challenge.frozen).filter(([key]) => key.startsWith('workspace/'))
    .map(([key, value]) => [key.slice('workspace/'.length), value]))
  delete expected['current/ledger.mjs']
  if (!protectedInputsMatch(workspace, expected)) throw new Error('Protected candidate files changed (including project tests)')
  const verdictPath = join(evidence, 'verdict.json')
  if (existsSync(verdictPath)) throw new Error('Existing verdict rejected; use a fresh prepared cell')
  const ledger = join(workspace, 'current/ledger.mjs')
  if (!lstatSync(ledger).isFile() || realpathSync(ledger) !== ledger) throw new Error('Ledger must be an ordinary candidate file')
  const beforeLedger = hash(ledger)
  const evaluator = join(fixture, 'evaluator/verify.mjs')
  const run = spawnSync(process.execPath, [evaluator], {
    cwd: evidence, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      CANDIDATE_WORKSPACE: workspace, VERDICT_PATH: verdictPath, RUN_NONCE: challenge.nonce,
      EVALUATOR_SHA256: challenge.frozen['evaluator/verify.mjs'],
      ORACLE_SHA256: challenge.frozen['evaluator/probe.mjs'],
      PRISTINE_LEDGER_SHA256: challenge.frozen['workspace/current/ledger.mjs'],
    },
  })
  if (!same(snapshot(fixture), challenge.frozen)) throw new Error('Trusted evaluator/oracle/fixture changed during execution')
  if (!protectedInputsMatch(workspace, expected)) throw new Error('Protected files changed during verification')
  const verdict = existsSync(verdictPath) ? JSON.parse(readFileSync(verdictPath, 'utf8')) : null
  const ids = ['evaluator_unmodified', 'oracle_unmodified', 'ledger_edited', 'project_tests_pass', 'candidate_protocol',
    'independent_cases', 'ledger_stable_during_verification', 'evaluator_unmodified_after']
  const evaluatorPass = !run.error && run.status === 0 && verdict?.schemaVersion === 2 && verdict.authoritative === false &&
    verdict.pass === true && verdict.nonce === challenge.nonce && verdict.workspace === workspace &&
    verdict.evaluatorSha256 === challenge.frozen['evaluator/verify.mjs'] && verdict.oracleSha256 === challenge.frozen['evaluator/probe.mjs'] &&
    verdict.ledgerSha256 === beforeLedger && beforeLedger === hash(join(workspace, 'current/ledger.mjs')) &&
    Array.isArray(verdict.checks) && verdict.checks.length === ids.length && ids.every((id) => verdict.checks.filter((check) => check.id === id && check.pass === true).length === 1)
  // Missing trace can certify a functional repair only, never a provider cell.
  let tracePass = false
  if (eventsPath) {
    const trace = realpathSync(eventsPath)
    if (within(workspace, trace) || within(realpathSync(fixture), trace)) throw new Error('Trace must be host-captured outside candidate content')
    const events = readFileSync(trace, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
    tracePass = checkTrace(events, challenge, JSON.parse(readFileSync(join(fixture, 'manifest.json'))).task)
  }
  const result = { schemaVersion: 1, authoritative: true, functionalPass: evaluatorPass, providerCellPass: evaluatorPass && tracePass,
    tracePass, nonce: challenge.nonce, ledgerSha256: beforeLedger, evaluatorExit: run.status, evaluatorError: run.error?.code ?? null }
  writeFileSync(join(evidence, 'qualification.json'), JSON.stringify(result, null, 2), { flag: 'wx' })
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, workspaceOrEvidence, evidenceOrEvents, provider, model] = process.argv.slice(2)
    if (mode === '--plan') {
      console.log(JSON.stringify({ authoritative: false, pass: false, mode: 'plan' }))
    } else if (mode === '--prepare') {
      console.log(JSON.stringify(prepare(workspaceOrEvidence, evidenceOrEvents, { provider, model })))
    } else if (mode === '--verify') {
      const result = qualify(workspaceOrEvidence, evidenceOrEvents)
      console.log(JSON.stringify(result))
      process.exitCode = result.providerCellPass ? 0 : 1
    } else throw new Error('Usage: --prepare ABS_WORKSPACE ABS_EVIDENCE GATEWAY MODEL | --verify ABS_EVIDENCE HOST_SESSION_EVENTS | --plan')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
