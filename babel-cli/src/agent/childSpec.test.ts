/**
 * S03/#213 — effective child spec + identity (T03/T04/T05).
 *
 * T03: every declared option (max_rounds, instructions, model) is honored,
 *      explicitly rejected, or clamped with a reason for both read and mutation.
 * T04: an inherited wall/cost stop is labelled truthfully, not as round exhaustion.
 * T05: child identity is bound to the parent delegation (distinct batches ->
 *      distinct ids; same delegation -> stable id; retry dir cannot overwrite).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CHILD_MUTATION_DEFAULT_ROUNDS,
  CHILD_READ_DEFAULT_ROUNDS,
  CHILD_ROUNDS_MAX,
  CHILD_ROUNDS_MIN,
  formatChildSpecReceipt,
  resolveChildSpec,
} from './childSpec.js';
import { childAttemptDir, deriveChildDelegationId } from './chatEngine.js';
import {
  childBudgetAttribution,
  subagentFinishedCleanly,
} from './lanes/runMutationAgentLoop.js';
import { inheritedChildBudgetLimiter } from './childBudget.js';

const BASE = {
  mutation: false,
  writeScope: [] as string[],
  parentModel: 'parent/provider-model',
};

describe('S03/#213 T03 — requested vs effective child rounds', () => {
  const cases: Array<{
    requested: number | null | undefined;
    read: [number, 'default' | 'honored' | 'clamped', string | null];
    mutation: [number, 'default' | 'honored' | 'clamped', string | null];
  }> = [
    { requested: undefined, read: [CHILD_READ_DEFAULT_ROUNDS, 'default', null], mutation: [CHILD_MUTATION_DEFAULT_ROUNDS, 'default', null] },
    { requested: null, read: [CHILD_READ_DEFAULT_ROUNDS, 'default', null], mutation: [CHILD_MUTATION_DEFAULT_ROUNDS, 'default', null] },
    { requested: NaN, read: [CHILD_READ_DEFAULT_ROUNDS, 'default', null], mutation: [CHILD_MUTATION_DEFAULT_ROUNDS, 'default', null] },
    { requested: 1, read: [1, 'honored', null], mutation: [1, 'honored', null] },
    { requested: 7, read: [7, 'honored', null], mutation: [7, 'honored', null] },
    { requested: CHILD_ROUNDS_MAX, read: [CHILD_ROUNDS_MAX, 'honored', null], mutation: [CHILD_ROUNDS_MAX, 'honored', null] },
    { requested: CHILD_ROUNDS_MAX + 1, read: [CHILD_ROUNDS_MAX, 'clamped', 'above_ceiling_20'], mutation: [CHILD_ROUNDS_MAX, 'clamped', 'above_ceiling_20'] },
    { requested: 0, read: [CHILD_ROUNDS_MIN, 'clamped', 'below_floor_1'], mutation: [CHILD_ROUNDS_MIN, 'clamped', 'below_floor_1'] },
    { requested: -3, read: [CHILD_ROUNDS_MIN, 'clamped', 'below_floor_1'], mutation: [CHILD_ROUNDS_MIN, 'clamped', 'below_floor_1'] },
    { requested: 3.9, read: [3, 'clamped', 'non_integer_truncated'], mutation: [3, 'clamped', 'non_integer_truncated'] },
  ];

  for (const c of cases) {
    test(`read max_rounds=${String(c.requested)} -> ${c.read[0]} (${c.read[1]})`, () => {
      const spec = resolveChildSpec({
        ...BASE,
        mutation: false,
        ...(c.requested !== undefined ? { maxRounds: c.requested } : {}),
      });
      assert.equal(spec.effectiveRounds, c.read[0]);
      assert.equal(spec.roundsDisposition, c.read[1]);
      assert.equal(spec.roundsClampReason, c.read[2]);
      assert.equal(
        spec.requestedRounds,
        typeof c.requested === 'number' && Number.isFinite(c.requested) ? c.requested : null,
      );
    });
    test(`mutation max_rounds=${String(c.requested)} -> ${c.mutation[0]} (${c.mutation[1]})`, () => {
      const spec = resolveChildSpec({
        ...BASE,
        mutation: true,
        ...(c.requested !== undefined ? { maxRounds: c.requested } : {}),
      });
      assert.equal(spec.effectiveRounds, c.mutation[0]);
      assert.equal(spec.roundsDisposition, c.mutation[1]);
      assert.equal(spec.roundsClampReason, c.mutation[2]);
    });
  }

  test('control: advertised mutation default no longer disagrees with effective rounds', () => {
    // Pre-S03: the schema advertised a mutation default of 8, while dispatch
    // hardcoded SUB_AGENT_MAX_ROUNDS=4 and ignored requested max_rounds.
    assert.equal(CHILD_MUTATION_DEFAULT_ROUNDS, 8);
    assert.equal(
      resolveChildSpec({ ...BASE, mutation: true }).effectiveRounds,
      CHILD_MUTATION_DEFAULT_ROUNDS,
    );
    // A requested mutation value is honored, not overwritten by a constant.
    assert.equal(
      resolveChildSpec({ ...BASE, mutation: true, maxRounds: 12 }).effectiveRounds,
      12,
    );
  });

  test('read and mutation defaults differ (4 vs 8) and both are clamped to 1-20', () => {
    const read = resolveChildSpec({ ...BASE });
    const mutation = resolveChildSpec({ ...BASE, mutation: true });
    assert.equal(read.effectiveRounds, 4);
    assert.equal(mutation.effectiveRounds, 8);
    assert.notEqual(read.effectiveRounds, mutation.effectiveRounds);
  });
});

describe('S03/#213 T03 — instructions and model dispositions', () => {
  test('instructions sentinel is forwarded for both read and mutation', () => {
    const sentinel = 'INSTRUCTION_SENTINEL_S03';
    for (const mutation of [false, true]) {
      const spec = resolveChildSpec({ ...BASE, mutation, instructions: sentinel });
      assert.equal(spec.instructions, sentinel);
      assert.equal(spec.instructionsDisposition, 'forwarded');
    }
  });

  test('absent / blank instructions are reported as absent, not silently unsupported', () => {
    assert.equal(resolveChildSpec({ ...BASE }).instructionsDisposition, 'absent');
    assert.equal(resolveChildSpec({ ...BASE, instructions: '   ' }).instructionsDisposition, 'absent');
  });

  test('model override vs parent default is reported truthfully', () => {
    const override = resolveChildSpec({ ...BASE, model: 'scout' });
    assert.equal(override.resolvedModel, 'scout');
    assert.equal(override.modelDisposition, 'override');
    assert.equal(override.requestedModel, 'scout');

    const fallback = resolveChildSpec({ ...BASE, model: null });
    assert.equal(fallback.resolvedModel, 'parent/provider-model');
    assert.equal(fallback.modelDisposition, 'parent_default');
    assert.equal(fallback.requestedModel, null);
  });

  test('receipt is derived from the resolved spec', () => {
    const spec = resolveChildSpec({ ...BASE, mutation: true, maxRounds: 50, model: 'scout' });
    const receipt = formatChildSpecReceipt(spec);
    assert.match(receipt, /rounds=20\(clamped:above_ceiling_20\)/);
    assert.match(receipt, /model=scout\(override\)/);
    assert.match(receipt, /instructions=absent/);
    assert.match(receipt, /write_scope=0/);
  });
});

describe('S03/#213 T04 — inherited wall/cost stops are not round exhaustion', () => {
  test('childBudgetAttribution distinguishes wall and cost from rounds', () => {
    assert.equal(childBudgetAttribution('wall'), 'child_wall_exhaustion');
    assert.equal(childBudgetAttribution('cost'), 'child_cost_exhaustion');
    assert.equal(childBudgetAttribution(undefined), 'child_round_exhaustion');
    for (const a of [
      childBudgetAttribution('wall'),
      childBudgetAttribution('cost'),
      childBudgetAttribution(undefined),
    ] as const) {
      assert.equal(subagentFinishedCleanly(a), false, `${a} is not a clean finish`);
    }
  });

  test('exhausted parent wall and cost allowances resolve to distinct limiters', () => {
    const wall = inheritedChildBudgetLimiter({
      costBaselineUsd: 0,
      remainingCostUsd: null,
      deadlineAtMs: Date.now() - 1,
      maxRounds: 4,
    });
    assert.equal(wall, 'wall');
    assert.equal(childBudgetAttribution(wall), 'child_wall_exhaustion');

    const cost = inheritedChildBudgetLimiter({
      costBaselineUsd: 0,
      remainingCostUsd: 0,
      deadlineAtMs: null,
      maxRounds: 4,
    });
    assert.equal(cost, 'cost');
    assert.equal(childBudgetAttribution(cost), 'child_cost_exhaustion');
  });
});

describe('S03/#213 T05 — stable delegation identity and attempt isolation', () => {
  const base = {
    parentRunId: 'run-1',
    turnId: 'turn-1',
    batchId: 'batch_1_0',
    actionIndex: 0,
    fingerprint: 'fp-read-abc',
  };

  test('same delegation is stable; distinct batches/actions/fingerprints are distinct', () => {
    const a = deriveChildDelegationId(base);
    assert.equal(deriveChildDelegationId({ ...base }), a, 'same inputs -> same id');
    assert.match(a, /^chat-sub-[0-9a-f]{12}$/);

    assert.notEqual(deriveChildDelegationId({ ...base, batchId: 'batch_2_5' }), a);
    assert.notEqual(deriveChildDelegationId({ ...base, turnId: 'turn-2' }), a);
    assert.notEqual(deriveChildDelegationId({ ...base, actionIndex: 1 }), a);
    assert.notEqual(deriveChildDelegationId({ ...base, fingerprint: 'fp-write-xyz' }), a);
    assert.notEqual(deriveChildDelegationId({ ...base, parentRunId: 'run-2' }), a);
  });

  test('control: the removed batch-local counter aliased two batches; hashed ids do not', () => {
    // The pre-S03 dispatch used `chat-sub-${subAgentCounter}` and reset the
    // counter on every executeActions call, so two successive batches produced
    // the same ids (and the same runDir). Assert the control, then the fix.
    const oldStyleA = ['chat-sub-1', 'chat-sub-2'];
    const oldStyleB = ['chat-sub-1', 'chat-sub-2'];
    assert.deepEqual(oldStyleA, oldStyleB, 'control: batch-local counter aliases across batches');

    const batchA = [
      deriveChildDelegationId({ ...base, batchId: 'batch_1_0' }),
      deriveChildDelegationId({ ...base, batchId: 'batch_1_0', actionIndex: 1 }),
    ];
    const batchB = [
      deriveChildDelegationId({ ...base, batchId: 'batch_2_5' }),
      deriveChildDelegationId({ ...base, batchId: 'batch_2_5', actionIndex: 1 }),
    ];
    assert.notDeepEqual(batchA, batchB, 'delegation ids are distinct across batches');
    assert.equal(new Set([...batchA, ...batchB]).size, 4, 'all four ids are distinct');
  });

  test('retry attempt dirs are distinct and do not alias the original evidence', () => {
    const id = deriveChildDelegationId(base);
    const first = childAttemptDir('/runs/engine', id, 1);
    const retry = childAttemptDir('/runs/engine', id, 2);
    assert.notEqual(first, retry);
    assert.match(first, /attempt-1$/);
    assert.match(retry, /attempt-2$/);
    // Path *structure*, not a hard-coded separator: `join` is platform-native,
    // so win32 yields `\runs\engine\<id>\attempt-N`. Normalize and assert the
    // delegation id is the immediate parent dir (the attempt dirs cannot alias).
    const normalized = (p: string): string => p.replace(/\\/g, '/');
    assert.equal(normalized(first), `/runs/engine/${id}/attempt-1`);
    assert.equal(normalized(retry), `/runs/engine/${id}/attempt-2`);
    // Same delegation id is retained across attempts (identity stable).
    assert.equal(id, deriveChildDelegationId(base));
  });
});
