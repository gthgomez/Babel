/**
 * Tests for pairedStats/pairOutcomeMatrix.ts (workstream D / W3).
 * Pure fixtures only — no network, no LLM; writer test uses a tmpdir.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  NormalizedAttemptOutcomeSchema,
  REFERENCE_ARM,
} from './contracts.js';
import type { NormalizedAttemptOutcome } from './contracts.js';
import {
  MIN_REPLICATES_FOR_SUSPECT,
  PairOutcomeMatrixArtifactSchema,
  buildPairOutcomeMatrix,
  wilsonScoreInterval,
  writeFilePairOutcomeMatrix,
} from './pairOutcomeMatrix.js';

const FIXED_TS = '2026-08-21T00:00:00.000Z';

function att(
  pairId: string,
  taskId: string,
  arm: string,
  replicateId: number,
  success: boolean | null,
  extra: Partial<NormalizedAttemptOutcome> = {},
): NormalizedAttemptOutcome {
  return NormalizedAttemptOutcomeSchema.parse({
    pair_id: pairId,
    task_id: taskId,
    arm,
    replicate_id: replicateId,
    attempt_id: `${arm}:${pairId}:r${replicateId}`,
    success,
    ...extra,
  });
}

const BABEL = 'babel_enforce';

function approx(a: number | null | undefined, b: number, eps = 1e-9): boolean {
  return a != null && Math.abs(a - b) < eps;
}

// ─── Arm summaries ───────────────────────────────────────────────────────────

describe('arm summaries', () => {
  test('counts pass/fail/null honestly with rate over resolved only', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', BABEL, 1, false),
        att('p2', 't2', BABEL, 0, null),
        att('p3', 't3', 'raw_opencode', 0, true),
      ],
      { generatedAt: FIXED_TS },
    );
    const babel = artifact.arm_summaries.find((s) => s.arm === BABEL);
    assert.ok(babel);
    assert.equal(babel.n_pass, 1);
    assert.equal(babel.n_fail, 1);
    assert.equal(babel.n_null, 1);
    assert.equal(babel.pass_rate, 0.5);
  });

  test('arm with zero resolved attempts gets pass_rate null and null interval', () => {
    const artifact = buildPairOutcomeMatrix([att('p1', 't1', BABEL, 0, null)], {
      generatedAt: FIXED_TS,
    });
    const babel = artifact.arm_summaries.find((s) => s.arm === BABEL);
    assert.ok(babel);
    assert.equal(babel.pass_rate, null);
    assert.equal(babel.pass_rate_wilson_95, null);
  });

  test('harness identity is carried from attempts when present', () => {
    const harness = { name: 'babel' as const, adapter_id: 'babel_cli_chat_headless', version: null };
    const without = { name: 'opencode' as const, adapter_id: 'opencode_cli_raw', version: null };
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', BABEL, 1, true),
        att('p1', 't1', BABEL, 0, true, { harness }),
        att('p1', 't1', 'raw_opencode', 0, false, { harness: without }),
      ],
      { generatedAt: FIXED_TS },
    );
    const babel = artifact.arm_summaries.find((s) => s.arm === BABEL);
    assert.ok(babel);
    assert.deepEqual(babel.harness, harness);
    const raw = artifact.arm_summaries.find((s) => s.arm === 'raw_opencode');
    assert.ok(raw);
    assert.deepEqual(raw.harness, without);
  });
});

// ─── Pair classification ─────────────────────────────────────────────────────

describe('pair classification', () => {
  test('edge 1: zero successes on BOTH sides → both_fail, delta contribution 0', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, false),
        att('p1', 't1', 'raw_opencode', 1, false),
        att('p1', 't1', BABEL, 0, false),
        att('p1', 't1', BABEL, 1, false),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(artifact.totals_by_classification['both_fail'], 1);
    const delta = artifact.pairwise_deltas.find((d) => d.candidate_arm === BABEL);
    assert.ok(delta);
    assert.equal(delta.success_delta, 0);
    assert.equal(delta.ref_pass_rate, 0);
    assert.equal(delta.cand_pass_rate, 0);
  });

  test('uplift cell: ref majority fail, candidate majority pass', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, false),
        att('p1', 't1', 'raw_opencode', 1, false),
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', BABEL, 1, true),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(artifact.totals_by_classification['uplift_babel_only'], 1);
    assert.equal(artifact.uplift_pairs.length, 1);
    assert.equal(artifact.uplift_pairs[0]?.pair_id, 'p1');
    assert.equal(artifact.suppression_suspects.length, 0);
  });

  test('suppression cell: ref majority pass, candidate majority fail', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, true),
        att('p1', 't1', 'raw_opencode', 1, true),
        att('p1', 't1', BABEL, 0, false),
        att('p1', 't1', BABEL, 1, false),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(artifact.totals_by_classification['suppression_suspect_raw_only'], 1);
    assert.equal(artifact.suppression_suspects.length, 1);
    assert.equal(artifact.uplift_pairs.length, 0);
  });

  test('edge 3: all-null attempts for one arm → pass_rate null, pairs incomplete', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', BABEL, 0, null),
        att('p1', 't1', BABEL, 1, null),
        att('p1', 't1', 'raw_opencode', 0, true),
      ],
      { generatedAt: FIXED_TS },
    );
    const babel = artifact.arm_summaries.find((s) => s.arm === BABEL);
    assert.ok(babel);
    assert.equal(babel.n_null, 2);
    assert.equal(babel.pass_rate, null);
    assert.equal(artifact.totals_by_classification['incomplete'], 1);
    // Reference attempts exist in the pair, so it is not "missing reference".
    assert.equal(artifact.pairs_missing_reference_count, 0);
  });

  test('edge 6: tie majority (2 vs 2) resolves to ambiguous_tie, never a directional cell', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, true),
        att('p1', 't1', 'raw_opencode', 1, false),
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', BABEL, 1, false),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(artifact.totals_by_classification['ambiguous_tie'], 1);
    assert.equal(artifact.totals_by_classification['both_pass'], 0);
    assert.equal(artifact.totals_by_classification['incomplete'], 0);
  });

  test('edge 2: reference arm absent entirely → no classifications, missing-reference count correct', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', 'babel_shadow', 0, false),
        att('p2', 't2', BABEL, 0, false),
        att('p2', 't2', 'babel_shadow', 0, false),
      ],
      { generatedAt: FIXED_TS },
    );
    for (const cls of Object.keys(artifact.totals_by_classification)) {
      assert.equal(artifact.totals_by_classification[cls], 0, `expected zero for ${cls}`);
    }
    assert.equal(artifact.pairs_missing_reference_count, 2);
    assert.deepEqual(artifact.pairwise_deltas, []);
    assert.equal(artifact.arm_summaries.length, 2);
  });

  test('totals cover the full classification vocabulary and order by count desc then key asc', () => {
    // Two RESOLVED replicates per arm so the uplift cell also clears the
    // symmetric MIN_REPLICATES_FOR_SUSPECT candidate-list gate honestly.
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', BABEL, 1, true),
        att('p1', 't1', 'raw_opencode', 0, false),
        att('p1', 't1', 'raw_opencode', 1, false),
      ],
      { generatedAt: FIXED_TS },
    );
    const keys = Object.keys(artifact.totals_by_classification);
    assert.equal(keys.length, 6);
    assert.equal(keys[0], 'uplift_babel_only');
    const counts = keys.map((k) => artifact.totals_by_classification[k] ?? 0);
    const sortedCopy = [...counts].sort((a, b) => b - a);
    assert.deepEqual(counts, sortedCopy);
  });
});

// ─── Candidate-list gating symmetry + input uniqueness ───────────────────────

describe('suspect/uplift gating symmetry and input uniqueness', () => {
  test('m3: single-resolved-replicate uplift stays out of uplift_pairs but remains in classification totals', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, false),
        att('p1', 't1', 'raw_opencode', 1, false),
        att('p1', 't1', BABEL, 0, true), // only ONE resolved candidate replicate
      ],
      { generatedAt: FIXED_TS },
    );
    // Classification is ungated — the cell is still counted and its delta
    // evidence remains visible in pairwise_deltas.
    assert.equal(artifact.totals_by_classification['uplift_babel_only'], 1);
    const delta = artifact.pairwise_deltas.find((d) => d.candidate_arm === BABEL);
    assert.ok(delta);
    assert.equal(delta.success_delta, 1);
    // Only the CANDIDATE LIST is gated, symmetrically with suppression_suspects.
    assert.deepEqual(artifact.uplift_pairs, []);
    assert.deepEqual(artifact.suppression_suspects, []);
  });

  test('m3: uplift with MIN_REPLICATES_FOR_SUSPECT resolved replicates IS listed; gate counts resolved, not rows', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, false),
        att('p1', 't1', 'raw_opencode', 1, false),
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', BABEL, 1, true),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.deepEqual(artifact.uplift_pairs, [
      { pair_id: 'p1', task_id: 't1', candidate_arm: BABEL },
    ]);
    assert.equal(artifact.totals_by_classification['uplift_babel_only'], 1);

    // Boundary: two replicate ROWS but one unresolved → still gated out,
    // proving the gate counts RESOLVED replicates exactly like the suspect side.
    const nullGated = buildPairOutcomeMatrix(
      [
        att('p2', 't2', 'raw_opencode', 0, false),
        att('p2', 't2', 'raw_opencode', 1, false),
        att('p2', 't2', BABEL, 0, true),
        att('p2', 't2', BABEL, 1, null),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(nullGated.totals_by_classification['uplift_babel_only'], 1);
    assert.deepEqual(nullGated.uplift_pairs, []);
  });

  test('m5: duplicate (pair_id, arm, replicate_id) triple throws fail-closed, naming the triple', () => {
    const duplicated = [
      att('p1', 't1', 'raw_opencode', 0, false),
      att('p1', 't1', BABEL, 0, true),
      att('p1', 't1', BABEL, 0, false), // same triple, conflicting outcome — must NOT be deduped
    ];
    assert.throws(
      () => buildPairOutcomeMatrix(duplicated, { generatedAt: FIXED_TS }),
      /duplicate \(pair_id, arm, replicate_id\) triple.*"p1".*"babel_enforce".*replicate_id=0/,
    );
    // Deterministic naming independent of caller element order.
    assert.throws(
      () => buildPairOutcomeMatrix([...duplicated].reverse(), { generatedAt: FIXED_TS }),
      /replicate_id=0/,
    );
    // Distinct replicate_ids remain perfectly legal — no false positives.
    const legal = buildPairOutcomeMatrix(
      [
        ...duplicated.slice(0, 2),
        att('p1', 't1', BABEL, 1, false),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(legal.totals_by_classification['ambiguous_tie'], 1);
  });

  test('determinism unaffected by gating/uniqueness changes: same multiset in any order → deep-equal artifact', () => {
    const mixed: NormalizedAttemptOutcome[] = [
      // uplift pair, gated OUT (single resolved candidate replicate)
      att('p_gated', 'tg', 'raw_opencode', 0, false),
      att('p_gated', 'tg', 'raw_opencode', 1, false),
      att('p_gated', 'tg', BABEL, 5, true),
      // uplift pair, LISTED (two resolved replicates)
      att('p_listed', 'tl', 'raw_opencode', 0, false),
      att('p_listed', 'tl', 'raw_opencode', 1, false),
      att('p_listed', 'tl', BABEL, 0, true),
      att('p_listed', 'tl', BABEL, 1, true),
      // suppression pair, LISTED (two resolved replicates)
      att('p_supp', 'ts', 'raw_opencode', 0, true),
      att('p_supp', 'ts', 'raw_opencode', 1, true),
      att('p_supp', 'ts', BABEL, 0, false),
      att('p_supp', 'ts', BABEL, 1, false),
    ];
    const a = buildPairOutcomeMatrix(mixed, { generatedAt: FIXED_TS });
    const b = buildPairOutcomeMatrix(mixed, { generatedAt: FIXED_TS });
    assert.deepStrictEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.deepEqual(a.uplift_pairs.map((u) => u.pair_id), ['p_listed']);
    assert.deepEqual(a.suppression_suspects.map((s) => s.pair_id), ['p_supp']);
    // Canonical sort makes the artifact independent of caller element order.
    const shuffled = buildPairOutcomeMatrix([...mixed].reverse(), { generatedAt: FIXED_TS });
    assert.deepStrictEqual(shuffled, a);
  });
});

// ─── Deltas, intervals, ratio ────────────────────────────────────────────────

describe('pairwise deltas, Wilson intervals, ratio stability', () => {
  test('edge 5: roadmap example scaled — raw 8/10 vs babel 3/10, delta −0.5, suspects gated by MIN_REPLICATES', () => {
    const P = true;
    const F = false;
    // Exactly the roadmap numbers over two paired tasks: raw 8/10, babel 3/10.
    const coreAttempts: NormalizedAttemptOutcome[] = [
      // p_a: raw 4/5, babel_enforce 1/5 → suppression suspect (5 resolved ≥ MIN)
      ...[P, P, P, P, F].map((s, i) => att('p_a', 'task_a', 'raw_opencode', i, s)),
      ...[F, F, F, F, P].map((s, i) => att('p_a', 'task_a', BABEL, i, s)),
      // p_b: raw 4/5, babel_enforce 2/5 → suppression suspect
      ...[P, P, P, P, F].map((s, i) => att('p_b', 'task_b', 'raw_opencode', i, s)),
      ...[F, F, F, P, P].map((s, i) => att('p_b', 'task_b', BABEL, i, s)),
    ];
    const artifact = buildPairOutcomeMatrix(coreAttempts, { generatedAt: FIXED_TS });

    assert.equal(MIN_REPLICATES_FOR_SUSPECT, 2);

    const raw = artifact.arm_summaries.find((s) => s.arm === 'raw_opencode');
    const babel = artifact.arm_summaries.find((s) => s.arm === BABEL);
    assert.ok(raw && babel);
    assert.equal(raw.pass_rate, 0.8);
    assert.equal(babel.pass_rate, 0.3);

    const delta = artifact.pairwise_deltas.find((d) => d.candidate_arm === BABEL);
    assert.ok(delta);
    const d = delta.success_delta;
    const ciLow = delta.delta_ci_low;
    const ciHigh = delta.delta_ci_high;
    assert.ok(approx(d, -0.5));
    assert.ok(d !== null && d < 0, 'delta must be negative');
    assert.ok(
      ciLow !== null &&
        ciHigh !== null &&
        ciLow <= d! &&
        d! <= ciHigh,
      'delta CI must contain the point estimate',
    );
    assert.equal(delta.n_pairs, 2);

    // Ratio is secondary and stable here: 0.3 / 0.8 = 0.375.
    assert.equal(delta.ratio_stability, 'ok');
    assert.ok(approx(delta.success_rate_ratio, 0.375));

    assert.deepEqual(artifact.suppression_suspects, [
      { pair_id: 'p_a', task_id: 'task_a', candidate_arm: BABEL },
      { pair_id: 'p_b', task_id: 'task_b', candidate_arm: BABEL },
    ]);
    assert.equal(artifact.uplift_pairs.length, 0);
    assert.equal(artifact.totals_by_classification['suppression_suspect_raw_only'], 2);
    assert.equal(Object.keys(artifact.totals_by_classification)[0], 'suppression_suspect_raw_only');

    // MIN_REPLICATES gate: a suspect-classified cell with a single candidate
    // replicate stays OUT of suppression_suspects (single-run noise guard).
    const gateArtifact = buildPairOutcomeMatrix(
      [
        ...coreAttempts,
        att('p_c', 'task_c', 'raw_opencode', 0, P),
        att('p_c', 'task_c', 'raw_opencode', 1, P),
        att('p_c', 'task_c', 'babel_shadow', 0, F),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(gateArtifact.totals_by_classification['suppression_suspect_raw_only'], 3);
    assert.deepEqual(gateArtifact.suppression_suspects, [
      { pair_id: 'p_a', task_id: 'task_a', candidate_arm: BABEL },
      { pair_id: 'p_b', task_id: 'task_b', candidate_arm: BABEL },
    ]);
    const shadowDelta = gateArtifact.pairwise_deltas.find(
      (x) => x.candidate_arm === 'babel_shadow',
    );
    assert.ok(shadowDelta);
    assert.equal(shadowDelta.n_pairs, 1);
  });

  test('edge 4: replicate imbalance (3 ref reps, 1 cand rep)', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, true),
        att('p1', 't1', 'raw_opencode', 1, true),
        att('p1', 't1', 'raw_opencode', 2, false),
        att('p1', 't1', BABEL, 0, true),
      ],
      { generatedAt: FIXED_TS },
    );
    assert.equal(artifact.totals_by_classification['both_pass'], 1);
    const delta = artifact.pairwise_deltas.find((d) => d.candidate_arm === BABEL);
    assert.ok(delta);
    assert.equal(delta.n_pairs, 1);
    assert.ok(approx(delta.ref_pass_rate, 2 / 3));
    assert.equal(delta.cand_pass_rate, 1);
    assert.ok(approx(delta.success_delta, 1 / 3));
  });

  test('edge 8: reference rate 0 but candidate >0 → ratio null + unstable flag', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, false),
        att('p1', 't1', 'raw_opencode', 1, false),
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', BABEL, 1, true),
      ],
      { generatedAt: FIXED_TS },
    );
    const delta = artifact.pairwise_deltas.find((d) => d.candidate_arm === BABEL);
    assert.ok(delta);
    assert.equal(delta.ref_pass_rate, 0);
    assert.equal(delta.cand_pass_rate, 1);
    assert.equal(delta.success_rate_ratio, null);
    assert.equal(delta.ratio_stability, 'unstable_reference_near_zero');
    assert.equal(delta.success_delta, 1);
  });

  test('wilson interval contains the point estimate and degrades to null at n=0', () => {
    const ci = wilsonScoreInterval(5, 10);
    assert.ok(ci);
    assert.ok(ci.low <= 0.5 && 0.5 <= ci.high);
    assert.ok(ci.low >= 0 && ci.high <= 1);
    const tight = wilsonScoreInterval(50, 100)!;
    assert.ok(tight.high - tight.low < ci.high - ci.low, 'larger n narrows the interval');
    assert.equal(wilsonScoreInterval(0, 0), null);
    const degenerate = wilsonScoreInterval(0, 3)!;
    assert.equal(degenerate.low, 0);
    assert.ok(degenerate.high > 0);
  });

  test('delta CI is emitted whenever both rates exist, even at extremes (clamped to [-1, 1])', () => {
    const artifact = buildPairOutcomeMatrix(
      [
        att('p1', 't1', 'raw_opencode', 0, false),
        att('p1', 't1', 'raw_opencode', 1, false),
        att('p1', 't1', BABEL, 0, true),
        att('p1', 't1', BABEL, 1, true),
      ],
      { generatedAt: FIXED_TS },
    );
    const delta = artifact.pairwise_deltas[0];
    assert.ok(delta);
    assert.notEqual(delta.delta_ci_low, null);
    assert.notEqual(delta.delta_ci_high, null);
    assert.ok(delta.delta_ci_low! >= -1 && delta.delta_ci_high! <= 1);
    assert.ok(delta.delta_ci_low! <= delta.success_delta! && delta.success_delta! <= delta.delta_ci_high!);
  });
});

// ─── Artifact shape, determinism, task classes, writer ──────────────────────

describe('artifact shape and determinism', () => {
  const FIXTURE: NormalizedAttemptOutcome[] = [
    att('p1', 't1', 'raw_opencode', 0, true, { task_class: 'tooling' }),
    att('p1', 't1', BABEL, 0, true, { task_class: 'tooling' }),
    att('p2', 't2', 'raw_opencode', 0, true, { task_class: 'reasoning' }),
    att('p2', 't2', BABEL, 0, false, { task_class: 'reasoning' }),
    att('p3', 't3', BABEL, 0, true),
  ];

  test('validates against its own zod schema; kind + version pinned', () => {
    const artifact = buildPairOutcomeMatrix(FIXTURE, { generatedAt: FIXED_TS });
    const parsed = PairOutcomeMatrixArtifactSchema.safeParse(artifact);
    assert.equal(parsed.success, true);
    assert.equal(artifact.kind, 'babel_pair_outcome_matrix');
    assert.equal(artifact.schema_version, 1);
    assert.equal(artifact.reference_arm, REFERENCE_ARM);
    assert.equal(artifact.generated_at, FIXED_TS);
  });

  test('edge 7: same input twice → deep-equal artifacts (determinism)', () => {
    const a = buildPairOutcomeMatrix(FIXTURE, { generatedAt: FIXED_TS });
    const b = buildPairOutcomeMatrix(FIXTURE, { generatedAt: FIXED_TS });
    assert.deepStrictEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('by_task_class groups under task_class ?? unclassified, recomputes rates/deltas per class', () => {
    const artifact = buildPairOutcomeMatrix(FIXTURE, { generatedAt: FIXED_TS });
    assert.deepEqual(
      artifact.by_task_class.map((b) => b.task_class),
      ['reasoning', 'tooling', 'unclassified'],
    );
    const reasoning = artifact.by_task_class.find((b) => b.task_class === 'reasoning');
    assert.ok(reasoning);
    assert.equal(reasoning.arm_summaries.length, 2);
    const reasoningRaw = reasoning.arm_summaries.find((s) => s.arm === 'raw_opencode');
    assert.ok(reasoningRaw);
    assert.equal(reasoningRaw.pass_rate, 1);
    // Within the reasoning class: raw passes, babel fails → suppression cell.
    assert.equal(reasoning.pairwise_deltas.find((d) => d.candidate_arm === BABEL)?.success_delta, -1);

    const unclassified = artifact.by_task_class.find((b) => b.task_class === 'unclassified');
    assert.ok(unclassified);
    // Only the candidate arm exists here — no deltas without the reference arm.
    assert.equal(unclassified.arm_summaries.length, 1);
    assert.deepEqual(unclassified.pairwise_deltas, []);
  });

  test('empty input produces an empty but well-formed matrix', () => {
    const artifact = buildPairOutcomeMatrix([], { generatedAt: FIXED_TS });
    assert.deepEqual(artifact.arm_summaries, []);
    assert.deepEqual(artifact.pairwise_deltas, []);
    assert.deepEqual(artifact.suppression_suspects, []);
    assert.deepEqual(artifact.uplift_pairs, []);
    assert.deepEqual(artifact.by_task_class, []);
    assert.equal(artifact.pairs_missing_reference_count, 0);
    assert.equal(Object.keys(artifact.totals_by_classification).length, 6);
  });
});

describe('writeFilePairOutcomeMatrix', () => {
  test('writes atomically to dir/pair-outcome-matrix.json and round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pom-test-'));
    try {
      const artifact = buildPairOutcomeMatrix(
        [
          att('p1', 't1', 'raw_opencode', 0, true),
          att('p1', 't1', BABEL, 0, true),
          att('p2', 't2', 'raw_opencode', 0, false),
          att('p2', 't2', 'raw_opencode', 1, false),
          // Second resolved replicate: the p2 uplift cell must clear the
          // symmetric MIN_REPLICATES_FOR_SUSPECT gate honestly.
          att('p2', 't2', BABEL, 0, true),
          att('p2', 't2', BABEL, 1, true),
        ],
        { generatedAt: FIXED_TS },
      );
      const path = writeFilePairOutcomeMatrix(dir, artifact);
      assert.equal(path, join(dir, 'pair-outcome-matrix.json'));
      const loaded: unknown = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(PairOutcomeMatrixArtifactSchema.safeParse(loaded).success, true);
      assert.deepEqual(loaded, artifact);
      // Idempotent rewrite over an existing file succeeds (Windows path).
      assert.equal(writeFilePairOutcomeMatrix(dir, artifact), path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
