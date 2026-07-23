/**
 * W3.3 / S-EVL-01 + S-EVL-02 — Grok-shadow implementor scorecard.
 *
 * Internal prove suite + false-positive dashboard that composes:
 * - W0.5 offline prove hard cells (mutation without false zero-write kill)
 * - W1 residual exit smokes (plan→execute + phase-gate visibility)
 * - W1 interactive metric gate (write-rate + TTF on fixture set)
 * - False-positive cells (policies must not fire on known-good cases)
 * - Shadow would-have-killed narrative (S-PR-03): what zero-write hard-stop
 *   *would* have done under a non-zero threshold while general_swe stays at 0
 *
 * Pure offline — no live LLM. Publish via JSON report + human formatter.
 */

import { evaluateZeroWriteHardStop } from './chatZeroWritePolicy.js';
import {
  defaultInteractiveTtfSamples,
  evaluateW1MetricGate,
  type W1MetricGateResult,
} from './implementorMetricGate.js';
import {
  classifyEmptyPatchHonesty,
  countPhaseGateWriteBlocks,
} from './implementorPolicy.js';
import {
  runImplementorProveSmokeSuite,
  type ProveSmokeSuiteReport,
} from './implementorProveSmoke.js';
import { runW1ResidualExitSmokes } from './implementorW1ExitSmoke.js';
import { reviewDiffHeuristically } from './reviewOnDiffAgent.js';
import {
  buildSecretScanReport,
  scanTextForSecrets,
} from '../services/shipSecretScan.js';

export const IMPLEMENTOR_SCORECARD_SCHEMA_VERSION = 1 as const;
export const IMPLEMENTOR_SCORECARD_KIND = 'babel_implementor_grok_shadow_scorecard' as const;

/** Shadow threshold used only for "would-have-killed" narrative (not enforced). */
export const SHADOW_ZERO_WRITE_THRESHOLD_TURNS = 12;

export interface FalsePositiveFinding {
  id: string;
  dimension:
    | 'zero_write_hard_stop'
    | 'empty_patch_kpi'
    | 'secret_scan'
    | 'review_on_diff'
    | 'phase_gate_write_count';
  /** True when the policy incorrectly fired (false positive). */
  false_positive: boolean;
  detail: string;
}

export interface ShadowWouldHaveKilledEvent {
  id: string;
  description: string;
  completed_turns: number;
  has_writes: boolean;
  /** Would hard-stop fire under SHADOW_ZERO_WRITE_THRESHOLD_TURNS? */
  would_kill: boolean;
  /** Actual general_swe policy (threshold 0) fires? */
  live_kills: boolean;
  note: string;
}

export interface ScorecardDimensionResult {
  id: string;
  pass: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ImplementorScorecardReport {
  schema_version: typeof IMPLEMENTOR_SCORECARD_SCHEMA_VERSION;
  kind: typeof IMPLEMENTOR_SCORECARD_KIND;
  generated_at: string;
  pass: boolean;
  dimensions: {
    prove_hard_cells: ScorecardDimensionResult & { report: ProveSmokeSuiteReport };
    w1_residual_exit: ScorecardDimensionResult;
    interactive_metrics: ScorecardDimensionResult & { report: W1MetricGateResult };
    false_positive_dashboard: ScorecardDimensionResult & {
      findings: FalsePositiveFinding[];
      false_positive_count: number;
      false_positive_rate: number;
      cells_total: number;
    };
    shadow_would_have_killed: ScorecardDimensionResult & {
      events: ShadowWouldHaveKilledEvent[];
      would_have_killed_count: number;
    };
  };
  fail_reasons: string[];
  summary_lines: string[];
}

function evaluateFalsePositiveCells(): FalsePositiveFinding[] {
  const findings: FalsePositiveFinding[] = [];

  // FP-1: late mutate with writes must never hard-stop under live general_swe
  const lateWriteMsg = evaluateZeroWriteHardStop({
    executeIntent: true,
    completedTurns: 25,
    hasAnyWrites: true,
    taskClass: 'general_swe',
  });
  findings.push({
    id: 'fp-zero-write-with-writes',
    dimension: 'zero_write_hard_stop',
    false_positive: lateWriteMsg != null,
    detail:
      lateWriteMsg != null
        ? 'zero-write hard stop fired despite writes (false positive)'
        : 'hard stop correctly silent when writes exist',
  });

  // FP-2: general_swe threshold 0 — no hard stop even at high turns without writes
  // (soft fuses only; false kill would be a product regression)
  const highTurnMsg = evaluateZeroWriteHardStop({
    executeIntent: true,
    completedTurns: 40,
    hasAnyWrites: false,
    taskClass: 'general_swe',
  });
  findings.push({
    id: 'fp-zero-write-general-swe-disabled',
    dimension: 'zero_write_hard_stop',
    false_positive: highTurnMsg != null,
    detail:
      highTurnMsg != null
        ? 'general_swe hard-stopped at threshold 0 (false kill)'
        : 'general_swe threshold 0 correctly disabled hard stop',
  });

  // FP-3: env_blocked empty patch must not score as empty_patch KPI failure
  const honesty = classifyEmptyPatchHonesty({ emptyPatch: true, envBlocked: true });
  findings.push({
    id: 'fp-empty-patch-env-blocked',
    dimension: 'empty_patch_kpi',
    false_positive: honesty.scoreAsEmptyPatchFailure === true,
    detail: honesty.scoreAsEmptyPatchFailure
      ? 'env_blocked empty_patch scored as KPI failure'
      : 'env_blocked empty_patch correctly quarantined',
  });

  // FP-4: placeholder secrets must not fail content scan
  const placeholder = scanTextForSecrets(
    "api_key = 'YOUR_API_KEY_HERE'\npassword = 'placeholder'",
    'docs/example.md',
  );
  const placeholderReport = buildSecretScanReport(placeholder);
  findings.push({
    id: 'fp-secret-scan-placeholder',
    dimension: 'secret_scan',
    false_positive: !placeholderReport.passed,
    detail: placeholderReport.passed
      ? 'placeholder assignments skipped'
      : `placeholder false positive: ${placeholder.map((f) => f.rule).join(', ')}`,
  });

  // FP-5: clean implement patch with test should not request_changes for missing tests
  const goodPatch = [
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' export function foo() {',
    '+  return 1;',
    ' }',
    '--- a/src/foo.test.ts',
    '+++ b/src/foo.test.ts',
    '@@ -1,2 +1,5 @@',
    " import { foo } from './foo';",
    '+test("foo", () => {',
    '+  assert.equal(foo(), 1);',
    '+});',
  ].join('\n');
  const reviewComments = reviewDiffHeuristically({
    task: 'Add foo unit tests',
    patch: goodPatch,
    changedFiles: ['src/foo.ts', 'src/foo.test.ts'],
  });
  const badReview = reviewComments.some(
    (c) => c.severity === 'error' && c.category === 'test',
  );
  findings.push({
    id: 'fp-review-missing-tests-on-good-patch',
    dimension: 'review_on_diff',
    false_positive: badReview,
    detail: badReview
      ? 'review flagged missing tests on patch that includes tests'
      : 'review correctly accepts patch with tests',
  });

  // FP-6: non-write phase-gate blocks must not inflate write block count
  const phaseMetrics = countPhaseGateWriteBlocks({
    policyEvents: [
      { kind: 'phase_gate_block', tool: 'grep', detail: 'phase-gate' },
      { kind: 'phase_gate_block', tool: 'read_file', detail: 'phase-gate' },
    ],
  });
  findings.push({
    id: 'fp-phase-gate-search-not-write',
    dimension: 'phase_gate_write_count',
    false_positive: phaseMetrics.phase_gate_write_block_count !== 0,
    detail:
      phaseMetrics.phase_gate_write_block_count === 0
        ? 'search-only phase-gate blocks correctly excluded from write count'
        : `search phase-gate counted as write blocks (${phaseMetrics.phase_gate_write_block_count})`,
  });

  return findings;
}

function evaluateShadowWouldHaveKilled(): ShadowWouldHaveKilledEvent[] {
  const scenarios: Array<{
    id: string;
    description: string;
    completed_turns: number;
    has_writes: boolean;
  }> = [
    {
      id: 'shadow-late-explore-no-write',
      description: 'Long investigate without mutate (explorer death path)',
      completed_turns: 20,
      has_writes: false,
    },
    {
      id: 'shadow-mid-with-write',
      description: 'Mid-run after first write',
      completed_turns: 15,
      has_writes: true,
    },
    {
      id: 'shadow-under-threshold',
      description: 'Few turns, no write — under shadow threshold',
      completed_turns: 5,
      has_writes: false,
    },
  ];

  return scenarios.map((s) => {
    const live = evaluateZeroWriteHardStop({
      executeIntent: true,
      completedTurns: s.completed_turns,
      hasAnyWrites: s.has_writes,
      taskClass: 'general_swe',
    });
    // Shadow: evaluate as if threshold were SHADOW_ZERO_WRITE_THRESHOLD_TURNS
    // by temporarily using env override path
    const shadow = evaluateZeroWriteHardStop({
      executeIntent: true,
      completedTurns: s.completed_turns,
      hasAnyWrites: s.has_writes,
      taskClass: 'general_swe',
      env: {
        ...process.env,
        BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS: String(SHADOW_ZERO_WRITE_THRESHOLD_TURNS),
      },
    });
    const would_kill = shadow != null;
    const live_kills = live != null;
    let note: string;
    if (would_kill && !live_kills) {
      note = `Shadow threshold ${SHADOW_ZERO_WRITE_THRESHOLD_TURNS} would kill; live general_swe (0) allows soft fuses only`;
    } else if (!would_kill && !live_kills) {
      note = 'Neither live nor shadow would hard-stop';
    } else if (would_kill && live_kills) {
      note = 'Both live and shadow would kill (unexpected for general_swe live)';
    } else {
      note = 'Live kills but shadow would not (unexpected inversion)';
    }
    return {
      id: s.id,
      description: s.description,
      completed_turns: s.completed_turns,
      has_writes: s.has_writes,
      would_kill,
      live_kills,
      note,
    };
  });
}

/**
 * Run the full offline Grok-shadow implementor scorecard.
 */
export function runImplementorScorecard(opts?: { now?: Date }): ImplementorScorecardReport {
  const generated_at = (opts?.now ?? new Date()).toISOString();
  const fail_reasons: string[] = [];

  // Dimension 1 — prove hard cells
  const prove = runImplementorProveSmokeSuite();
  const proveDim: ImplementorScorecardReport['dimensions']['prove_hard_cells'] = {
    id: 'prove_hard_cells',
    pass: prove.pass,
    summary: `Prove suite ${prove.cells_passed}/${prove.cells_total} (TTF median ${prove.ttf_write_median ?? 'n/a'})`,
    report: prove,
  };
  if (!prove.pass) fail_reasons.push('prove_hard_cells failed');

  // Dimension 2 — W1 residual exit
  const w1Exit = runW1ResidualExitSmokes();
  const w1ExitDim: ScorecardDimensionResult = {
    id: 'w1_residual_exit',
    pass: w1Exit.pass,
    summary: w1Exit.pass
      ? 'Plan→execute linked-id + phase-gate visibility smokes pass'
      : `W1 residual exit failed: ${w1Exit.results
          .filter((r) => !r.pass)
          .map((r) => r.id)
          .join(', ')}`,
    details: {
      results: w1Exit.results.map((r) => ({
        id: r.id,
        pass: r.pass,
        fail_reasons: r.fail_reasons,
      })),
    },
  };
  if (!w1Exit.pass) fail_reasons.push('w1_residual_exit failed');

  // Dimension 3 — interactive metrics (single-file fixture set)
  const metric = evaluateW1MetricGate(defaultInteractiveTtfSamples(), {
    taskScale: 'single_file',
  });
  const metricDim: ImplementorScorecardReport['dimensions']['interactive_metrics'] = {
    id: 'interactive_metrics',
    pass: metric.pass,
    summary: `write_rate=${(metric.write_rate * 100).toFixed(0)}% ttf_median=${metric.ttf_write_median ?? 'n/a'} (${metric.ttf_write_reason})`,
    report: metric,
  };
  if (!metric.pass) fail_reasons.push(`interactive_metrics: ${metric.fail_reasons.join('; ')}`);

  // Dimension 4 — false-positive dashboard
  const fpFindings = evaluateFalsePositiveCells();
  const fpCount = fpFindings.filter((f) => f.false_positive).length;
  const fpRate = fpFindings.length === 0 ? 0 : fpCount / fpFindings.length;
  const fpPass = fpCount === 0;
  const fpDim: ImplementorScorecardReport['dimensions']['false_positive_dashboard'] = {
    id: 'false_positive_dashboard',
    pass: fpPass,
    summary: `false_positive_rate=${(fpRate * 100).toFixed(0)}% (${fpCount}/${fpFindings.length})`,
    findings: fpFindings,
    false_positive_count: fpCount,
    false_positive_rate: fpRate,
    cells_total: fpFindings.length,
  };
  if (!fpPass) {
    fail_reasons.push(
      `false positives: ${fpFindings
        .filter((f) => f.false_positive)
        .map((f) => f.id)
        .join(', ')}`,
    );
  }

  // Dimension 5 — shadow would-have-killed (informational; always "pass" if consistent)
  const shadowEvents = evaluateShadowWouldHaveKilled();
  const wouldCount = shadowEvents.filter((e) => e.would_kill).length;
  // Consistency: live_kills must never be true for general_swe offline cells without writes
  // when product lock is threshold 0. Mid-with-write must never live-kill.
  const shadowInconsistent = shadowEvents.some((e) => e.live_kills);
  const shadowDim: ImplementorScorecardReport['dimensions']['shadow_would_have_killed'] = {
    id: 'shadow_would_have_killed',
    pass: !shadowInconsistent,
    summary: `${wouldCount} shadow kill(s) under threshold ${SHADOW_ZERO_WRITE_THRESHOLD_TURNS}; live kills=${shadowEvents.filter((e) => e.live_kills).length}`,
    events: shadowEvents,
    would_have_killed_count: wouldCount,
  };
  if (shadowInconsistent) {
    fail_reasons.push('shadow: live general_swe hard-stopped (threshold 0 regression)');
  }

  const pass = fail_reasons.length === 0;
  const summary_lines = [
    `Grok-shadow implementor scorecard: ${pass ? 'PASS' : 'FAIL'}`,
    proveDim.summary,
    w1ExitDim.summary,
    metricDim.summary,
    fpDim.summary,
    shadowDim.summary,
  ];

  return {
    schema_version: IMPLEMENTOR_SCORECARD_SCHEMA_VERSION,
    kind: IMPLEMENTOR_SCORECARD_KIND,
    generated_at,
    pass,
    dimensions: {
      prove_hard_cells: proveDim,
      w1_residual_exit: w1ExitDim,
      interactive_metrics: metricDim,
      false_positive_dashboard: fpDim,
      shadow_would_have_killed: shadowDim,
    },
    fail_reasons,
    summary_lines,
  };
}

/** Human-readable scorecard for CLI / status notes. */
export function formatImplementorScorecardHuman(report: ImplementorScorecardReport): string {
  const lines = [
    'Babel Implementor Grok-Shadow Scorecard (W3.3)',
    `Status: ${report.pass ? 'PASS' : 'FAIL'}`,
    `Generated: ${report.generated_at}`,
    '',
    '## Dimensions',
    `- Prove hard cells: ${report.dimensions.prove_hard_cells.pass ? 'PASS' : 'FAIL'} — ${report.dimensions.prove_hard_cells.summary}`,
    `- W1 residual exit: ${report.dimensions.w1_residual_exit.pass ? 'PASS' : 'FAIL'} — ${report.dimensions.w1_residual_exit.summary}`,
    `- Interactive metrics: ${report.dimensions.interactive_metrics.pass ? 'PASS' : 'FAIL'} — ${report.dimensions.interactive_metrics.summary}`,
    `- False-positive dashboard: ${report.dimensions.false_positive_dashboard.pass ? 'PASS' : 'FAIL'} — ${report.dimensions.false_positive_dashboard.summary}`,
    `- Shadow would-have-killed: ${report.dimensions.shadow_would_have_killed.pass ? 'PASS' : 'FAIL'} — ${report.dimensions.shadow_would_have_killed.summary}`,
  ];

  lines.push('', '## False-positive cells');
  for (const f of report.dimensions.false_positive_dashboard.findings) {
    lines.push(
      `- ${f.false_positive ? 'FP' : 'ok'} \`${f.id}\` [${f.dimension}] ${f.detail}`,
    );
  }

  lines.push('', '## Shadow would-have-killed');
  for (const e of report.dimensions.shadow_would_have_killed.events) {
    lines.push(
      `- \`${e.id}\` turns=${e.completed_turns} writes=${e.has_writes} shadow_kill=${e.would_kill} live_kill=${e.live_kills}`,
      `  ${e.note}`,
    );
  }

  if (report.fail_reasons.length > 0) {
    lines.push('', '## Fail reasons', ...report.fail_reasons.map((r) => `- ${r}`));
  }

  lines.push(
    '',
    '---',
    '_W3.3 / S-EVL-01 Grok-shadow suite · S-EVL-02 false-positive rate · S-PR-03 shadow narrative_',
  );
  return lines.join('\n');
}
