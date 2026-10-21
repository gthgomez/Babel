/**
 * B reciprocal for Agent A ownership repair @ 161984196deb8f9dfb6c44e72a8f093835b21ed4 (draft PR 406).
 * Child retrieval throws RetrievalIterationFailedAfterAcquireError with own acquiredHandle/writeContext;
 * composed iteration must not adopt readMissionWriteFence after foreign replacement.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createGovernedSourceAccessPort } from '../access/governedSourceAccessPort.js'
import { createMissionProductionSearchProvider } from '../access/createMissionProductionSearchProvider.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { examplePlanRevisionFixture } from '../fixtures/exampleMission.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { createCombinedResearchRegistries } from '../registry/reviewedBAdapterIntegration.js'
import { resolveDiscoveryAdapterForMission } from '../registry/missionAdapterResolution.js'
import { runAdmittedComposedRetrievalIteration } from './researchComposedRetrievalLoop.js'
import { ResearchPassFailedError } from './researchPassFailure.js'
import pins from '../fixtures/campaign/T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const FIXED_NOW = '2026-10-21T09:15:00.000Z'
const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')

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

describe('composed retrieval composition ownership (B reciprocal @ A 16198419)', () => {
  it('foreign fence advance after failed child keeps controller on own CAS generation and fences out', async () => {
    const base = loadMission('T-L2-mission.json')
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

    const pdfFixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../adapters/documents/fixtures/two-page-sample.pdf'),
    )

    const searchProvider = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async () => ({
        ok: false,
        status: 500,
        entries: [],
        message: 'repository child failed before foreign replacement',
      }),
    })

    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async ({ url }) => ({
        ok: url === pins.t_l2_paper.canonical_url,
        status: url === pins.t_l2_paper.canonical_url ? 200 : 404,
        contentType: 'application/pdf',
        buffer: url === pins.t_l2_paper.canonical_url ? pdfFixture : Buffer.alloc(0),
        bytesReceived: url === pins.t_l2_paper.canonical_url ? pdfFixture.length : 0,
        truncated: false,
        requestedUrl: url,
        finalUrl: url,
        redirectChain: [url],
        transportCoding: null,
      }),
    })

    const { store, handle } = await seedMissionStore(mission)
    const eventsBefore = (await store.listEvents(mission.mission_id)).length

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
          searchOperationId: 'b-reciprocal-foreign-search',
          searchAttemptId: 'b-reciprocal-foreign-search-att',
          fetchOperationId: 'b-reciprocal-foreign-fetch',
          fetchAttemptId: 'b-reciprocal-foreign-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: new AbortController().signal,
          now: () => FIXED_NOW,
        }),
      (err: unknown) =>
        err instanceof ResearchPassFailedError ||
        (err instanceof Error && /competing resume rejected/i.test(err.message)),
    )

    assert.equal(childOwnGeneration, 2, 'repository child must CAS from session generation 1 to own generation 2')
    const fence = store.readMissionWriteFence(mission.mission_id)
    assert.ok(fence.writer_generation > childOwnGeneration!)
    assert.notEqual(
      fence.writer_generation,
      childOwnGeneration,
      'foreign replacement must advance fence beyond this controller CAS generation',
    )

    const events = await store.listEvents(mission.mission_id)
    const docPassages = events
      .slice(eventsBefore)
      .filter((e) => e.kind === 'passage_recorded' || e.kind === 'source_recorded')
    assert.equal(
      docPassages.length,
      0,
      'document slot must not admit evidence after foreign replacement fenced controller out',
    )
  })
})
