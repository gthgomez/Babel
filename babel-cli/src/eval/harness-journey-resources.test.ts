import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareJourneyFixture, readJourneyCorpus } from './harness-journey-fixtures.js'
import { journeyScenario, withJourneyResources } from './harness-journey-resources.js'

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
