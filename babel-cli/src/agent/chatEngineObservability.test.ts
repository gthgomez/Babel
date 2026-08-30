/**
 * Slice 2: routing receipt plumbing + harness boundary counters.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildCellTelemetryBundle,
  computeHarnessBoundaryCounters,
  makeChatRunner,
  pushRoutingReceiptFromMetadata,
} from './chatEngineObservability.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
import { TurnRoutingReceiptLog } from './turnRoutingReceipt.js';

test('GLM backend key creates the exact OpenRouter phase runner', () => {
  const runner = makeChatRunner('glm-5.3-flash');
  assert.ok(runner instanceof OpenRouterApiRunner);
});

test('phase runner uses OpenRouter for the exact GLM live route', () => {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const previousKey = process.env['OPENROUTER_API_KEY'];
  delete process.env['BABEL_OFFLINE'];
  process.env['OPENROUTER_API_KEY'] = 'test-openrouter-key';
  try {
    assert.ok(makeChatRunner('z-ai/glm-5.3-flash') instanceof OpenRouterApiRunner);
  } finally {
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    if (previousKey === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = previousKey;
  }
});

describe('pushRoutingReceiptFromMetadata', () => {
  test('preserves requested/normalized/sent/observed effort (DeepSeek medium→high)', () => {
    const log = new TurnRoutingReceiptLog();
    pushRoutingReceiptFromMetadata(log, 3, 'mutate', {
      provider_model_id: 'deepseek-v4-flash',
      prompt_tokens: 1000,
      completion_tokens: 200,
      estimated_cost_usd: 0.004,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 900,
      cost_precision: 'exact',
      pricing_verified_at: '2026-08-02',
      pricing_source_url: 'https://example.test/pricing',
      requested_model_id: 'deepseek-v4-flash',
      sent_model_id: 'deepseek-v4-flash',
      observed_model_id: 'deepseek-v4-flash',
      requested_reasoning_effort: 'medium',
      normalized_reasoning_effort: 'high',
      sent_reasoning_effort: 'high',
      observed_reasoning_effort: 'high',
    });

    const receipts = log.toJSON();
    assert.equal(receipts.length, 1);
    const r = receipts[0]!;
    assert.equal(r.model, 'deepseek-v4-flash');
    assert.equal(r.turn, 3);
    assert.equal(r.phase, 'mutate');
    assert.equal(r.requested_reasoning_effort, 'medium');
    assert.equal(r.normalized_reasoning_effort, 'high');
    assert.equal(r.sent_reasoning_effort, 'high');
    assert.equal(r.observed_reasoning_effort, 'high');
    assert.equal(r.effort_aliased, true);
    assert.equal(r.effective_source, 'observed');
    assert.equal(r.cost_basis, 'provider_usage_x_pinned_rate');
    assert.equal(r.pricing_verified_at, '2026-08-02');
    assert.equal(r.cache_hit_tokens, 100);
    assert.equal(r.sent_model_id, 'deepseek-v4-flash');
  });

  test('skips incomplete metadata (no silent zero-token receipt)', () => {
    const log = new TurnRoutingReceiptLog();
    pushRoutingReceiptFromMetadata(log, 0, null, {
      provider_model_id: 'x',
      prompt_tokens: null,
      completion_tokens: 1,
    });
    assert.equal(log.toJSON().length, 0);
  });

  test('effort_aliased false when requested equals sent', () => {
    const log = new TurnRoutingReceiptLog();
    pushRoutingReceiptFromMetadata(log, 0, 'investigate', {
      provider_model_id: 'deepseek-v4-flash',
      prompt_tokens: 10,
      completion_tokens: 5,
      estimated_cost_usd: 0,
      requested_reasoning_effort: 'high',
      sent_reasoning_effort: 'high',
      observed_reasoning_effort: 'high',
    });
    assert.equal(log.toJSON()[0]!.effort_aliased, false);
    assert.equal(log.toJSON()[0]!.effective_source, 'observed');
  });
});

describe('computeHarnessBoundaryCounters', () => {
  test('classifies thrash-shaped force_mutate + zero writes', () => {
    const c = computeHarnessBoundaryCounters({
      policyEvents: [
        { at_turn: 2, kind: 'force_mutate_shadow' },
        { at_turn: 4, kind: 'force_mutate_shadow' },
        { at_turn: 6, kind: 'zero_write_shadow' },
        { at_turn: 8, kind: 'budget_kill' },
      ],
      toolCalls: [
        { tool: 'read_file', index: 0 },
        { tool: 'read_file', index: 1 },
        { tool: 'grep', index: 2 },
      ],
    });
    assert.equal(c.force_mutate_shadow_count, 2);
    assert.equal(c.zero_write_shadow_count, 1);
    assert.equal(c.budget_arbitration_count, 1);
    assert.equal(c.successful_write_tool_count, 0);
    assert.equal(c.mutation_intent_count, 0);
  });

  test('counts successful writes and mutation intents', () => {
    const c = computeHarnessBoundaryCounters({
      policyEvents: [{ at_turn: 1, kind: 'mutation_intent' }],
      toolCalls: [
        { tool: 'str_replace', index: 0 },
        { tool: 'str_replace', error: 'not found', index: 1 },
        { tool: 'run_tests', exit_code: 1, index: 2 },
      ],
      logIndexToTurn: new Map([
        [0, 1],
        [1, 2],
        [2, 3],
      ]),
    });
    assert.equal(c.successful_write_tool_count, 1);
    assert.equal(c.denied_or_failed_write_tool_count, 1);
    assert.equal(c.verifier_attempt_tool_count, 1);
    assert.equal(c.turns_to_first_applied_write, 1);
    assert.ok(c.mutation_intent_count >= 1);
  });

  test('uses tool.turn for turns_to_first_applied_write when present', () => {
    const c = computeHarnessBoundaryCounters({
      toolCalls: [
        { tool: 'read_file', turn: 0, index: 0 },
        { tool: 'str_replace', turn: 4, index: 1 },
        { tool: 'write_file', turn: 7, index: 2 },
      ],
    });
    assert.equal(c.successful_write_tool_count, 2);
    assert.equal(c.turns_to_first_applied_write, 4);
  });
});

describe('exportToolCallsWithTurns', () => {
  test('binds turn from logIndexToTurn', async () => {
    const { exportToolCallsWithTurns } = await import('./chatEngineObservability.js');
    const out = exportToolCallsWithTurns(
      [
        { tool: 'write_file', target: 'a.ts', index: 0 },
        { tool: 'read_file', target: 'b.ts', index: 1 },
      ],
      new Map([
        [0, 2],
        [1, 3],
      ]),
    );
    assert.equal(out[0]!.turn, 2);
    assert.equal(out[0]!.index, 0);
    assert.equal(out[1]!.turn, 3);
  });
});

describe('buildCellTelemetryBundle', () => {
  test('combines effort, cost, and boundary', () => {
    const log = new TurnRoutingReceiptLog();
    pushRoutingReceiptFromMetadata(log, 0, 'mutate', {
      provider_model_id: 'deepseek-v4-flash',
      prompt_tokens: 100,
      completion_tokens: 50,
      estimated_cost_usd: 0.01,
      cost_precision: 'exact',
      requested_reasoning_effort: 'medium',
      sent_reasoning_effort: 'high',
      observed_reasoning_effort: 'high',
    });
    const bundle = buildCellTelemetryBundle({
      turnRouting: log.toJSON(),
      policyEvents: [{ at_turn: 0, kind: 'force_mutate' }],
      toolCalls: [{ tool: 'write_file' }],
    });
    assert.equal(bundle.effort.effort_aliased, true);
    assert.equal(bundle.effort.effective_source, 'observed');
    assert.equal(bundle.cost.estimated_usd, 0.01);
    assert.equal(bundle.cost.reconciled, true);
    assert.equal(bundle.boundary.force_mutate_count, 1);
    assert.equal(bundle.boundary.successful_write_tool_count, 1);
  });
});
