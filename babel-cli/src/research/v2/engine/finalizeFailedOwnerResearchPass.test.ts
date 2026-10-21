import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { runResearchV2EnginePassOnOwner } from '../cli/researchV2MissionRun.js'
import { ProviderResearchModelBridge } from '../model/providerResearchModelBridge.js'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LlmRunner, RunnerCallbacks } from '../../../runners/base.js'
import type { ZodType } from 'zod'
import { buildResearchV2StructuredModelPrompt } from '../model/researchV2ProviderModelPrompt.js'
import { reportResearchV2Store } from '../cli/researchV2CliOperations.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'

const malformedFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L1-live-malformed-plan-questions-response.json',
)

function malformedPlanningBridge(): ProviderResearchModelBridge {
  const fixture = JSON.parse(readFileSync(malformedFixturePath, 'utf8')) as {
    representative_validation_failure_payload: Record<string, unknown>
  }
  const runner: Pick<LlmRunner, 'execute'> = {
    async execute<T>(_prompt: string, _schema: ZodType<T>, callbacks?: RunnerCallbacks): Promise<T> {
      callbacks?.onInvocationCompleted?.({
        inference_id: 'inf-malformed-replay',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        status: 'delivered',
        usage_metadata: {
          provider: 'openrouter',
          provider_model_id: 'deepseek/deepseek-v4-flash-0731',
          latency_ms: 1,
          prompt_tokens: 652,
          completion_tokens: 556,
          total_tokens: 1208,
          estimated_cost_usd: 0.0001117236,
          cost_precision: 'exact',
        },
        observed_model_id: null,
      })
      return fixture.representative_validation_failure_payload as T
    },
  }
  return new ProviderResearchModelBridge({
    runner,
    backendKey: 'research-v2-cli',
    provider: 'openrouter',
    providerModelId: 'deepseek/deepseek-v4-flash-0731',
    buildPrompt: buildResearchV2StructuredModelPrompt,
  })
}

describe('finalizeFailedOwnerResearchPass', () => {
  it('records failed terminal receipt when planning invoke fails so report is inspectable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-failed-pass-'))
    try {
      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: new FixtureResearchModelBridge(),
      })
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      await assert.rejects(() =>
        runResearchV2EnginePassOnOwner({
          owner,
          mission: exampleTechnicalMissionFixture,
          handle,
          discoverQuery: 'RESEARCH_CONTRACT',
          injectedOffline: false,
          planRevisionId: 'plan-failed-pass-001',
          model: malformedPlanningBridge(),
          signal: new AbortController().signal,
        }),
      )
      await owner.close()

      let reportPayload: { report?: { terminal_state?: string; stopping_reason?: string } } | undefined
      await reportResearchV2Store({
        store: dir,
        missionId: exampleTechnicalMissionFixture.mission_id,
        print: (p) => {
          reportPayload = p as { report?: { terminal_state?: string } }
        },
      })
      assert.equal(reportPayload?.report?.terminal_state, 'failed')
      assert.equal(reportPayload?.report?.stopping_reason, 'structured_output_validation_failed')

      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      await reopened.close()
      const reportedCostCompletions = events.filter((e) => {
        if (e.kind !== 'external_operation_completed') return false
        const completion = (e.payload as { completion: { usage_settlement?: { cost?: { status?: string } } } })
          .completion
        return completion.usage_settlement?.cost?.status === 'reported'
      })
      assert.equal(reportedCostCompletions.length, 1)
      const cost = (
        reportedCostCompletions[0]!.payload as {
          completion: { usage_settlement: { cost: { amount_usd?: number } } }
        }
      ).completion.usage_settlement.cost
      assert.equal(cost.amount_usd, 0.0001117236)

    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
