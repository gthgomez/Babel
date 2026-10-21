import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import type { ResearchModelInvocationRequest, ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import { runAdmittedPlanningIteration } from './researchIterationLoop.js'

describe('model receipt binding repairs', () => {
  it('does not persist a foreign-operation receipt', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const model = {
      async invokeStructured(_request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
        return {
          status: 'ok',
          operationId: 'plan-op',
          output: {
            kind: 'plan_questions',
            questions: [{ text: 'Q?', importance: 'low' }],
          },
          receipt: {
            operation_id: 'foreign-op',
            backend_key: 'k',
            provider: 'p',
            provider_model_id: 'm',
            resolved_at: '2026-10-20T00:00:00.000Z',
            usage_settlement: { attempt_id: 'plan-att', cost: { status: 'unknown' } },
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
        planRevisionId: 'plan-bind-001',
        revisionReason: 'receipt-binding-test',
        dispatchedAt: '2026-10-20T00:00:00.000Z',
        signal: new AbortController().signal,
      }),
    )
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.ok(!events.some((e) => e.kind === 'model_invocation_completed'))
    assert.ok(
      !events.some(
        (e) =>
          e.kind === 'plan_revised' &&
          (e.payload as { plan: { plan_revision_id: string } }).plan.plan_revision_id ===
            'plan-bind-001',
      ),
    )
    const completion = events.find(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload as { completion: { operation_id: string } }).completion.operation_id === 'plan-op',
    )
    assert.equal(
      (completion?.payload as { completion: { settlement: string } }).completion.settlement,
      'failed',
    )
  })
})
