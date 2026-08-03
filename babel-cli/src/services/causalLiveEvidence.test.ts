/**
 * Slice 7 — provider-free unit tests for live causal evidence harness.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  LIVE_CANARY_PLAN,
  LIVE_SPEND_AUTHORIZE_FLAG,
  analyzeLiveEvidenceDir,
  buildLiveCanaryPlan,
  checkLiveSpendAuthorization,
  hasLiveSpendAuthorization,
  rankImprovementHypotheses,
  writeImprovementLedger,
  type LiveCellSummary,
} from './causalLiveEvidence.js';

describe('buildLiveCanaryPlan', () => {
  test('freezes predeclared fields without overrides', () => {
    const frozen = buildLiveCanaryPlan({ frozen_at: '2026-08-02T00:00:00.000Z' });
    assert.equal(frozen.schema_version, 1);
    assert.equal(frozen.kind, 'babel_live_canary_plan');
    assert.equal(frozen.frozen_at, '2026-08-02T00:00:00.000Z');
    assert.equal(frozen.plan.n_tasks, LIVE_CANARY_PLAN.n_tasks);
    assert.equal(frozen.plan.model, 'deepseek-v4-flash');
    assert.equal(frozen.plan.mode, 'chat-headless');
    assert.deepEqual(frozen.plan.arms_live, ['babel_enforce']);
    assert.equal(frozen.plan.replicates, 1);
    assert.equal(frozen.plan.early_stop, 5);
    assert.equal(frozen.plan.agent_timeout_ms, 1_500_000);
    assert.ok(frozen.plan.metrics.includes('patch_bytes'));
    assert.ok(frozen.plan.metrics.includes('boundary_force_mutate_*'));
    assert.ok(frozen.plan.metrics.includes('derived_eligibility'));
    assert.deepEqual(frozen.overrides_applied, []);
  });

  test('records overrides_applied when fields change', () => {
    const frozen = buildLiveCanaryPlan({
      n_tasks: 2,
      model: 'deepseek-v4-pro',
      frozen_at: '2026-08-02T00:00:00.000Z',
    });
    assert.equal(frozen.plan.n_tasks, 2);
    assert.equal(frozen.plan.model, 'deepseek-v4-pro');
    assert.ok(frozen.overrides_applied.includes('n_tasks'));
    assert.ok(frozen.overrides_applied.includes('model'));
    // Default arms still frozen
    assert.deepEqual(frozen.plan.arms_live, ['babel_enforce']);
  });
});

describe('live spend authorization check', () => {
  test('refuses without authorize flag', () => {
    assert.equal(hasLiveSpendAuthorization(['--evidence-dir', 'x']), false);
    const msg = checkLiveSpendAuthorization(['--json']);
    assert.ok(msg != null);
    assert.match(msg!, /Refusing live causal canary/);
    assert.match(msg!, new RegExp(LIVE_SPEND_AUTHORIZE_FLAG));
  });

  test('allows when --i-authorize-live-spend present', () => {
    assert.equal(hasLiveSpendAuthorization([LIVE_SPEND_AUTHORIZE_FLAG]), true);
    assert.equal(checkLiveSpendAuthorization(['--model', 'x', LIVE_SPEND_AUTHORIZE_FLAG]), null);
  });
});

describe('analyzeLiveEvidenceDir', () => {
  test('produces thrash hypothesis when patch_bytes=0 and force_mutate_shadow present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'causal-live-ev-'));
    mkdirSync(join(dir, 'live'), { recursive: true });

    writeFileSync(
      join(dir, 'campaign-manifest.json'),
      JSON.stringify({
        schema_version: 1,
        kind: 'babel_causal_campaign_manifest',
        campaign_id: 'test-canary',
      }),
      'utf8',
    );

    writeFileSync(
      join(dir, 'campaign-report.json'),
      JSON.stringify({
        schema_version: 1,
        kind: 'babel_swe_bench_pro_campaign',
        campaign_id: 'test-canary',
        cells: [
          {
            instance_id: 'task_zero_patch_thrash',
            phase: 'live',
            status: 'fail',
            signature: 'agent:budget_exhausted',
            patch_bytes: 0,
            fail_to_pass_ok: false,
            fail_to_pass_class: 'assert_fail',
            notes: ['effort_aliased=false', 'status=BUDGET_EXCEEDED', 'terminal_outcome=BUDGET_EXHAUSTED'],
            policy_events: [
              { at_turn: 2, kind: 'force_mutate', detail: 'turns_without_write=3' },
              { at_turn: 2, kind: 'force_mutate_shadow', detail: 'would_restrict_tools=mutate_only' },
              { at_turn: 5, kind: 'force_mutate', detail: 'turns_without_write=3' },
              { at_turn: 8, kind: 'zero_write_shadow', detail: 'would_kill' },
              { at_turn: 10, kind: 'budget_kill', detail: 'tokens' },
            ],
            telemetry: {
              effort: {
                effort_aliased: false,
                requested_reasoning_effort: 'medium',
                sent_reasoning_effort: 'medium',
                observed_reasoning_effort: 'medium',
              },
              boundary: {
                force_mutate_count: 2,
                force_mutate_shadow_count: 1,
                zero_write_shadow_count: 1,
                zero_write_hard_stop_count: 0,
                successful_write_tool_count: 0,
                turns_to_first_applied_write: null,
              },
            },
          },
        ],
      }),
      'utf8',
    );

    writeFileSync(
      join(dir, 'live', 'task_zero_patch_thrash.json'),
      JSON.stringify({
        instance_id: 'task_zero_patch_thrash',
        phase: 'live',
        status: 'fail',
        signature: 'agent:budget_exhausted',
        patch_bytes: 0,
        fail_to_pass_class: 'assert_fail',
        policy_events: [
          { at_turn: 2, kind: 'force_mutate_shadow' },
          { at_turn: 2, kind: 'force_mutate' },
        ],
        telemetry: {
          effort: {
            effort_aliased: true,
            requested_reasoning_effort: 'high',
            sent_reasoning_effort: 'medium',
            observed_reasoning_effort: 'medium',
          },
          boundary: {
            force_mutate_count: 4,
            force_mutate_shadow_count: 2,
            zero_write_shadow_count: 1,
            zero_write_hard_stop_count: 0,
            successful_write_tool_count: 0,
            turns_to_first_applied_write: null,
          },
        },
      }),
      'utf8',
    );

    writeFileSync(
      join(dir, 'policy-events.jsonl'),
      [
        JSON.stringify({ at_turn: 2, kind: 'force_mutate_shadow' }),
        JSON.stringify({ at_turn: 8, kind: 'zero_write_shadow' }),
      ].join('\n') + '\n',
      'utf8',
    );

    writeFileSync(
      join(dir, 'campaign-derived.json'),
      JSON.stringify({
        schema_version: 1,
        kind: 'babel_causal_campaign_derived',
        scorer_version: 'causal-scorer-v1',
        eligibility: {
          artifact_valid: true,
          campaign_complete: false,
          reliability_eligible: false,
          promotion_eligible: false,
          capability_score_valid: false,
        },
        notes: ['synthetic fixture'],
      }),
      'utf8',
    );

    const ledger = analyzeLiveEvidenceDir(dir);
    assert.equal(ledger.schema_version, 1);
    assert.equal(ledger.kind, 'babel_live_improvement_ledger');
    assert.ok(ledger.scorer_version.length > 0);
    assert.equal(ledger.n, 1);
    assert.match(ledger.uncertainty_note, /Small-N|n=1/i);

    assert.equal(ledger.patch_bytes.total, 0);
    assert.equal(ledger.patch_bytes.zero_patch_cells, 1);
    assert.equal(ledger.patch_bytes.zero_patch_rate, 1);
    assert.ok((ledger.signatures_histogram['agent:budget_exhausted'] ?? 0) >= 1);
    assert.ok(ledger.force_mutate_signals.force_mutate_shadow_total >= 1);
    assert.equal(ledger.force_mutate_signals.cells_zero_patch_and_force_mutate_shadow, 1);

    const thrash = ledger.hypotheses.find((h) => h.id === 'zero_patch_force_mutate_shadow_thrash');
    assert.ok(thrash, 'expected zero_patch_force_mutate_shadow_thrash hypothesis');
    assert.equal(thrash!.severity, 'high');
    assert.match(thrash!.summary, /zero patch.*force_mutate_shadow/i);
    assert.ok(thrash!.rank >= 1);

    assert.ok(ledger.derived_eligibility);
    assert.equal(ledger.derived_eligibility!.artifact_valid, true);
    assert.equal(ledger.derived_eligibility!.campaign_complete, false);

    const written = writeImprovementLedger(dir, ledger);
    assert.ok(written.markdown.includes('zero_patch_force_mutate_shadow_thrash'));
    const reloaded = JSON.parse(readFileSync(written.jsonPath, 'utf8')) as { n: number };
    assert.equal(reloaded.n, 1);
  });

  test('rankImprovementHypotheses orders thrash first', () => {
    const cells: LiveCellSummary[] = [
      {
        instance_id: 'a',
        phase: 'live',
        status: 'fail',
        signature: 'agent:budget_exhausted',
        patch_bytes: 0,
        fail_to_pass_class: 'assert_fail',
        fail_to_pass_ok: false,
        gold_diff_ok: false,
        force_mutate_count: 5,
        force_mutate_shadow_count: 1,
        zero_write_shadow_count: 0,
        zero_write_hard_stop_count: 0,
        successful_write_tool_count: 0,
        turns_to_first_write: null,
        effort_aliased: true,
        effort_requested: 'high',
        effort_sent: 'medium',
        effort_observed: 'medium',
        budget_signature: 'agent:budget_exhausted',
        source: 'test',
      },
    ];
    const ranked = rankImprovementHypotheses(cells);
    assert.ok(ranked.length >= 2);
    assert.equal(ranked[0]!.id, 'zero_patch_force_mutate_shadow_thrash');
    assert.equal(ranked[0]!.rank, 1);
  });
});
