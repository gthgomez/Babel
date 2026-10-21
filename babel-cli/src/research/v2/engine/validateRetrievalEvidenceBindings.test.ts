import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { technicalRepositoryCorpusSource } from '../fixtures/technicalRepositoryCorpus.js'
import {
  RetrievalEvidenceBindingError,
  validateRetrievalEvidenceBindings,
} from './validateRetrievalEvidenceBindings.js'

const ctx = {
  mission_id: exampleTechnicalMissionFixture.mission_id,
  plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
  writer_generation: 2,
}

function okDiscover() {
  return {
    operationId: 'search-op',
    status: 'ok' as const,
    candidates: [technicalRepositoryCorpusSource],
  }
}

function okRead(revisionId = 'rev-1', passageRevisionId = revisionId) {
  return {
    operationId: 'fetch-op',
    status: 'ok' as const,
    revision: {
      revision_id: revisionId,
      source_id: technicalRepositoryCorpusSource.source_id,
      content_hash: 'abc',
      retrieved_at: '2026-10-20T12:00:00.000Z',
      extraction_version: 't',
      media_type: 'text/plain',
      completeness: 'complete' as const,
    },
    passages: [
      {
        passage_id: 'passage-1',
        source_revision_id: passageRevisionId,
        locator: { kind: 'line_range' as const, start_line: 1, end_line: 1 },
        text_ref: { mode: 'inline' as const, text: 'x', text_hash: 'h' },
      },
    ],
    extraction_version: 't',
  }
}

describe('validateRetrievalEvidenceBindings', () => {
  it('accepts a consistent discover/read chain', () => {
    validateRetrievalEvidenceBindings({
      searchOperationId: 'search-op',
      fetchOperationId: 'fetch-op',
      discover: okDiscover(),
      read: okRead(),
      candidate: technicalRepositoryCorpusSource,
      mission: exampleTechnicalMissionFixture,
      plan: examplePlanRevisionFixture,
      ctx,
    })
  })

  it('rejects discover operationId mismatch', () => {
    assert.throws(
      () =>
        validateRetrievalEvidenceBindings({
          searchOperationId: 'search-op',
          fetchOperationId: 'fetch-op',
          discover: { ...okDiscover(), operationId: 'wrong-search' },
          read: okRead(),
          candidate: technicalRepositoryCorpusSource,
          mission: exampleTechnicalMissionFixture,
          plan: examplePlanRevisionFixture,
          ctx,
        }),
      RetrievalEvidenceBindingError,
    )
  })

  it('rejects read operationId mismatch', () => {
    assert.throws(
      () =>
        validateRetrievalEvidenceBindings({
          searchOperationId: 'search-op',
          fetchOperationId: 'fetch-op',
          discover: okDiscover(),
          read: { ...okRead(), operationId: 'wrong-fetch' },
          candidate: technicalRepositoryCorpusSource,
          mission: exampleTechnicalMissionFixture,
          plan: examplePlanRevisionFixture,
          ctx,
        }),
      RetrievalEvidenceBindingError,
    )
  })

  it('rejects revision source_id mismatch', () => {
    assert.throws(
      () =>
        validateRetrievalEvidenceBindings({
          searchOperationId: 'search-op',
          fetchOperationId: 'fetch-op',
          discover: okDiscover(),
          read: {
            ...okRead(),
            revision: { ...okRead().revision, source_id: 'other-source' },
          },
          candidate: technicalRepositoryCorpusSource,
          mission: exampleTechnicalMissionFixture,
          plan: examplePlanRevisionFixture,
          ctx,
        }),
      RetrievalEvidenceBindingError,
    )
  })

  it('rejects passage source_revision_id mismatch', () => {
    assert.throws(
      () =>
        validateRetrievalEvidenceBindings({
          searchOperationId: 'search-op',
          fetchOperationId: 'fetch-op',
          discover: okDiscover(),
          read: okRead('rev-1', 'rev-other'),
          candidate: technicalRepositoryCorpusSource,
          mission: exampleTechnicalMissionFixture,
          plan: examplePlanRevisionFixture,
          ctx,
        }),
      RetrievalEvidenceBindingError,
    )
  })

  it('rejects plan mission mismatch', () => {
    assert.throws(
      () =>
        validateRetrievalEvidenceBindings({
          searchOperationId: 'search-op',
          fetchOperationId: 'fetch-op',
          discover: okDiscover(),
          read: okRead(),
          candidate: technicalRepositoryCorpusSource,
          mission: exampleTechnicalMissionFixture,
          plan: { ...examplePlanRevisionFixture, mission_id: 'other-mission' },
          ctx,
        }),
      RetrievalEvidenceBindingError,
    )
  })

  it('rejects plan revision mismatch with write context', () => {
    assert.throws(
      () =>
        validateRetrievalEvidenceBindings({
          searchOperationId: 'search-op',
          fetchOperationId: 'fetch-op',
          discover: okDiscover(),
          read: okRead(),
          candidate: technicalRepositoryCorpusSource,
          mission: exampleTechnicalMissionFixture,
          plan: examplePlanRevisionFixture,
          ctx: { ...ctx, plan_revision_id: 'other-plan' },
        }),
      RetrievalEvidenceBindingError,
    )
  })
})
