/**
 * Regression tests for independent #405 review findings (59cd561b…).
 * These encode the *target* contract; they fail until a revised checkpoint lands.
 * Do not weaken assertions to greenwash the current M0 freeze.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResearchStore } from '../ports/researchStore.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { FakeSourceAccessPort } from '../fixtures/fakePorts.js'
import { SourceRecordSchema } from './sources.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'

function hasStoreMethod(store: ResearchStore, name: string): boolean {
  return typeof (store as Record<string, unknown>)[name] === 'function'
}

describe('research v2 contract regressions (#405 review)', () => {
  it('ResearchStore exposes mission-scoped external operation intent/completion writes', () => {
    const store = new InMemoryResearchStore()
    assert.ok(
      hasStoreMethod(store, 'appendExternalOperationIntent'),
      'missing appendExternalOperationIntent(missionWriteContext, intent)',
    )
    assert.ok(
      hasStoreMethod(store, 'appendExternalOperationCompleted'),
      'missing appendExternalOperationCompleted(missionWriteContext, completion)',
    )
  })

  it('listEvents(missionId) includes evidence writes keyed to the mission, not entity ids', async () => {
    const missionId = exampleTechnicalMissionFixture.mission_id
    const store = new InMemoryResearchStore()
    await store.appendMission(exampleTechnicalMissionFixture)
    const source = SourceRecordSchema.parse({
      source_id: 'src-regression-1',
      kind: 'document',
      canonical_key: 'fixture:doc:1',
      observed_urls: ['https://example.test/doc/1'],
    })
    await store.appendSource(source)
    const events = await store.listEvents(missionId)
    const kinds = events.map((e) => e.kind)
    assert.ok(kinds.includes('mission_created'), 'mission_created missing')
    assert.ok(
      kinds.includes('source_recorded'),
      `source_recorded missing from listEvents(${missionId}); got kinds=${kinds.join(',')}`,
    )
  })

  it('SourceAccessPort.read yields bounded admitted raw bytes for B-owned HTML/PDF parsing', async () => {
    const source = SourceRecordSchema.parse({
      source_id: 'src-html-1',
      kind: 'web',
      canonical_key: 'fixture:web:1',
      observed_urls: ['https://example.test/page'],
    })
    const access: SourceAccessPort = new FakeSourceAccessPort([
      { source, body: '<html><body><p>fee</p></body></html>', mediaType: 'text/html' },
    ])
    const result = await access.read({
      operationId: 'op-raw-1',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.ok(
      'admitted_content' in result &&
        result.admitted_content !== undefined &&
        (result.admitted_content.mode === 'inline_bytes' ||
          result.admitted_content.mode === 'blob_ref'),
      'read must return admitted_content for adapter parsing, not port-owned passages only',
    )
    assert.equal(
      (result as { passages?: unknown }).passages,
      undefined,
      'port read must not pre-extract passages; adapters own extraction',
    )
  })

  it('SourceAdapter exposes read() in addition to discover()', () => {
    const adapterShape: Pick<SourceAdapter, 'adapterId' | 'supportedKinds'> = {
      adapterId: 'web',
      supportedKinds: ['web'],
    }
    assert.ok(
      typeof (adapterShape as SourceAdapter).read === 'function',
      'SourceAdapter.read missing — discover-only cannot host B HTML/PDF parsers',
    )
  })
})
