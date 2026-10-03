import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  chmod,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SUITE_VERSION = 'babel-curated-eval-v1'
const HASH = /^sha256:[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const INFRA_ERRORS = new Set([
  'container_start_failed',
  'container_runtime_missing',
  'image_unavailable',
  'fixture_setup_failed',
  'grader_start_failed',
  'grader_protocol_error',
  'adapter_unavailable',
  'provider_transport_unavailable',
  'engine_infrastructure_failure',
  'grader_timeout',
  'workspace_integrity_error',
])

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Catalog field ${field} must be a non-empty string`)
}

function validateTask(task) {
  requireString(task.id, 'task.id')
  requireString(task.category, `${task.id}.category`)
  requireString(task.adapter, `${task.id}.adapter`)
  requireString(task.prompt, `${task.id}.prompt`)
  if (!['babel_original', 'terminal_bench_2_1'].includes(task.source?.kind)) {
    throw new Error(`Task ${task.id} has an unsupported or missing source kind`)
  }
  if (task.source.kind === 'terminal_bench_2_1' && !COMMIT.test(task.source.revision ?? '')) {
    throw new Error(`Task ${task.id} must pin a full Terminal-Bench revision`)
  }
  if (task.source.kind === 'terminal_bench_2_1' && task.source.license !== 'Apache-2.0') {
    throw new Error(`Task ${task.id} must record its upstream license`)
  }
  if (!HASH.test(task.environment?.image?.match(/@(.+)$/)?.[1] ?? '')) {
    throw new Error(`Task ${task.id} must use an immutable image digest`)
  }
  if (task.environment.network !== 'none') throw new Error(`Task ${task.id} must run without task-container network access`)
  for (const [key, value] of Object.entries({
    cpus: task.environment.cpus,
    memory_mb: task.environment.memory_mb,
    gpus: task.environment.gpus,
    wall_seconds: task.limits?.wall_seconds,
    max_turns: task.limits?.max_turns,
    max_tokens: task.limits?.max_tokens,
  })) {
    if (!Number.isFinite(value) || value < 0 || (key !== 'gpus' && value === 0)) {
      throw new Error(`Task ${task.id} has invalid ${key}`)
    }
  }
  if (!Array.isArray(task.expected_artifacts) || task.expected_artifacts.length === 0) {
    throw new Error(`Task ${task.id} must declare expected artifacts`)
  }
  requireString(task.scoring?.verifier, `${task.id}.scoring.verifier`)
  requireString(task.qualification?.oracle, `${task.id}.qualification.oracle`)
  requireString(task.qualification?.isolated_container, `${task.id}.qualification.isolated_container`)
  requireString(task.qualification?.limitation, `${task.id}.qualification.limitation`)
  if (task.source.kind === 'babel_original' && (!task.fixture?.solver_dir || !task.fixture?.grader_dir)) {
    throw new Error(`Original task ${task.id} must separate solver and grader fixture paths`)
  }
}

/** Load and validate the immutable curated task catalog. */
export async function loadCatalog(suiteRoot) {
  const manifestPath = path.join(suiteRoot, 'manifest.json')
  const catalog = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.tasks) || catalog.tasks.length === 0) {
    throw new Error('Unsupported or empty curated benchmark manifest')
  }
  const ids = new Set()
  for (const task of catalog.tasks) {
    validateTask(task)
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`)
    ids.add(task.id)
    if (task.source.kind === 'babel_original') {
      const solverDir = path.resolve(suiteRoot, task.fixture.solver_dir)
      const graderDir = path.resolve(suiteRoot, task.fixture.grader_dir)
      if (!isWithin(suiteRoot, solverDir) || !isWithin(suiteRoot, graderDir)) {
        throw new Error(`Task ${task.id} fixture path escapes the curated suite`)
      }
      if (!HASH.test(task.fixture.solver_sha256 ?? '')) {
        throw new Error(`Task ${task.id} has an invalid solver fixture digest`)
      }
      if (task.source.revision !== `fixture-${task.fixture.solver_sha256}`) {
        throw new Error(`Task ${task.id} source revision must match its solver fixture digest`)
      }
      const actualHash = await hashTree(solverDir)
      if (actualHash !== task.fixture.solver_sha256) throw new Error(`Task ${task.id} solver fixture hash mismatch`)
    }
  }
  return catalog
}

function fitsBudget(task, totals, options) {
  const limits = task.limits
  if (options.maxTurns !== undefined && totals.turns + limits.max_turns > options.maxTurns) return false
  if (options.maxSeconds !== undefined && totals.seconds + limits.wall_seconds > options.maxSeconds) return false
  if (options.maxTokens !== undefined && totals.tokens + limits.max_tokens > options.maxTokens) return false
  if (options.maxCostUsd !== undefined) {
    if (limits.max_cost_usd === null || limits.max_cost_usd === undefined) return false
    if (totals.costUsd + limits.max_cost_usd > options.maxCostUsd) return false
  }
  return true
}

/** Select a deterministic manifest-order subset by task id, category and summed limits. */
export function selectTasks(catalog, options = {}) {
  const categories = new Set(options.categories ?? [])
  const taskIds = new Set(options.taskIds ?? [])
  const totals = { turns: 0, seconds: 0, tokens: 0, costUsd: 0 }
  const selected = []
  for (const task of catalog.tasks) {
    if (categories.size > 0 && !categories.has(task.category)) continue
    if (taskIds.size > 0 && !taskIds.has(task.id)) continue
    if (!fitsBudget(task, totals, options)) continue
    selected.push(task)
    totals.turns += task.limits.max_turns
    totals.seconds += task.limits.wall_seconds
    totals.tokens += task.limits.max_tokens
    totals.costUsd += task.limits.max_cost_usd ?? 0
  }
  return selected
}

/** Build a no-spend plan. This function never creates an agent or provider client. */
export function buildDryRunPlan(catalog, options = {}) {
  const tasks = selectTasks(catalog, options)
  return {
    schema_version: 1,
    suite_id: catalog.suite_id,
    execution_mode: 'dry_run',
    provider_requests: 0,
    live_execution_authorized: false,
    provider_transport_integrated: false,
    model_performance_claim: false,
    network: 'task_and_grader_none',
    requested_model: options.requestedModel ?? null,
    selected_task_count: tasks.length,
    totals: {
      max_turns: tasks.reduce((sum, task) => sum + task.limits.max_turns, 0),
      wall_seconds: tasks.reduce((sum, task) => sum + task.limits.wall_seconds, 0),
      max_tokens: tasks.reduce((sum, task) => sum + task.limits.max_tokens, 0),
      max_cost_usd: tasks.every((task) => task.limits.max_cost_usd !== null)
        ? tasks.reduce((sum, task) => sum + task.limits.max_cost_usd, 0)
        : null,
    },
    tasks: tasks.map((task) => ({
      task_id: task.id,
      category: task.category,
      source_kind: task.source.kind,
      source_revision: task.source.revision,
      image: task.environment.image,
      requested_model: options.requestedModel ?? null,
      sent_model: null,
      observed_model: null,
      readiness: task.source.kind === 'terminal_bench_2_1'
        ? 'requires_harbor_data_and_source_chat_engine_transport'
        : 'local_fixture_source_chat_engine_transport_unavailable',
      qualification: task.qualification,
      limits: task.limits,
    })),
    caveats: [
      'This plan performs no model or provider requests and is not a benchmark score.',
      'Provider traffic for a future live run must use the separately approved, narrowly brokered model route; task and grader containers have no general network access.',
      'External Harbor task bootstrap and hidden-verifier execution are not certified by this dry run.',
    ],
  }
}

async function walkFiles(root, relative = '') {
  const current = path.join(root, relative)
  const entries = await readdir(current, { withFileTypes: true })
  const paths = []
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name
    const childPath = path.join(root, childRelative)
    const stats = await lstat(childPath)
    if (stats.isSymbolicLink()) throw new Error(`Symlink is not allowed in a benchmark workspace: ${childRelative}`)
    if (stats.isDirectory()) paths.push(...(await walkFiles(root, childRelative)))
    else if (stats.isFile()) paths.push(childRelative)
    else throw new Error(`Unsupported workspace object: ${childRelative}`)
  }
  return paths.sort()
}

/** Hash the full solver-visible tree, rejecting symlinks and special files. */
export async function hashTree(root) {
  const hash = createHash('sha256')
  for (const relative of await walkFiles(root)) {
    const filename = path.join(root, relative)
    const stats = await lstat(filename)
    hash.update(`${relative}\0${stats.mode & 0o777}\0`)
    hash.update(await readFile(filename))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function relativePattern(pattern, workingDirectory) {
  if (pattern.startsWith(`${workingDirectory}/`)) return pattern.slice(workingDirectory.length + 1)
  return pattern.replace(/^\//, '')
}

function globMatches(pattern, relative) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`).test(relative)
}

function isProtected(task, relative) {
  const cwd = task.environment.working_directory
  return (task.change_policy.protected_patterns ?? []).some((pattern) => globMatches(relativePattern(pattern, cwd), relative))
}

function isAllowed(task, relative) {
  const cwd = task.environment.working_directory
  return (task.change_policy.allowed_patterns ?? []).some((pattern) => globMatches(relativePattern(pattern, cwd), relative))
}

/** Copy only the visible fixture directory into a fresh disposable workspace. */
export async function prepareTaskWorkspace(suiteRoot, taskId, destination) {
  const catalog = await loadCatalog(suiteRoot)
  const task = catalog.tasks.find((entry) => entry.id === taskId)
  if (!task) throw new Error(`Unknown task id: ${taskId}`)
  if (task.source.kind !== 'babel_original') throw new Error(`Task ${taskId} requires the pinned external benchmark adapter`)
  const source = path.resolve(suiteRoot, task.fixture.solver_dir)
  const target = path.resolve(destination)
  if (!isWithin(suiteRoot, source) || target === source || isWithin(source, target)) {
    throw new Error('Solver workspace paths must be separate from the fixture source')
  }
  try {
    await lstat(target)
    throw new Error(`Solver destination already exists: ${target}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false })
  const copiedHash = await hashTree(target)
  if (copiedHash !== task.fixture.solver_sha256) throw new Error(`Prepared fixture hash mismatch for ${taskId}`)
  if (task.environment.container_user === '65534:65534') {
    for (const relative of await walkFiles(target)) {
      const privatePath = relative === 'private' || relative.startsWith(`private${path.sep}`) || relative.startsWith('private/')
      const filename = path.join(target, relative)
      if (privatePath) await chmod(filename, relative === 'private' ? 0o700 : 0o600)
      else await chmod(filename, 0o666)
    }
    for (const relative of ['.', 'src', 'public', 'test', 'private']) {
      const directory = path.join(target, relative)
      try {
        await lstat(directory)
        await chmod(directory, relative === 'private' ? 0o700 : 0o777)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  return { task_id: taskId, workspace: target, fixture_sha256: copiedHash }
}

/** Capture added, modified, deleted and mode-changed files across the whole workspace. */
export async function collectWorkspaceDiff(beforeRoot, afterRoot) {
  const beforePaths = await walkFiles(beforeRoot)
  const afterPaths = await walkFiles(afterRoot)
  const before = new Map()
  const after = new Map()
  for (const relative of beforePaths) {
    const filename = path.join(beforeRoot, relative)
    const stats = await lstat(filename)
    before.set(relative, { digest: createHash('sha256').update(await readFile(filename)).digest('hex'), mode: stats.mode & 0o777 })
  }
  for (const relative of afterPaths) {
    const filename = path.join(afterRoot, relative)
    const stats = await lstat(filename)
    after.set(relative, { digest: createHash('sha256').update(await readFile(filename)).digest('hex'), mode: stats.mode & 0o777 })
  }
  const added = afterPaths.filter((item) => !before.has(item))
  const deleted = beforePaths.filter((item) => !after.has(item))
  const modified = afterPaths.filter((item) => {
    const original = before.get(item)
    const final = after.get(item)
    return original && (original.digest !== final.digest || original.mode !== final.mode)
  })
  return { added, modified, deleted }
}

function classifyTerminal(terminalStatus, errorClass) {
  if (errorClass && INFRA_ERRORS.has(errorClass)) return 'infrastructure_error'
  if (['error', 'infra_failed', 'infrastructure_error'].includes(terminalStatus)) return 'infrastructure_error'
  if (['limit_reached', 'turn_limit', 'wall_limit', 'cost_limit', 'budget_exhausted'].includes(terminalStatus)) return 'budget_truncated'
  if (['cancelled', 'canceled', 'user_cancelled'].includes(terminalStatus)) return 'cancelled'
  if (['completed', 'failed', 'blocked'].includes(terminalStatus)) return 'task_failure'
  return 'unknown'
}

/** Normalize unknown telemetry as null and keep runtime errors outside task scoring. */
export function normalizeAttempt(raw) {
  const result = {
    schema_version: 1,
    task_id: raw.task_id,
    attempt_id: raw.attempt_id ?? null,
    harness_build: raw.harness_build ?? null,
    adapter: raw.adapter ?? 'babel_source_chat_engine',
    task_image: raw.task_image ?? null,
    task_revision: raw.task_revision ?? null,
    requested_model: raw.requested_model ?? null,
    sent_model: raw.sent_model ?? null,
    observed_model: raw.observed_model ?? null,
    terminal_status: raw.terminal_status ?? 'unknown',
    engine_terminal_outcome: raw.engine_terminal_outcome ?? null,
    completion_claimed: raw.completion_claimed === true,
    completion_claim_evidence: raw.completion_claim_evidence ?? null,
    outcome: classifyTerminal(raw.terminal_status, raw.error_class),
    error_class: raw.error_class ?? null,
    errors: Array.isArray(raw.errors) ? raw.errors : [],
    verifier: raw.verifier ?? { status: 'not_run', assertions: null, errors: [] },
    diff: raw.diff ?? { added: [], modified: [], deleted: [] },
    exposure: raw.exposure ?? { oracle_visible: false, reference_visible: false, unexpected_reads: [] },
    usage: {
      input_tokens: Number.isFinite(raw.usage?.input_tokens) ? raw.usage.input_tokens : null,
      output_tokens: Number.isFinite(raw.usage?.output_tokens) ? raw.usage.output_tokens : null,
      cost_usd: Number.isFinite(raw.usage?.cost_usd) ? raw.usage.cost_usd : null,
      duration_ms: Number.isFinite(raw.usage?.duration_ms) ? raw.usage.duration_ms : null,
      retries: Number.isInteger(raw.usage?.retries) ? raw.usage.retries : null,
    },
    started_at: raw.started_at ?? null,
    completed_at: raw.completed_at ?? null,
    scripted_provider: raw.scripted_provider === true,
    model_performance_claim: raw.scripted_provider !== true && raw.model_performance_claim === true,
    model_routing: raw.model_routing ?? { requested: null, sent: null, observed: null, turns: [] },
  }
  return result
}

/** Score only completed attempts with a passing behavioral verifier and an authorized diff. */
export function scoreAttempt(task, attempt) {
  const outcome = classifyTerminal(attempt.terminal_status, attempt.error_class)
  if (outcome !== 'task_failure') {
    return { outcome, false_complete: false, unauthorized_changes: [], verifier_passed: false }
  }
  if (attempt.verifier?.status === 'infrastructure_error') {
    return { outcome: 'infrastructure_error', false_complete: false, unauthorized_changes: [], verifier_passed: false }
  }
  const diff = attempt.diff ?? { added: [], modified: [], deleted: [] }
  const allChanges = [...diff.added, ...diff.modified, ...diff.deleted]
  const unauthorizedChanges = [...new Set(allChanges.filter((file) => isProtected(task, file) || !isAllowed(task, file)))].sort()
  const verifierPassed = attempt.verifier?.status === 'passed'
  const falseComplete = attempt.completion_claimed === true && !verifierPassed
  const succeeded = attempt.terminal_status === 'completed' && verifierPassed && unauthorizedChanges.length === 0
  return {
    outcome: succeeded ? 'valid_success' : 'task_failure',
    false_complete: falseComplete,
    unauthorized_changes: unauthorizedChanges,
    verifier_passed: verifierPassed,
  }
}

function safeMountPath(value, label) {
  const resolved = path.resolve(value)
  if (resolved.includes(',')) throw new Error(`${label} paths containing commas are not supported by Docker --mount`)
  return resolved
}

function bindMount(source, target, readOnly) {
  const mode = readOnly ? ',readonly' : ''
  return `type=bind,src=${source},dst=${target}${mode}`
}

function workspaceOwnerUser() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 65534
  const gid = typeof process.getgid === 'function' ? process.getgid() : uid
  return `${uid}:${gid}`
}

/** Build a Docker argv for a no-network task or grader container. */
export function buildIsolatedDockerArgs(task, options) {
  const { role, workspace, command } = options
  if (!['solver', 'grader'].includes(role)) throw new Error('Docker role must be solver or grader')
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string')) {
    throw new Error('A non-empty argv array is required; shell command strings are not accepted')
  }
  const workspacePath = safeMountPath(workspace, 'workspace')
  const args = [
    'run', '--rm', '--network=none',
    `--cpus=${task.environment.cpus}`,
    `--memory=${Math.round(task.environment.memory_mb / 1024)}g`,
    '--gpus=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=64',
    '--tmpfs=/tmp:rw,exec,nosuid,nodev,size=64m',
    '--workdir', task.environment.working_directory,
    '--mount', bindMount(workspacePath, role === 'grader' ? '/solver' : task.environment.working_directory, role === 'grader'),
  ]
  if (role === 'solver') {
    args.push('--user', task.environment.container_user ?? workspaceOwnerUser())
    args.push('--env=HOME=/tmp/agent-home', '--env=BABEL_CURATED_ISOLATED_SOLVER=1')
    for (const relative of task.environment.protected_mounts_read_only ?? []) {
      const protectedPath = path.resolve(workspacePath, relative)
      if (!isWithin(workspacePath, protectedPath)) throw new Error(`Protected mount escapes workspace: ${relative}`)
      args.push('--mount', bindMount(safeMountPath(protectedPath, 'protected path'), path.posix.join(task.environment.working_directory, relative), true))
    }
  } else {
    const graderPath = safeMountPath(options.grader, 'grader')
    const outputPath = safeMountPath(options.output, 'output')
    const runnerPath = safeMountPath(options.runner, 'grader runner')
    args.push(
      '--user', workspaceOwnerUser(),
      '--mount', bindMount(graderPath, '/oracle', true),
      '--mount', bindMount(outputPath, '/out', false),
      '--mount', bindMount(runnerPath, '/runner/grade.mjs', true),
    )
  }
  args.push(task.environment.image, ...command)
  return args
}

/** Start one isolated grader and classify setup failures separately from failed assertions. */
export async function runIsolatedVerifier(task, options) {
  const args = buildIsolatedDockerArgs(task, {
    ...options,
    role: 'grader',
    command: ['node', '/runner/grade.mjs', '/solver', '/oracle/verify.mjs', task.id],
  })
  const result = spawnSync(options.docker ?? 'docker', args, {
    encoding: 'utf8',
    timeout: (task.limits.wall_seconds + 60) * 1000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error || result.status === null) {
    return {
      status: 'infrastructure_error',
      error_class: result.error?.code === 'ETIMEDOUT' ? 'grader_timeout' : 'grader_start_failed',
      assertions: null,
      errors: [result.error?.message ?? result.stderr ?? 'grader process did not exit'],
    }
  }
  const line = result.stdout.trim().split(/\r?\n/).at(-1)
  try {
    const report = JSON.parse(line)
    if (!['passed', 'failed', 'infrastructure_error'].includes(report.status) || !Array.isArray(report.errors)) {
      return { status: 'infrastructure_error', error_class: 'grader_protocol_error', assertions: null, errors: ['grader returned an invalid JSON result'] }
    }
    if (result.status === 0 && report.status !== 'passed') return { status: 'infrastructure_error', error_class: 'grader_protocol_error', assertions: report.assertions ?? null, errors: ['grader returned a non-passing result with exit code zero'] }
    if (result.status !== 0 && (report.status === 'passed' || (report.status === 'failed' && result.status !== 1) || (report.status === 'infrastructure_error' && result.status !== 2))) {
      return { status: 'infrastructure_error', error_class: 'grader_protocol_error', assertions: report.assertions ?? null, errors: ['grader exit code and verdict disagree'] }
    }
    return report
  } catch {
    return {
      status: 'infrastructure_error',
      error_class: 'grader_protocol_error',
      assertions: null,
      errors: [result.stderr || result.stdout || `grader exited ${result.status} without JSON`],
    }
  }
}

function parseArgs(argv) {
  const options = { categories: [], taskIds: [], maxTurns: undefined, maxSeconds: undefined, maxTokens: undefined, maxCostUsd: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`)
      return next
    }
    if (flag === '--list') options.list = true
    else if (flag === '--plan' || flag === '--dry-run') options.plan = true
    else if (flag === '--category') options.categories.push(value())
    else if (flag === '--task') options.taskIds.push(value())
    else if (flag === '--max-turns' || flag === '--budget-turns') options.maxTurns = Number(value())
    else if (flag === '--max-seconds' || flag === '--budget-seconds') options.maxSeconds = Number(value())
    else if (flag === '--max-tokens' || flag === '--budget-tokens') options.maxTokens = Number(value())
    else if (flag === '--max-cost-usd' || flag === '--budget-usd') options.maxCostUsd = Number(value())
    else if (flag === '--requested-model') options.requestedModel = value()
    else if (flag === '--output') options.output = value()
    else if (flag === '--json') options.json = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else throw new Error(`Unknown argument: ${flag}`)
  }
  for (const key of ['maxTurns', 'maxSeconds', 'maxTokens', 'maxCostUsd']) {
    if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key] < 0)) {
      throw new Error(`--${key} must be a non-negative number`)
    }
  }
  return options
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help || (!options.list && !options.plan)) {
    process.stdout.write('Usage: node benchmarks/curated-eval/runner.mjs (--list | --plan) [--category ID] [--task ID] [--budget-turns N] [--budget-seconds N] [--budget-tokens N] [--budget-usd N] [--requested-model ID] [--output PATH]\n')
    return
  }
  const suiteRoot = path.dirname(fileURLToPath(import.meta.url))
  const catalog = await loadCatalog(suiteRoot)
  const payload = options.plan
    ? buildDryRunPlan(catalog, options)
    : { suite_id: catalog.suite_id, tasks: selectTasks(catalog, options).map(({ id, category, source, limits, environment, qualification }) => ({ id, category, source, limits, image: environment.image, qualification })) }
  const output = `${JSON.stringify(payload, null, 2)}\n`
  if (options.output) {
    const target = path.resolve(options.output)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, output)
  }
  process.stdout.write(output)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
