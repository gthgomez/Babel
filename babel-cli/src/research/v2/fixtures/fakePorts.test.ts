import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceRecordSchema } from '../contracts/sources.js'
import {
  FakeResearchModelPort,
  FakeSourceAccessPort,
  InMemoryResearchStore,
} from './fakePorts.js'
import {
  exampleMissionWriteContext,
  exampleTechnicalMissionFixture,
} from './exampleMission.js'

describe('research v2 fake ports', () => {
  it('runs search/fetch without network', async () => {
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
    assert.equal(search.status, 'ok')
    if (search.status === 'ok') assert.equal(search.hits.length, 1)
    const fetched = await access.fetchContent({
      operationId: 'op-fetch-1',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(fetched.status, 'ok')
    if (fetched.status === 'ok') {
      assert.match(fetched.admitted.revision.content_hash, /^[a-f0-9]{64}$/i)
      assert.equal(fetched.admitted.payload.mode, 'inline_bytes')
    }
  })

  it('search distinguishes cancel from zero hits', async () => {
    const access = new FakeSourceAccessPort([])
    const controller = new AbortController()
    controller.abort()
    const cancelled = await access.search({
      operationId: 's-cancel',
      query: 'x',
      sourceClasses: ['web'],
      signal: controller.signal,
    })
    assert.equal(cancelled.status, 'cancelled')
    const empty = await access.search({
      operationId: 's-empty',
      query: 'no-match-term-xyz',
      sourceClasses: ['web'],
      signal: new AbortController().signal,
    })
    assert.equal(empty.status, 'ok')
    if (empty.status === 'ok') assert.equal(empty.hits.length, 0)
  })

  it('model port rejects malformed structured output', async () => {
    const model = new FakeResearchModelPort()
    model.scriptOutput('bad-1', { kind: 'plan_questions', questions: [{ text: '', importance: 'low' }] })
    const result = await model.invokeStructured({
      operationId: 'bad-1',
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
  })

  it('appends durable mission-scoped events in order', async () => {
    const store = new InMemoryResearchStore()
    await store.appendMission(exampleTechnicalMissionFixture)
    await store.appendSource(exampleMissionWriteContext, SourceRecordSchema.parse({
      source_id: 'src-1',
      kind: 'web',
      canonical_key: 'k',
      observed_urls: ['https://example.test/'],
    }))
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.equal(events.length, 2)
    assert.equal(events[1]?.kind, 'source_recorded')
  })
})
