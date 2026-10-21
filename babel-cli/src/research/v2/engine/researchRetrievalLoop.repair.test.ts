import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import { FakeSourceAccessPort } from '../fixtures/fakePorts.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
  technicalRepositoryCorpusSource,
} from '../fixtures/technicalRepositoryCorpus.js'
import { passageWithIntegrityVerification } from '../integrity/passageIntegrityReceipt.js'
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

  it('does not fetch when discover operationId mismatches search operation', async () => {
    const store = new InMemoryResearchStore()
    const session = await seedSession(store)
    let readCalls = 0
    const adapter: SourceAdapter = {
      adapterId: 'bad-discover-op',
      supportedKinds: ['repository_file'],
      async discover(request) {
        return {
          operationId: 'wrong-discover-op',
          status: 'ok',
          candidates: [technicalRepositoryCorpusSource],
        }
      },
      async read() {
        readCalls += 1
        throw new Error('read should not run')
      },
    }
    await assert.rejects(() =>
      runAdmittedRetrievalIteration({
        session,
        store,
        access: new FakeSourceAccessPort([]),
        adapter,
        activePlan: examplePlanRevisionFixture,
        discoverQuery: 'x',
        searchOperationId: 'discover-bind-search',
        searchAttemptId: 'discover-bind-search-att',
        fetchOperationId: 'discover-bind-fetch',
        fetchAttemptId: 'discover-bind-fetch-att',
        dispatchedAt: FIXED_NOW,
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      }),
    )
    assert.equal(readCalls, 0)
    const completion = completionFor(await store.listEvents(session.mission.mission_id), 'discover-bind-search')
    assert.equal(completion?.settlement, 'failed')
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

  it('settles fetch cancelled when aborted during evidence persistence after source write', async () => {
    const controller = new AbortController()
    class AbortOnRevisionStore extends InMemoryResearchStore {
      override async appendSourceRevision(
        ctx: Parameters<InMemoryResearchStore['appendSourceRevision']>[0],
        revision: Parameters<InMemoryResearchStore['appendSourceRevision']>[1],
      ) {
        controller.abort()
        return super.appendSourceRevision(ctx, revision)
      }
    }
    const store = new AbortOnRevisionStore()
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
      read: (req, port) => inner.read(req, port),
    }
    await assert.rejects(() =>
      runAdmittedRetrievalIteration({
        session,
        store,
        access,
        adapter,
        activePlan: examplePlanRevisionFixture,
        discoverQuery: 'RESEARCH_CONTRACT',
        searchOperationId: 'persist-cancel-search',
        searchAttemptId: 'persist-cancel-search-att',
        fetchOperationId: 'persist-cancel-fetch',
        fetchAttemptId: 'persist-cancel-fetch-att',
        dispatchedAt: FIXED_NOW,
        signal: controller.signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(session.mission.mission_id)
    assert.equal(events.filter((e) => e.kind === 'source_recorded').length, 1)
    assert.equal(events.filter((e) => e.kind === 'passage_recorded').length, 0)
    const completion = completionFor(events, 'persist-cancel-fetch')
    assert.equal(completion?.settlement, 'cancelled')
  })

  it('durable store: single cancelled completion when aborted during final appendPassage', async () => {
    const controller = new AbortController()
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-final-passage-cancel-'))
    try {
      const store = await DurableResearchStore.open(dir)
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
      let passageWrites = 0
      const originalAppendPassage = store.appendPassage.bind(store)
      store.appendPassage = async (ctx, passage) => {
        const result = await originalAppendPassage(ctx, passage)
        passageWrites++
        if (passageWrites >= 2) {
          controller.abort()
        }
        return result
      }
      const adapter: SourceAdapter = {
        adapterId: inner.adapterId,
        supportedKinds: inner.supportedKinds,
        discover: (req, port) => inner.discover(req, port),
        read: async (req, port) => {
          const result = await inner.read(req, port)
          if (result.status !== 'ok' || result.passages.length < 1) return result
          const first = result.passages[0]!
          const fetchOperationId = `${req.operationId}:fetch`
          const fetched = await port.fetchContent({
            operationId: fetchOperationId,
            source: req.source,
            signal: req.signal,
          })
          if (fetched.status !== 'ok') {
            return result
          }
          const dupPassage = passageWithIntegrityVerification(
            { ...first, passage_id: `${first.passage_id}-dup` },
            {
              source: req.source,
              revision: result.revision,
              admitted: fetched.admitted,
              extractionVersion: result.extraction_version,
            },
          )
          return { ...result, passages: [...result.passages, dupPassage] }
        },
      }
      await assert.rejects(
        () =>
          runAdmittedRetrievalIteration({
            session,
            store,
            access,
            adapter,
            activePlan: examplePlanRevisionFixture,
            discoverQuery: 'RESEARCH_CONTRACT',
            searchOperationId: 'final-pass-search',
            searchAttemptId: 'final-pass-search-att',
            fetchOperationId: 'final-pass-fetch',
            fetchAttemptId: 'final-pass-fetch-att',
            dispatchedAt: FIXED_NOW,
            signal: controller.signal,
            now: () => FIXED_NOW,
          }),
        (err: unknown) => err instanceof Error && /aborted during evidence persistence/.test(err.message),
      )
      const events = await store.listEvents(session.mission.mission_id)
      const completions = events.filter((e) => e.kind === 'external_operation_completed')
      const fetchCompletions = completions.filter(
        (e) => (e.payload.completion as { operation_id?: string }).operation_id === 'final-pass-fetch',
      )
      assert.equal(fetchCompletions.length, 1)
      assert.equal(
        (fetchCompletions[0]!.payload.completion as { settlement?: string }).settlement,
        'cancelled',
      )
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('settles fetch cancelled for zero passages when aborted after persistence loop', async () => {
    const controller = new AbortController()
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
      read: async (req, port) => {
        const result = await inner.read(req, port)
        if (result.status !== 'ok') return result
        controller.abort()
        return { ...result, passages: [] }
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
        searchOperationId: 'zero-pass-search',
        searchAttemptId: 'zero-pass-search-att',
        fetchOperationId: 'zero-pass-fetch',
        fetchAttemptId: 'zero-pass-fetch-att',
        dispatchedAt: FIXED_NOW,
        signal: controller.signal,
        now: () => FIXED_NOW,
      }),
    )
    const completion = completionFor(
      await store.listEvents(session.mission.mission_id),
      'zero-pass-fetch',
    )
    assert.equal(completion?.settlement, 'cancelled')
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
