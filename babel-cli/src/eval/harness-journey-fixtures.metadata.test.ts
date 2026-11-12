import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { TaskMutationOwnership, decodeTaskGitOutput } from '../agent/taskMutationOwnership.js'
import { benchmarkPorcelainRecords, observeBenchmarkWorkingTreeDirty, runBenchmarkGitCommandBytes, runBenchmarkGitObserve } from '../utils/gitExec.js'
import {
  captureJourneyGitState,
  diffFixtureMetadataEntries,
  fixtureGitIndexSemanticBinding,
  fixtureMetadataDigest,
  fixtureMetadataEntries,
  prepareJourneyFixture,
  readJourneyCorpus,
} from './harness-journey-fixtures.js'

const corpusPath = fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url))

async function j03Fixture() {
  const root = await mkdtemp(join(tmpdir(), 'babel-fixture-metadata-'))
  const corpus = await readJourneyCorpus(corpusPath)
  const spec = { ...corpus.journeys.find(row => row.id === 'J03')!, id: 'read-only-metadata' }
  const prepared = await prepareJourneyFixture(spec, corpus.fixtures[spec.fixtureId]!, join(root, 'cell'))
  return { root, prepared, candidateRoot: prepared.candidateRoot }
}

async function j05Fixture() {
  const root = await mkdtemp(join(tmpdir(), 'babel-fixture-metadata-'))
  const corpus = await readJourneyCorpus(corpusPath)
  const spec = { ...corpus.journeys.find(row => row.id === 'J05')!, id: 'quantity-metadata' }
  const prepared = await prepareJourneyFixture(spec, corpus.fixtures[spec.fixtureId]!, join(root, 'cell'))
  return { root, prepared, candidateRoot: prepared.candidateRoot }
}

test('diffFixtureMetadataEntries reports only same-fixture path deltas', () => {
  const before: [string, string][] = [['config', 'aa'], ['index', 'bb'], ['refs/heads/main', 'cc']]
  const after: [string, string][] = [['config', 'aa'], ['index', 'bb2'], ['refs/heads/main', 'cc'], ['objects/ab/cd', 'dd']]
  const delta = diffFixtureMetadataEntries(before, after)
  assert.deepEqual(delta.map(entry => entry.path), ['index', 'objects/ab/cd'])
  assert.equal(delta.find(entry => entry.path === 'index')?.before, 'bb')
  assert.equal(delta.find(entry => entry.path === 'index')?.after, 'bb2')
})

test('captureJourneyGitState observes without mutating fixture metadata digest', async () => {
  const { candidateRoot, prepared } = await j03Fixture()
  const digestBefore = await fixtureMetadataDigest(candidateRoot)
  const observed = await captureJourneyGitState(candidateRoot, prepared.gitMetadataDigest!)
  const digestAfter = await fixtureMetadataDigest(candidateRoot)
  assert.equal(observed.metadataDigest, prepared.gitMetadataDigest)
  assert.equal(digestBefore, digestAfter)
})

test('benchmark git observe does not refresh fixture index bytes', async () => {
  const { candidateRoot, prepared } = await j03Fixture()
  const bindingBefore = fixtureGitIndexSemanticBinding(candidateRoot)
  const digestBefore = await fixtureMetadataDigest(candidateRoot)
  assert.equal(observeBenchmarkWorkingTreeDirty(candidateRoot), false)
  const bindingAfter = fixtureGitIndexSemanticBinding(candidateRoot)
  const digestAfter = await fixtureMetadataDigest(candidateRoot)
  assert.equal(bindingBefore, bindingAfter)
  assert.equal(digestBefore, digestAfter)
  assert.equal(digestAfter, prepared.gitMetadataDigest)
})

test('clean hardened benchmark porcelain -z is empty and ownership stays verifiable', async () => {
  const { candidateRoot } = await j05Fixture()
  const status = runBenchmarkGitCommandBytes(candidateRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  assert.equal(status.status, 0)
  assert.equal(status.stdout.length, 0)
  const prior = process.env['BABEL_BENCHMARK_MODE']
  process.env['BABEL_BENCHMARK_MODE'] = '1'
  try {
    assert.deepEqual(new TaskMutationOwnership(candidateRoot, 'benchmark-clean').classifyChanges().unverifiablePaths, [])
    assert.equal(benchmarkPorcelainRecords(candidateRoot).length, 0)
  } finally {
    if (prior === undefined) delete process.env['BABEL_BENCHMARK_MODE']
    else process.env['BABEL_BENCHMARK_MODE'] = prior
  }
})

test('staged hardened benchmark porcelain preserves staged column semantics', async () => {
  const { candidateRoot } = await j05Fixture()
  const path = 'lib/total.mjs'
  await writeFile(join(candidateRoot, path), 'export const staged = 1\n')
  assert.equal(runBenchmarkGitCommandBytes(candidateRoot, ['add', path]).status, 0)
  const decoded = decodeTaskGitOutput(runBenchmarkGitCommandBytes(candidateRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout)
  assert.notEqual(decoded, null)
  const record = decoded!.split('\0').filter(Boolean)[0]!
  assert.match(record, /^M[ MD]/)
  assert.doesNotMatch(record, /^ M /)
})

test('undecodable porcelain bytes gate ownership as git-status unverifiable', () => {
  const bytes = Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x2e, 0x74, 0x78, 0x74, 0])
  assert.equal(decodeTaskGitOutput(bytes), null)
})

test('unhardened porcelain git status may refresh index bytes without semantic binding drift', async t => {
  const { candidateRoot, prepared } = await j03Fixture()
  const bindingBefore = fixtureGitIndexSemanticBinding(candidateRoot)
  const digestBefore = await fixtureMetadataDigest(candidateRoot)
  const { spawnSync } = await import('node:child_process')
  spawnSync('git', ['status', '--porcelain'], { cwd: candidateRoot, encoding: 'utf8' })
  const bindingAfter = fixtureGitIndexSemanticBinding(candidateRoot)
  const digestAfter = await fixtureMetadataDigest(candidateRoot)
  assert.equal(bindingBefore, bindingAfter, 'ls-files stage/mode/flags binding must not change under unhardened status')
  if (digestBefore !== digestAfter) {
    t.diagnostic('observed .git/index byte refresh on this Git/host after unhardened porcelain status')
    assert.notEqual(digestAfter, prepared.gitMetadataDigest)
  } else {
    t.diagnostic('no index byte refresh observed on this Git/host (environment-sensitive diagnostic; hardened observers still required)')
  }
})

test('update-index --skip-worktree fails full metadata digest and semantic binding', async () => {
  const { candidateRoot, prepared } = await j03Fixture()
  const bindingBefore = fixtureGitIndexSemanticBinding(candidateRoot)
  const result = runBenchmarkGitObserve(candidateRoot, ['update-index', '--skip-worktree', 'REPO_MAP.md'])
  assert.equal(result.status, 0, result.stderr)
  const bindingAfter = fixtureGitIndexSemanticBinding(candidateRoot)
  const observed = await captureJourneyGitState(candidateRoot, prepared.gitMetadataDigest!)
  assert.notEqual(bindingBefore, bindingAfter)
  assert.notEqual(observed.metadataDigest, prepared.gitMetadataDigest)
  assert.equal(observed.head, '')
  assert.match(observed.porcelainStatus, /metadata_changed/)
})

test('staged content tampering fails protected metadata digest', async () => {
  const { candidateRoot, prepared } = await j03Fixture()
  await writeFile(join(candidateRoot, 'REPO_MAP.md'), await (await import('node:fs/promises')).readFile(join(candidateRoot, 'REPO_MAP.md'), 'utf8') + '# tamper\n')
  const add = runBenchmarkGitObserve(candidateRoot, ['add', 'REPO_MAP.md'])
  assert.equal(add.status, 0, add.stderr)
  const observed = await captureJourneyGitState(candidateRoot, prepared.gitMetadataDigest!)
  assert.notEqual(observed.metadataDigest, prepared.gitMetadataDigest)
  assert.equal(createHash('sha256').update(JSON.stringify(await fixtureMetadataEntries(candidateRoot))).digest('hex'), observed.metadataDigest)
})
