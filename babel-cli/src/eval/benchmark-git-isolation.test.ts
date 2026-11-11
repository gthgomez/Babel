import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  'BABEL_REQUIRE_CLEAN_TREE', 'BABEL_DIRTY_TREE', 'BABEL_ALLOW_HOST_FALLBACK',
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
  assert.equal(
    (parseBenchmarkPorcelainBytes(0, Buffer.from('bogus\0', 'utf8')) as { reason: string }).reason,
    'invalid_porcelain',
  )
  assert.equal(
    (parseBenchmarkPorcelainBytes(0, Buffer.from('XY .babel/hidden\0', 'utf8')) as { reason: string }).reason,
    'invalid_porcelain',
  )
  assert.equal(
    (parseBenchmarkPorcelainBytes(0, Buffer.from('    \0', 'utf8')) as { reason: string }).reason,
    'invalid_porcelain',
  )
})

test('rename porcelain pairs validate continuation paths before internal filtering', () => {
  const intoBabel = Buffer.from('R  .babel/hidden.mjs\0lib/total.mjs\0', 'utf8')
  const parsedInto = parseBenchmarkPorcelainBytes(0, intoBabel)
  assert.equal(parsedInto.ok, true)
  assert.ok(parsedInto.ok && parsedInto.records.length > 0)
  const withinBabel = Buffer.from('R  .babel/a.mjs\0.babel/b.mjs\0', 'utf8')
  assert.deepEqual(parseBenchmarkPorcelainBytes(0, withinBabel), { ok: true, records: [] })
  const ordinary = Buffer.from('R  lib/new.mjs\0lib/old.mjs\0', 'utf8')
  const parsedOrdinary = parseBenchmarkPorcelainBytes(0, ordinary)
  assert.equal(parsedOrdinary.ok, true)
  assert.ok(parsedOrdinary.ok && parsedOrdinary.records.length > 0)
  assert.equal(
    (parseBenchmarkPorcelainBytes(0, Buffer.from('R  only-dest.mjs\0', 'utf8')) as { reason: string }).reason,
    'invalid_porcelain',
  )
  assert.equal(
    (parseBenchmarkPorcelainBytes(0, Buffer.from('R  dest.mjs\0 M bad.mjs\0', 'utf8')) as { reason: string }).reason,
    'invalid_porcelain',
  )
  const ambiguousPartner = parseBenchmarkPorcelainBytes(0, Buffer.from('R  dest.mjs\0 M lib/path.mjs\0', 'utf8'))
  assert.equal(ambiguousPartner.ok, false)
  assert.equal((ambiguousPartner as { reason: string }).reason, 'invalid_porcelain')
})

test('benchmark observer treats spawn and git failures as conservatively dirty', async () => {
  const nogit = await mkdtemp(join(tmpdir(), 'babel-benchmark-observe-'))
  const missingCwd = join(tmpdir(), `babel-missing-cwd-${Date.now()}`)
  try {
    assert.equal((observeBenchmarkPorcelain(nogit) as { reason: string }).reason, 'git_exit')
    assert.equal(observeBenchmarkWorkingTreeDirty(nogit), true)
    assert.equal((observeBenchmarkPorcelain(missingCwd) as { reason: string }).reason, 'spawn_failed')
    assert.equal(observeBenchmarkWorkingTreeDirty(missingCwd), true)
    if (process.platform !== 'win32') {
      const priorPath = process.env['PATH']
      try {
        process.env['PATH'] = ''
        assert.equal((observeBenchmarkPorcelain(nogit) as { reason: string }).reason, 'spawn_failed')
      } finally {
        if (priorPath === undefined) delete process.env['PATH']
        else process.env['PATH'] = priorPath
      }
    }
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

test('internal-only .babel untracked does not count as workspace dirty', async () => {
  const { candidateRoot } = await j05Fixture()
  await mkdir(join(candidateRoot, '.babel'), { recursive: true })
  await writeFile(join(candidateRoot, '.babel', 'scratch.txt'), 'scratch\n')
  const observed = observeBenchmarkPorcelain(candidateRoot)
  assert.equal(observed.ok, true)
  assert.equal(observed.ok && observed.records.length, 0)
  assert.equal(observeBenchmarkWorkingTreeDirty(candidateRoot), false)
})

test('staged and ordinary rename mutations surface as dirty benchmark porcelain', async () => {
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

test('rename into .babel keeps broker dirty and routes ownership classification', async () => {
  const { candidateRoot } = await j05Fixture()
  await mkdir(join(candidateRoot, '.babel'), { recursive: true })
  assert.equal(
    runBenchmarkGitObserve(candidateRoot, ['mv', 'lib/total.mjs', '.babel/hidden.mjs']).status,
    0,
  )
  const prior = snapshotEnv()
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  try {
    assert.equal(observeBenchmarkWorkingTreeDirty(candidateRoot), true)
    assert.equal(detectWorkingTreeDirty(candidateRoot, process.env), true)
    withBenchmarkIsolationEnv(candidateRoot, ownership => {
      const flags = resolveIsolationBrokerFlags(candidateRoot, process.env)
      assert.equal(flags.dirtyTree, true)
      assert.equal(ownership.matchesRoot(candidateRoot), true)
      const changes = ownership.classifyChanges()
      assert.ok(changes.unexpectedPaths.length > 0 || changes.unverifiablePaths.length > 0)
    })
  } finally {
    restoreEnv(prior)
  }
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
    await rm(nogit, { recursive: true, force: true })
  }
})

test('invalid porcelain bytes are fail-closed at the broker observer', async () => {
  const truncated = Buffer.from(' M tracked.txt', 'utf8')
  const nonUtf8 = Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x2e, 0x74, 0x78, 0x74, 0x00])
  assert.equal((parseBenchmarkPorcelainBytes(0, truncated) as { reason: string }).reason, 'truncated_nul')
  assert.equal((parseBenchmarkPorcelainBytes(0, nonUtf8) as { reason: string }).reason, 'non_utf8')
  const nogit = await mkdtemp(join(tmpdir(), 'babel-benchmark-invalid-close-'))
  try {
    assert.equal(observeBenchmarkWorkingTreeDirty(nogit), true)
  } finally {
    await rm(nogit, { recursive: true, force: true })
  }
})
