import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createGovernedSourceAccessPort } from '../access/governedSourceAccessPort.js'
import { createPinnedRepositoryFileSearchProvider } from '../access/pinnedRepositoryFileSearchProvider.js'
import type { SourceAcquisitionDiagnostics } from '../contracts/sourceAcquisitionDiagnostics.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import { createCombinedResearchRegistries } from '../registry/reviewedBAdapterIntegration.js'
import { resolveDiscoveryAdapterForMission } from '../registry/missionAdapterResolution.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import { ResearchPassFailedError } from './researchPassFailure.js'
import { slotOperationSuffix } from './technicalRetrievalComposition.js'
import { runAdmittedComposedRetrievalIteration } from './researchComposedRetrievalLoop.js'
import {
  RetrievalIterationFailedAfterAcquireError,
  runAdmittedRetrievalIteration,
} from './researchRetrievalLoop.js'

const FIXED_NOW = '2026-10-21T17:05:00.000Z'

const TREE_FAILURE_DIAGNOSTICS: SourceAcquisitionDiagnostics = {
  evidence_role: 'attempted_source',
  attempted_url: 'https://api.github.com/repos/gthgomez/Babel/git/trees/d9e42b14b00b6dba25f0415ae16b084363386a01',
  http_status: 403,
  http_failure: {
    public_message: 'API rate limit exceeded',
    public_message_qualifier: 'unverified_github_json_message_field',
    rate_limit_remaining: '0',
  },
}

function treeFailedSearchProvider(mission: typeof exampleTechnicalMissionFixture) {
  return createPinnedRepositoryFileSearchProvider({
    fetchTree: async () => ({
      ok: false,
      status: 403,
      entries: [],
      message: 'GitHub tree API HTTP 403: API rate limit exceeded',
      acquisition_diagnostics: TREE_FAILURE_DIAGNOSTICS,
    }),
  })
}

function completionFor(
  events: Awaited<ReturnType<DurableResearchStore['listEvents']>>,
  operationId: string,
) {
  return events.find(
    (e) =>
      e.kind === 'external_operation_completed' &&
      (e.payload.completion as { operation_id?: string })?.operation_id === operationId,
  )?.payload?.completion as {
    settlement?: string
    acquisition_diagnostics?: SourceAcquisitionDiagnostics
  }
}

describe('discovery acquisition_diagnostics propagation (GitHub tree failures)', () => {
  it('TechnicalRepositoryFileAdapter.discover forwards failed search diagnostics', async () => {
    const mission = exampleTechnicalMissionFixture
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: treeFailedSearchProvider(mission),
    })
    const adapter = new TechnicalRepositoryFileAdapter()
    const discover = await adapter.discover(
      {
        operationId: 'disc-tree-fail',
        query: 'RESEARCH_CONTRACT',
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(discover.status, 'failed')
    if (discover.status !== 'failed') return
    assert.equal(discover.failureCategory, 'rate_limited')
    assert.equal(discover.acquisition_diagnostics?.http_status, 403)
    assert.equal(
      discover.acquisition_diagnostics?.http_failure?.public_message_qualifier,
      'unverified_github_json_message_field',
    )
  })

  it('researchRetrievalLoop settles failed discover with diagnostics (durable + cold reopen)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-discover-diag-retrieval-'))
    try {
      const mission = exampleTechnicalMissionFixture
      const access = createGovernedSourceAccessPort({
        mission,
        searchProvider: treeFailedSearchProvider(mission),
      })
      const adapter = new TechnicalRepositoryFileAdapter()
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(mission)
      await store.appendPlanRevision(
        {
          mission_id: handle.mission_id,
          plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
          writer_generation: handle.writer_generation,
        },
        examplePlanRevisionFixture,
      )
      const session = {
        mission,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      }
      const searchOperationId = 'tree-fail-search'
      await assert.rejects(
        () =>
          runAdmittedRetrievalIteration({
            session,
            store,
            access,
            adapter,
            activePlan: examplePlanRevisionFixture,
            discoverQuery: 'RESEARCH_CONTRACT',
            searchOperationId,
            searchAttemptId: 'tree-fail-search-att',
            fetchOperationId: 'tree-fail-fetch',
            fetchAttemptId: 'tree-fail-fetch-att',
            dispatchedAt: FIXED_NOW,
            signal: new AbortController().signal,
            now: () => FIXED_NOW,
          }),
        (err: unknown) => err instanceof RetrievalIterationFailedAfterAcquireError,
      )
      const events = await store.listEvents(mission.mission_id)
      const completion = completionFor(events, searchOperationId)
      assert.equal(completion?.settlement, 'failed')
      assert.equal(completion?.acquisition_diagnostics?.http_status, 403)
      assert.equal(
        completion?.acquisition_diagnostics?.http_failure?.public_message_qualifier,
        'unverified_github_json_message_field',
      )
      await store.close()

      store = await DurableResearchStore.open(dir)
      const reopenedEvents = await store.listEvents(mission.mission_id)
      const reopenedCompletion = completionFor(reopenedEvents, searchOperationId)
      assert.equal(reopenedCompletion?.settlement, 'failed')
      assert.equal(reopenedCompletion?.acquisition_diagnostics?.http_status, 403)
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('researchComposedRetrievalLoop settles failed document search with diagnostics (durable + cold reopen)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-discover-diag-composed-doc-'))
    try {
      const mission = ResearchMissionV2Schema.parse({
        ...exampleTechnicalMissionFixture,
        source_policy: {
          ...exampleTechnicalMissionFixture.source_policy,
          allowed_source_classes: ['document'],
          selected_document_refs: ['https://arxiv.org/abs/2401.00001'],
        },
        pinned_target_repository: undefined,
      })
      const registries = await createCombinedResearchRegistries()
      const documentSearchDiagnostics: SourceAcquisitionDiagnostics = {
        evidence_role: 'attempted_source',
        attempted_url: 'https://api.example.test/document-search',
        http_status: 502,
      }
      const searchProvider: AdmittedSourceSearchProvider = {
        async search(request) {
          return {
            operationId: request.operationId,
            status: 'failed',
            failureCategory: 'network_error',
            message: 'document source search failed',
            acquisition_diagnostics: documentSearchDiagnostics,
          }
        },
      }
      const access = createGovernedSourceAccessPort({
        mission,
        searchProvider,
      })
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(mission)
      await store.appendPlanRevision(
        {
          mission_id: handle.mission_id,
          plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
          writer_generation: handle.writer_generation,
        },
        examplePlanRevisionFixture,
      )
      const session = {
        mission,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      }
      const searchOperationId = 'composed-doc-fail-search'
      const slotId = 'document-ref-0'
      const slotSearchOperationId = slotOperationSuffix(searchOperationId, slotId)
      await assert.rejects(
        () =>
          runAdmittedComposedRetrievalIteration({
            session,
            store,
            access,
            adapter: new TechnicalRepositoryFileAdapter(),
            registries,
            activePlan: examplePlanRevisionFixture,
            discoverQuery: 'unused',
            searchOperationId,
            searchAttemptId: 'composed-doc-fail-search-att',
            fetchOperationId: 'composed-doc-fail-fetch',
            fetchAttemptId: 'composed-doc-fail-fetch-att',
            dispatchedAt: FIXED_NOW,
            signal: new AbortController().signal,
            now: () => FIXED_NOW,
          }),
        (err: unknown) => err instanceof ResearchPassFailedError,
      )
      const events = await store.listEvents(mission.mission_id)
      const completion = completionFor(events, slotSearchOperationId)
      assert.equal(completion?.settlement, 'failed')
      assert.equal(completion?.acquisition_diagnostics?.http_status, 502)
      await store.close()

      store = await DurableResearchStore.open(dir)
      const reopenedCompletion = completionFor(
        await store.listEvents(mission.mission_id),
        slotSearchOperationId,
      )
      assert.equal(reopenedCompletion?.acquisition_diagnostics?.attempted_url, documentSearchDiagnostics.attempted_url)
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('researchComposedRetrievalLoop settles failed repository tree search with diagnostics (durable + cold reopen)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-discover-diag-composed-'))
    try {
      const mission = exampleTechnicalMissionFixture
      const registries = await createCombinedResearchRegistries()
      const discovery = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(discovery instanceof TechnicalRepositoryFileAdapter)
      const access = createGovernedSourceAccessPort({
        mission,
        searchProvider: treeFailedSearchProvider(mission),
      })
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(mission)
      await store.appendPlanRevision(
        {
          mission_id: handle.mission_id,
          plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
          writer_generation: handle.writer_generation,
        },
        examplePlanRevisionFixture,
      )
      const session = {
        mission,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      }
      const searchOperationId = 'composed-tree-fail-search'
      const slotId = 'repository-pin-0'
      const slotSearchOperationId = slotOperationSuffix(searchOperationId, slotId)
      await assert.rejects(
        () =>
          runAdmittedComposedRetrievalIteration({
            session,
            store,
            access,
            adapter: discovery,
            registries,
            activePlan: examplePlanRevisionFixture,
            discoverQuery: 'RESEARCH_CONTRACT',
            searchOperationId,
            searchAttemptId: 'composed-tree-fail-search-att',
            fetchOperationId: 'composed-tree-fail-fetch',
            fetchAttemptId: 'composed-tree-fail-fetch-att',
            dispatchedAt: FIXED_NOW,
            signal: new AbortController().signal,
            now: () => FIXED_NOW,
          }),
        (err: unknown) => err instanceof ResearchPassFailedError,
      )
      const events = await store.listEvents(mission.mission_id)
      const completion = completionFor(events, slotSearchOperationId)
      assert.equal(completion?.settlement, 'failed')
      assert.equal(completion?.acquisition_diagnostics?.http_status, 403)
      await store.close()

      store = await DurableResearchStore.open(dir)
      const reopenedEvents = await store.listEvents(mission.mission_id)
      const reopenedCompletion = completionFor(reopenedEvents, slotSearchOperationId)
      assert.equal(reopenedCompletion?.acquisition_diagnostics?.http_status, 403)
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
