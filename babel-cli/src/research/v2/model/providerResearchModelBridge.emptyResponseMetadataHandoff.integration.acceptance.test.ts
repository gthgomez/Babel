/**
 * Durable store metadata acceptance @ 3340cf0d + 1153af89 settlement (draft PR 406).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { MissionWriteContext } from '../contracts/common.js'
import { ProviderInvokeDiagnosticsSchema } from '../contracts/providerInvokeDiagnostics.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { settleModelOperation } from '../engine/settleModelOperation.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'
import {
  EMPTY_RESPONSE_HANDOFF_FORBIDDEN_STORE_SUBSTRINGS,
  EMPTY_RESPONSE_HANDOFF_USAGE_META,
  productionShapedEmptyResponseBridgeOptions,
  emptyResponseHandoffRunner,
  interleavedEmptyResponseHandoffRunner,
} from './fixtures/emptyResponseMetadataHandoff.fixture.js'
import { assertNoForbiddenPersistenceSubstrings } from './fixtures/providerInvokeDiagnosticsAllowlist.js'

const FIXED_COMPLETED_AT = '2026-10-21T08:30:00.000Z'
const PLAN_REVISION_ID = 'plan-empty-response-accept-001'
const REPORTED_COST_USD = EMPTY_RESPONSE_HANDOFF_USAGE_META.estimated_cost_usd

function writeContext(handle: { mission_id: string; writer_generation: number }): MissionWriteContext {
  return {
    mission_id: handle.mission_id,
    plan_revision_id: PLAN_REVISION_ID,
    writer_generation: handle.writer_generation,
  }
}

async function admitMissionWithPlan(store: DurableResearchStore) {
  const handle = await store.appendMission(exampleTechnicalMissionFixture)
  const ctx = writeContext(handle)
  const plan = {
    ...examplePlanRevisionFixture,
    plan_revision_id: PLAN_REVISION_ID,
    mission_id: handle.mission_id,
    created_at: '2026-10-21T08:28:00.000Z',
    revision_reason: 'empty_response_acceptance_fixture',
  }
  await store.appendPlanRevision(ctx, plan)
  return { handle, ctx }
}

type CompletionPayload = {
  completion: {
    operation_id: string
    attempt_id: string
    settlement: string
    failure_category?: string
    usage_settlement?: {
      input_tokens?: number
      output_tokens?: number
      reasoning_tokens?: number
      cost: { status: string; amount_usd?: number }
    }
    provider_invoke_diagnostics?: unknown
  }
}

function completionsForOp(events: readonly { kind: string; payload: Record<string, unknown> }[], opId: string) {
  return events.filter((e) => {
    if (e.kind !== 'external_operation_completed') return false
    const completion = (e.payload as CompletionPayload).completion
    return completion.operation_id === opId
  })
}

describe('empty-response metadata durable settlement (A repair acceptance)', () => {
  it('close/reopen retains usage, cost, and bounded diagnostics exactly once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-empty-response-meta-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const { handle, ctx } = await admitMissionWithPlan(store)
      const operationId = 'model-empty-response-accept'
      const attemptId = 'model-empty-response-accept-att'
      await store.appendExternalOperationIntent(ctx, {
        mission_id: handle.mission_id,
        operation_id: operationId,
        attempt_id: attemptId,
        operation_kind: 'model_invoke',
        dispatched_at: '2026-10-21T08:29:00.000Z',
        idempotency_key: `${operationId}:${attemptId}`,
      })
      const bridge = new ProviderResearchModelBridge(
        productionShapedEmptyResponseBridgeOptions(emptyResponseHandoffRunner()),
      )
      const modelResult = await bridge.invokeStructured({
        operationId,
        attemptId,
        kind: 'plan_questions',
        input: { mission_id: handle.mission_id },
        signal: new AbortController().signal,
      })
      await settleModelOperation(
        store,
        ctx,
        handle.mission_id,
        operationId,
        attemptId,
        modelResult,
        FIXED_COMPLETED_AT,
      )
      await store.close()

      const reopened = await DurableResearchStore.open(dir)
      const eventsAfterReopen = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      const completed = completionsForOp(eventsAfterReopen, operationId)
      assert.equal(completed.length, 1, 'expected exactly one external_operation_completed for the invoke')
      const completion = (completed[0]!.payload as CompletionPayload).completion
      assert.equal(completion.settlement, 'failed')
      assert.equal(completion.failure_category, 'provider_invoke_failed')
      assert.equal(completion.usage_settlement?.input_tokens, 652)
      assert.equal(completion.usage_settlement?.output_tokens, 32_000)
      assert.equal(
        completion.usage_settlement?.reasoning_tokens,
        EMPTY_RESPONSE_HANDOFF_USAGE_META.actual_reasoning_tokens,
      )
      assert.equal(completion.usage_settlement?.cost.status, 'reported')
      assert.equal(completion.usage_settlement?.cost.amount_usd, REPORTED_COST_USD)
      ProviderInvokeDiagnosticsSchema.parse(completion.provider_invoke_diagnostics)
      assert.equal(
        (completion.provider_invoke_diagnostics as { visible_content_present?: boolean })
          .visible_content_present,
        false,
      )
      assertNoForbiddenPersistenceSubstrings(
        JSON.stringify(eventsAfterReopen),
        EMPTY_RESPONSE_HANDOFF_FORBIDDEN_STORE_SUBSTRINGS,
      )
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('interleaved invokes on one shared bridge keep isolated durable completion metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-empty-response-meta-isolate-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const { handle, ctx } = await admitMissionWithPlan(store)
      const specs = [
        {
          operationId: 'model-empty-a',
          attemptId: 'model-empty-a-att',
          providerRequestId: 'req-store-a',
          inferenceId: 'inf-store-a',
        },
        {
          operationId: 'model-empty-b',
          attemptId: 'model-empty-b-att',
          providerRequestId: 'req-store-b',
          inferenceId: 'inf-store-b',
        },
      ]
      for (const spec of specs) {
        await store.appendExternalOperationIntent(ctx, {
          mission_id: handle.mission_id,
          operation_id: spec.operationId,
          attempt_id: spec.attemptId,
          operation_kind: 'model_invoke',
          dispatched_at: '2026-10-21T08:29:30.000Z',
          idempotency_key: `${spec.operationId}:${spec.attemptId}`,
        })
      }

      const turnOrder: Array<() => void> = []
      const awaitTurn = (index: number) =>
        new Promise<void>((resolve) => {
          turnOrder[index] = resolve
        })
      const bridge = new ProviderResearchModelBridge(
        productionShapedEmptyResponseBridgeOptions(
          interleavedEmptyResponseHandoffRunner(
            specs.map((spec, index) => ({
              inferenceId: spec.inferenceId,
              providerRequestId: spec.providerRequestId,
              awaitTurn: () => awaitTurn(index),
            })),
          ),
        ),
      )

      const pending = specs.map((spec) =>
        bridge.invokeStructured({
          operationId: spec.operationId,
          attemptId: spec.attemptId,
          kind: 'plan_questions',
          input: { mission_id: handle.mission_id },
          signal: new AbortController().signal,
        }),
      )
      turnOrder[1]?.()
      turnOrder[0]?.()
      const modelResults = await Promise.all(pending)
      for (let i = 0; i < specs.length; i += 1) {
        const spec = specs[i]!
        await settleModelOperation(
          store,
          ctx,
          handle.mission_id,
          spec.operationId,
          spec.attemptId,
          modelResults[i]!,
          FIXED_COMPLETED_AT,
        )
      }
      const events = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
      for (const spec of specs) {
        const completed = completionsForOp(events, spec.operationId)
        assert.equal(completed.length, 1)
        const diagnostics = ProviderInvokeDiagnosticsSchema.parse(
          (completed[0]!.payload as CompletionPayload).completion.provider_invoke_diagnostics,
        )
        assert.equal(diagnostics.provider_request_id, spec.providerRequestId)
        assert.equal(diagnostics.inference_id, spec.inferenceId)
        const usage = (completed[0]!.payload as CompletionPayload).completion.usage_settlement
        assert.equal(usage?.cost.status, 'reported')
        assert.equal(usage?.cost.amount_usd, REPORTED_COST_USD)
      }
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
