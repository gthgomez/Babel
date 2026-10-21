import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { technicalRepositorySearchIndex } from '../fixtures/technicalSearchIndex.js'
import { admittedMissionSourceSearch } from './admittedMissionSourceSearch.js'

describe('admittedMissionSourceSearch', () => {
  it('returns mission-admitted hits for repository_file query', () => {
    const result = admittedMissionSourceSearch(
      {
        operationId: 'search-1',
        query: 'RESEARCH_CONTRACT',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
      technicalRepositorySearchIndex(),
    )
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.hits.length, 1)
      assert.equal(result.hits[0]?.source.kind, 'repository_file')
    }
  })

  it('filters out sources outside pinned repository commit', () => {
    const index = technicalRepositorySearchIndex()
    const tampered = {
      ...index[0]!,
      source: {
        ...index[0]!.source,
        canonical_identifiers: {
          ...index[0]!.source.canonical_identifiers,
          github_commit_sha: '0000000000000000000000000000000000000000',
        },
      },
    }
    const result = admittedMissionSourceSearch(
      {
        operationId: 'search-2',
        query: 'RESEARCH',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
      [tampered],
    )
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.hits.length, 0)
    }
  })
})
