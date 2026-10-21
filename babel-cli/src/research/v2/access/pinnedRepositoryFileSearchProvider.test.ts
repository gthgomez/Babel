import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { createPinnedRepositoryFileSearchProvider } from './pinnedRepositoryFileSearchProvider.js'

describe('pinnedRepositoryFileSearchProvider', () => {
  it('returns commit-pinned repository_file hits from injected tree listing', async () => {
    const provider = createPinnedRepositoryFileSearchProvider({
      fetchTree: async () => ({
        ok: true,
        status: 200,
        entries: [
          { path: 'babel-cli/src/research/contracts.ts', type: 'blob' },
          { path: 'README.md', type: 'blob' },
          { path: 'docs', type: 'tree' },
        ],
      }),
    })
    const result = await provider.search(
      {
        operationId: 'op-tree',
        query: 'research contracts',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.hits.length, 1)
    const source = result.hits[0]?.source
    assert.equal(source?.kind, 'repository_file')
    assert.equal(
      source?.canonical_identifiers?.github_commit_sha,
      exampleTechnicalMissionFixture.pinned_target_repository?.commit_sha,
    )
    assert.match(source?.observed_urls[0] ?? '', /\/blob\/[a-f0-9]{40}\//)
  })
})
