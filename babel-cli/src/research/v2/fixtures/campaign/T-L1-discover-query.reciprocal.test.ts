import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import { createPinnedRepositoryFileSearchProvider } from '../../access/pinnedRepositoryFileSearchProvider.js'
import type { GitHubTreeEntry } from '../../access/pinnedRepositoryFileSearchProvider.js'
import pins from './T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const campaignDir = dirname(fileURLToPath(import.meta.url))

function loadMission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'T-L1-mission.json'), 'utf8')),
  )
}

function treeFromPaths(paths: string[]): GitHubTreeEntry[] {
  return paths.map((path) => ({ path, type: 'blob' }))
}

describe('T-L1 discover-query reciprocal (injected trees, no GitHub API)', () => {
  it('CLI default first-eight-word query matches zero repository paths', async () => {
    const mission = loadMission()
    const defaultQuery = mission.primary_question.split(/\s+/).slice(0, 8).join(' ')
    const babelPaths = [
      'babel-cli/src/research/v2/persistence/README.md',
      'babel-cli/src/research/v2/persistence/durableResearchStore.ts',
      'babel-cli/src/executor/kernel.ts',
    ]
    const langGraphPaths = [
      'libs/langgraph/langgraph/pregel/_checkpoint.py',
      'libs/checkpoint-postgres/langgraph/store/postgres/base.py',
    ]
    const provider = createPinnedRepositoryFileSearchProvider({
      fetchTree: async ({ apiUrl }) => {
        if (apiUrl.includes('gthgomez/Babel')) {
          return { ok: true, status: 200, entries: treeFromPaths(babelPaths) }
        }
        if (apiUrl.includes('langchain-ai/langgraph')) {
          return { ok: true, status: 200, entries: treeFromPaths(langGraphPaths) }
        }
        return { ok: false, status: 404, entries: [], message: 'unexpected repo' }
      },
    })
    const result = await provider.search(
      {
        operationId: 't-l1-default-query',
        query: defaultQuery,
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      mission,
    )
    assert.equal(result.status, 'ok')
    assert.equal(result.hits.length, 0)
  })

  it('explicit production discover-query yields concrete Babel persistence paths', async () => {
    const mission = loadMission()
    const explicitQuery =
      process.env.BABEL_RESEARCH_V2_T_L1_DISCOVER_QUERY?.trim() ?? 'research v2 persistence'
    const babelPaths = [
      'babel-cli/src/research/v2/persistence/README.md',
      'babel-cli/src/research/v2/persistence/durableResearchStore.ts',
      'babel-cli/src/research/v2/persistence/durableStoreErrors.ts',
      'babel-cli/src/executor/kernel.ts',
    ]
    const provider = createPinnedRepositoryFileSearchProvider({
      fetchTree: async () => ({ ok: true, status: 200, entries: treeFromPaths(babelPaths) }),
    })
    const result = await provider.search(
      {
        operationId: 't-l1-explicit-query',
        query: explicitQuery,
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      mission,
    )
    assert.equal(result.status, 'ok')
    assert.ok(result.hits.length >= 1)
    const keys = result.hits.map((h) => h.source.canonical_key)
    assert.ok(keys.some((k) => k.includes('persistence/README.md')))
    assert.ok(keys.some((k) => k.includes('durableResearchStore.ts')))
  })

  it('mission declares distinct per-pin discover_query terms for Babel vs LangGraph', () => {
    const mission = loadMission()
    assert.equal(mission.pinned_target_repository?.discover_query, 'research v2 persistence')
    assert.equal(
      mission.source_policy.selected_repository_refs?.[0]?.discover_query,
      'libs checkpoint',
    )
    assert.equal(pins.reference_repository.commit_sha, mission.source_policy.selected_repository_refs?.[0]?.commit_sha)
    assert.equal(pins.reference_repository.git_tree_sha, 'a8aa3b138b6036c25331712af8ed8b3f0a4a0fda')
  })
})
