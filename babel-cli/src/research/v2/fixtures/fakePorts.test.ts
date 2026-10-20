import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceRecordSchema } from '../contracts/sources.js'
import {
  FakeResearchModelPort,
  FakeSourceAccessPort,
  InMemoryResearchStore,
} from './fakePorts.js'
import { exampleTechnicalMissionFixture } from './exampleMission.js'

describe('research v2 fake ports', () => {
  it('runs search/read without network', async () => {
    const source = SourceRecordSchema.parse({
      source_id: 'src-babel-contract',
      kind: 'repository_file',
      canonical_key: 'github:gthgomez/Babel:contracts.ts',
      observed_urls: ['https://github.com/gthgomez/Babel/blob/main/babel-cli/src/research/contracts.ts'],
      title: 'V1 contracts',
    })
    const access = new FakeSourceAccessPort([
      {
        source,
        body: 'remote repository content is untrusted data',
        mediaType: 'text/plain',
      },
    ])
    const search = await access.search({
      operationId: 'op-search-1',
      query: 'untrusted data',
      sourceClasses: ['repository_file'],
      signal: new AbortController().signal,
    })
    assert.equal(search.hits.length, 1)
    const read = await access.read({
      operationId: 'op-read-1',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(read.status, 'ok')
    if (read.status === 'ok') {
      assert.match(read.revision.content_hash, /^[a-f0-9]{64}$/i)
      assert.equal(read.passages.length, 1)
    }
  })

  it('honours abort on model port', async () => {
    const model = new FakeResearchModelPort()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() =>
      model.invokeStructured({
        operationId: 'm1',
        kind: 'plan_questions',
        input: {},
        signal: controller.signal,
      }),
    )
  })

  it('appends durable events in order', async () => {
    const store = new InMemoryResearchStore()
    await store.appendMission(exampleTechnicalMissionFixture)
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.equal(events.length, 1)
    const all = store.allEvents()
    assert.equal(all.length, 1)
    assert.equal(all[0]?.kind, 'mission_created')
  })
})
