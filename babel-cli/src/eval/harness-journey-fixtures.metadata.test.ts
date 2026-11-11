import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { observeBenchmarkWorkingTreeDirty, runBenchmarkGitObserve } from '../utils/benchmarkGitObserve.js'
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

test('porcelain git status refreshes index bytes but not semantic index binding', async () => {
  const { candidateRoot, prepared } = await j03Fixture()
  const bindingBefore = fixtureGitIndexSemanticBinding(candidateRoot)
  const digestBefore = await fixtureMetadataDigest(candidateRoot)
  const { spawnSync } = await import('node:child_process')
  spawnSync('git', ['status', '--porcelain'], { cwd: candidateRoot, encoding: 'utf8' })
  const bindingAfter = fixtureGitIndexSemanticBinding(candidateRoot)
  const digestAfter = await fixtureMetadataDigest(candidateRoot)
  assert.equal(bindingBefore, bindingAfter)
  assert.notEqual(digestBefore, digestAfter)
  assert.notEqual(digestAfter, prepared.gitMetadataDigest)
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
