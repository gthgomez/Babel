import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildDryRunPlan,
  buildIsolatedDockerArgs,
  collectWorkspaceDiff,
  loadCatalog,
  normalizeAttempt,
  prepareTaskWorkspace,
  scoreAttempt,
  selectTasks,
} from '../runner.mjs'

const root = path.resolve(import.meta.dirname, '..')
const workspaceOwner = `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? process.getuid?.() ?? 65534}`

test('core catalog is small, varied, and explicitly sourced', async () => {
  const catalog = await loadCatalog(root)
  assert.equal(catalog.tasks.length, 2)
  assert.deepEqual(new Set(catalog.tasks.map((task) => task.category)), new Set([
    'terminal_data_processing',
    'read_only_repository_exploration',
  ]))
  assert.ok(catalog.tasks.every((task) => task.source.kind === 'babel_original'))
  for (const task of catalog.tasks) {
    assert.match(task.source.revision, /^fixture-sha256:[a-f0-9]{64}$/)
    assert.equal(task.source.revision, `fixture-${task.fixture.solver_sha256}`)
    assert.match(task.environment.image, /@sha256:[a-f0-9]{64}$/)
    assert.equal(task.environment.network, 'none')
    assert.ok(task.limits.max_turns > 0 && task.limits.wall_seconds > 0)
    assert.ok(task.expected_artifacts.length > 0 && task.scoring.verifier)
  }
})

test('selection filters categories and applies summed turn budgets', async () => {
  const catalog = await loadCatalog(root)
  assert.deepEqual(selectTasks(catalog, { categories: ['terminal_data_processing'], maxTurns: 6 }).map((task) => task.id), ['csv-rollup-cli'])
  assert.deepEqual(selectTasks(catalog, { categories: ['terminal_data_processing'], maxTurns: 5 }), [])
})

test('dry-run is machine-readable and never issues provider requests', async () => {
  const catalog = await loadCatalog(root)
  const plan = buildDryRunPlan(catalog, { maxTurns: 20, requestedModel: 'deepseek-v4.1-flash' })
  assert.equal(plan.execution_mode, 'dry_run')
  assert.equal(plan.provider_requests, 0)
  assert.equal(plan.provider_transport_integrated, false)
  assert.equal(plan.live_execution_authorized, false)
  assert.equal(plan.tasks.length, 2)
  assert.equal(plan.tasks[0].requested_model, 'deepseek-v4.1-flash')
  assert.equal(plan.tasks[0].sent_model, null)
  assert.equal(plan.tasks[0].observed_model, null)
})

test('Docker args keep solver and grader isolated and resource bounded', async () => {
  const catalog = await loadCatalog(root)
  const task = catalog.tasks[0]
  const args = buildIsolatedDockerArgs(task, {
    role: 'grader',
    workspace: '/tmp/solver-workspace',
    grader: '/tmp/task-oracle',
    output: '/tmp/task-report',
    runner: path.join(root, 'grader-runner.mjs'),
    command: ['node', '/oracle/verify.mjs', '/solver'],
  })
  for (const required of ['--network=none', '--cpus=1', '--memory=2g', '--gpus=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges']) {
    assert.ok(args.includes(required), `missing ${required}`)
  }
  assert.equal(args[args.indexOf('--user') + 1], workspaceOwner)
  assert.ok(args.some((arg) => arg.includes('dst=/solver,readonly')))
  assert.ok(args.some((arg) => arg.includes('dst=/oracle,readonly')))
  assert.ok(!args.some((arg) => arg.includes('/workspace/Babel')))

  const solverArgs = buildIsolatedDockerArgs(task, { role: 'solver', workspace: '/tmp/solver-workspace', command: ['node', 'agent.mjs'] })
  assert.equal(solverArgs[solverArgs.indexOf('--user') + 1], workspaceOwner)
  assert.ok(solverArgs.includes('--network=none'))
})

test('prepared task workspace contains solver inputs but no oracle or reference files', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-curated-workspace-'))
  const target = path.join(parent, 'solver')
  try {
    await prepareTaskWorkspace(root, 'csv-rollup-cli', target)
    assert.ok((await readFile(path.join(target, 'input/events.csv'), 'utf8')).includes('event_id'))
    await assert.rejects(readFile(path.join(target, 'oracle/verify.mjs')))
    await assert.rejects(readFile(path.join(target, 'reference/solve.mjs')))
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('full file diff records additions, modifications, and deletions', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'babel-curated-diff-'))
  const before = path.join(parent, 'before')
  const after = path.join(parent, 'after')
  try {
    await mkdir(path.join(before, 'src'), { recursive: true })
    await mkdir(path.join(after, 'src'), { recursive: true })
    await writeFile(path.join(before, 'src/keep.js'), 'before\n')
    await writeFile(path.join(after, 'src/keep.js'), 'after\n')
    await writeFile(path.join(before, 'src/remove.js'), 'remove\n')
    await writeFile(path.join(after, 'added.txt'), 'new\n')
    assert.deepEqual(await collectWorkspaceDiff(before, after), {
      added: ['added.txt'], modified: ['src/keep.js'], deleted: ['src/remove.js'],
    })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('score needs a passing oracle and rejects test/config changes', async () => {
  const catalog = await loadCatalog(root)
  const task = catalog.tasks.find((item) => item.id === 'csv-rollup-cli')
  assert.equal(scoreAttempt(task, {
    terminal_status: 'completed',
    completion_claimed: true,
    verifier: { status: 'passed', assertions: 2 },
    diff: { added: ['output/summary.csv'], modified: ['src/summarize.mjs'], deleted: [] },
  }).outcome, 'valid_success')
  for (const terminal_status of ['failed', 'blocked']) {
    assert.equal(scoreAttempt(task, {
      terminal_status,
      verifier: { status: 'passed', assertions: 2 },
      diff: { added: [], modified: [], deleted: [] },
    }).outcome, 'task_failure', `${terminal_status} must not score as valid success`)
  }
  const tampered = scoreAttempt(task, {
    terminal_status: 'completed',
    completion_claimed: true,
    verifier: { status: 'passed', assertions: 2 },
    diff: { added: ['README.md'], modified: ['src/summarize.mjs', 'test/public.test.mjs', 'package.json'], deleted: ['input/events.csv'] },
  })
  assert.equal(tampered.outcome, 'task_failure')
  assert.deepEqual(tampered.unauthorized_changes, ['input/events.csv', 'package.json', 'README.md', 'test/public.test.mjs'].sort())
  assert.equal(scoreAttempt(task, {
    terminal_status: 'completed', completion_claimed: true,
    verifier: { status: 'infrastructure_error', assertions: null, errors: ['grader unavailable'] },
    diff: { added: [], modified: [], deleted: [] },
  }).outcome, 'infrastructure_error')
})

test('attempt reporting keeps infrastructure, budget, usage, and unknowns separate', () => {
  const infra = normalizeAttempt({
    task_id: 'csv-rollup-cli', terminal_status: 'error', error_class: 'container_start_failed',
    usage: { input_tokens: null, output_tokens: null, cost_usd: null },
  })
  assert.equal(infra.outcome, 'infrastructure_error')
  assert.equal(infra.usage.cost_usd, null)
  assert.equal(infra.observed_model, null)
  const truncated = normalizeAttempt({ task_id: 'csv-rollup-cli', terminal_status: 'limit_reached', usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } })
  assert.equal(truncated.outcome, 'budget_truncated')
  assert.equal(truncated.usage.input_tokens, 100)
})
