import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import type { ResearchModelInvocationRequest, ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import { createMissionScopedSourceAccessPort } from '../access/missionScopedSourceAccessPort.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../fixtures/technicalRepositoryCorpus.js'
import { searchIndexForTechnicalMission } from '../fixtures/technicalSearchIndex.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../registry/frozenRegistries.js'
import { runAdmittedResearchEndToEndPass } from './researchEndToEndPass.js'
import { runAdmittedPlanningIteration } from './researchIterationLoop.js'

const FIXED_NOW = '2026-10-20T12:30:00.000Z'

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

function completionUsageAttempt(
  event: { kind: string; payload: unknown } | undefined,
): string | undefined {
  if (!event || event.kind !== 'external_operation_completed') return undefined
  const completion = (event.payload as {
    completion?: { usage_settlement?: { attempt_id?: string; cost?: { status?: string } } }
  }).completion
  return completion?.usage_settlement?.attempt_id
}

function completionCostStatus(
  event: { kind: string; payload: unknown } | undefined,
): string | undefined {
  if (!event || event.kind !== 'external_operation_completed') return undefined
  const completion = (event.payload as {
    completion?: { usage_settlement?: { cost?: { status?: string } } }
  }).completion
  return completion?.usage_settlement?.cost?.status
}

describe('cancellation after invoke receipt binding', () => {
  it('planning: foreign receipt on abort does not charge current attempt', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const controller = new AbortController()
    const model = {
      async invokeStructured(
        _request: ResearchModelInvocationRequest,
      ): Promise<ResearchModelInvocationResult> {
        controller.abort()
        return {
          status: 'ok',
          operationId: 'plan-op-foreign-abort',
          output: {
            kind: 'plan_questions',
            questions: [{ text: 'Should not persist', importance: 'low' }],
          },
          receipt: {
            operation_id: 'foreign-op',
            backend_key: 'k',
            provider: 'p',
            provider_model_id: 'm',
            resolved_at: '2026-10-20T00:00:00.000Z',
            usage_settlement: {
              attempt_id: 'foreign-att',
              cost: { status: 'reported', amount_usd: 0.42, currency: 'USD' },
            },
          },
        }
      },
    }
    await assert.rejects(() =>
      runAdmittedPlanningIteration({
        session: { mission: exampleTechnicalMissionFixture, handle },
        store,
        model,
        modelOperationId: 'plan-op-foreign-abort',
        modelAttemptId: 'plan-att-foreign-abort',
        planRevisionId: 'plan-foreign-abort-001',
        revisionReason: 'foreign-abort',
        dispatchedAt: '2026-10-20T00:00:00.000Z',
        signal: controller.signal,
      }),
    )
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
    const completed = events.find(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload as { completion: { operation_id: string } }).completion.operation_id ===
          'plan-op-foreign-abort',
    )
    assert.equal(
      (completed?.payload as { completion: { settlement: string } }).completion.settlement,
      'cancelled',
    )
    assert.equal(completionUsageAttempt(completed), 'plan-att-foreign-abort')
    assert.equal(completionCostStatus(completed), 'unknown')
  })

  it('end-to-end extract: foreign receipt on abort does not charge current attempt', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const controller = new AbortController()
    const fixture = new FixtureResearchModelBridge()
    fixture.scriptOutput('e2e-plan-foreign-abort', {
      kind: 'plan_questions',
      questions: [{ text: 'Contract?', importance: 'high' }],
    })
    const model = {
      async invokeStructured(
        request: ResearchModelInvocationRequest,
      ): Promise<ResearchModelInvocationResult> {
        if (request.kind === 'plan_questions') {
          return fixture.invokeStructured(request)
        }
        if (request.kind === 'extract_findings') {
          controller.abort()
          return {
            status: 'ok',
            operationId: request.operationId,
            output: { kind: 'extract_findings', findings: [] },
            receipt: {
              operation_id: 'foreign-extract-op',
              backend_key: 'k',
              provider: 'p',
              provider_model_id: 'm',
              resolved_at: '2026-10-20T00:00:00.000Z',
              usage_settlement: {
                attempt_id: 'foreign-extract-att',
                cost: { status: 'reported', amount_usd: 0.99, currency: 'USD' },
              },
            },
          }
        }
        throw new Error(`unexpected kind ${request.kind}`)
      },
    }
    const registries = createTechnicalResearchRegistries()
    const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
    assert.ok(adapter)
    await assert.rejects(() =>
      runAdmittedResearchEndToEndPass({
        session: { mission: exampleTechnicalMissionFixture, handle },
        store,
        model,
        access: governedAccess(),
        adapter,
        registries,
        discoverQuery: 'RESEARCH_CONTRACT',
        planOperationId: 'e2e-plan-foreign-abort',
        planAttemptId: 'e2e-plan-foreign-abort-att',
        planRevisionId: 'plan-foreign-abort-e2e',
        retrievalSearchOperationId: 'e2e-search-foreign-abort',
        retrievalSearchAttemptId: 'e2e-search-foreign-abort-att',
        retrievalFetchOperationId: 'e2e-fetch-foreign-abort',
        retrievalFetchAttemptId: 'e2e-fetch-foreign-abort-att',
        extractOperationId: 'e2e-extract-foreign-abort',
        extractAttemptId: 'e2e-extract-foreign-abort-att',
        reviewOperationId: 'e2e-review-foreign-abort',
        reviewAttemptId: 'e2e-review-foreign-abort-att',
        synthesizeOperationId: 'e2e-synth-foreign-abort',
        synthesizeAttemptId: 'e2e-synth-foreign-abort-att',
        dispatchedAt: FIXED_NOW,
        signal: controller.signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    const extractCompletion = events.find(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload as { completion: { operation_id: string } }).completion.operation_id ===
          'e2e-extract-foreign-abort',
    )
    assert.equal(
      (extractCompletion?.payload as { completion: { settlement: string } }).completion.settlement,
      'cancelled',
    )
    assert.equal(completionUsageAttempt(extractCompletion), 'e2e-extract-foreign-abort-att')
    assert.equal(completionCostStatus(extractCompletion), 'unknown')
  })
})
