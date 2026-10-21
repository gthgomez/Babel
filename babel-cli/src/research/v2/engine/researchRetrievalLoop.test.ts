import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { FakeSourceAccessPort } from '../fixtures/fakePorts.js'
import {
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
  technicalRepositoryCorpusSource,
} from '../fixtures/technicalRepositoryCorpus.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../registry/frozenRegistries.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { runAdmittedPlanningIteration } from './researchIterationLoop.js'
import { runAdmittedRetrievalIteration } from './researchRetrievalLoop.js'

const FIXED_NOW = '2026-10-20T12:10:00.000Z'

function completionSettlement(event: { payload: Record<string, unknown> } | undefined): string | undefined {
  const completion = event?.payload.completion as { settlement?: string } | undefined
  return completion?.settlement
}

async function seedAdmittedPlan(store: InMemoryResearchStore) {
  const handle = await store.appendMission(exampleTechnicalMissionFixture)
  await store.appendPlanRevision(
    {
      mission_id: handle.mission_id,
      plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
      writer_generation: handle.writer_generation,
    },
    examplePlanRevisionFixture,
  )
  const session = {
    mission: exampleTechnicalMissionFixture,
    handle,
    activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
  }
  return session
}

describe('research retrieval loop (admitted ports)', () => {
  it('runs discover → read → evidence through technical adapter and fake access', async () => {
    const store = new InMemoryResearchStore()
    const session = await seedAdmittedPlan(store)
    const registries = createTechnicalResearchRegistries()
    const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
    assert.ok(adapter)
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: technicalRepositoryCorpusFinalUrl,
      },
    ])
    const result = await runAdmittedRetrievalIteration({
      session,
      store,
      access,
      adapter,
      activePlan: examplePlanRevisionFixture,
      discoverQuery: 'RESEARCH_CONTRACT',
      searchOperationId: 'ret-search-1',
      searchAttemptId: 'ret-search-att-1',
      fetchOperationId: 'ret-fetch-1',
      fetchAttemptId: 'ret-fetch-att-1',
      dispatchedAt: '2026-10-20T12:09:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.source.source_id, technicalRepositoryCorpusSource.source_id)
    assert.ok(result.passageIds.length >= 1)
    const events = await store.listEvents(session.mission.mission_id)
    assert.ok(events.some((e) => e.kind === 'source_recorded'))
    assert.ok(events.some((e) => e.kind === 'revision_recorded'))
    assert.ok(events.some((e) => e.kind === 'passage_recorded'))
    const searchCompleted = events.filter(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload.completion as { operation_id?: string })?.operation_id === 'ret-search-1',
    )
    assert.equal(searchCompleted.length, 1)
    assert.equal(completionSettlement(searchCompleted[0]), 'succeeded')
    const fetchCompleted = events.filter(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload.completion as { operation_id?: string })?.operation_id === 'ret-fetch-1',
    )
    assert.equal(fetchCompleted.length, 1)
    assert.equal(completionSettlement(fetchCompleted[0]), 'succeeded')
  })

  it('persists retrieval and offline terminal report on durable admitted session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-retrieval-'))
    try {
      const engine = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: new FixtureResearchModelBridge(),
      })
      const handle = await engine.appendMission(exampleTechnicalMissionFixture)
      await engine.store.appendPlanRevision(
        {
          mission_id: handle.mission_id,
          plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
          writer_generation: handle.writer_generation,
        },
        examplePlanRevisionFixture,
      )
      const registries = createTechnicalResearchRegistries()
      const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
      assert.ok(adapter)
      const access = new FakeSourceAccessPort([
        {
          source: technicalRepositoryCorpusSource,
          body: technicalRepositoryCorpusBody,
          mediaType: 'text/plain',
          finalUrl: technicalRepositoryCorpusFinalUrl,
        },
      ])
      const session = {
        mission: exampleTechnicalMissionFixture,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      }
      const result = await runAdmittedRetrievalIteration({
        session,
        store: engine.store,
        access,
        adapter,
        activePlan: examplePlanRevisionFixture,
        discoverQuery: 'untrusted',
        searchOperationId: 'dur-search-1',
        searchAttemptId: 'dur-search-att-1',
        fetchOperationId: 'dur-fetch-1',
        fetchAttemptId: 'dur-fetch-att-1',
        dispatchedAt: '2026-10-20T12:09:30.000Z',
        signal: new AbortController().signal,
        emitOfflineTerminalReport: true,
        now: () => FIXED_NOW,
      })
      assert.equal(result.terminalReportEmitted, true)
      const events = await engine.store.listEvents(session.mission.mission_id)
      assert.ok(events.some((e) => e.kind === 'terminal_receipt'))
      await engine.close()
      const successor = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: new FixtureResearchModelBridge(),
      })
      await successor.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('chains planning then retrieval without duplicating general adapters', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const session = { mission: exampleTechnicalMissionFixture, handle }
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-before-retrieval', {
      kind: 'plan_questions',
      questions: [{ text: 'What does the contract export?', importance: 'high' }],
    })
    const planned = await runAdmittedPlanningIteration({
      session,
      store,
      model,
      modelOperationId: 'plan-before-retrieval',
      modelAttemptId: 'plan-before-retrieval-att',
      planRevisionId: 'plan-after-model-001',
      revisionReason: 'pre_retrieval',
      dispatchedAt: '2026-10-20T12:08:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    const planEvents = await store.listEvents(session.mission.mission_id)
    const activePlan = planEvents
      .filter((e) => e.kind === 'plan_revised')
      .map((e) => (e.payload as { plan: typeof examplePlanRevisionFixture }).plan)
      .find((p) => p.plan_revision_id === planned.planRevisionId)
    assert.ok(activePlan)
    const registries = createTechnicalResearchRegistries()
    const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
    assert.ok(adapter)
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: technicalRepositoryCorpusFinalUrl,
      },
    ])
    await runAdmittedRetrievalIteration({
      session: {
        mission: session.mission,
        handle: planned.handle,
        activePlanRevisionId: planned.planRevisionId,
      },
      store,
      access,
      adapter: adapter!,
      activePlan: activePlan!,
      discoverQuery: 'RESEARCH',
      searchOperationId: 'chain-search',
      searchAttemptId: 'chain-search-att',
      fetchOperationId: 'chain-fetch',
      fetchAttemptId: 'chain-fetch-att',
      dispatchedAt: '2026-10-20T12:09:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    const events = await store.listEvents(session.mission.mission_id)
    assert.ok(events.some((e) => e.kind === 'model_invocation_completed'))
    assert.ok(events.some((e) => e.kind === 'passage_recorded'))
  })
})
