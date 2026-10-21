import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import { FakeSourceAccessPort } from '../fixtures/fakePorts.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
  technicalRepositoryCorpusSource,
} from '../fixtures/technicalRepositoryCorpus.js'
import { buildOfflineRetrievalReport } from './buildOfflineRetrievalReport.js'
import { runAdmittedRetrievalIteration } from './researchRetrievalLoop.js'

const FIXED_NOW = '2026-10-20T12:11:00.000Z'

async function seedSession(store: InMemoryResearchStore) {
  const handle = await store.appendMission(exampleTechnicalMissionFixture)
  await store.appendPlanRevision(
    {
      mission_id: handle.mission_id,
      plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
      writer_generation: handle.writer_generation,
    },
    examplePlanRevisionFixture,
  )
  return {
    mission: exampleTechnicalMissionFixture,
    handle,
    activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
  }
}

function completionFor(events: Awaited<ReturnType<InMemoryResearchStore['listEvents']>>, opId: string) {
  const row = events.find(
    (e) =>
      e.kind === 'external_operation_completed' &&
      (e.payload.completion as { operation_id?: string })?.operation_id === opId,
  )
  return row?.payload?.completion as { settlement?: string; usage_settlement?: { cost?: { status?: string } } } | undefined
}

describe('research retrieval loop repairs', () => {
  it('settles search cancelled without evidence when signal aborts after late discover ok', async () => {
    const store = new InMemoryResearchStore()
    const session = await seedSession(store)
    const controller = new AbortController()
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: technicalRepositoryCorpusFinalUrl,
      },
    ])
    const adapter: SourceAdapter = {
      adapterId: 'test',
      supportedKinds: ['repository_file'],
      async discover(request, port) {
        const result = await new (await import('../profiles/technical/repositoryFileAdapter.js')).TechnicalRepositoryFileAdapter().discover(
          request,
          port,
        )
        controller.abort()
        return result
      },
      read: async () => ({
        operationId: 'fetch-op',
        status: 'ok',
        revision: {
          revision_id: 'rev',
          source_id: technicalRepositoryCorpusSource.source_id,
          content_hash: 'x',
          retrieved_at: FIXED_NOW,
          extraction_version: 't',
          media_type: 'text/plain',
          completeness: 'complete',
        },
        passages: [],
        extraction_version: 't',
      }),
    }
    await assert.rejects(() =>
      runAdmittedRetrievalIteration({
        session,
        store,
        access,
        adapter,
        activePlan: examplePlanRevisionFixture,
        discoverQuery: 'RESEARCH',
        searchOperationId: 'late-cancel-search',
        searchAttemptId: 'late-cancel-search-att',
        fetchOperationId: 'late-cancel-fetch',
        fetchAttemptId: 'late-cancel-fetch-att',
        dispatchedAt: FIXED_NOW,
        signal: controller.signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'source_recorded').length, 0)
    const completion = events.find(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload.completion as { operation_id?: string })?.operation_id === 'late-cancel-search',
    )
    assert.equal((completion?.payload.completion as { settlement?: string }).settlement, 'cancelled')
  })

  it('settles uncertain when discover throws during cancellation', async () => {
    const store = new InMemoryResearchStore()
    const session = await seedSession(store)
    const controller = new AbortController()
    const adapter: SourceAdapter = {
      adapterId: 'throw-discover',
      supportedKinds: ['repository_file'],
      async discover() {
        controller.abort()
        throw new Error('discover transport error')
      },
      async read() {
        throw new Error('unreachable')
      },
    }
    await assert.rejects(
      () =>
        runAdmittedRetrievalIteration({
          session,
          store,
          access: new FakeSourceAccessPort([]),
          adapter,
          activePlan: examplePlanRevisionFixture,
          discoverQuery: 'x',
          searchOperationId: 'throw-search',
          searchAttemptId: 'throw-search-att',
          fetchOperationId: 'throw-fetch',
          fetchAttemptId: 'throw-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: controller.signal,
          now: () => FIXED_NOW,
        }),
      /discover transport error/,
    )
    const events = await store.listEvents(session.mission.mission_id)
    const completion = completionFor(events, 'throw-search')
    assert.equal(completion?.settlement, 'uncertain')
    assert.equal(completion?.usage_settlement?.cost?.status, 'unknown')
  })

  it('does not append evidence when read operationId mismatches fetch operation', async () => {
    const store = new InMemoryResearchStore()
    const session = await seedSession(store)
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: technicalRepositoryCorpusFinalUrl,
      },
    ])
    const { TechnicalRepositoryFileAdapter } = await import('../profiles/technical/repositoryFileAdapter.js')
    const inner = new TechnicalRepositoryFileAdapter()
    const adapter: SourceAdapter = {
      adapterId: inner.adapterId,
      supportedKinds: inner.supportedKinds,
      discover: (req, port) => inner.discover(req, port),
      async read(request, port) {
        const result = await inner.read(request, port)
        if (result.status !== 'ok') return result
        return { ...result, operationId: 'wrong-fetch-op' }
      },
    }
    await assert.rejects(() =>
      runAdmittedRetrievalIteration({
        session,
        store,
        access,
        adapter,
        activePlan: examplePlanRevisionFixture,
        discoverQuery: 'RESEARCH_CONTRACT',
        searchOperationId: 'bind-search',
        searchAttemptId: 'bind-search-att',
        fetchOperationId: 'bind-fetch',
        fetchAttemptId: 'bind-fetch-att',
        dispatchedAt: FIXED_NOW,
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'passage_recorded').length, 0)
    const completion = completionFor(events, 'bind-fetch')
    assert.equal(completion?.settlement, 'failed')
  })

  it('offline report omits no_live_network without proven offline execution', () => {
    const report = buildOfflineRetrievalReport({
      mission: exampleTechnicalMissionFixture,
      plan: examplePlanRevisionFixture,
      ctx: {
        mission_id: exampleTechnicalMissionFixture.mission_id,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        writer_generation: 1,
      },
      passages: [],
      generatedAt: FIXED_NOW,
    })
    assert.ok(!report.limitations.includes('no_live_network'))
    assert.ok(report.limitations.includes('no_model_synthesis'))
  })

  it('offline report records injected offline provenance when provided', () => {
    const report = buildOfflineRetrievalReport({
      mission: exampleTechnicalMissionFixture,
      plan: examplePlanRevisionFixture,
      ctx: {
        mission_id: exampleTechnicalMissionFixture.mission_id,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        writer_generation: 1,
      },
      passages: [],
      generatedAt: FIXED_NOW,
      executionProvenance: { mode: 'offline_injected_access' },
    })
    assert.ok(report.limitations.includes('execution_used_injected_offline_source_access'))
  })
})
