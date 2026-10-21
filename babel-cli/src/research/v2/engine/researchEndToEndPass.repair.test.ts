import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createMissionScopedSourceAccessPort } from '../access/missionScopedSourceAccessPort.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../fixtures/technicalRepositoryCorpus.js'
import { searchIndexForTechnicalMission } from '../fixtures/technicalSearchIndex.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type { ResearchModelInvocationRequest, ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../registry/frozenRegistries.js'
import { listFindingsFromStoreEvents } from './listFindingsFromStoreEvents.js'
import { runAdmittedResearchEndToEndPass } from './researchEndToEndPass.js'

const FIXED_NOW = '2026-10-20T12:25:00.000Z'

function governedAccess() {
  return createMissionScopedSourceAccessPort({
    mission: exampleTechnicalMissionFixture,
    searchIndex: searchIndexForTechnicalMission(exampleTechnicalMissionFixture),
    admittedGet: async () => ({
      ok: true,
      status: 200,
      contentType: 'text/plain',
      buffer: Buffer.from(technicalRepositoryCorpusBody, 'utf8'),
      bytesReceived: technicalRepositoryCorpusBody.length,
      truncated: false,
      requestedUrl: technicalRepositoryCorpusFinalUrl,
      finalUrl: technicalRepositoryCorpusFinalUrl,
      redirectChain: [technicalRepositoryCorpusFinalUrl],
    transportCoding: null,
    }),
  })
}

function modelPort(): import('../ports/researchModelPort.js').ResearchModelPort {
  const fixture = new FixtureResearchModelBridge()
  return {
    async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
      if (request.kind === 'plan_questions') {
        fixture.scriptOutput(request.operationId, {
          kind: 'plan_questions',
          questions: [{ text: 'Repair check?', importance: 'high' }],
        })
      }
      if (request.kind === 'extract_findings') {
        const passageIds = (request.input.passages as { passage_id: string }[])?.map((p) => p.passage_id) ?? []
        fixture.scriptOutput(request.operationId, {
          kind: 'extract_findings',
          findings: [
            {
              assertion_text: 'Observed constant export.',
              assertion_kind: 'source_observation',
              passage_ids: passageIds.slice(0, 1),
            },
          ],
        })
      }
      if (request.kind === 'semantic_support_review') {
        const findings = request.input.findings as {
          finding_id: string
          cited_passages: { content_status: string; text?: string }[]
        }[]
        assert.ok(findings[0]?.cited_passages[0]?.content_status === 'available')
        fixture.scriptOutput(request.operationId, {
          kind: 'semantic_support_review',
          judgments: [],
        })
      }
      if (request.kind === 'synthesize_report') {
        fixture.scriptOutput(request.operationId, {
          kind: 'synthesize_report',
          answer_summary: 'Unqualified summary.',
          stopping_reason: 'repair_test',
        })
      }
      return fixture.invokeStructured(request)
    },
  }
}

describe('research end-to-end pass repairs', () => {
  it('persists not_checked judgments and reloads them from durable store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-e2e-repair-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const registries = createTechnicalResearchRegistries()
      const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
      assert.ok(adapter)

      await runAdmittedResearchEndToEndPass({
        session: { mission: exampleTechnicalMissionFixture, handle },
        store,
        model: modelPort(),
        access: governedAccess(),
        adapter,
        discoverQuery: 'RESEARCH_CONTRACT',
        planOperationId: 'repair-plan',
        planAttemptId: 'repair-plan-att',
        planRevisionId: 'plan-repair-001',
        retrievalSearchOperationId: 'repair-search',
        retrievalSearchAttemptId: 'repair-search-att',
        retrievalFetchOperationId: 'repair-fetch',
        retrievalFetchAttemptId: 'repair-fetch-att',
        extractOperationId: 'repair-extract',
        extractAttemptId: 'repair-extract-att',
        reviewOperationId: 'repair-review',
        reviewAttemptId: 'repair-review-att',
        synthesizeOperationId: 'repair-synth',
        synthesizeAttemptId: 'repair-synth-att',
        dispatchedAt: '2026-10-20T12:24:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })
      await store.close()

      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      const findings = listFindingsFromStoreEvents(events)
      assert.ok(findings.length >= 1)
      assert.equal(findings[0]?.semantic_support?.status, 'not_checked')
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('in-memory pass records usage settlement on model phases', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const registries = createTechnicalResearchRegistries()
    const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
    assert.ok(adapter)
    await runAdmittedResearchEndToEndPass({
      session: { mission: exampleTechnicalMissionFixture, handle },
      store,
      model: modelPort(),
      access: governedAccess(),
      adapter,
      discoverQuery: 'RESEARCH_CONTRACT',
      planOperationId: 'repair-plan-2',
      planAttemptId: 'repair-plan-2-att',
      planRevisionId: 'plan-repair-002',
      retrievalSearchOperationId: 'repair-search-2',
      retrievalSearchAttemptId: 'repair-search-2-att',
      retrievalFetchOperationId: 'repair-fetch-2',
      retrievalFetchAttemptId: 'repair-fetch-2-att',
      extractOperationId: 'repair-extract-2',
      extractAttemptId: 'repair-extract-2-att',
      reviewOperationId: 'repair-review-2',
      reviewAttemptId: 'repair-review-2-att',
      synthesizeOperationId: 'repair-synth-2',
      synthesizeAttemptId: 'repair-synth-2-att',
      dispatchedAt: '2026-10-20T12:24:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    const modelCompletions = events.filter((e) => {
      if (e.kind !== 'external_operation_completed') return false
      const operationId = (e.payload as { completion: { operation_id: string } }).completion.operation_id
      return (
        operationId === 'repair-plan-2' ||
        operationId === 'repair-extract-2' ||
        operationId === 'repair-review-2' ||
        operationId === 'repair-synth-2'
      )
    })
    assert.equal(modelCompletions.length, 4)
    for (const event of modelCompletions) {
      const completion = (event.payload as { completion: { usage_settlement?: unknown } }).completion
      assert.ok(completion.usage_settlement, 'expected usage settlement on model phase completion')
    }
  })
})
