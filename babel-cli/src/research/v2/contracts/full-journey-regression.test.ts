/**
 * End-to-end regression: verbatim B brief normalization + store lifecycle + model attempt
 * identity + cancellation + accounting-only late settlement (no post-terminal evidence).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GeneralMissionBriefSchema,
  normalizeGeneralMissionBrief,
} from './normalization.js'
import { ResearchMissionV2Schema } from './mission.js'
import { ResearchReportV2Schema, PlanRevisionSchema } from './plan.js'
import {
  FakeResearchModelPort,
  InMemoryResearchStore,
  StoreContractError,
} from '../fixtures/fakePorts.js'
import { RESEARCH_V2_CONTRACT_VERSION } from './version.js'
import { parseVerbatimBriefJson } from '../fixtures/general-dev-brief-corpus/verbatimBriefBytes.js'

describe('research v2 full journey regression (checkpoint.3.1 candidate)', () => {
  it('verbatim G-DEV-01 brief through cancel and late usage reconciliation only', async () => {
    const brief = GeneralMissionBriefSchema.parse(parseVerbatimBriefJson('G-DEV-01'))
    const mission = ResearchMissionV2Schema.parse(
      normalizeGeneralMissionBrief(brief, {
        mission_id: 'journey-g-dev-01',
        created_at: '2026-10-20T12:00:00.000Z',
        profile_version: '0.0.0-checkpoint',
      }),
    )
    assert.equal(mission.contract_version, RESEARCH_V2_CONTRACT_VERSION)

    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(mission)
    const acquired = await store.acquireWriterOwnership({
      mission_id: mission.mission_id,
      expected_writer_generation: handle.writer_generation,
    })
    const planP1 = PlanRevisionSchema.parse({
      plan_revision_id: 'journey-plan-1',
      mission_id: mission.mission_id,
      created_at: '2026-10-20T12:01:00.000Z',
      revision_reason: 'initial',
      questions: [
        {
          question_id: 'q1',
          text: 'What does the brief require?',
          importance: 'high',
          evidence_requirement: 'Primary sources',
          status: 'open',
        },
      ],
    })
    const ctxP1 = {
      mission_id: mission.mission_id,
      plan_revision_id: planP1.plan_revision_id,
      writer_generation: acquired.writer_generation,
    }
    await store.appendPlanRevision(ctxP1, planP1)
    const planP2 = { ...planP1, plan_revision_id: 'journey-plan-2', revision_reason: 'refine' }
    await store.appendPlanRevision(ctxP1, planP2)
    const ctx = { ...ctxP1, plan_revision_id: planP2.plan_revision_id }

    const operationId = 'journey-model-op'
    const attemptId = 'journey-attempt-admitted'
    await store.appendExternalOperationIntent(ctx, {
      mission_id: mission.mission_id,
      operation_id: operationId,
      attempt_id: attemptId,
      operation_kind: 'model_invoke',
      dispatched_at: '2026-10-20T12:02:00.000Z',
      idempotency_key: 'journey-1',
    })

    const model = new FakeResearchModelPort()
    const invoked = await model.invokeStructured({
      operationId,
      attemptId,
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(invoked.status, 'ok')
    if (invoked.status === 'ok') {
      assert.equal(invoked.receipt.usage_settlement.attempt_id, attemptId)
    }

    const report = ResearchReportV2Schema.parse({
      mission_id: mission.mission_id,
      plan_revision_id: planP2.plan_revision_id,
      terminal_state: 'cancelled',
      answer_summary: 'cancelled before completion recorded',
      unanswered_questions: ['q1'],
      coverage_notes: 'intent dispatched; no store completion',
      limitations: [],
      source_cutoff: 'unknown',
      acceptance_state: 'not_accepted',
      stopping_reason: 'user_cancel',
      finding_ids: [],
      citation_passage_ids: [],
      generated_at: '2026-10-20T12:04:00.000Z',
    })
    await store.appendTerminalReport(ctx, report)

    const reconcileCtx = { ...ctx, write_authority: 'usage_reconciliation' as const }
    await store.appendExternalOperationReconciled(reconcileCtx, {
      mission_id: mission.mission_id,
      operation_id: operationId,
      attempt_id: attemptId,
      reconciled_at: '2026-10-20T12:05:00.000Z',
      prior_settlement: 'uncertain',
      resolved_settlement: 'cancelled',
      usage_settlement: {
        attempt_id: attemptId,
        cost: { status: 'reported', amount_usd: 0.005, currency: 'USD' },
      },
      rationale: 'late provider bill after mission cancel',
    })

    await assert.rejects(
      () =>
        store.appendExternalOperationIntent(ctx, {
          mission_id: mission.mission_id,
          operation_id: 'post-terminal-op',
          attempt_id: 'post-att',
          operation_kind: 'model_invoke',
          dispatched_at: '2026-10-20T12:06:00.000Z',
          idempotency_key: 'post',
        }),
      (e: unknown) => e instanceof StoreContractError,
    )

    const kinds = (await store.listEvents(mission.mission_id)).map((e) => e.kind)
    assert.deepEqual(
      kinds,
      [
        'mission_created',
        'plan_revised',
        'plan_revised',
        'external_operation_intent',
        'terminal_receipt',
        'external_operation_reconciled',
      ],
    )
  })
})
