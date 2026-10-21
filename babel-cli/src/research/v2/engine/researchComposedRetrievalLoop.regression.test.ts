import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createGovernedSourceAccessPort } from '../access/governedSourceAccessPort.js'
import { createMissionProductionSearchProvider } from '../access/createMissionProductionSearchProvider.js'
import { missionScopedToRepositoryPin } from '../access/missionPinnedRepositories.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { examplePlanRevisionFixture } from '../fixtures/exampleMission.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { createCombinedResearchRegistries } from '../registry/reviewedBAdapterIntegration.js'
import { resolveDiscoveryAdapterForMission } from '../registry/missionAdapterResolution.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import { ResearchPassFailedError } from './researchPassFailure.js'
import { runAdmittedComposedRetrievalIteration } from './researchComposedRetrievalLoop.js'
import pins from '../fixtures/campaign/T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const FIXED_NOW = '2026-10-21T09:00:00.000Z'
const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const syntheticPaperBytes = readFileSync(join(campaignDir, 'papers/mutable-locator-synthetic.pdf'))

function loadMission(name: string) {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, name), 'utf8')),
  )
}

async function seedMissionStore(mission: ReturnType<typeof loadMission>) {
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
  return { store, handle }
}

describe('composed retrieval regressions (scoped access + settlement)', () => {
  it('distinct repository pins discover different paths under governed port', async () => {
    const mission = loadMission('T-L1-mission.json')
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery instanceof TechnicalRepositoryFileAdapter)

    const babelPath = 'babel-cli/src/research/v2/persistence/durableResearchStore.ts'
    const langgraphPath = 'libs/langgraph/pregel/checkpoint.py'
    const treesSeen: string[] = []

    const searchProvider = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async ({ apiUrl }) => {
        treesSeen.push(apiUrl)
        if (apiUrl.includes('gthgomez%2FBabel') || apiUrl.includes('gthgomez/Babel')) {
          return { ok: true, status: 200, entries: [{ path: babelPath, type: 'blob' }] }
        }
        if (apiUrl.includes('langchain-ai%2Flanggraph') || apiUrl.includes('langchain-ai/langgraph')) {
          return { ok: true, status: 200, entries: [{ path: langgraphPath, type: 'blob' }] }
        }
        return { ok: false, status: 404, entries: [], message: 'unexpected tree api' }
      },
    })

    const admittedGet = async ({ url }: { url: string }) => {
      const body = url.includes(babelPath)
        ? Buffer.from('# babel persistence\n', 'utf8')
        : Buffer.from('# langgraph persistence\n', 'utf8')
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
    }

    const access = createGovernedSourceAccessPort({ mission, searchProvider, admittedGet })
    const { store, handle } = await seedMissionStore(mission)

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
      discoverQuery: 'README',
      searchOperationId: 'reg-search',
      searchAttemptId: 'reg-search-att',
      fetchOperationId: 'reg-fetch',
      fetchAttemptId: 'reg-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })

    assert.equal(result.slotOutcomes.filter((o) => o.kind === 'repository_pin').length, 2)
    const repoSources = result.sources.filter((s) => s.kind === 'repository_file')
    assert.equal(repoSources.length, 2)
    const titles = new Set(repoSources.map((s) => s.title))
    assert.ok(titles.has(babelPath))
    assert.ok(titles.has(langgraphPath))
    assert.equal(treesSeen.length, 2)
    assert.notEqual(treesSeen[0], treesSeen[1])
  })

  it('repository slot failure preserves writer generation for a later document slot', async () => {
    const base = loadMission('T-L2-synthetic-mission.json')
    const mission = {
      ...base,
      source_policy: {
        ...base.source_policy,
        allowed_source_classes: ['repository_file' as const, 'document' as const],
        selected_document_refs: [pins.t_l2_paper.canonical_url],
      },
    }
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery instanceof TechnicalRepositoryFileAdapter)

    const searchProvider = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async () => ({
        ok: false,
        status: 500,
        entries: [],
        message: 'tree listing failed for regression',
      }),
    })

    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async ({ url }) => {
        if (url === pins.t_l2_paper.canonical_url) {
          return {
            ok: true,
            status: 200,
            contentType: 'application/pdf',
            buffer: syntheticPaperBytes,
            bytesReceived: syntheticPaperBytes.length,
            truncated: false,
            requestedUrl: url,
            finalUrl: url,
            redirectChain: [url],
            transportCoding: null,
          }
        }
        return {
          ok: false,
          status: 404,
          contentType: 'application/octet-stream',
          buffer: Buffer.alloc(0),
          bytesReceived: 0,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }
      },
    })

    const { store, handle } = await seedMissionStore(mission)
    const generationBefore = handle.writer_generation
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
      discoverQuery: 'persistence',
      searchOperationId: 'fail-then-doc-search',
      searchAttemptId: 'fail-then-doc-search-att',
      fetchOperationId: 'fail-then-doc-fetch',
      fetchAttemptId: 'fail-then-doc-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })

    const repoOutcome = result.slotOutcomes.find((o) => o.kind === 'repository_pin')
    assert.equal(repoOutcome?.settlement, 'failed')
    const docOutcome = result.slotOutcomes.find((o) => o.kind === 'document_ref')
    assert.equal(docOutcome?.settlement, 'succeeded')
    assert.ok(result.passageIds.length >= 1)
    assert.ok(result.handle.writer_generation > generationBefore)
    const fence = store.readMissionWriteFence(mission.mission_id)
    assert.equal(fence.writer_generation, result.handle.writer_generation)
  })

  it('foreign writer replacement after failed child slot fences composed controller out', async () => {
    const base = loadMission('T-L2-synthetic-mission.json')
    const mission = {
      ...base,
      source_policy: {
        ...base.source_policy,
        allowed_source_classes: ['repository_file' as const, 'document' as const],
        selected_document_refs: [pins.t_l2_paper.canonical_url],
      },
    }
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery)
    const searchProvider = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async () => ({
        ok: false,
        status: 500,
        entries: [],
        message: 'tree listing failed for regression',
      }),
    })
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async ({ url }) => ({
        ok: url === pins.t_l2_paper.canonical_url,
        status: url === pins.t_l2_paper.canonical_url ? 200 : 404,
        contentType: 'application/pdf',
        buffer: url === pins.t_l2_paper.canonical_url ? syntheticPaperBytes : Buffer.alloc(0),
        bytesReceived: url === pins.t_l2_paper.canonical_url ? syntheticPaperBytes.length : 0,
        truncated: false,
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [url],
        transportCoding: null,
      }),
    })
    const { store, handle } = await seedMissionStore(mission)
    let childOwnGeneration: number | null = null
    const origAcquire = store.acquireWriterOwnership.bind(store)
    store.acquireWriterOwnership = async (req) => {
      const acquired = await origAcquire(req)
      if (
        childOwnGeneration === null &&
        req.expected_writer_generation === handle.writer_generation
      ) {
        childOwnGeneration = acquired.writer_generation
        store.bumpWriterGeneration(req.mission_id)
      }
      return acquired
    }

    await assert.rejects(
      () =>
        runAdmittedComposedRetrievalIteration({
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
          discoverQuery: 'persistence',
          searchOperationId: 'foreign-owner-search',
          searchAttemptId: 'foreign-owner-search-att',
          fetchOperationId: 'foreign-owner-fetch',
          fetchAttemptId: 'foreign-owner-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: new AbortController().signal,
          now: () => FIXED_NOW,
        }),
      (err: unknown) =>
        err instanceof ResearchPassFailedError ||
        (err instanceof Error && /competing resume rejected/i.test(err.message)),
    )

    assert.ok(childOwnGeneration !== null)
    const fence = store.readMissionWriteFence(mission.mission_id)
    assert.ok(fence.writer_generation > childOwnGeneration!)
  })

  it('settles thrown document search exactly once', async () => {
    const base = loadMission('T-L2-mission.json')
    const mission = {
      ...base,
      pinned_target_repository: undefined,
      source_policy: {
        ...base.source_policy,
        allowed_source_classes: ['document' as const],
        selected_repository_refs: undefined,
        selected_document_refs: ['https://example.test/paper.pdf'],
      },
    }
    const registries = await createCombinedResearchRegistries()
    const searchProvider = createMissionProductionSearchProvider({ mission })
    const throwingProvider = {
      limitations: searchProvider.limitations,
      search: async () => {
        throw new Error('document search transport exploded')
      },
    }
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: throwingProvider,
      admittedGet: async () => ({
        ok: false,
        status: 500,
        contentType: 'application/octet-stream',
        buffer: Buffer.alloc(0),
        bytesReceived: 0,
        truncated: false,
        requestedUrl: 'https://example.test/paper.pdf',
        finalUrl: 'https://example.test/paper.pdf',
        redirectChain: [],
        transportCoding: null,
      }),
    })
    const { store, handle } = await seedMissionStore(mission)
    const searchOperationId = 'doc-throw-search--document-ref-0'
    const result = await runAdmittedComposedRetrievalIteration({
      session: {
        mission,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      },
      store,
      access,
      adapter: new TechnicalRepositoryFileAdapter(),
      registries,
      activePlan: { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
      discoverQuery: 'paper',
      searchOperationId: 'doc-throw-search',
      searchAttemptId: 'doc-throw-search-att',
      fetchOperationId: 'doc-throw-fetch',
      fetchAttemptId: 'doc-throw-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    }).catch((err: unknown) => err)

    assert.ok(result instanceof Error)
    const events = await store.listEvents(mission.mission_id)
    const completions = events.filter(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload.completion as { operation_id?: string }).operation_id === searchOperationId,
    )
    assert.equal(completions.length, 1)
    assert.equal(
      (completions[0]!.payload.completion as { settlement?: string }).settlement,
      'uncertain',
    )
  })

  it('aborts after successful document read without persisting passages or succeeding fetch', async () => {
    const base = loadMission('T-L2-mission.json')
    const mission = {
      ...base,
      pinned_target_repository: undefined,
      source_policy: {
        ...base.source_policy,
        allowed_source_classes: ['document' as const],
        selected_repository_refs: undefined,
        selected_document_refs: ['https://example.test/abort-after-read.pdf'],
      },
    }
    const registries = await createCombinedResearchRegistries()
    const pdfFixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../adapters/documents/fixtures/two-page-sample.pdf'),
    )
    const searchProvider = createMissionProductionSearchProvider({ mission })
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async ({ url }) => ({
        ok: true,
        status: 200,
        contentType: 'application/pdf',
        buffer: pdfFixture,
        bytesReceived: pdfFixture.length,
        truncated: false,
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [url],
        transportCoding: null,
      }),
    })
    const { store, handle } = await seedMissionStore(mission)
    const ac = new AbortController()
    const fetchOperationId = 'abort-read-fetch--document-ref-0'
    store.appendPassage = async () => {
      ac.abort()
      throw new Error('passage persistence blocked after read for abort regression')
    }

    await assert.rejects(
      () =>
        runAdmittedComposedRetrievalIteration({
          session: {
            mission,
            handle,
            activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
          },
          store,
          access,
          adapter: new TechnicalRepositoryFileAdapter(),
          registries,
          activePlan: { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
          discoverQuery: mission.source_policy.selected_document_refs![0]!,
          searchOperationId: 'abort-read-search',
          searchAttemptId: 'abort-read-search-att',
          fetchOperationId: 'abort-read-fetch',
          fetchAttemptId: 'abort-read-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: ac.signal,
          now: () => FIXED_NOW,
        }),
      /aborted during evidence persistence/i,
    )

    const events = await store.listEvents(mission.mission_id)
    const passages = events.filter((e) => e.kind === 'passage_recorded')
    assert.equal(passages.length, 0)
    const fetchCompletion = events.filter(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload.completion as { operation_id?: string }).operation_id === fetchOperationId,
    )
    assert.equal(fetchCompletion.length, 1)
    assert.equal(
      (fetchCompletion[0]!.payload.completion as { settlement?: string }).settlement,
      'cancelled',
    )
  })

  it('aborts on final passage write without fetch success settlement', async () => {
    const base = loadMission('T-L2-mission.json')
    const mission = {
      ...base,
      pinned_target_repository: undefined,
      source_policy: {
        ...base.source_policy,
        allowed_source_classes: ['document' as const],
        selected_repository_refs: undefined,
        selected_document_refs: ['https://example.test/final-passage.pdf'],
      },
    }
    const registries = await createCombinedResearchRegistries()
    const pdfFixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../adapters/documents/fixtures/two-page-sample.pdf'),
    )
    const searchProvider = createMissionProductionSearchProvider({ mission })
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async ({ url }) => ({
        ok: true,
        status: 200,
        contentType: 'application/pdf',
        buffer: pdfFixture,
        bytesReceived: pdfFixture.length,
        truncated: false,
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [url],
        transportCoding: null,
      }),
    })
    const { store, handle } = await seedMissionStore(mission)
    const ac = new AbortController()
    const fetchOperationId = 'final-passage-fetch--document-ref-0'
    let passageCalls = 0
    const origAppendPassage = store.appendPassage.bind(store)
    store.appendPassage = async (ctx, passage) => {
      passageCalls += 1
      if (passageCalls >= 2) {
        ac.abort()
        throw new Error('final passage blocked')
      }
      return origAppendPassage(ctx, passage)
    }

    await assert.rejects(
      () =>
        runAdmittedComposedRetrievalIteration({
          session: {
            mission,
            handle,
            activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
          },
          store,
          access,
          adapter: new TechnicalRepositoryFileAdapter(),
          registries,
          activePlan: { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
          discoverQuery: mission.source_policy.selected_document_refs![0]!,
          searchOperationId: 'final-passage-search',
          searchAttemptId: 'final-passage-search-att',
          fetchOperationId: 'final-passage-fetch',
          fetchAttemptId: 'final-passage-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: ac.signal,
          now: () => FIXED_NOW,
        }),
      /aborted during evidence persistence/i,
    )

    const events = await store.listEvents(mission.mission_id)
    const passages = events.filter((e) => e.kind === 'passage_recorded')
    assert.equal(passages.length, 1)
    const fetchCompletions = events.filter(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload.completion as { operation_id?: string }).operation_id === fetchOperationId,
    )
    assert.equal(fetchCompletions.length, 1)
    assert.equal(
      (fetchCompletions[0]!.payload.completion as { settlement?: string }).settlement,
      'cancelled',
    )
  })

  it('missionScopedToRepositoryPin drops sibling pins from selected_repository_refs', () => {
    const mission = loadMission('T-L1-mission.json')
    const pin = mission.pinned_target_repository!
    const scoped = missionScopedToRepositoryPin(mission, pin)
    assert.equal(scoped.pinned_target_repository?.repo_id, pin.repo_id)
    assert.equal(scoped.source_policy.selected_repository_refs, undefined)
  })
})
