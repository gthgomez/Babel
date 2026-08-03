/**
 * Slice 2: effort / cost aggregation for turn routing receipts.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  deriveEffortAliased,
  mapCostPrecisionToBasis,
  resolveEffectiveEffortSource,
  summarizeCellCost,
  summarizeCellEffort,
  TurnRoutingReceiptLog,
  type TurnRoutingReceipt,
} from './turnRoutingReceipt.js';

function receipt(partial: Partial<TurnRoutingReceipt> & Pick<TurnRoutingReceipt, 'turn' | 'model'>): TurnRoutingReceipt {
  return {
    phase: 'mutate',
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.01,
    ...partial,
  };
}

describe('deriveEffortAliased', () => {
  test('medium requested vs high sent is aliased', () => {
    assert.equal(deriveEffortAliased('medium', 'high'), true);
  });

  test('same requested and sent is not aliased', () => {
    assert.equal(deriveEffortAliased('high', 'high'), false);
  });

  test('falls back to normalized when sent missing', () => {
    assert.equal(deriveEffortAliased('medium', null, 'high'), true);
    assert.equal(deriveEffortAliased('high', null, 'high'), false);
  });
});

describe('resolveEffectiveEffortSource', () => {
  test('prefers observed → sent → normalized → requested', () => {
    assert.deepEqual(
      resolveEffectiveEffortSource({
        requested: 'medium',
        normalized: 'high',
        sent: 'high',
        observed: 'high',
      }),
      { source: 'observed', value: 'high' },
    );
    assert.deepEqual(
      resolveEffectiveEffortSource({
        requested: 'medium',
        normalized: 'high',
        sent: 'high',
        observed: null,
      }),
      { source: 'sent', value: 'high' },
    );
    assert.deepEqual(
      resolveEffectiveEffortSource({
        requested: 'low',
        normalized: 'low',
        sent: null,
        observed: null,
      }),
      { source: 'normalized', value: 'low' },
    );
    assert.deepEqual(
      resolveEffectiveEffortSource({ requested: 'max' }),
      { source: 'requested', value: 'max' },
    );
    assert.deepEqual(resolveEffectiveEffortSource({}), { source: 'unknown', value: null });
  });
});

describe('mapCostPrecisionToBasis', () => {
  test('maps precision labels without claiming invoice by default', () => {
    assert.equal(mapCostPrecisionToBasis('exact'), 'provider_usage_x_pinned_rate');
    assert.equal(mapCostPrecisionToBasis('conservative'), 'provider_usage_x_pinned_rate');
    assert.equal(mapCostPrecisionToBasis('invoice'), 'provider_billed');
    assert.equal(mapCostPrecisionToBasis(null), 'unknown');
  });
});

describe('summarizeCellEffort', () => {
  test('uses last turn with effort fields and ORs effort_aliased', () => {
    const receipts: TurnRoutingReceipt[] = [
      receipt({
        turn: 0,
        model: 'deepseek-v4-flash',
        requested_reasoning_effort: 'medium',
        sent_reasoning_effort: 'high',
        effort_aliased: true,
        effective_source: 'sent',
      }),
      receipt({
        turn: 1,
        model: 'deepseek-v4-flash',
        requested_reasoning_effort: 'high',
        sent_reasoning_effort: 'high',
        observed_reasoning_effort: 'high',
        effort_aliased: false,
        effective_source: 'observed',
      }),
    ];
    const s = summarizeCellEffort(receipts);
    assert.equal(s.turns_with_effort, 2);
    assert.equal(s.effort_aliased, true);
    assert.equal(s.requested_reasoning_effort, 'high');
    assert.equal(s.sent_reasoning_effort, 'high');
    assert.equal(s.observed_reasoning_effort, 'high');
    assert.equal(s.effective_source, 'observed');
    assert.equal(s.effective_reasoning_effort, 'high');
  });
});

describe('summarizeCellCost', () => {
  test('sums tokens and cost; marks reconciled', () => {
    const receipts: TurnRoutingReceipt[] = [
      receipt({
        turn: 0,
        model: 'm',
        cost_usd: 0.02,
        input_tokens: 100,
        output_tokens: 20,
        cache_hit_tokens: 10,
        cost_basis: 'provider_usage_x_pinned_rate',
        pricing_verified_at: '2026-08-02',
      }),
      receipt({
        turn: 1,
        model: 'm',
        cost_usd: 0.03,
        input_tokens: 50,
        output_tokens: 10,
        cost_basis: 'provider_usage_x_pinned_rate',
      }),
    ];
    const s = summarizeCellCost(receipts);
    assert.equal(s.estimated_usd, 0.05);
    assert.equal(s.input_tokens, 150);
    assert.equal(s.output_tokens, 30);
    assert.equal(s.cache_hit_tokens, 10);
    assert.equal(s.turn_count, 2);
    assert.equal(s.reconciled, true);
    assert.equal(s.cost_basis, 'provider_usage_x_pinned_rate');
    assert.equal(s.pricing_verified_at, '2026-08-02');
  });
});

describe('TurnRoutingReceiptLog.summarize', () => {
  test('includes effort rollup fields', () => {
    const log = new TurnRoutingReceiptLog();
    log.push(
      receipt({
        turn: 0,
        model: 'deepseek-v4-flash',
        cost_usd: 0.1,
        requested_reasoning_effort: 'medium',
        sent_reasoning_effort: 'high',
        effort_aliased: true,
        effective_source: 'sent',
      }),
    );
    log.push(
      receipt({
        turn: 1,
        model: 'deepseek-v4-pro',
        cost_usd: 0.2,
        phase: 'verify',
        requested_reasoning_effort: 'high',
        sent_reasoning_effort: 'high',
        observed_reasoning_effort: 'high',
        effective_source: 'observed',
      }),
    );
    const s = log.summarize();
    assert.ok(s.models_used.includes('deepseek-v4-flash'));
    assert.ok(s.models_used.includes('deepseek-v4-pro'));
    assert.ok(Math.abs(s.total_cost_usd - 0.3) < 1e-9);
    assert.ok(s.pro_cost_share > 0);
    assert.equal(s.effort_aliased_any, true);
    assert.equal(s.last_sent_effort, 'high');
    assert.equal(s.last_observed_effort, 'high');
    assert.equal(s.last_effective_source, 'observed');
  });
});
