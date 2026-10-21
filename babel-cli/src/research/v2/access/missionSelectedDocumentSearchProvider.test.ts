import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { createMissionSelectedDocumentSearchProvider } from './missionSelectedDocumentSearchProvider.js'

describe('missionSelectedDocumentSearchProvider', () => {
  it('returns admitted document hits from selected_document_refs', async () => {
    const mission = ResearchMissionV2Schema.parse({
      ...exampleTechnicalMissionFixture,
      mission_id: 'mission-doc-search-001',
      source_policy: {
        ...exampleTechnicalMissionFixture.source_policy,
        allowed_source_classes: ['document', 'web'],
        selected_document_refs: ['https://example.invalid/two-page-sample.pdf'],
      },
    })
    const provider = createMissionSelectedDocumentSearchProvider()
    const result = await provider.search(
      {
        operationId: 'doc-search',
        query: 'two-page sample pdf',
        sourceClasses: ['document'],
        signal: new AbortController().signal,
      },
      mission,
    )
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0]?.source.kind, 'document')
  })
})
