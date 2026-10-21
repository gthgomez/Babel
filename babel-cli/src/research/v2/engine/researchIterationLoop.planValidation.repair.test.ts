import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import type { ResearchModelInvocationRequest, ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import { runAdmittedPlanningIteration } from './researchIterationLoop.js'

describe('planning post-response validation settlement', () => {
  it('settles model operation once when plan slot validation fails after ok invoke', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const model = {
      async invokeStructured(_request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
        return {
          status: 'ok',
          operationId: 'plan-op',
          output: {
            kind: 'plan_questions',
            questions: [
              {
                text: 'Q with bad slot?',
                importance: 'low',
                coverage_obligations: [
                  {
                    obligation_id: 'ob-bad',
                    source_slot: 'repository-pin-99',
                    aspect: 'technical_effect',
                    technical_effect: 'general_technical',
                  },
                ],
              },
            ],
          },
          receipt: {
            operation_id: 'plan-op',
            backend_key: 'k',
            provider: 'p',
            provider_model_id: 'm',
            resolved_at: '2026-10-20T00:00:00.000Z',
            usage_settlement: {
              attempt_id: 'plan-att',
              cost: { status: 'reported', amount_usd: 0.001, currency: 'USD' },
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
        modelOperationId: 'plan-op',
        modelAttemptId: 'plan-att',
        planRevisionId: 'plan-slot-invalid-001',
        revisionReason: 'slot-validation-test',
        dispatchedAt: '2026-10-20T00:00:00.000Z',
        signal: new AbortController().signal,
      }),
    )
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.ok(
      !events.some(
        (e) =>
          e.kind === 'plan_revised' &&
          (e.payload as { plan: { plan_revision_id: string } }).plan.plan_revision_id ===
            'plan-slot-invalid-001',
      ),
    )
    const completions = events.filter((e) => e.kind === 'external_operation_completed')
    assert.equal(completions.length, 1)
    const completion = completions[0]!.payload as {
      completion: { settlement: string; failure_category?: string }
    }
    assert.equal(completion.completion.settlement, 'failed')
    assert.equal(completion.completion.failure_category, 'structured_output_validation_failed')
  })
})
