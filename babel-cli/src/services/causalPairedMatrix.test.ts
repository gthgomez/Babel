/**
 * Slice 6: provider-free paired Stage 1 arm matrix.
 *
 * Proves measurement substrate wiring only; not live causal claims.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CAUSAL_SCORER_VERSION,
  CAUSAL_STAGE1_ARMS,
  makePairId,
} from './causalCampaignContract.js';
import {
  computeResourceParityView,
  DEFAULT_MAX_RESPONSES,
  DEFAULT_MAX_TURNS,
  DEFAULT_OBSERVED_MODEL_ID,
  DEFAULT_SIMULATED_COST_USD,
  PAIRED_MATRIX_FIXED_ARM_ORDER,
  PAIRED_MATRIX_KIND,
  runProviderFreePairedMatrix,
  type PairedMatrixReport,
} from './causalPairedMatrix.js';

function assertIntegerCounts(report: PairedMatrixReport): void {
  const c = report.paired_counts;
  for (const [key, value] of Object.entries(c)) {
    assert.equal(typeof value, 'number', key);
    assert.ok(Number.isInteger(value), `${key}=${value} must be integer`);
    assert.ok(value >= 0, `${key}=${value} must be non-negative`);
  }
  // No lone generalized rate field on the report root
  assert.equal(
    'suppression_rate' in report || 'harness_suppression_rate' in report,
    false,
  );
}

describe('runProviderFreePairedMatrix', () => {
  test('matrix produces 3 Stage 1 arms per block', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_matrix'],
      replicates: 1,
      injectSuppressionOnEnforce: false,
    });

    assert.equal(report.schema_version, 1);
    assert.equal(report.kind, PAIRED_MATRIX_KIND);
    assert.equal(report.scorer_version, CAUSAL_SCORER_VERSION);
    assert.equal(report.mode, 'chat-headless');
    assert.equal(report.substrate, 'provider_free_fixtures');
    assert.equal(report.blocks.length, 1);

    const block = report.blocks[0]!;
    assert.equal(block.task_id, 't_matrix');
    assert.equal(block.replicate_id, 0);
    assert.equal(block.pair_id, makePairId('t_matrix', 0));
    assert.equal(block.arm_order.length, 3);
    assert.deepEqual(
      [...block.arm_order].sort(),
      [...CAUSAL_STAGE1_ARMS].sort(),
    );

    for (const arm of CAUSAL_STAGE1_ARMS) {
      assert.ok(block.arms[arm], `missing arm ${arm}`);
      assert.equal(typeof block.arms[arm]!.oracle_pass, 'boolean');
      assert.equal(typeof block.arms[arm]!.non_pass, 'boolean');
      assert.equal(block.arms[arm]!.non_pass, !block.arms[arm]!.oracle_pass);
      assert.equal(typeof block.arms[arm]!.simulated_cost_usd, 'number');
      assert.ok('observed_model_id' in block.arms[arm]!);
    }

    // Fixed order default: control → shadow → enforce
    assert.deepEqual(block.arm_order, [...PAIRED_MATRIX_FIXED_ARM_ORDER]);
  });

  test('harness_suppressed detected when inject on', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_suppress'],
      replicates: 1,
      injectSuppressionOnEnforce: true,
    });

    assert.equal(report.blocks.length, 1);
    const block = report.blocks[0]!;
    assert.equal(block.arms['babel_prompt_control']!.oracle_pass, true);
    assert.equal(block.arms['babel_shadow']!.oracle_pass, true);
    assert.equal(block.arms['babel_enforce']!.oracle_pass, false);
    assert.equal(block.arms['babel_enforce']!.non_pass, true);
    assert.equal(block.harness_suppressed, true);
    assert.equal(report.paired_counts.harness_suppressed, 1);
  });

  test('harness_suppressed false when inject off and all arms known-good', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_clean'],
      injectSuppressionOnEnforce: false,
    });
    const block = report.blocks[0]!;
    assert.equal(block.arms['babel_enforce']!.oracle_pass, true);
    assert.equal(block.harness_suppressed, false);
    assert.equal(report.paired_counts.harness_suppressed, 0);
  });

  test('inject suppression only on first block when multiple tasks', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_a', 't_b'],
      replicates: 1,
      injectSuppressionOnEnforce: true,
    });
    assert.equal(report.blocks.length, 2);
    assert.equal(report.blocks[0]!.harness_suppressed, true);
    assert.equal(report.blocks[1]!.harness_suppressed, false);
    assert.equal(report.paired_counts.harness_suppressed, 1);
  });

  test('model parity fail excludes from estimate', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_mismatch'],
      injectSuppressionOnEnforce: false,
      injectModelMismatch: true,
    });

    const block = report.blocks[0]!;
    assert.equal(block.model_parity_ok, false);
    assert.equal(block.included_in_paired_causal_estimate, false);
    assert.notEqual(
      block.arms['babel_enforce']!.observed_model_id,
      block.arms['babel_prompt_control']!.observed_model_id,
    );
    assert.equal(report.paired_counts.model_mismatch, 1);
    assert.equal(report.paired_counts.included_in_estimate, 0);
  });

  test('model parity ok includes block in estimate', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_parity_ok'],
      injectSuppressionOnEnforce: false,
      injectModelMismatch: false,
    });
    const block = report.blocks[0]!;
    assert.equal(block.model_parity_ok, true);
    assert.equal(block.included_in_paired_causal_estimate, true);
    for (const arm of CAUSAL_STAGE1_ARMS) {
      assert.equal(block.arms[arm]!.observed_model_id, DEFAULT_OBSERVED_MODEL_ID);
    }
    assert.equal(report.paired_counts.model_mismatch, 0);
    assert.equal(report.paired_counts.included_in_estimate, 1);
  });

  test('armModelOverrides can force model_parity_ok false', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_override'],
      injectSuppressionOnEnforce: false,
      armModelOverrides: {
        babel_shadow: { observed_model_id: 'other-model-x' },
      },
    });
    const block = report.blocks[0]!;
    assert.equal(block.model_parity_ok, false);
    assert.equal(block.included_in_paired_causal_estimate, false);
  });

  test('resource parity fields present and spend_parity_ok by default', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_resource'],
      maxTurns: 16,
      maxResponses: 8,
      injectSuppressionOnEnforce: false,
    });
    const block = report.blocks[0]!;
    const rp = block.resource_parity;

    assert.ok(rp);
    assert.equal(typeof rp.spend_parity_ok, 'boolean');
    assert.equal(typeof rp.response_allowance_identical, 'boolean');
    assert.equal(rp.spend_parity_ok, true);
    assert.equal(rp.response_allowance_identical, true);
    assert.equal(rp.equal_model_response_allowance.max_turns, 16);
    assert.equal(rp.equal_model_response_allowance.max_responses, 8);

    for (const arm of CAUSAL_STAGE1_ARMS) {
      assert.equal(rp.equal_total_spend_usd[arm], DEFAULT_SIMULATED_COST_USD);
      assert.equal(block.arms[arm]!.simulated_cost_usd, DEFAULT_SIMULATED_COST_USD);
    }

    // Defaults when maxTurns/maxResponses omitted
    const defaults = runProviderFreePairedMatrix({
      taskIds: ['t_defaults'],
      injectSuppressionOnEnforce: false,
    });
    assert.equal(
      defaults.blocks[0]!.resource_parity.equal_model_response_allowance.max_turns,
      DEFAULT_MAX_TURNS,
    );
    assert.equal(
      defaults.blocks[0]!.resource_parity.equal_model_response_allowance.max_responses,
      DEFAULT_MAX_RESPONSES,
    );
  });

  test('unequal simulated costs mark spend_parity_ok false', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_spend_skew'],
      injectSuppressionOnEnforce: false,
      armModelOverrides: {
        babel_enforce: { simulated_cost_usd: 0.05 },
      },
    });
    const rp = report.blocks[0]!.resource_parity;
    assert.equal(rp.spend_parity_ok, false);
    assert.equal(rp.equal_total_spend_usd['babel_enforce'], 0.05);
  });

  test('paired_counts are integers not a lone rate', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t1', 't2'],
      replicates: 2,
      injectSuppressionOnEnforce: true,
      injectHonestyCatch: true,
      injectModelMismatch: true,
    });

    // 2 tasks × 2 replicates = 4 primary + 1 honesty = 5
    assert.equal(report.paired_counts.total_blocks, 5);
    assertIntegerCounts(report);

    assert.equal(typeof report.paired_counts.harness_suppressed, 'number');
    assert.equal(typeof report.paired_counts.honesty_catch, 'number');
    assert.equal(typeof report.paired_counts.model_mismatch, 'number');
    assert.equal(typeof report.paired_counts.included_in_estimate, 'number');

    // First primary block: suppression + mismatch
    assert.ok(report.paired_counts.harness_suppressed >= 1);
    assert.ok(report.paired_counts.honesty_catch >= 1);
    assert.ok(report.paired_counts.model_mismatch >= 1);

    // Counts must reconcile with block flags
    assert.equal(
      report.paired_counts.harness_suppressed,
      report.blocks.filter((b) => b.harness_suppressed).length,
    );
    assert.equal(
      report.paired_counts.honesty_catch,
      report.blocks.filter((b) => b.honesty_catch).length,
    );
    assert.equal(
      report.paired_counts.model_mismatch,
      report.blocks.filter((b) => !b.model_parity_ok).length,
    );
    assert.equal(
      report.paired_counts.included_in_estimate,
      report.blocks.filter((b) => b.included_in_paired_causal_estimate).length,
    );
  });

  test('honesty catch block wires honesty_catch true', () => {
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_primary'],
      injectSuppressionOnEnforce: false,
      injectHonestyCatch: true,
    });
    assert.equal(report.blocks.length, 2);
    const honesty = report.blocks.find((b) => b.task_id === 'fixture_paired_honesty');
    assert.ok(honesty);
    assert.equal(honesty!.honesty_catch, true);
    assert.equal(honesty!.arms['babel_prompt_control']!.oracle_pass, false);
    assert.equal(report.paired_counts.honesty_catch, 1);
  });

  test('shuffleArmOrder produces deterministic permutation for seed', () => {
    const a = runProviderFreePairedMatrix({
      taskIds: ['t_shuffle'],
      shuffleArmOrder: true,
      seed: 42,
      injectSuppressionOnEnforce: false,
    });
    const b = runProviderFreePairedMatrix({
      taskIds: ['t_shuffle'],
      shuffleArmOrder: true,
      seed: 42,
      injectSuppressionOnEnforce: false,
    });
    assert.deepEqual(a.blocks[0]!.arm_order, b.blocks[0]!.arm_order);
    // Still contains all three arms
    assert.deepEqual(
      [...a.blocks[0]!.arm_order].sort(),
      [...CAUSAL_STAGE1_ARMS].sort(),
    );

    const c = runProviderFreePairedMatrix({
      taskIds: ['t_shuffle'],
      shuffleArmOrder: true,
      seed: 99,
      injectSuppressionOnEnforce: false,
    });
    // Different seed may differ (not guaranteed for all seeds, but 42 vs 99 should)
    // At minimum both remain valid 3-arm permutations
    assert.equal(c.blocks[0]!.arm_order.length, 3);
  });

  test('writes paired-matrix-report.json when evidenceDir set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'causal-paired-'));
    const report = runProviderFreePairedMatrix({
      taskIds: ['t_write'],
      injectSuppressionOnEnforce: false,
      evidenceDir: dir,
    });
    const path = join(dir, 'paired-matrix-report.json');
    assert.equal(existsSync(path), true);
    const loaded = JSON.parse(readFileSync(path, 'utf8')) as PairedMatrixReport;
    assert.equal(loaded.kind, PAIRED_MATRIX_KIND);
    assert.equal(loaded.blocks.length, report.blocks.length);
    assert.equal(loaded.paired_counts.total_blocks, report.paired_counts.total_blocks);
  });
});

describe('computeResourceParityView', () => {
  test('reports spend_parity_ok when costs match', () => {
    const view = computeResourceParityView(
      {
        babel_prompt_control: { simulated_cost_usd: 0.01 },
        babel_shadow: { simulated_cost_usd: 0.01 },
        babel_enforce: { simulated_cost_usd: 0.01 },
      },
      { max_turns: 10, max_responses: 10 },
    );
    assert.equal(view.spend_parity_ok, true);
    assert.equal(view.response_allowance_identical, true);
  });

  test('reports spend_parity_ok false when costs diverge', () => {
    const view = computeResourceParityView(
      {
        babel_prompt_control: { simulated_cost_usd: 0.01 },
        babel_enforce: { simulated_cost_usd: 0.02 },
      },
      { max_turns: 4, max_responses: 4 },
    );
    assert.equal(view.spend_parity_ok, false);
  });
});
