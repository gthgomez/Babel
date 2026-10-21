/**
 * Checkpoint.3.1 composition FIX — store fencing, plans, ownership, operations, late accounting.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FakeResearchModelPort,
  InMemoryResearchStore,
  StoreContractError,
} from '../fixtures/fakePorts.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { SourceRecordSchema } from './sources.js'
import { ResearchReportV2Schema } from './plan.js'
import type { ExternalOperationReconciliation } from './operations.js'

const planP1 = examplePlanRevisionFixture
const planP2 = {
  ...examplePlanRevisionFixture,
  plan_revision_id: 'plan-fixture-002',
  revision_reason: 'refined_scope',
  created_at: '2026-10-20T12:02:00.000Z',
}

async function seedMission(store: InMemoryResearchStore) {
  return store.appendMission(exampleTechnicalMissionFixture)
}

async function withPlanP1(store: InMemoryResearchStore) {
  await seedMission(store)
  await store.appendPlanRevision(exampleMissionWriteContext, planP1)
}

function ctxAt(planRevisionId: string, writerGeneration = 1) {
  return {
    ...exampleMissionWriteContext,
    plan_revision_id: planRevisionId,
    writer_generation: writerGeneration,
  }
}

describe('research v2 store lifecycle (checkpoint.3.1 composition FIX)', () => {
  it('rejects duplicate mission creation', async () => {
    const store = new InMemoryResearchStore()
    await store.appendMission(exampleTechnicalMissionFixture)
    await assert.rejects(
      () => store.appendMission(exampleTechnicalMissionFixture),
      (e: unknown) => e instanceof StoreContractError,
    )
  })

  it('activates plan P1 then transitions to P2 with current-plan precondition', async () => {
    const store = new InMemoryResearchStore()
    await withPlanP1(store)
    const ctxP1 = ctxAt(planP1.plan_revision_id)
    await assert.rejects(
      () =>
        store.appendPlanRevision(ctxP1, {
          ...planP2,
          plan_revision_id: planP1.plan_revision_id,
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    await assert.rejects(
      () =>
        store.appendPlanRevision(
          { ...ctxP1, plan_revision_id: 'stale-plan-id' },
          planP2,
        ),
      (e: unknown) => e instanceof StoreContractError,
    )
    await store.appendPlanRevision(ctxP1, planP2)
    const ctxP2 = ctxAt(planP2.plan_revision_id)
    await store.appendSource(
      ctxP2,
      SourceRecordSchema.parse({
        source_id: 'after-p2',
        kind: 'web',
        canonical_key: 'after-p2',
        observed_urls: ['https://example.test/p2'],
      }),
    )
    const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
    assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 2)
  })

  it('requires expected_writer_generation and rejects competing resumes', async () => {
    const store = new InMemoryResearchStore()
    await withPlanP1(store)
    const missionId = exampleTechnicalMissionFixture.mission_id
    const first = await store.acquireWriterOwnership({
      mission_id: missionId,
      expected_writer_generation: 1,
    })
    assert.equal(first.writer_generation, 2)
    await assert.rejects(
      () =>
        store.acquireWriterOwnership({
          mission_id: missionId,
          expected_writer_generation: 1,
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    const second = await store.acquireWriterOwnership({
      mission_id: missionId,
      expected_writer_generation: 2,
    })
    assert.equal(second.writer_generation, 3)
  })

  it('replace and release writer ownership invalidate stale generations', async () => {
    const store = new InMemoryResearchStore()
    await withPlanP1(store)
    const replaced = await store.replaceWriterOwnership(
      exampleMissionWriteContext,
      'crash recovery handoff',
    )
    assert.equal(replaced.writer_generation, 2)
    const acquired = await store.acquireWriterOwnership({
      mission_id: exampleMissionWriteContext.mission_id,
      expected_writer_generation: 2,
    })
    assert.equal(acquired.writer_generation, 3)
    await store.releaseWriterOwnership({
      ...exampleMissionWriteContext,
      writer_generation: 3,
    })
    await assert.rejects(
      () =>
        store.appendSource(exampleMissionWriteContext, SourceRecordSchema.parse({
          source_id: 'stale-gen',
          kind: 'web',
          canonical_key: 'stale',
          observed_urls: ['https://example.test/stale'],
        })),
      (e: unknown) => e instanceof StoreContractError,
    )
  })

  it('enforces operation intent before completion and mission-scoped operation ids in one store', async () => {
    const store = new InMemoryResearchStore()
    const missionA = { ...exampleTechnicalMissionFixture, mission_id: 'mission-a' }
    const missionB = { ...exampleTechnicalMissionFixture, mission_id: 'mission-b' }
    await store.appendMission(missionA)
    await store.appendMission(missionB)
    const ctxA = { ...ctxAt('plan-a'), mission_id: 'mission-a' }
    const ctxB = { ...ctxAt('plan-b'), mission_id: 'mission-b' }
    await store.appendPlanRevision(ctxA, {
      ...planP1,
      mission_id: 'mission-a',
      plan_revision_id: 'plan-a',
    })
    await store.appendPlanRevision(ctxB, {
      ...planP1,
      mission_id: 'mission-b',
      plan_revision_id: 'plan-b',
    })
    await assert.rejects(
      () =>
        store.appendExternalOperationCompleted(ctxA, {
          mission_id: 'mission-a',
          operation_id: 'orphan',
          attempt_id: 'att-1',
          completed_at: '2026-10-20T12:00:00.000Z',
          settlement: 'succeeded',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    await store.appendExternalOperationIntent(ctxA, {
      mission_id: 'mission-a',
      operation_id: 'shared-op',
      attempt_id: 'att-a',
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'a',
    })
    await store.appendExternalOperationIntent(ctxB, {
      mission_id: 'mission-b',
      operation_id: 'shared-op',
      attempt_id: 'att-b',
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'b',
    })
    await assert.rejects(
      () =>
        store.appendExternalOperationCompleted(ctxA, {
          mission_id: 'mission-a',
          operation_id: 'shared-op',
          attempt_id: 'att-wrong',
          completed_at: '2026-10-20T12:00:01.000Z',
          settlement: 'succeeded',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    const completion = {
      mission_id: 'mission-a',
      operation_id: 'shared-op',
      attempt_id: 'att-a',
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'succeeded' as const,
    }
    await store.appendExternalOperationCompleted(ctxA, completion)
    await store.appendExternalOperationCompleted(ctxA, completion)
  })

  it('allows explicit retry with new attempt after failed completion on same operation id', async () => {
    const store = new InMemoryResearchStore()
    await withPlanP1(store)
    const ctx = ctxAt(planP1.plan_revision_id)
    const missionId = ctx.mission_id
    const op = 'model-op-retry'
    await store.appendExternalOperationIntent(ctx, {
      mission_id: missionId,
      operation_id: op,
      attempt_id: 'att-fail',
      operation_kind: 'model_invoke',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'k-fail',
    })
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: missionId,
      operation_id: op,
      attempt_id: 'att-fail',
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'failed',
      failure_category: 'timeout',
    })
    await store.appendExternalOperationIntent(ctx, {
      mission_id: missionId,
      operation_id: op,
      attempt_id: 'att-retry',
      operation_kind: 'model_invoke',
      dispatched_at: '2026-10-20T12:00:02.000Z',
      idempotency_key: 'k-retry',
    })
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: missionId,
      operation_id: op,
      attempt_id: 'att-retry',
      completed_at: '2026-10-20T12:00:03.000Z',
      settlement: 'succeeded',
    })
  })

  it('model port carries admitted attempt_id into usage settlement', async () => {
    const model = new FakeResearchModelPort()
    const result = await model.invokeStructured({
      operationId: 'op-1',
      attemptId: 'admitted-attempt-42',
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.receipt.usage_settlement.attempt_id, 'admitted-attempt-42')
    }
  })

  it('fences evidence after terminal but allows uncertain completion reconciliation', async () => {
    const store = new InMemoryResearchStore()
    await withPlanP1(store)
    const ctx = ctxAt(planP1.plan_revision_id)
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
    const reconciliation = {
      mission_id: missionId,
      operation_id: 'op-uncertain',
      attempt_id: 'att-1',
      reconciled_at: '2026-10-20T12:06:00.000Z',
      prior_settlement: 'uncertain' as const,
      resolved_settlement: 'cancelled' as const,
      usage_settlement: {
        attempt_id: 'att-1',
        cost: { status: 'reported' as const, amount_usd: 0.02, currency: 'USD' as const },
      },
      rationale: 'bill uncertain model call after cancel',
    }
    await store.appendExternalOperationReconciled(reconcileCtx, reconciliation)
    await store.appendExternalOperationReconciled(reconcileCtx, reconciliation)
    await assert.rejects(
      () =>
        store.appendExternalOperationReconciled(reconcileCtx, {
          ...reconciliation,
          rationale: 'different rationale',
          usage_settlement: {
            attempt_id: 'att-1',
            cost: { status: 'reported' as const, amount_usd: 0.03, currency: 'USD' as const },
          },
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    const events = await store.listEvents(missionId)
    assert.ok(events.some((e) => e.kind === 'external_operation_reconciled'))
    assert.ok(!events.some((e) => e.kind === 'finding_recorded'))
  })

  it('settles late accounting when intent dispatched then cancelled without completion', async () => {
    const store = new InMemoryResearchStore()
    await withPlanP1(store)
    const ctx = ctxAt(planP1.plan_revision_id)
    const missionId = ctx.mission_id
    await store.appendExternalOperationIntent(ctx, {
      mission_id: missionId,
      operation_id: 'op-late-bill',
      attempt_id: 'att-late',
      operation_kind: 'model_invoke',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'late',
    })
    const report = ResearchReportV2Schema.parse({
      mission_id: missionId,
      plan_revision_id: ctx.plan_revision_id,
      terminal_state: 'cancelled',
      answer_summary: 'cancelled before model completion recorded',
      unanswered_questions: [],
      coverage_notes: 'no completion event',
      limitations: [],
      source_cutoff: 'unknown',
      acceptance_state: 'not_accepted',
      stopping_reason: 'user_cancel',
      finding_ids: [],
      citation_passage_ids: [],
      generated_at: '2026-10-20T12:04:00.000Z',
    })
    await store.appendTerminalReport(ctx, report)
    const reconcileCtx = {
      ...ctx,
      write_authority: 'usage_reconciliation' as const,
    }
    await assert.rejects(
      () =>
        store.appendExternalOperationReconciled(reconcileCtx, {
          mission_id: missionId,
          operation_id: 'op-late-bill',
          attempt_id: 'att-late',
          reconciled_at: '2026-10-20T12:05:00.000Z',
          prior_settlement: 'uncertain',
          resolved_settlement: 'cancelled',
          usage_settlement: {
            attempt_id: 'att-wrong',
            cost: { status: 'reported', amount_usd: 0.01, currency: 'USD' },
          },
          rationale: 'bad nested attempt',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
    const late: ExternalOperationReconciliation = {
      mission_id: missionId,
      operation_id: 'op-late-bill',
      attempt_id: 'att-late',
      reconciled_at: '2026-10-20T12:05:00.000Z',
      prior_settlement: 'uncertain',
      resolved_settlement: 'cancelled',
      usage_settlement: {
        attempt_id: 'att-late',
        cost: { status: 'reported', amount_usd: 0.01, currency: 'USD' },
      },
      rationale: 'provider bill arrived after mission cancel',
    }
    await store.appendExternalOperationReconciled(reconcileCtx, late)
    await assert.rejects(
      () =>
        store.appendTerminalReport(
          ctx,
          ResearchReportV2Schema.parse({
            ...report,
            answer_summary: 'cannot resurrect',
          }),
        ),
      (e: unknown) => e instanceof StoreContractError,
    )
  })

  it('composed VALID lifecycle: acquire, plan transition, dispatch, terminal fence', async () => {
    const store = new InMemoryResearchStore()
    const handle = await seedMission(store)
    assert.equal(handle.writer_generation, 1)
    const acquiredRun = await store.acquireWriterOwnership({
      mission_id: handle.mission_id,
      expected_writer_generation: 1,
    })
    assert.equal(acquiredRun.writer_generation, 2)
    const ctxP1 = {
      ...exampleMissionWriteContext,
      writer_generation: 2,
      plan_revision_id: planP1.plan_revision_id,
    }
    await store.appendPlanRevision(ctxP1, planP1)
    await store.appendPlanRevision(ctxP1, planP2)
    const ctxP2 = { ...ctxP1, plan_revision_id: planP2.plan_revision_id }
    await store.appendExternalOperationIntent(ctxP2, {
      mission_id: ctxP2.mission_id,
      operation_id: 'composed-op',
      attempt_id: 'composed-att',
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:10:00.000Z',
      idempotency_key: 'composed',
    })
    await store.appendExternalOperationCompleted(ctxP2, {
      mission_id: ctxP2.mission_id,
      operation_id: 'composed-op',
      attempt_id: 'composed-att',
      completed_at: '2026-10-20T12:10:01.000Z',
      settlement: 'succeeded',
    })
    await store.appendTerminalReport(
      ctxP2,
      ResearchReportV2Schema.parse({
        mission_id: ctxP2.mission_id,
        plan_revision_id: planP2.plan_revision_id,
        terminal_state: 'complete',
        answer_summary: 'done',
        unanswered_questions: [],
        coverage_notes: 'fixture',
        limitations: [],
        source_cutoff: 'unknown',
        acceptance_state: 'accepted_with_limitations',
        stopping_reason: 'coverage_sufficient',
        finding_ids: [],
        citation_passage_ids: [],
        generated_at: '2026-10-20T12:11:00.000Z',
      }),
    )
    await assert.rejects(
      () =>
        store.appendExternalOperationIntent(ctxP2, {
          mission_id: ctxP2.mission_id,
          operation_id: 'post-terminal',
          attempt_id: 'post-att',
          operation_kind: 'source_fetch',
          dispatched_at: '2026-10-20T12:12:00.000Z',
          idempotency_key: 'post',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )
  })
})
