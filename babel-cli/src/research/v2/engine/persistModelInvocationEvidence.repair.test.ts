import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { buildBootstrapPlanRevision } from './planFromModelOutput.js'
import { persistModelInvocationEvidence } from './persistModelInvocationEvidence.js'

describe('persistModelInvocationEvidence', () => {
  it('settles exactly one completion when appendModelReceipt rejects', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const acquired = await store.acquireWriterOwnership({
      mission_id: handle.mission_id,
      expected_writer_generation: handle.writer_generation,
    })
    const bootstrapPlanId = 'plan-receipt-fail-bootstrap'
    const ctx = {
      mission_id: acquired.mission_id,
      plan_revision_id: bootstrapPlanId,
      writer_generation: acquired.writer_generation,
    }
    await store.appendPlanRevision(
      ctx,
      buildBootstrapPlanRevision({
        mission: exampleTechnicalMissionFixture,
        planRevisionId: bootstrapPlanId,
        createdAt: '2026-10-20T00:00:00.000Z',
      }),
    )
    await store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: 'extract-op',
      attempt_id: 'extract-att',
      operation_kind: 'model_invoke',
      dispatched_at: '2026-10-20T00:00:00.000Z',
      idempotency_key: 'extract-op',
    })
    const originalAppend = store.appendModelReceipt.bind(store)
    store.appendModelReceipt = async () => {
      throw new Error('simulated receipt persistence failure')
    }
    const modelResult = {
      status: 'ok' as const,
      operationId: 'extract-op',
      output: { kind: 'extract_findings', findings: [] },
      receipt: {
        operation_id: 'extract-op',
        backend_key: 'k',
        provider: 'p',
        provider_model_id: 'm',
        resolved_at: '2026-10-20T00:00:00.000Z',
        usage_settlement: {
          attempt_id: 'extract-att',
          cost: { status: 'reported' as const, amount_usd: 0.002, currency: 'USD' as const },
        },
      },
    }
    await assert.rejects(() =>
      persistModelInvocationEvidence({
        store,
        ctx,
        missionId: ctx.mission_id,
        operationId: 'extract-op',
        attemptId: 'extract-att',
        modelResult,
        completedAt: '2026-10-20T01:00:00.000Z',
      }),
    )
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    const completions = events.filter((e) => e.kind === 'external_operation_completed')
    assert.equal(completions.length, 1)
    assert.equal(
      (completions[0]!.payload as { completion: { settlement: string } }).completion.settlement,
      'succeeded',
    )
    assert.equal(events.filter((e) => e.kind === 'model_invocation_completed').length, 0)
  })
})
