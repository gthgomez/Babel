/**
 * Clustering + ledger reporting — deterministic ordering, subsystem
 * derivation heuristics, tie-breaking, empty inputs.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  AUDIT_FINDING_KIND,
  AUDIT_FINDING_SCHEMA_VERSION,
  AuditFindingSchema,
  type AuditFinding,
  type HypothesisLabel,
} from './findings.js';
import {
  BottleneckLedgerEntrySchema,
  type BottleneckLedgerEntry,
} from './bottleneckLedger.js';
import {
  HYPOTHESIS_TO_SUBSYSTEM,
  NON_HARNESS_TOP_HYPOTHESES,
  UNRESOLVED_SUBSYSTEM,
  buildLedgerReport,
  clusterFindings,
  deriveSuspectedSubsystem,
} from './clustering.js';

// ─── Audit finding fixtures ──────────────────────────────────────────────────

interface FindingOverride {
  finding_id?: string;
  stage?: AuditFinding['stage'];
  confidence?: number;
  hypotheses?: { label: HypothesisLabel; weight: number }[];
}

function makeFinding(overrides: FindingOverride = {}): AuditFinding {
  const hypotheses = overrides.hypotheses ?? [
    { label: 'HARNESS_TOOL', weight: 0.7 },
    { label: 'MODEL', weight: 0.3 },
  ];
  return AuditFindingSchema.parse({
    schema_version: AUDIT_FINDING_SCHEMA_VERSION,
    kind: AUDIT_FINDING_KIND,
    finding_id: overrides.finding_id ?? 'F-001',
    produced_at: '2026-08-21T09:00:00.000Z',
    task_id: 'task_a',
    arm: 'babel_enforce',
    model: 'test-model',
    attempt_id: null,
    campaign_id: null,
    episode_run_dir: null,
    stage: overrides.stage ?? 'tool_use',
    claim: 'Tool results dropped stderr context causing blind retries',
    expected_capability: 'Recover from failing tools using stderr context',
    observed_behavior: 'Agent retried identical tool calls without new information',
    impact: 'Wasted attempts and eventual task failure',
    evidence_refs: [{ source: 'transcript', id: `tr-${overrides.finding_id ?? 'F-001'}` }],
    hypotheses: hypotheses.map((h) => ({ ...h, rationale: `rationale for ${h.label}` })),
    confidence: overrides.confidence ?? 0.8,
    counterfactual: 'With stderr preserved the agent would have adjusted its arguments',
    falsification_experiment: {
      description: 'Paired replay with stderr-tail preservation',
      preregistered_prediction: 'Blind retries drop significantly under the intervention arm',
      success_metric: 'blind_retry_rate delta < 0',
    },
    near_miss: false,
    succeeded_despite_harness: false,
    worker_friction_agreement: 'corroborates',
  });
}

// ─── Ledger entry fixtures ───────────────────────────────────────────────────

function ledgerEntry(overrides: Record<string, unknown> = {}): BottleneckLedgerEntry {
  return BottleneckLedgerEntrySchema.parse({
    schema_version: 1,
    kind: 'babel_bottleneck_ledger_entry',
    id: 'BB-001',
    status: 'OPEN',
    claim: 'Tool mediation drops stderr context during long failing tool chains',
    suspected_subsystem: 'tool_mediation',
    observed_across: { attempt_count: 3, task_count: 2, model_count: 1 },
    harnesses: [{ name: 'babel', adapter_id: 'babel_cli_chat_headless', version: null }],
    stages: ['tool_use'],
    effect_quantification: null,
    evidence_strength: 'moderate',
    evidence_strength_justification: 'Two independent audits corroborate the pattern.',
    evidence_refs: [{ source: 'transcript', id: 'tr-001' }],
    competing_hypotheses: [
      { label: 'HARNESS_TOOL', weight: 0.7, rationale: 'denials surround failures' },
      { label: 'MODEL', weight: 0.3, rationale: 'model sometimes recovers' },
    ],
    proposed_intervention: {
      description: 'Preserve stderr tail in tool results',
      expected_effect: 'Fewer blind retries',
      preregistered_falsifier: 'No retry-rate change under paired replay falsifies this',
    },
    baseline_manifest_sha: null,
    rerun_manifest_sha: null,
    result: { verdict: null, replay_delta: null, notes: '' },
    created_at: '2026-08-21T10:00:00.000Z',
    updated_at: '2026-08-21T10:00:00.000Z',
    ...overrides,
  });
}

function confirmedEntry(id: string): BottleneckLedgerEntry {
  return ledgerEntry({
    id,
    status: 'CONFIRMED',
    effect_quantification: {
      metric_name: 'blind_retry_rate',
      baseline_value: 0.5,
      intervention_value: 0.68,
      direction: 'improves',
    },
    baseline_manifest_sha: 'sha_b',
    rerun_manifest_sha: 'sha_r',
    result: { verdict: 'CONFIRMED', replay_delta: 0.2, notes: '' },
  });
}

function falsifiedEntry(id: string): BottleneckLedgerEntry {
  return ledgerEntry({
    id,
    status: 'FALSIFIED',
    baseline_manifest_sha: 'sha_b',
    rerun_manifest_sha: 'sha_r',
    result: { verdict: 'FALSIFIED', replay_delta: -0.3, notes: '' },
  });
}

// ─── Subsystem derivation ────────────────────────────────────────────────────

describe('deriveSuspectedSubsystem', () => {
  test('maps harness hypotheses to documented subsystems', () => {
    assert.deepEqual(deriveSuspectedSubsystem([{ label: 'HARNESS_TOOL', weight: 0.7 }]), {
      subsystem: 'tool_mediation',
      top_label: 'HARNESS_TOOL',
    });
    assert.deepEqual(deriveSuspectedSubsystem([{ label: 'POLICY', weight: 1 }]), {
      subsystem: 'mutation_governance',
      top_label: 'POLICY',
    });
    assert.deepEqual(
      deriveSuspectedSubsystem([{ label: 'HARNESS_ORCHESTRATION', weight: 0.6 }]),
      { subsystem: 'orchestration', top_label: 'HARNESS_ORCHESTRATION' },
    );
    assert.deepEqual(deriveSuspectedSubsystem([{ label: 'HARNESS_CONTEXT', weight: 0.6 }]), {
      subsystem: 'context_assembly',
      top_label: 'HARNESS_CONTEXT',
    });
  });

  test('skips MODEL/UNKNOWN/INTERACTION even when they carry the top weight', () => {
    const derived = deriveSuspectedSubsystem([
      { label: 'MODEL', weight: 0.5 },
      { label: 'HARNESS_CONTEXT', weight: 0.3 },
      { label: 'TASK', weight: 0.2 },
    ]);
    assert.equal(derived.top_label, 'HARNESS_CONTEXT');
    assert.equal(derived.subsystem, 'context_assembly');
  });

  test('falls back to attribution_unresolved when only excluded labels remain', () => {
    const derived = deriveSuspectedSubsystem([
      { label: 'MODEL', weight: 0.6 },
      { label: 'UNKNOWN', weight: 0.25 },
      { label: 'INTERACTION', weight: 0.15 },
    ]);
    assert.equal(derived.top_label, null);
    assert.equal(derived.subsystem, UNRESOLVED_SUBSYSTEM);
  });

  test('non-harness but eligible labels pass through without being dropped', () => {
    assert.deepEqual(deriveSuspectedSubsystem([{ label: 'ENVIRONMENT', weight: 0.9 }]), {
      subsystem: 'environment',
      top_label: 'ENVIRONMENT',
    });
    assert.deepEqual(deriveSuspectedSubsystem([{ label: 'REPOSITORY', weight: 0.9 }]), {
      subsystem: 'repository',
      top_label: 'REPOSITORY',
    });
  });

  test('weight ties break by label ascending', () => {
    const derived = deriveSuspectedSubsystem([
      { label: 'POLICY', weight: 0.5 },
      { label: 'ENVIRONMENT', weight: 0.5 },
    ]);
    assert.equal(derived.top_label, 'ENVIRONMENT');
    assert.equal(derived.subsystem, 'environment');
  });

  test('mapping table covers every hypothesis label exactly once', () => {
    assert.deepEqual(Object.keys(HYPOTHESIS_TO_SUBSYSTEM).sort(), [
      'ENVIRONMENT',
      'HARNESS_CONTEXT',
      'HARNESS_ORCHESTRATION',
      'HARNESS_TOOL',
      'INTERACTION',
      'MODEL',
      'POLICY',
      'REPOSITORY',
      'TASK',
      'UNKNOWN',
    ]);
    assert.deepEqual([...NON_HARNESS_TOP_HYPOTHESES].sort(), ['INTERACTION', 'MODEL', 'UNKNOWN']);
  });
});

// ─── clusterFindings ─────────────────────────────────────────────────────────

describe('clusterFindings', () => {
  test('groups by derived subsystem × stage with sorted finding ids', () => {
    const f1 = makeFinding({ finding_id: 'F-002' });
    const f2 = makeFinding({ finding_id: 'F-001' });
    const clusters = clusterFindings([f1, f2]);
    assert.equal(clusters.length, 1);
    const c = clusters[0];
    assert.ok(c);
    assert.equal(c.key, 'tool_mediation::tool_use');
    assert.equal(c.suspected_subsystem, 'tool_mediation');
    assert.equal(c.stage, 'tool_use');
    assert.deepEqual(c.finding_ids, ['F-001', 'F-002']);
    assert.ok(Math.abs(c.total_confidence_weighted_count - 1.6) < 1e-9);
  });

  test('same subsystem at different stages forms separate clusters', () => {
    const clusters = clusterFindings([
      makeFinding({ finding_id: 'F-1', stage: 'tool_use' }),
      makeFinding({ finding_id: 'F-2', stage: 'verification' }),
    ]);
    assert.equal(clusters.length, 2);
    assert.deepEqual(
      clusters.map((c) => c.key).sort(),
      ['tool_mediation::tool_use', 'tool_mediation::verification'],
    );
  });

  test('clusters sort by total confidence-weighted count descending', () => {
    const big = [
      makeFinding({ finding_id: 'A1', confidence: 0.9 }),
      makeFinding({ finding_id: 'A2', confidence: 0.8 }),
    ];
    const small = [
      makeFinding({
        finding_id: 'B1',
        stage: 'mutation',
        confidence: 0.4,
        hypotheses: [
          { label: 'POLICY', weight: 0.8 },
          { label: 'MODEL', weight: 0.2 },
        ],
      }),
    ];
    const clusters = clusterFindings([...small, ...big]);
    assert.deepEqual(clusters.map((c) => c.key), [
      'tool_mediation::tool_use',
      'mutation_governance::mutation',
    ]);
    assert.equal(clusters[0]?.finding_ids.length, 2);
    assert.ok(clusters[0]!.total_confidence_weighted_count > clusters[1]!.total_confidence_weighted_count);
  });

  test('equal-weight clusters tie-break by key ascending', () => {
    const policy = makeFinding({
      finding_id: 'P1',
      stage: 'mutation',
      hypotheses: [
        { label: 'POLICY', weight: 0.8 },
        { label: 'MODEL', weight: 0.2 },
      ],
    });
    const orchestration = makeFinding({
      finding_id: 'O1',
      stage: 'planning',
      hypotheses: [
        { label: 'HARNESS_ORCHESTRATION', weight: 0.8 },
        { label: 'MODEL', weight: 0.2 },
      ],
    });
    const clusters = clusterFindings([orchestration, policy]);
    assert.deepEqual(clusters.map((c) => c.key), [
      'mutation_governance::mutation',
      'orchestration::planning',
    ]);
  });

  test('leading attribution skips heavier MODEL weight inside findings', () => {
    const clusters = clusterFindings([
      makeFinding({
        finding_id: 'M1',
        hypotheses: [
          { label: 'MODEL', weight: 0.5 },
          { label: 'HARNESS_TOOL', weight: 0.3 },
          { label: 'TASK', weight: 0.2 },
        ],
      }),
    ]);
    const c = clusters[0];
    assert.ok(c);
    assert.equal(c.key, 'tool_mediation::tool_use');
    assert.equal(c.aggregate_hypotheses[0]?.label, 'MODEL');
    assert.match(c.suggested_ledger_claim, /implicate tool_mediation at stage 'tool_use'/);
  });

  test('all-excluded attributions land under attribution_unresolved instead of vanishing', () => {
    const clusters = clusterFindings([
      makeFinding({
        finding_id: 'U1',
        stage: 'completion',
        hypotheses: [
          { label: 'MODEL', weight: 0.6 },
          { label: 'UNKNOWN', weight: 0.4 },
        ],
      }),
    ]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.key, `${UNRESOLVED_SUBSYSTEM}::completion`);
  });

  test('aggregate_hypotheses are sorted by share desc then label asc and sum to ~1', () => {
    const clusters = clusterFindings([
      makeFinding({
        finding_id: 'S1',
        hypotheses: [
          { label: 'HARNESS_TOOL', weight: 0.7 },
          { label: 'MODEL', weight: 0.3 },
        ],
        confidence: 0.8,
      }),
      makeFinding({
        finding_id: 'S2',
        hypotheses: [
          { label: 'HARNESS_TOOL', weight: 0.5 },
          { label: 'MODEL', weight: 0.5 },
        ],
        confidence: 0.2,
      }),
    ]);
    const agg = clusters[0]?.aggregate_hypotheses ?? [];
    assert.equal(agg.length, 2);
    assert.equal(agg[0]?.label, 'HARNESS_TOOL');
    assert.equal(agg[1]?.label, 'MODEL');
    assert.ok(agg[0] !== undefined && agg[0].share >= agg[1]!.share);
    const sum = agg.reduce((acc, h) => acc + h.share, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  test('suggested_ledger_claim is deterministic and self-describing', () => {
    const input = [
      makeFinding({
        finding_id: 'D1',
        stage: 'completion',
        hypotheses: [
          { label: 'POLICY', weight: 0.75 },
          { label: 'MODEL', weight: 0.25 },
        ],
        confidence: 0.5,
      }),
    ];
    const firstRun = clusterFindings(input);
    const secondRun = clusterFindings(input.map((f) => structuredClone(f)));
    assert.deepEqual(firstRun, secondRun);
    assert.match(
      firstRun[0]?.suggested_ledger_claim ?? '',
      /^1 audit finding\(s\) implicate mutation_governance at stage 'completion' with leading attribution POLICY \(\d+% confidence-weighted share\)$/,
    );
  });

  test('clustering is deterministic across repeated calls on shared inputs', () => {
    const findings = [
      makeFinding({ finding_id: 'R1' }),
      makeFinding({ finding_id: 'R2', stage: 'planning', confidence: 0.6 }),
      makeFinding({ finding_id: 'R3', confidence: 0.95 }),
    ];
    const a = clusterFindings(findings);
    const b = clusterFindings(findings);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  test('empty input produces no clusters', () => {
    assert.deepEqual(clusterFindings([]), []);
  });
});

// ─── buildLedgerReport ───────────────────────────────────────────────────────

describe('buildLedgerReport', () => {
  test('reports kind/schema_version/totals across all statuses', () => {
    const report = buildLedgerReport([
      ledgerEntry({ id: 'BB-001' }),
      ledgerEntry({ id: 'BB-002', status: 'INTERVENTION_SHIPPED', baseline_manifest_sha: 'sb' }),
      confirmedEntry('BB-003'),
      confirmedEntry('BB-004'),
      falsifiedEntry('BB-005'),
    ]);
    assert.equal(report.kind, 'babel_bottleneck_ledger_report');
    assert.equal(report.schema_version, 1);
    assert.deepEqual(report.totals_by_status, {
      OPEN: 1,
      INTERVENTION_SHIPPED: 1,
      CONFIRMED: 2,
      FALSIFIED: 1,
    });
  });

  test('open_priorities excludes non-OPEN entries', () => {
    const report = buildLedgerReport([
      ledgerEntry({ id: 'BB-010' }),
      confirmedEntry('BB-011'),
      falsifiedEntry('BB-012'),
    ]);
    assert.deepEqual(report.open_priorities.map((e) => e.id), ['BB-010']);
  });

  test('open_priorities orders by strength desc, attempts desc, id asc', () => {
    const entries = [
      ledgerEntry({ id: 'BB-105', evidence_strength: 'weak', observed_across: { attempt_count: 999, task_count: 1, model_count: 1 } }),
      ledgerEntry({ id: 'BB-104', evidence_strength: 'moderate', observed_across: { attempt_count: 50, task_count: 1, model_count: 1 } }),
      ledgerEntry({ id: 'BB-103', evidence_strength: 'strong', observed_across: { attempt_count: 10, task_count: 1, model_count: 1 } }),
      ledgerEntry({ id: 'BB-102', evidence_strength: 'strong', observed_across: { attempt_count: 20, task_count: 1, model_count: 1 } }),
      ledgerEntry({ id: 'BB-101', evidence_strength: 'strong', observed_across: { attempt_count: 20, task_count: 1, model_count: 1 } }),
      ledgerEntry({ id: 'BB-100', evidence_strength: 'moderate', observed_across: { attempt_count: 99, task_count: 1, model_count: 1 } }),
    ];
    const report = buildLedgerReport(entries);
    assert.deepEqual(
      report.open_priorities.map((e) => e.id),
      ['BB-101', 'BB-102', 'BB-103', 'BB-100', 'BB-104', 'BB-105'],
    );
  });

  test('generated_at is included only when explicitly provided', () => {
    const base = buildLedgerReport([]);
    assert.equal(base.generated_at, undefined);
    const stamped = buildLedgerReport([], { generatedAt: '2026-08-21T12:00:00.000Z' });
    assert.equal(stamped.generated_at, '2026-08-21T12:00:00.000Z');
  });

  test('empty ledger yields zeroed totals and empty priorities', () => {
    const report = buildLedgerReport([]);
    assert.deepEqual(report.totals_by_status, {
      OPEN: 0,
      INTERVENTION_SHIPPED: 0,
      CONFIRMED: 0,
      FALSIFIED: 0,
    });
    assert.deepEqual(report.open_priorities, []);
  });

  test('report building is deterministic', () => {
    const entries = [ledgerEntry({ id: 'BB-001' }), confirmedEntry('BB-002')];
    const a = buildLedgerReport(entries);
    const b = buildLedgerReport(structuredClone(entries));
    assert.deepEqual(a, b);
  });
});
