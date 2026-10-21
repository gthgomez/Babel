import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LlmRunner, RunnerCallbacks, RunnerInvocationMetadata } from '../../../runners/base.js'
import { createMissionScopedSourceAccessPort } from '../access/missionScopedSourceAccessPort.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../fixtures/technicalRepositoryCorpus.js'
import { searchIndexForTechnicalMission } from '../fixtures/technicalSearchIndex.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { ProviderResearchModelBridge } from '../model/providerResearchModelBridge.js'
import type {
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
} from '../ports/researchModelPort.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../registry/frozenRegistries.js'
import { runAdmittedResearchEndToEndPass } from './researchEndToEndPass.js'

const FIXED_NOW = '2026-10-20T12:20:00.000Z'

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

function fixtureModelWithE2eScripts(): ResearchModelPort {
  const fixture = new FixtureResearchModelBridge()
  fixture.scriptOutput('e2e-plan', {
    kind: 'plan_questions',
    questions: [{ text: 'What does the contract export?', importance: 'high' }],
  })
  return {
    async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
      if (request.kind === 'extract_findings') {
        const passageIds = (request.input.passage_ids as string[]) ?? []
        const questionId =
          (request.input.plan_questions as { question_id: string }[])?.[0]?.question_id ??
          'missing-plan-question'
        fixture.scriptOutput(request.operationId, {
          kind: 'extract_findings',
          findings: [
            {
              assertion_text: 'The file exports a RESEARCH_CONTRACT constant.',
              assertion_kind: 'source_observation',
              passage_ids: passageIds,
              question_id: questionId,
            },
          ],
        })
      }
      if (request.kind === 'semantic_support_review') {
        const findingId = (request.input.findings as { finding_id: string }[])?.[0]?.finding_id
        fixture.scriptOutput(request.operationId, {
          kind: 'semantic_support_review',
          judgments: [
            {
              finding_id: findingId ?? 'missing',
              status: 'insufficient',
              rationale: 'Only one pinned file was retrieved; decision remains incomplete.',
              question_coverage: 'none',
            },
          ],
        })
      }
      if (request.kind === 'synthesize_report') {
        fixture.scriptOutput(request.operationId, {
          kind: 'synthesize_report',
          answer_summary:
            'Evidence from the pinned contracts file suggests an exported constant; the mission decision is not fully resolved.',
          stopping_reason: 'insufficient_semantic_support',
        })
      }
      return fixture.invokeStructured(request)
    },
  }
}

describe('research end-to-end pass (offline governed)', () => {
  it('runs plan → admitted search/fetch → claims → review → cited partial report', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const session = { mission: exampleTechnicalMissionFixture, handle }
    const registries = createTechnicalResearchRegistries()
    const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
    assert.ok(adapter)

    const result = await runAdmittedResearchEndToEndPass({
      session,
      store,
      model: fixtureModelWithE2eScripts(),
      access: governedAccess(),
      adapter,
      registries,
      discoverQuery: 'RESEARCH_CONTRACT',
      planOperationId: 'e2e-plan',
      planAttemptId: 'e2e-plan-att',
      planRevisionId: 'plan-e2e-001',
      retrievalSearchOperationId: 'e2e-search',
      retrievalSearchAttemptId: 'e2e-search-att',
      retrievalFetchOperationId: 'e2e-fetch',
      retrievalFetchAttemptId: 'e2e-fetch-att',
      extractOperationId: 'e2e-extract',
      extractAttemptId: 'e2e-extract-att',
      reviewOperationId: 'e2e-review',
      reviewAttemptId: 'e2e-review-att',
      synthesizeOperationId: 'e2e-synth',
      synthesizeAttemptId: 'e2e-synth-att',
      dispatchedAt: '2026-10-20T12:19:00.000Z',
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })

    assert.ok(result.passageIds.length >= 1)
    assert.ok(result.findingIds.length >= 1)
    const events = await store.listEvents(session.mission.mission_id)
    assert.ok(
      events.some(
        (e) =>
          e.kind === 'external_operation_intent' &&
          (e.payload as { intent: { operation_kind: string } }).intent.operation_kind === 'source_search',
      ),
    )
    assert.ok(events.some((e) => e.kind === 'finding_recorded'))
    assert.ok(events.some((e) => e.kind === 'model_invocation_completed'))
    assert.ok(events.some((e) => e.kind === 'terminal_receipt'))
    const terminal = events.find((e) => e.kind === 'terminal_receipt')
    const report = (
      terminal?.payload as {
        report: {
          terminal_state: string
          citation_passage_ids: string[]
          limitations: string[]
          answer_summary: string
        }
      }
    ).report
    assert.equal(report.terminal_state, 'partial')
    assert.ok(report.limitations.includes('semantic_support_insufficient'))
    assert.ok(report.answer_summary.includes('supported:') || report.answer_summary.includes('No semantically'))
  })

  it('ProviderResearchModelBridge uses request-local callback metadata (factory path)', async () => {
    const scripts = new Map<string, Record<string, unknown>>([
      [
        'factory-op',
        {
          kind: 'plan_questions',
          questions: [{ text: 'Factory wiring check', importance: 'low' }],
        },
      ],
    ])
    const runner: Pick<LlmRunner, 'execute'> = {
      async execute(prompt, schema, callbacks?: RunnerCallbacks) {
        const envelope = JSON.parse(prompt) as { operation_id: string }
        const operationId = envelope.operation_id
        const meta: RunnerInvocationMetadata = {
          provider: 'openrouter',
          provider_model_id: 'fixture/factory',
          latency_ms: 2,
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 7,
          estimated_cost_usd: 0.002,
          cost_precision: 'exact',
        }
        callbacks?.onInvocationCompleted?.({
          inference_id: 'inf-factory',
          provider: 'openrouter',
          model: 'fixture/factory',
          status: 'delivered',
          usage_metadata: meta,
        })
        return schema.parse(scripts.get(operationId) ?? scripts.get('factory-op'))
      },
    }
    const bridge = new ProviderResearchModelBridge({
      runner,
      backendKey: 'research-v2-factory-test',
      provider: 'openrouter',
      providerModelId: 'fixture/factory',
      buildPrompt: (req) => ({
        systemPrompt: 'json only',
        prompt: JSON.stringify({ operation_id: req.operationId, kind: req.kind, input: req.input }),
      }),
    })
    const result = await bridge.invokeStructured({
      operationId: 'factory-op',
      attemptId: 'factory-att',
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.receipt.provider_model_id, 'fixture/factory')
      assert.equal(result.receipt.usage_settlement.cost.status, 'reported')
    }
  })
})
