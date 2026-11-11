import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { detectWorkingTreeDirty } from '../agent/capabilityBroker.js'
import { resolveIsolationBrokerFlags } from '../agent/chatEngineIsolationFlags.js'
import { runWithExecutionContext, type ExecutionContext } from '../agent/executionContext.js'
import { TaskMutationOwnership } from '../agent/taskMutationOwnership.js'
import { resetDockerAvailabilityCache } from '../config/benchmarkContainer.js'
import {
  benchmarkPorcelainRecords,
  observeBenchmarkPorcelain,
  observeBenchmarkWorkingTreeDirty,
  parseBenchmarkPorcelainBytes,
  runBenchmarkGitCommandBytes,
  runBenchmarkGitObserve,
} from '../utils/gitExec.js'
import { prepareJourneyFixture, readJourneyCorpus } from './harness-journey-fixtures.js'

const corpusPath = fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url))

async function j05Fixture() {
  const root = await mkdtemp(join(tmpdir(), 'babel-benchmark-isolation-'))
  const corpus = await readJourneyCorpus(corpusPath)
  const spec = { ...corpus.journeys.find(row => row.id === 'J05')!, id: 'benchmark-isolation' }
  const prepared = await prepareJourneyFixture(spec, corpus.fixtures[spec.fixtureId]!, join(root, 'cell'))
  return { root, candidateRoot: prepared.candidateRoot }
}

const envKeys = [
  'BABEL_BENCHMARK_MODE', 'BABEL_EXECUTION_PROFILE', 'BABEL_DOCKER_DISABLE',
  'BABEL_REQUIRE_CLEAN_TREE', 'BABEL_DIRTY_TREE', 'BABEL_GIT_PATH', 'BABEL_ALLOW_HOST_FALLBACK',
] as const

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
}

function restoreEnv(prior: Record<string, string | undefined>): void {
  for (const key of envKeys) {
    if (prior[key] === undefined) delete process.env[key]
    else process.env[key] = prior[key]
  }
  resetDockerAvailabilityCache()
}

function withBenchmarkIsolationEnv(
  root: string,
  run: (ownership: TaskMutationOwnership) => void,
): void {
  const prior = snapshotEnv()
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_DOCKER_DISABLE'] = 'true'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  const ownership = new TaskMutationOwnership(root, 'benchmark-isolation-eval')
  const ctx: ExecutionContext = {
    threadId: 'benchmark-isolation',
    turnId: null,
    root,
    indexWritePolicy: 'allow',
    mutationOwnership: ownership,
  }
  try {
    runWithExecutionContext(ctx, () => run(ownership))
  } finally {
    ownership.retire()
    restoreEnv(prior)
  }
}

test('parseBenchmarkPorcelainBytes distinguishes valid clean from invalid porcelain', () => {
  assert.deepEqual(parseBenchmarkPorcelainBytes(0, Buffer.alloc(0)), { ok: true, records: [] })
  assert.equal(parseBenchmarkPorcelainBytes(1, Buffer.alloc(0)).ok, false)
  assert.equal((parseBenchmarkPorcelainBytes(1, Buffer.alloc(0)) as { reason: string }).reason, 'git_exit')
  assert.equal((parseBenchmarkPorcelainBytes(null, Buffer.alloc(0)) as { reason: string }).reason, 'spawn_failed')
  const nonUtf8 = Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x2e, 0x74, 0x78, 0x74, 0x00])
  assert.equal((parseBenchmarkPorcelainBytes(0, nonUtf8) as { reason: string }).reason, 'non_utf8')
  assert.equal(
    (parseBenchmarkPorcelainBytes(0, Buffer.from(' M file.txt', 'utf8')) as { reason: string }).reason,
    'truncated_nul',
  )
})

test('benchmark observer treats invalid porcelain as conservatively dirty', async () => {
  const nonUtf8 = Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x2e, 0x74, 0x78, 0x74, 0x00])
  const nogit = await mkdtemp(join(tmpdir(), 'babel-benchmark-observe-'))
  try {
    assert.equal((observeBenchmarkPorcelain(nogit) as { reason: string }).reason, 'git_exit')
    assert.equal(observeBenchmarkWorkingTreeDirty(nogit), true)
    assert.equal(benchmarkPorcelainRecords(nogit).length, 0)
    const priorPath = process.env['PATH']
    process.env['PATH'] = join(tmpdir(), 'empty-path-with-no-git')
    assert.equal((observeBenchmarkPorcelain(nogit) as { reason: string }).reason, 'spawn_failed')
    assert.equal(observeBenchmarkWorkingTreeDirty(nogit), true)
    if (priorPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = priorPath
    assert.equal(parseBenchmarkPorcelainBytes(0, nonUtf8).ok, false)
  } finally {
    await rm(nogit, { recursive: true, force: true })
  }
})

test('known-clean fixture yields valid empty porcelain and non-dirty broker probe', async () => {
  const { candidateRoot } = await j05Fixture()
  const prior = snapshotEnv()
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  try {
    const observed = observeBenchmarkPorcelain(candidateRoot)
    assert.equal(observed.ok, true)
    assert.equal(observed.ok && observed.records.length, 0)
    assert.equal(observeBenchmarkWorkingTreeDirty(candidateRoot), false)
    assert.equal(detectWorkingTreeDirty(candidateRoot, process.env), false)
  } finally {
    restoreEnv(prior)
  }
})

test('staged and rename mutations surface as dirty benchmark porcelain', async () => {
  const { candidateRoot } = await j05Fixture()
  const stagedPath = 'lib/total.mjs'
  await writeFile(join(candidateRoot, stagedPath), 'export const staged = 1\n')
  assert.equal(runBenchmarkGitCommandBytes(candidateRoot, ['add', stagedPath]).status, 0)
  assert.equal(observeBenchmarkWorkingTreeDirty(candidateRoot), true)
  assert.ok(benchmarkPorcelainRecords(candidateRoot).some(row => row.includes('total.mjs')))
  const renameTo = join(candidateRoot, 'lib', 'total-renamed.mjs')
  assert.equal(runBenchmarkGitObserve(candidateRoot, ['mv', 'lib/total.mjs', 'lib/total-renamed.mjs']).status, 0)
  assert.equal(observeBenchmarkWorkingTreeDirty(candidateRoot), true)
  assert.ok(benchmarkPorcelainRecords(candidateRoot).some(row => row.includes('total')))
  const { access, stat } = await import('node:fs/promises')
  await access(renameTo)
  await assert.rejects(stat(join(candidateRoot, 'lib', 'total.mjs')))
})

test('benchmark Git failure keeps isolation path and ownership git-status unverifiable', async () => {
  const nogit = await mkdtemp(join(tmpdir(), 'babel-benchmark-nogit-'))
  const prior = snapshotEnv()
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  try {
    assert.equal(detectWorkingTreeDirty(nogit, process.env), true)
    withBenchmarkIsolationEnv(nogit, ownership => {
      assert.equal(ownership.matchesRoot(nogit), true)
      const flags = resolveIsolationBrokerFlags(nogit, process.env)
      assert.equal(flags.isolationRequired, true)
      assert.equal(flags.dirtyTree, true)
      const changes = ownership.classifyChanges()
      assert.ok(changes.unverifiablePaths.includes('<git-status>'))
    })
  } finally {
    restoreEnv(prior)
  }
})

test('truncated and non-utf8 porcelain are not treated as valid clean observations', () => {
  const truncated = Buffer.from(' M tracked.txt', 'utf8')
  const nonUtf8 = Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x2e, 0x74, 0x78, 0x74, 0x00])
  assert.equal((parseBenchmarkPorcelainBytes(0, truncated) as { reason: string }).reason, 'truncated_nul')
  assert.equal((parseBenchmarkPorcelainBytes(0, nonUtf8) as { reason: string }).reason, 'non_utf8')
})
