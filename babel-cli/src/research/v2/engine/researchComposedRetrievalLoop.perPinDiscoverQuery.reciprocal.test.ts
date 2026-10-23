import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createGovernedSourceAccessPort } from '../access/governedSourceAccessPort.js'
import { createMissionProductionSearchProvider } from '../access/createMissionProductionSearchProvider.js'
import type { GitHubTreeEntry } from '../access/pinnedRepositoryFileSearchProvider.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { examplePlanRevisionFixture } from '../fixtures/exampleMission.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { createCombinedResearchRegistries } from '../registry/reviewedBAdapterIntegration.js'
import { resolveDiscoveryAdapterForMission } from '../registry/missionAdapterResolution.js'
import { runAdmittedComposedRetrievalIteration } from './researchComposedRetrievalLoop.js'
import pins from '../fixtures/campaign/T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const FIXED_NOW = '2026-10-21T14:05:00.000Z'
const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')

function treeFromPaths(paths: string[]): GitHubTreeEntry[] {
  return paths.map((path) => ({ path, type: 'blob' }))
}

describe('composed retrieval per-pin discover query (T-L1, injected trees)', () => {
  it('dispatches scoped queries to each repository pin with global fallback unused', async () => {
    const mission = ResearchMissionV2Schema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'T-L1-mission.json'), 'utf8')),
    )
    assert.equal(mission.pinned_target_repository?.discover_query, 'persistence durableresearchstore.ts')
    assert.equal(
      mission.source_policy.selected_repository_refs?.[0]?.discover_query,
      'pregel checkpoint',
    )
    assert.equal(mission.pinned_target_repository?.commit_sha, pins.babel_repository.commit_sha)
    assert.equal(
      mission.source_policy.selected_repository_refs?.[0]?.commit_sha,
      pins.reference_repository.commit_sha,
    )

    const babelPath = 'babel-cli/src/research/v2/persistence/durableResearchStore.ts'
    const langPath = 'libs/langgraph/langgraph/pregel/_checkpoint.py'
    const recordedQueries: Array<{ query: string; fullName: string }> = []

    const baseSearch = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async ({ apiUrl }) => {
        if (apiUrl.includes('gthgomez/Babel')) {
          return {
            ok: true,
            status: 200,
            entries: treeFromPaths([babelPath, 'babel-cli/src/executor/kernel.ts']),
          }
        }
        if (apiUrl.includes('langchain-ai/langgraph')) {
          return {
            ok: true,
            status: 200,
            entries: treeFromPaths([langPath, 'libs/checkpoint-conformance/Makefile']),
          }
        }
        return { ok: false, status: 404, entries: [], message: `unexpected tree ${apiUrl}` }
      },
    })

    const searchProvider = {
      limitations: baseSearch.limitations,
      async search(
        request: Parameters<typeof baseSearch.search>[0],
        scopedMission: Parameters<typeof baseSearch.search>[1],
      ) {
        const pin = scopedMission.pinned_target_repository
        assert.ok(pin)
        recordedQueries.push({ query: request.query, fullName: pin.full_name })
        return baseSearch.search(request, scopedMission)
      },
    }

    const babelRaw = `https://raw.githubusercontent.com/${mission.pinned_target_repository!.full_name}/${mission.pinned_target_repository!.commit_sha}/${babelPath}`
    const langRaw = `https://raw.githubusercontent.com/${mission.source_policy.selected_repository_refs![0]!.full_name}/${mission.source_policy.selected_repository_refs![0]!.commit_sha}/${langPath}`

    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async ({ url }) => {
        const body =
          url === babelRaw || url.includes(babelPath)
            ? Buffer.from('export const durable = 1\n', 'utf8')
            : url === langRaw || url.includes(langPath)
              ? Buffer.from('# pregel checkpoint module\n', 'utf8')
              : null
        if (!body) {
          return {
            ok: false,
            status: 404,
            contentType: 'text/plain',
            buffer: Buffer.alloc(0),
            bytesReceived: 0,
            truncated: false,
            requestedUrl: url,
            finalUrl: url,
            redirectChain: [url],
            transportCoding: null,
          }
        }
        return {
          ok: true,
          status: 200,
          contentType: 'text/plain',
          buffer: body,
          bytesReceived: body.length,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }
      },
    })

    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery)

    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(mission)
    await store.appendPlanRevision(
      {
        mission_id: handle.mission_id,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        writer_generation: handle.writer_generation,
      },
      { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
    )

    const globalUnused = 'compare pinned repositories persistence execution policy'
    const result = await runAdmittedComposedRetrievalIteration({
      session: {
        mission,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      },
      store,
      access,
      adapter: discovery,
      registries,
      activePlan: { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
      discoverQuery: globalUnused,
      searchOperationId: 't-l1-per-pin-search',
      searchAttemptId: 't-l1-per-pin-search-att',
      fetchOperationId: 't-l1-per-pin-fetch',
      fetchAttemptId: 't-l1-per-pin-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })

    assert.equal(result.slotOutcomes.filter((o) => o.kind === 'repository_pin').length, 2)
    assert.ok(result.passageIds.length >= 2)
    assert.deepEqual(
      recordedQueries.map((r) => r.query).sort(),
      ['pregel checkpoint', 'persistence durableresearchstore.ts'].sort(),
    )
    assert.ok(recordedQueries.some((r) => r.fullName === 'gthgomez/Babel'))
    assert.ok(recordedQueries.some((r) => r.fullName === 'langchain-ai/langgraph'))
    assert.ok(!recordedQueries.some((r) => r.query === globalUnused))
  })

  it('uses global discover query when a pin omits discover_query', async () => {
    const base = ResearchMissionV2Schema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'T-L1-mission.json'), 'utf8')),
    )
    const mission = {
      ...base,
      pinned_target_repository: {
        ...base.pinned_target_repository!,
        discover_query: undefined,
      },
      source_policy: {
        ...base.source_policy,
        selected_repository_refs: undefined,
      },
    }
    const repoPath = 'babel-cli/src/research/v2/persistence/durableResearchStore.ts'
    const recorded: string[] = []
    const baseSearch = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async () => ({
        ok: true,
        status: 200,
        entries: treeFromPaths([repoPath]),
      }),
    })
    const searchProvider = {
      limitations: baseSearch.limitations,
      async search(
        request: Parameters<typeof baseSearch.search>[0],
        scopedMission: Parameters<typeof baseSearch.search>[1],
      ) {
        recorded.push(request.query)
        return baseSearch.search(request, scopedMission)
      },
    }
    const rawUrl = `https://raw.githubusercontent.com/${mission.pinned_target_repository!.full_name}/${mission.pinned_target_repository!.commit_sha}/${repoPath}`
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async ({ url }) => ({
        ok: url === rawUrl || url.includes(repoPath),
        status: url === rawUrl || url.includes(repoPath) ? 200 : 404,
        contentType: 'text/plain',
        buffer: Buffer.from('# persistence\n', 'utf8'),
        bytesReceived: 16,
        truncated: false,
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [url],
        transportCoding: null,
      }),
    })
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery)
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(mission)
    await store.appendPlanRevision(
      {
        mission_id: handle.mission_id,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        writer_generation: handle.writer_generation,
      },
      { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
    )
    const fallbackQuery = 'persistence durableresearchstore.ts'
    await runAdmittedComposedRetrievalIteration({
      session: {
        mission,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      },
      store,
      access,
      adapter: discovery,
      registries,
      activePlan: { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
      discoverQuery: fallbackQuery,
      searchOperationId: 'fallback-search',
      searchAttemptId: 'fallback-search-att',
      fetchOperationId: 'fallback-fetch',
      fetchAttemptId: 'fallback-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.deepEqual(recorded, [fallbackQuery])
  })
})
