import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import type { ResearchModelInvocationRequest, ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import { runAdmittedPlanningIteration } from './researchIterationLoop.js'

describe('planning receipt binding before plan activation', () => {
  it('rejects foreign model result before appendPlanRevision', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const model = {
      async invokeStructured(_request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
        return {
          status: 'ok',
          operationId: 'wrong-op',
          output: {
            kind: 'plan_questions',
            questions: [{ text: 'Q?', importance: 'low' }],
          },
          receipt: {
            operation_id: 'plan-op',
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
        planRevisionId: 'plan-pre-bind-001',
        revisionReason: 'pre-bind-test',
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
            'plan-pre-bind-001',
      ),
    )
    assert.ok(!events.some((e) => e.kind === 'model_invocation_completed'))
  })
})
