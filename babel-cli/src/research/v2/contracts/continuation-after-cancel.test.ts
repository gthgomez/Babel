/**
 * Fail-before / pass-after: host-authorized continuation after cancel + late accounting only.
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
import { WriterOwnershipAcquireSchema } from './storeLifecycle.js'

const planP1 = examplePlanRevisionFixture
const planP2 = {
  ...examplePlanRevisionFixture,
  plan_revision_id: 'plan-fixture-002',
  revision_reason: 'refined_scope',
}

describe('host-authorized continuation after cancellation (checkpoint.3.1.1)', () => {
  it('schema rejects acquire without expected_writer_generation', () => {
    assert.throws(
      () => WriterOwnershipAcquireSchema.parse({ mission_id: 'mission-1' }),
      /expected_writer_generation/,
    )
  })

  it('complete journey: P1 work, P2, cancel, late accounting, explicit resume, new terminal', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const acquired = await store.acquireWriterOwnership({
      mission_id: handle.mission_id,
      expected_writer_generation: handle.writer_generation,
    })
    const ctxP1 = {
      ...exampleMissionWriteContext,
      writer_generation: acquired.writer_generation,
      plan_revision_id: planP1.plan_revision_id,
    }
    await store.appendPlanRevision(ctxP1, planP1)

    const settledOp = 'run-op-settled'
    const settledAttempt = 'run-att-settled'
    await store.appendExternalOperationIntent(ctxP1, {
      mission_id: ctxP1.mission_id,
      operation_id: settledOp,
      attempt_id: settledAttempt,
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: 'run-settled',
    })
    await store.appendExternalOperationCompleted(ctxP1, {
      mission_id: ctxP1.mission_id,
      operation_id: settledOp,
      attempt_id: settledAttempt,
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'succeeded',
    })
    const evidenceSource = SourceRecordSchema.parse({
      source_id: 'pre-cancel-src',
      kind: 'web',
      canonical_key: 'pre-cancel',
      observed_urls: ['https://example.test/pre'],
    })
    await store.appendSource(ctxP1, evidenceSource)

    await store.appendPlanRevision(ctxP1, planP2)
    const ctxP2 = { ...ctxP1, plan_revision_id: planP2.plan_revision_id }

    const billOp = 'run-op-bill'
    const billAttempt = 'run-att-bill'
    await store.appendExternalOperationIntent(ctxP2, {
      mission_id: ctxP2.mission_id,
      operation_id: billOp,
      attempt_id: billAttempt,
      operation_kind: 'model_invoke',
      dispatched_at: '2026-10-20T12:02:00.000Z',
      idempotency_key: 'run-bill',
    })

    const cancelledReport = ResearchReportV2Schema.parse({
      mission_id: ctxP2.mission_id,
      plan_revision_id: planP2.plan_revision_id,
      terminal_state: 'cancelled',
      answer_summary: 'user cancelled run',
      unanswered_questions: [],
      coverage_notes: 'cancelled with prior evidence',
      limitations: [],
      source_cutoff: 'unknown',
      acceptance_state: 'not_accepted',
      stopping_reason: 'user_cancel',
      finding_ids: [],
      citation_passage_ids: [],
      generated_at: '2026-10-20T12:03:00.000Z',
    })
    await store.appendTerminalReport(ctxP2, cancelledReport)
    const cancelledEvent = (await store.listEvents(ctxP2.mission_id)).find(
      (e) => e.kind === 'terminal_receipt',
    )
    assert.ok(cancelledEvent)
    const cancelledPayload = structuredClone(cancelledEvent!.payload)

    await assert.rejects(
      () =>
        store.acquireWriterOwnership({
          mission_id: ctxP2.mission_id,
          expected_writer_generation: ctxP2.writer_generation,
        }),
      (e: unknown) => e instanceof StoreContractError,
    )

    const reconcileCtx = {
      ...ctxP2,
      write_authority: 'usage_reconciliation' as const,
    }
    const lateReconcile = {
      mission_id: ctxP2.mission_id,
      operation_id: billOp,
      attempt_id: billAttempt,
      reconciled_at: '2026-10-20T12:04:00.000Z',
      prior_settlement: 'uncertain' as const,
      resolved_settlement: 'cancelled' as const,
      usage_settlement: {
        attempt_id: billAttempt,
        cost: { status: 'reported' as const, amount_usd: 0.01, currency: 'USD' as const },
      },
      rationale: 'late bill after cancel',
    }
    await store.appendExternalOperationReconciled(reconcileCtx, lateReconcile)
    await store.appendExternalOperationReconciled(reconcileCtx, lateReconcile)

    await assert.rejects(
      () => store.appendSource(ctxP2, evidenceSource),
      (e: unknown) => e instanceof StoreContractError,
    )

    const generationBeforeResume = ctxP2.writer_generation
    await assert.rejects(
      () =>
        store.resumeResearchContinuation({
          mission_id: ctxP2.mission_id,
          expected_writer_generation: generationBeforeResume - 1,
          host_authorization_ref: 'host-ops/ticket-99',
          acknowledged_plan_revision_id: planP2.plan_revision_id,
          acknowledged_terminal_state: 'cancelled',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )

    const resumed = await store.resumeResearchContinuation({
      mission_id: ctxP2.mission_id,
      expected_writer_generation: generationBeforeResume,
      host_authorization_ref: 'host-ops/ticket-99',
      acknowledged_plan_revision_id: planP2.plan_revision_id,
      acknowledged_terminal_state: 'cancelled',
    })
    assert.equal(resumed.writer_generation, generationBeforeResume + 1)

    await assert.rejects(
      () =>
        store.resumeResearchContinuation({
          mission_id: ctxP2.mission_id,
          expected_writer_generation: generationBeforeResume,
          host_authorization_ref: 'host-ops/ticket-duplicate',
          acknowledged_plan_revision_id: planP2.plan_revision_id,
          acknowledged_terminal_state: 'cancelled',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )

    const ctxContinued = {
      ...ctxP2,
      writer_generation: resumed.writer_generation,
    }
    await store.appendSource(
      ctxContinued,
      SourceRecordSchema.parse({
        source_id: 'post-resume-src',
        kind: 'web',
        canonical_key: 'post-resume',
        observed_urls: ['https://example.test/post'],
      }),
    )

    await assert.rejects(
      () => store.appendSource(ctxP2, evidenceSource),
      (e: unknown) => e instanceof StoreContractError,
    )

    const finalReport = ResearchReportV2Schema.parse({
      mission_id: ctxContinued.mission_id,
      plan_revision_id: planP2.plan_revision_id,
      terminal_state: 'complete',
      answer_summary: 'completed after explicit resume',
      unanswered_questions: [],
      coverage_notes: 'second terminal',
      limitations: [],
      source_cutoff: 'unknown',
      acceptance_state: 'accepted_with_limitations',
      stopping_reason: 'coverage_sufficient',
      finding_ids: [],
      citation_passage_ids: [],
      generated_at: '2026-10-20T12:10:00.000Z',
    })
    await store.appendTerminalReport(ctxContinued, finalReport)

    const events = await store.listEvents(ctxContinued.mission_id)
    const cancelledAfter = events.find((e) => e.kind === 'terminal_receipt' && e.eventId === cancelledEvent!.eventId)
    assert.deepEqual(cancelledAfter?.payload, cancelledPayload)
    assert.ok(events.some((e) => e.kind === 'source_recorded' && (e.payload as { source?: { source_id?: string } }).source?.source_id === 'pre-cancel-src'))
    assert.ok(events.some((e) => e.kind === 'source_recorded' && (e.payload as { source?: { source_id?: string } }).source?.source_id === 'post-resume-src'))
    assert.equal(events.filter((e) => e.kind === 'external_operation_reconciled').length, 1)
    assert.equal(events.filter((e) => e.kind === 'terminal_receipt').length, 2)
    assert.equal(events.filter((e) => e.kind === 'research_continuation_resumed').length, 1)
  })
})
