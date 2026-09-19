/**
 * T20 — input-validity hardening for the H7 evaluator (R11 / A20a).
 *
 * These tests drive the real `agent/harnessEval.ts` exports. `legacyPairedDeltas`
 * is the pre-repair behavior used only as a control to demonstrate the defect;
 * every acceptance assertion is against the shipped exports.
 */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computePairedDeltas,
  evaluatePairedComparison,
  environmentDigest,
  type EvalTaskResult,
  type FixedEvalControls,
  type PairedMetric,
} from './harnessEval.js';

function attempt(
  overrides: Partial<EvalTaskResult> & { task_id: string; variant: string },
): EvalTaskResult {
  return {
    verified_complete_no_policy_violation: true,
    tokens: 100,
    duration_ms: 1000,
    false_completion: false,
    instruction_policy_violation: false,
    resume_state_equivalent: null,
    critical_fact_retention: null,
    infrastructure_failure: false,
    agent_failure: false,
    human_intervention: false,
    clean_room_pass: null,
    ...overrides,
  };
}

const controls: FixedEvalControls = {
  task_set_id: 't20-input-validity',
  model_snapshot: 'deepseek-chat@fixed',
  sampling: { temperature: 0 },
  repository_revision: 'rev-t20',
  permissions_profile: 'safe_repo',
  verifier_profile: 'general_swe',
  resource_profile: 'default',
  environment_digest: environmentDigest({ os: 'linux' }),
};

interface LegacyDelta {
  task_id: string;
  delta: number;
  uncertainty: number;
  n_pairs: number;
  baseline_value: number;
  candidate_value: number;
}

/**
 * CONTROL ONLY — the exact pre-repair algorithm (Number(metric ?? 0),
 * Array.find, skip-unmatched, uncertainty 0 for a single pair). Used to show
 * the defect that the candidate export now rejects.
 */
function legacyPairedDeltas(
  baseline: readonly EvalTaskResult[],
  candidate: readonly EvalTaskResult[],
  metric: PairedMetric,
): LegacyDelta[] {
  const deltas: LegacyDelta[] = [];
  for (const taskId of [...new Set(baseline.map((r) => r.task_id))]) {
    const pairs = baseline
      .filter((r) => r.task_id === taskId)
      .flatMap((base) => {
        const found = candidate.find(
          (r) => r.task_id === taskId && r.trial_index === base.trial_index,
        );
        return found ? [{ base, candidate: found }] : [];
      });
    if (pairs.length === 0) continue;
    const baselineValues = pairs.map(({ base }) => Number(base[metric] ?? 0));
    const candidateValues = pairs.map(({ candidate: found }) => Number(found[metric] ?? 0));
    const paired = pairs.map(
      ({ base, candidate: found }) => Number(found[metric] ?? 0) - Number(base[metric] ?? 0),
    );
    const mean = paired.reduce((sum, value) => sum + value, 0) / paired.length;
    const variance =
      paired.length > 1
        ? paired.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (paired.length - 1)
        : 0;
    deltas.push({
      task_id: taskId,
      delta: mean,
      uncertainty: paired.length > 1 ? Math.sqrt(variance / paired.length) : 0,
      n_pairs: pairs.length,
      baseline_value: baselineValues.reduce((sum, value) => sum + value, 0) / pairs.length,
      candidate_value: candidateValues.reduce((sum, value) => sum + value, 0) / pairs.length,
    });
  }
  return deltas;
}

describe('T20 harnessEval input validity', () => {
  it('missing retention is rejected, never coerced to an observed zero', () => {
    const baseline = [
      attempt({ task_id: 'ret', variant: 'base', critical_fact_retention: null }),
    ];
    const candidate = [
      attempt({ task_id: 'ret', variant: 'cand', critical_fact_retention: 0.5 }),
    ];

    // Control defect: missing retention silently becomes 0.
    const legacy = legacyPairedDeltas(baseline, candidate, 'critical_fact_retention');
    assert.strictEqual(legacy[0]!.baseline_value, 0);

    // Candidate export rejects the comparison and reports the missing metric.
    const deltas = computePairedDeltas(baseline, candidate, 'critical_fact_retention');
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0]!.valid, false);
    assert.strictEqual(deltas[0]!.baseline_value, null);
    assert.strictEqual(deltas[0]!.candidate_value, null);
    assert.strictEqual(deltas[0]!.delta, null);
    assert.strictEqual(deltas[0]!.uncertainty, null);
    assert.ok(deltas[0]!.issues.includes('missing_metric'));
    assert.notStrictEqual(deltas[0]!.delta, 0);
  });

  it('duplicate baseline pair key cannot reuse one candidate', () => {
    const baseline = [
      attempt({ task_id: 'dup', variant: 'base', trial_index: 0, tokens: 100 }),
      attempt({ task_id: 'dup', variant: 'base', trial_index: 0, tokens: 130 }),
    ];
    const candidate = [
      attempt({ task_id: 'dup', variant: 'cand', trial_index: 0, tokens: 50 }),
    ];

    // Control defect: Array.find pairs both baseline rows to the same candidate.
    const legacy = legacyPairedDeltas(baseline, candidate, 'tokens');
    assert.strictEqual(legacy[0]!.n_pairs, 2);

    const report = evaluatePairedComparison(baseline, candidate, 'tokens');
    const delta = report.deltas[0]!;
    assert.strictEqual(delta.valid, false);
    assert.strictEqual(delta.n_pairs, 0);
    assert.ok(
      delta.issues.includes('duplicate_pair_key') ||
        delta.issues.includes('ambiguous_pair_key'),
    );
    assert.strictEqual(report.valid, false);
    assert.ok(report.dropped_samples.length >= 2);
  });

  it('unmatched task is reported as an explicit rejected comparison', () => {
    const baseline = [
      attempt({ task_id: 'a', variant: 'base' }),
      attempt({
        task_id: 'b',
        variant: 'base',
        infrastructure_failure: true,
        agent_failure: false,
      }),
    ];
    const candidate = [attempt({ task_id: 'a', variant: 'cand' })];

    // Control defect: unpaired task b disappears from the output entirely.
    const legacy = legacyPairedDeltas(baseline, candidate, 'tokens');
    assert.strictEqual(legacy.length, 1);

    const report = evaluatePairedComparison(baseline, candidate, 'tokens');
    const b = report.deltas.find((delta) => delta.task_id === 'b');
    assert.ok(b, 'unpaired task must produce an explicit entry');
    assert.strictEqual(b!.valid, false);
    assert.ok(b!.issues.includes('unpaired_baseline'));
    assert.ok(
      report.dropped_samples.some(
        (sample) =>
          sample.task_id === 'b' &&
          sample.arm === 'baseline' &&
          sample.infrastructure_failure,
      ),
    );
    assert.strictEqual(report.coverage_complete, false);
    assert.strictEqual(report.valid, false);
  });

  it('candidate-only task is reported as unpaired', () => {
    const baseline = [attempt({ task_id: 'a', variant: 'base' })];
    const candidate = [
      attempt({ task_id: 'a', variant: 'cand' }),
      attempt({ task_id: 'c-only', variant: 'cand' }),
    ];
    const report = evaluatePairedComparison(baseline, candidate, 'tokens');
    const only = report.deltas.find((delta) => delta.task_id === 'c-only');
    assert.ok(only);
    assert.ok(only!.issues.includes('unpaired_candidate'));
    assert.ok(
      report.dropped_samples.some(
        (sample) => sample.task_id === 'c-only' && sample.arm === 'candidate',
      ),
    );
  });

  it('single trial reports unknown uncertainty, never a false zero', () => {
    const baseline = [attempt({ task_id: 's', variant: 'base', tokens: 100 })];
    const candidate = [attempt({ task_id: 's', variant: 'cand', tokens: 80 })];

    // Control defect: a single pair stores zero numerical uncertainty.
    const legacy = legacyPairedDeltas(baseline, candidate, 'tokens');
    assert.strictEqual(legacy[0]!.uncertainty, 0);

    const delta = computePairedDeltas(baseline, candidate, 'tokens')[0]!;
    assert.strictEqual(delta.valid, true);
    assert.strictEqual(delta.delta, -20);
    assert.strictEqual(delta.uncertainty, null);
    assert.strictEqual(delta.uncertainty_status, 'insufficient_replicates');
    assert.notStrictEqual(delta.uncertainty, 0);
  });

  it('changed controls reject every comparison', () => {
    const baseline = [attempt({ task_id: 'c', variant: 'base' })];
    const candidate = [attempt({ task_id: 'c', variant: 'cand' })];
    const report = evaluatePairedComparison(baseline, candidate, 'tokens', {
      baseline_controls: controls,
      candidate_controls: {
        ...controls,
        model_snapshot: 'other-model@fixed',
        environment_digest: 'different-environment',
      },
    });
    assert.ok(report.global_issues.includes('controls_changed'));
    assert.ok(report.control_deviations.includes('model_snapshot'));
    assert.ok(report.control_deviations.includes('environment_digest'));
    assert.strictEqual(report.deltas[0]!.valid, false);
    assert.strictEqual(report.deltas[0]!.delta, null);
    assert.strictEqual(report.valid, false);
  });

  it('per-row model and environment mismatch is detected', () => {
    const baseline = [
      attempt({
        task_id: 'm',
        variant: 'base',
        model_snapshot: 'model-a',
        environment_digest: 'env-a',
      }),
    ];
    const candidate = [
      attempt({
        task_id: 'm',
        variant: 'cand',
        model_snapshot: 'model-b',
        environment_digest: 'env-b',
      }),
    ];
    const report = evaluatePairedComparison(baseline, candidate, 'tokens');
    assert.ok(report.global_issues.includes('model_mismatch'));
    assert.ok(report.global_issues.includes('environment_mismatch'));
    assert.strictEqual(report.deltas[0]!.valid, false);
  });

  it('expected task and trial coverage gaps are reported', () => {
    const baseline = [attempt({ task_id: 'x', variant: 'base', trial_index: 0 })];
    const candidate = [attempt({ task_id: 'x', variant: 'cand', trial_index: 0 })];
    const report = evaluatePairedComparison(baseline, candidate, 'tokens', {
      expected_task_ids: ['x', 'y'],
      expected_trials_per_task: 2,
    });
    assert.ok(report.global_issues.includes('missing_expected_task'));
    assert.ok(report.global_issues.includes('missing_expected_trial'));
    assert.strictEqual(report.coverage_complete, false);
    assert.strictEqual(report.valid, false);
  });

  it('failed and infrastructure attempts stay in the denominator and cost', () => {
    const baseline = [
      attempt({
        task_id: 'f',
        variant: 'base',
        trial_index: 0,
        verified_complete_no_policy_violation: false,
        infrastructure_failure: true,
        tokens: 42,
      }),
      attempt({ task_id: 'f', variant: 'base', trial_index: 1, tokens: 100 }),
    ];
    const candidate = [
      attempt({
        task_id: 'f',
        variant: 'cand',
        trial_index: 0,
        verified_complete_no_policy_violation: false,
        infrastructure_failure: true,
        tokens: 30,
      }),
      attempt({ task_id: 'f', variant: 'cand', trial_index: 1, tokens: 90 }),
    ];
    const report = evaluatePairedComparison(baseline, candidate, 'tokens');
    assert.strictEqual(report.attempt_outcomes.baseline.attempts, 2);
    assert.strictEqual(report.attempt_outcomes.baseline.infrastructure_failure, 1);
    assert.strictEqual(report.attempt_outcomes.candidate.infrastructure_failure, 1);
    assert.strictEqual(report.intention_to_test_tokens.baseline, 142);
    assert.strictEqual(report.intention_to_test_tokens.candidate, 120);

    const delta = report.deltas[0]!;
    assert.strictEqual(delta.valid, true);
    assert.strictEqual(delta.n_pairs, 2);
    // Both pairs count, including the infra-failed one: (-12 + -10) / 2 = -11.
    assert.strictEqual(delta.delta, -11);
    assert.ok(delta.uncertainty !== null && delta.uncertainty > 0);
  });

  it('valid repeated pairs still produce measured uncertainty', () => {
    const baseline = [0, 1].map((trial) =>
      attempt({ task_id: 'ok', variant: 'base', trial_index: trial, tokens: 100 }),
    );
    const candidate = [
      attempt({ task_id: 'ok', variant: 'cand', trial_index: 0, tokens: 80 }),
      attempt({ task_id: 'ok', variant: 'cand', trial_index: 1, tokens: 60 }),
    ];
    const report = evaluatePairedComparison(baseline, candidate, 'tokens');
    assert.strictEqual(report.valid, true);
    assert.strictEqual(report.coverage_complete, true);
    const delta = report.deltas[0]!;
    assert.strictEqual(delta.valid, true);
    assert.strictEqual(delta.uncertainty_status, 'measured');
    assert.ok(delta.uncertainty !== null && delta.uncertainty > 0);
  });

  it('non-finite metrics are rejected rather than aggregated', () => {
    const baseline = [attempt({ task_id: 'nan', variant: 'base', tokens: Number.NaN })];
    const candidate = [attempt({ task_id: 'nan', variant: 'cand', tokens: 10 })];
    const delta = computePairedDeltas(baseline, candidate, 'tokens')[0]!;
    assert.strictEqual(delta.valid, false);
    assert.ok(delta.issues.includes('non_finite_metric'));
    assert.strictEqual(delta.delta, null);
  });
});
