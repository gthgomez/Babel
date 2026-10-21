/**
 * B reciprocal for Agent A ownership repair @ 161984196deb8f9dfb6c44e72a8f093835b21ed4 (draft PR 406).
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
import { slotOperationSuffix } from './technicalRetrievalComposition.js'
import { runAdmittedComposedRetrievalIteration } from './researchComposedRetrievalLoop.js'
import { ResearchPassFailedError } from './researchPassFailure.js'
import pins from '../fixtures/campaign/T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const FIXED_NOW = '2026-10-21T09:15:00.000Z'
const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const SEARCH_BASE = 'b-reciprocal-foreign-search'
const FETCH_BASE = 'b-reciprocal-foreign-fetch'
const REPO_SLOT_ID = 'repository-pin-0'
const DOC_SLOT_ID = 'document-ref-0'
const REPO_SEARCH_OP = slotOperationSuffix(SEARCH_BASE, REPO_SLOT_ID)
const DOC_SEARCH_OP = slotOperationSuffix(SEARCH_BASE, DOC_SLOT_ID)
const DOC_FETCH_OP = slotOperationSuffix(FETCH_BASE, DOC_SLOT_ID)

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

function operationIdFromEvent(event: { kind: string; payload: Record<string, unknown> }): string | undefined {
  if (event.kind === 'external_operation_intent') {
    return (event.payload.intent as { operation_id?: string }).operation_id
  }
  if (event.kind === 'external_operation_completed') {
    return (event.payload.completion as { operation_id?: string }).operation_id
  }
  return undefined
}

describe('composed retrieval composition ownership (B reciprocal @ A 16198419)', () => {
  it('foreign replacement during dispatched failing repository slot blocks later dispatch and evidence', async () => {
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
      }
      return acquired
    }

    let foreignReplacementDuringPendingSlot = false

    const searchProvider = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async () => {
        const events = await store.listEvents(mission.mission_id)
        const repoIntentDispatched = events.some(
          (e) =>
            e.kind === 'external_operation_intent' &&
            operationIdFromEvent(e) === REPO_SEARCH_OP,
        )
        assert.equal(
          repoIntentDispatched,
          true,
          'repository search intent must be dispatched before foreign replacement during pending slot',
        )
        const fence = store.readMissionWriteFence(mission.mission_id)
        await store.acquireWriterOwnership({
          mission_id: mission.mission_id,
          expected_writer_generation: fence.writer_generation,
        })
        foreignReplacementDuringPendingSlot = true
        return {
          ok: false,
          status: 500,
          entries: [],
          message: 'tree listing failed after foreign replacement during pending slot',
        }
      },
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

    const eventsBefore = (await store.listEvents(mission.mission_id)).length

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
          searchOperationId: SEARCH_BASE,
          searchAttemptId: 'b-reciprocal-foreign-search-att',
          fetchOperationId: FETCH_BASE,
          fetchAttemptId: 'b-reciprocal-foreign-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: new AbortController().signal,
          now: () => FIXED_NOW,
        }),
      (err: unknown) =>
        err instanceof ResearchPassFailedError ||
        (err instanceof Error && /competing resume rejected/i.test(err.message)),
    )

    assert.equal(foreignReplacementDuringPendingSlot, true)
    assert.equal(childOwnGeneration, 2)

    const events = await store.listEvents(mission.mission_id)
    const repoIntentIndex = events.findIndex(
      (e) => e.kind === 'external_operation_intent' && operationIdFromEvent(e) === REPO_SEARCH_OP,
    )
    assert.ok(repoIntentIndex >= 0)
    const afterRepoIntent = events.slice(repoIntentIndex + 1)

    const subsequentDispatches = afterRepoIntent.filter((e) => e.kind === 'external_operation_intent')
    assert.equal(
      subsequentDispatches.length,
      0,
      'no later-slot external_operation_intent after foreign replacement during failing repository slot',
    )
    const subsequentCompletions = afterRepoIntent.filter((e) => e.kind === 'external_operation_completed')
    for (const event of subsequentCompletions) {
      const opId = operationIdFromEvent(event)
      assert.notEqual(opId, DOC_SEARCH_OP)
      assert.notEqual(opId, DOC_FETCH_OP)
    }

    const evidenceAfter = events
      .slice(eventsBefore)
      .filter((e) => e.kind === 'source_recorded' || e.kind === 'passage_recorded')
    assert.equal(evidenceAfter.length, 0)

    const fence = store.readMissionWriteFence(mission.mission_id)
    assert.ok(fence.writer_generation > childOwnGeneration!)
  })
})
