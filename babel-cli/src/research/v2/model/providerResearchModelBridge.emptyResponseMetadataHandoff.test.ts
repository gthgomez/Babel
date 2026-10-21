import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ZodType } from 'zod'
import {
  buildStructuredOutputError,
  type LlmRunner,
  type RunnerCallbacks,
  type RunnerInvocationMetadata,
} from '../../../runners/base.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { settleModelOperation } from '../engine/settleModelOperation.js'
import { EMPTY_VISIBLE_OUTPUT_DIGEST } from './providerInvokeDiagnosticsFromCompletion.js'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'

const EMPTY_HOOK_META: RunnerInvocationMetadata = {
  provider: 'openrouter',
  provider_model_id: 'deepseek/deepseek-v4-flash-0731',
  observed_model_id: 'deepseek/deepseek-v4-flash-0731',
  latency_ms: 120_000,
  prompt_tokens: 652,
  completion_tokens: 32_000,
  total_tokens: 32_652,
  actual_reasoning_tokens: 31_500,
  normalized_finish_reason: 'OUTPUT_BUDGET_EXHAUSTED',
  requested_output_budget: 32_000,
  effective_output_budget: 32_000,
  estimated_cost_usd: 0.004328364,
  cost_precision: 'exact',
}

function emptyDeliveredRunner(): Pick<LlmRunner, 'execute'> {
  return {
    async execute<T>(_prompt: string, _schema: ZodType<T>, callbacks?: RunnerCallbacks): Promise<T> {
      callbacks?.onInvocationCompleted?.({
        inference_id: 'inf-empty-handoff',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        status: 'delivered',
        usage_metadata: EMPTY_HOOK_META,
        observed_model_id: 'deepseek/deepseek-v4-flash-0731',
        output_digest: EMPTY_VISIBLE_OUTPUT_DIGEST,
        normalized_finish_reason: 'OUTPUT_BUDGET_EXHAUSTED',
        provider_request_id: 'req-handoff-fixture',
        requested_output_budget: 32_000,
        effective_output_budget: 32_000,
      })
      throw buildStructuredOutputError({
        failure_kind: 'empty_response',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        message: '[deepInfraApi] Empty response from model "deepseek/deepseek-v4-flash-0731".',
        raw_output: '',
      })
    },
  }
}

describe('ProviderResearchModelBridge empty-response metadata handoff', () => {
  it('fails on empty visible content with provider_invoke_failed', async () => {
    const bridge = new ProviderResearchModelBridge({
      runner: emptyDeliveredRunner(),
      backendKey: 'deepseek-v4-flash-openrouter',
      provider: 'openrouter',
      providerModelId: 'deepseek/deepseek-v4-flash-0731',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-empty',
      attemptId: 'att-empty',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.match(result.message, /Empty response/i)
  })

  it('retains request-local finish reason, token split, budgets, and request id from the completion hook', async () => {
    const bridge = new ProviderResearchModelBridge({
      runner: emptyDeliveredRunner(),
      backendKey: 'deepseek-v4-flash-openrouter',
      provider: 'openrouter',
      providerModelId: 'deepseek/deepseek-v4-flash-0731',
    })
    const result = await bridge.invokeStructured({
      operationId: 'op-empty-2',
      attemptId: 'att-empty-2',
      kind: 'plan_questions',
      input: { mission_id: 'mission-fixture' },
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(result.usageSettlement.output_tokens, 32_000)
    assert.equal(result.usageSettlement.input_tokens, 652)
    assert.equal(result.usageSettlement.reasoning_tokens, 31_500)
    assert.ok(result.providerInvokeDiagnostics)
    assert.equal(result.providerInvokeDiagnostics.inference_id, 'inf-empty-handoff')
    assert.equal(result.providerInvokeDiagnostics.normalized_finish_reason, 'OUTPUT_BUDGET_EXHAUSTED')
    assert.equal(result.providerInvokeDiagnostics.visible_content_present, false)
    assert.equal(result.providerInvokeDiagnostics.visible_content_byte_length, 0)
    assert.equal(result.providerInvokeDiagnostics.output_digest, EMPTY_VISIBLE_OUTPUT_DIGEST)
    assert.equal(result.providerInvokeDiagnostics.provider_request_id, 'req-handoff-fixture')
    assert.equal(result.providerInvokeDiagnostics.requested_output_budget, 32_000)
    assert.equal(result.providerInvokeDiagnostics.effective_output_budget, 32_000)
  })

  it('persists diagnostics and usage exactly once on external_operation_completed after snapshot reopen', async () => {
    const store = new InMemoryResearchStore()
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const planRevisionId = 'plan-empty-meta'
      await store.appendPlanRevision(
        {
          mission_id: handle.mission_id,
          plan_revision_id: planRevisionId,
          writer_generation: handle.writer_generation,
        },
        { ...examplePlanRevisionFixture, mission_id: handle.mission_id, plan_revision_id: planRevisionId },
      )
      const ctx = {
        mission_id: handle.mission_id,
        plan_revision_id: planRevisionId,
        writer_generation: handle.writer_generation,
      }
      const bridge = new ProviderResearchModelBridge({
        runner: emptyDeliveredRunner(),
        backendKey: 'deepseek-v4-flash-openrouter',
        provider: 'openrouter',
        providerModelId: 'deepseek/deepseek-v4-flash-0731',
      })
      const result = await bridge.invokeStructured({
        operationId: 'op-empty-store',
        attemptId: 'att-empty-store',
        kind: 'plan_questions',
        input: { mission_id: exampleTechnicalMissionFixture.mission_id },
        signal: new AbortController().signal,
      })
      assert.equal(result.status, 'failed')
      await store.appendExternalOperationIntent(ctx, {
        mission_id: handle.mission_id,
        operation_id: 'op-empty-store',
        attempt_id: 'att-empty-store',
        operation_kind: 'model_invoke',
        dispatched_at: '2026-10-21T08:19:59.000Z',
        idempotency_key: 'op-empty-store',
      })
      await settleModelOperation(
        store,
        ctx,
        handle.mission_id,
        'op-empty-store',
        'att-empty-store',
        result,
        '2026-10-21T08:20:00.000Z',
      )
      const reopened = InMemoryResearchStore.restoreSnapshot(store.exportSnapshot())
      const events = await reopened.listEvents(handle.mission_id)
      const completions = events.filter((e) => e.kind === 'external_operation_completed')
      assert.equal(completions.length, 1)
      const completion = (completions[0]!.payload as { completion: Record<string, unknown> }).completion
      assert.equal(completion.operation_id, 'op-empty-store')
      const usage = completion.usage_settlement as {
        input_tokens?: number
        output_tokens?: number
        reasoning_tokens?: number
      }
      assert.equal(usage.input_tokens, 652)
      assert.equal(usage.output_tokens, 32_000)
      assert.equal(usage.reasoning_tokens, 31_500)
      const diagnostics = completion.provider_invoke_diagnostics as {
        normalized_finish_reason?: string
        provider_request_id?: string
      }
      assert.equal(diagnostics.normalized_finish_reason, 'OUTPUT_BUDGET_EXHAUSTED')
      assert.equal(diagnostics.provider_request_id, 'req-handoff-fixture')
  })
})
