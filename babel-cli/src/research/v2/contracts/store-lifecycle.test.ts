/**
 * Consolidated FIX review — store fencing, operations, terminal usage reconciliation.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemoryResearchStore, StoreContractError } from '../fixtures/fakePorts.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { SourceRecordSchema } from './sources.js'
import { ResearchReportV2Schema } from './plan.js'

function withPlan(store: InMemoryResearchStore) {
  return store.appendMission(exampleTechnicalMissionFixture).then(() =>
    store.appendPlanRevision(exampleMissionWriteContext, examplePlanRevisionFixture),
  )
}

describe('research v2 store lifecycle (checkpoint.3 FIX)', () => {
  it('rejects duplicate mission creation', async () => {
    const store = new InMemoryResearchStore()
    await store.appendMission(exampleTechnicalMissionFixture)
    await assert.rejects(
      () => store.appendMission(exampleTechnicalMissionFixture),
      (e: unknown) => e instanceof StoreContractError,
    )
  })

  it('fences evidence after terminal report but allows usage reconciliation', async () => {
    const store = new InMemoryResearchStore()
    await withPlan(store)
    const ctx = { ...exampleMissionWriteContext }
    const missionId = ctx.mission_id
    await store.appendExternalOperationIntent(ctx, {
      mission_id: missionId,
      operation_id: 'op-uncertain',
      attempt_id: 'att-1',
      operation_kind: 'model_invoke',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'k1',
    })
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: missionId,
      operation_id: 'op-uncertain',
      attempt_id: 'att-1',
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'uncertain',
    })
    const report = ResearchReportV2Schema.parse({
      mission_id: missionId,
      plan_revision_id: ctx.plan_revision_id,
      terminal_state: 'cancelled',
      answer_summary: 'stopped',
      unanswered_questions: [],
      coverage_notes: 'cancelled after uncertain usage',
      limitations: [],
      source_cutoff: 'unknown',
      acceptance_state: 'not_accepted',
      stopping_reason: 'user_cancel',
      finding_ids: [],
      citation_passage_ids: [],
      generated_at: '2026-10-20T12:05:00.000Z',
    })
    await store.appendTerminalReport(ctx, report)
    await assert.rejects(
      () =>
        store.appendSource(
          ctx,
          SourceRecordSchema.parse({
            source_id: 'late-src',
            kind: 'web',
            canonical_key: 'late',
            observed_urls: ['https://example.test/late'],
          }),
        ),
      (e: unknown) => e instanceof StoreContractError,
    )
    const reconcileCtx = {
      ...ctx,
      write_authority: 'usage_reconciliation' as const,
    }
    await store.appendExternalOperationReconciled(reconcileCtx, {
      mission_id: missionId,
      operation_id: 'op-uncertain',
      attempt_id: 'att-1',
      reconciled_at: '2026-10-20T12:06:00.000Z',
      prior_settlement: 'uncertain',
      resolved_settlement: 'cancelled',
      usage_settlement: {
        attempt_id: 'att-1',
        cost: { status: 'reported', amount_usd: 0.02, currency: 'USD' },
      },
      rationale: 'bill uncertain model call after cancel',
    })
    const events = await store.listEvents(missionId)
    assert.ok(events.some((e) => e.kind === 'external_operation_reconciled'))
  })

  it('enforces operation intent before completion and mission-scoped operation ids', async () => {
    const store = new InMemoryResearchStore()
    await withPlan(store)
    const ctx = { ...exampleMissionWriteContext }
    await assert.rejects(
      () =>
        store.appendExternalOperationCompleted(ctx, {
          mission_id: ctx.mission_id,
          operation_id: 'orphan',
          attempt_id: 'att-1',
          completed_at: '2026-10-20T12:00:00.000Z',
          settlement: 'succeeded',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    await store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: 'shared-op',
      attempt_id: 'att-a',
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'a',
    })
    const storeB = new InMemoryResearchStore()
    const missionB = { ...exampleTechnicalMissionFixture, mission_id: 'mission-b-2' }
    const planB = { ...examplePlanRevisionFixture, mission_id: 'mission-b-2', plan_revision_id: 'plan-b-2' }
    await storeB.appendMission(missionB)
    const ctxB = {
      mission_id: 'mission-b-2',
      plan_revision_id: 'plan-b-2',
      writer_generation: 1,
    }
    await storeB.appendPlanRevision(ctxB, planB)
    await storeB.appendExternalOperationIntent(ctxB, {
      mission_id: 'mission-b-2',
      operation_id: 'shared-op',
      attempt_id: 'att-b',
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'b',
    })
    await assert.rejects(
      () =>
        store.appendExternalOperationCompleted(ctx, {
          mission_id: ctx.mission_id,
          operation_id: 'shared-op',
          attempt_id: 'att-wrong',
          completed_at: '2026-10-20T12:00:01.000Z',
          settlement: 'succeeded',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    const completion = {
      mission_id: ctx.mission_id,
      operation_id: 'shared-op',
      attempt_id: 'att-a',
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'succeeded' as const,
    }
    await store.appendExternalOperationCompleted(ctx, completion)
    await store.appendExternalOperationCompleted(ctx, completion)
  })

  it('exposes acquire/replace/release writer ownership on the store contract', async () => {
    const store = new InMemoryResearchStore()
    await withPlan(store)
    const replaced = await store.replaceWriterOwnership(
      exampleMissionWriteContext,
      'crash recovery handoff',
    )
    assert.equal(replaced.writer_generation, 2)
    await assert.rejects(
      () => store.acquireWriterOwnership({ mission_id: exampleMissionWriteContext.mission_id, expected_writer_generation: 1 }),
      (e: unknown) => e instanceof StoreContractError,
    )
    const acquired = await store.acquireWriterOwnership({
      mission_id: exampleMissionWriteContext.mission_id,
      expected_writer_generation: 2,
    })
    assert.equal(acquired.writer_generation, 3)
    await store.releaseWriterOwnership({
      ...exampleMissionWriteContext,
      writer_generation: 3,
    })
  })
})
