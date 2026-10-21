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
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import type { SourceRecord } from '../contracts/sources.js'
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

  it('fetches each mission selected_web_ref with distinct fetch operations', async () => {
    const mdnUrl = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'
    const cfUrl = 'https://developers.cloudflare.com/workers/'
    const mission = ResearchMissionV2Schema.parse({
      ...exampleTechnicalMissionFixture,
      mission_id: 'mission-multi-web',
      profile_id: 'general',
      source_policy: {
        allowed_source_classes: ['web'],
        allowed_web_domains: ['developer.mozilla.org', 'developers.cloudflare.com'],
        selected_web_refs: [mdnUrl, cfUrl],
        visibility_retention: exampleTechnicalMissionFixture.source_policy.visibility_retention,
      },
    })
    const plan = {
      ...examplePlanRevisionFixture,
      mission_id: mission.mission_id,
    }
    const webA: SourceRecord = {
      source_id: 'web-mdn',
      kind: 'web',
      canonical_key: mdnUrl,
      observed_urls: [mdnUrl],
      title: 'MDN Fetch',
    }
    const webB: SourceRecord = {
      source_id: 'web-cf',
      kind: 'web',
      canonical_key: cfUrl,
      observed_urls: [cfUrl],
      title: 'Cloudflare Workers',
    }
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(mission)
    await store.appendPlanRevision(
      {
        mission_id: handle.mission_id,
        plan_revision_id: plan.plan_revision_id,
        writer_generation: handle.writer_generation,
      },
      plan,
    )
    const session = {
      mission,
      handle,
      activePlanRevisionId: plan.plan_revision_id,
    }
    const adapter: SourceAdapter = {
      adapterId: 'multi-web-fixture',
      supportedKinds: ['web'],
      async discover(request) {
        return {
          operationId: request.operationId,
          status: 'ok',
          candidates: [webB, webA],
        }
      },
      async read(request) {
        const revisionId = `rev-${request.source.source_id}`
        return {
          operationId: request.operationId,
          status: 'ok',
          revision: {
            revision_id: revisionId,
            source_id: request.source.source_id,
            content_hash: 'hash',
            retrieved_at: FIXED_NOW,
            extraction_version: 'fixture',
            media_type: 'text/html',
            completeness: 'complete',
          },
          passages: [
            {
              passage_id: `${request.operationId}:p0`,
              source_revision_id: revisionId,
              locator: { kind: 'line_range', start_line: 1, end_line: 1 },
              text_ref: { mode: 'inline', text: `body-${request.source.source_id}`, text_hash: 'h' },
            },
          ],
          extraction_version: 'fixture',
        }
      },
    }
    const result = await runAdmittedRetrievalIteration({
      session,
      store,
      access: new FakeSourceAccessPort([]),
      adapter,
      activePlan: plan,
      discoverQuery: 'compare fetch workers',
      searchOperationId: 'multi-search',
      searchAttemptId: 'multi-search-att',
      fetchOperationId: 'multi-fetch',
      fetchAttemptId: 'multi-fetch-att',
      dispatchedAt: '2026-10-20T12:09:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.sources.length, 2)
    assert.equal(result.passageIds.length, 2)
    assert.deepEqual(result.limitations, [])
    const events = await store.listEvents(mission.mission_id)
    assert.equal(completionSettlement(completionEvent(events, 'multi-fetch--web-ref-0')), 'succeeded')
    assert.equal(completionSettlement(completionEvent(events, 'multi-fetch--web-ref-1')), 'succeeded')
  })
})

function completionEvent(
  events: Awaited<ReturnType<InMemoryResearchStore['listEvents']>>,
  opId: string,
) {
  return events.find(
    (e) =>
      e.kind === 'external_operation_completed' &&
      (e.payload.completion as { operation_id?: string })?.operation_id === opId,
  )
}
