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

  it('carries bounded acquisition_diagnostics and evidence-based failure category on tree HTTP errors', async () => {
    const provider = createPinnedRepositoryFileSearchProvider({
      fetchTree: async () => ({
        ok: false,
        status: 403,
        entries: [],
        message: 'GitHub tree API HTTP 403: API rate limit exceeded',
        acquisition_diagnostics: {
          evidence_role: 'attempted_source',
          attempted_url: 'https://api.github.com/repos/o/r/git/trees/sha',
          http_status: 403,
          http_failure: {
            public_message: 'API rate limit exceeded',
            public_message_qualifier: 'unverified_github_json_message_field',
            rate_limit_remaining: '0',
          },
        },
      }),
    })
    const result = await provider.search(
      {
        operationId: 'op-tree-403',
        query: 'contracts',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(result.failureCategory, 'rate_limited')
    assert.equal(result.acquisition_diagnostics?.http_status, 403)
    assert.equal(result.acquisition_diagnostics?.http_failure?.public_message_qualifier, 'unverified_github_json_message_field')
  })

  it('keeps unknown 403 as network_error without rate/auth evidence', async () => {
    const provider = createPinnedRepositoryFileSearchProvider({
      fetchTree: async () => ({
        ok: false,
        status: 403,
        entries: [],
        message: 'GitHub tree API HTTP 403',
        acquisition_diagnostics: {
          evidence_role: 'attempted_source',
          attempted_url: 'https://api.github.com/repos/o/r/git/trees/sha',
          http_status: 403,
        },
      }),
    })
    const result = await provider.search(
      {
        operationId: 'op-tree-403-unknown',
        query: 'contracts',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(result.failureCategory, 'network_error')
  })
})
