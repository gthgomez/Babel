import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareJourneyFixture, readJourneyCorpus } from './harness-journey-fixtures.js'
import { journeyScenario, withJourneyResources } from './harness-journey-resources.js'

test('prepared native journey sources and Git metadata are sandbox-readable under restrictive umask or Windows ACLs', async () => {
  const corpus = await readJourneyCorpus(fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url)))
  const spec = corpus.journeys.find(row => row.id === 'J03')!
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-modes-'))
  const originalUmask = process.umask(0o077)
  try {
    const prepared = await prepareJourneyFixture(spec, corpus.fixtures[spec.fixtureId]!, join(root, 'cell'))
    const paths = [prepared.candidateRoot, join(prepared.candidateRoot, 'REPO_MAP.md'), join(prepared.candidateRoot, '.git/index')]
    if (process.platform === 'win32') {
      const { readdir, readFile: readBytes } = await import('node:fs/promises')
      assert.ok((await readdir(paths[0]!)).includes('REPO_MAP.md'))
      assert.ok((await readBytes(paths[1]!)).length > 0)
      assert.ok((await readBytes(paths[2]!)).length > 0)
    } else {
      assert.deepEqual(await Promise.all(paths.map(async path => (await stat(path)).mode & 0o777)), [0o755, 0o644, 0o644])
    }
  } finally {
    process.umask(originalUmask)
    await rm(root, { recursive: true, force: true })
  }
})

test('prepared services expose supplied sources and persist receipts outside candidate grants, then close on failure', async () => {
  const corpus = await readJourneyCorpus(fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url)))
  const spec = corpus.journeys.find(row => row.id === 'J02')!
  const definition = corpus.fixtures[spec.fixtureId]!
  const root = await mkdtemp(join(tmpdir(), 'babel-journey-resources-'))
  const prepared = await prepareJourneyFixture(spec, definition, join(root, 'cell'))
  let url = ''
  await assert.rejects(withJourneyResources(spec, definition, prepared, async ({ service }) => {
    url = service.baseUrl
    assert.equal((await fetch(`${url}/sources/aspen-v1`)).status, 503)
    assert.match(await (await fetch(`${url}/sources/aspen-v1`)).text(), /8 GiB/)
    throw new Error('candidate interrupted')
  }), /candidate interrupted/)
  await assert.rejects(fetch(`${url}/sources/aspen-v1`))
  const persisted = JSON.parse(await readFile(join(prepared.protectedRoot, 'service-state.json'), 'utf8'))
  assert.equal(persisted.sourceReads.length, 1)
  assert.equal(prepared.protectedRoot.startsWith(prepared.candidateRoot), false)
})

test('steering schedules freeze required checkpoints and never count planning as execution', async () => {
  const corpus = await readJourneyCorpus(fileURLToPath(new URL('../../../benchmarks/harness-journeys/development.json', import.meta.url)))
  const j11 = corpus.journeys.find(row => row.id === 'J11')!
  assert.deepEqual(journeyScenario(j11).map(step => step.action), ['status', 'compact', 'restart_and_continue'])
  const j16 = corpus.journeys.find(row => row.id === 'J16')!
  const amendment = journeyScenario(j16)[0]!
  assert.equal(amendment.checkpoint, 'before_external_write')
  assert.match(amendment.message!, /Prefer Birch/)
})
