/**
 * D03 — the review card branches on the structured reason code, never on prose.
 * The previous defect: every BLOCKED card advised "Review the blocked capability",
 * including pure no-progress exhaustion.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewCard, getContextualNextActions } from './reviewCard.js';

describe('D03 reviewCard reason-first guidance', () => {
  test('recovery exhaustion is not presented as a missing capability', () => {
    const card = buildReviewCard({
      outcome: 'BLOCKED_POLICY',
      status: 'blocked',
      reasonCode: 'recovery_exhausted',
      causeClass: 'model',
    });
    assert.equal(card.kind, 'BLOCKED');
    assert.match(card.body, /No progress after recovery/);
    assert.match(card.body, /Inspect diagnostics/);
    assert.match(card.body, /Narrow scope/);
    assert.doesNotMatch(card.body, /Review the blocked capability/);
    assert.doesNotMatch(card.body, /permission/i);
  });

  test('reason code outranks diagnostic prose (no prose-derived authority)', () => {
    const actions = getContextualNextActions('BLOCKED', {
      outcome: 'BLOCKED_POLICY',
      status: 'blocked',
      reasonCode: 'recovery_exhausted',
      // A misleading free-text summary must not re-route the guidance.
      summary: 'permission denied by policy',
    });
    assert.deepEqual(actions.slice(0, 2), ['Inspect diagnostics', 'Narrow scope']);
  });

  test('permission denial names the policy boundary', () => {
    const actions = getContextualNextActions('BLOCKED', {
      outcome: 'BLOCKED_POLICY',
      status: 'blocked',
      reasonCode: 'permission_denied',
      causeClass: 'harness',
    });
    assert.ok(actions.some((a) => /permission/i.test(a)), actions.join(','));
  });

  test('external dependency guidance is not permission guidance', () => {
    const card = buildReviewCard({
      outcome: 'BLOCKED_EXTERNAL',
      status: 'blocked',
      reasonCode: 'external_dependency',
      causeClass: 'environment',
    });
    assert.match(card.body, /external dependency/i);
    assert.doesNotMatch(card.body, /Review permission/);
  });

  test('provider failure and budget exhaustion keep their canonical actions', () => {
    assert.deepEqual(
      getContextualNextActions('INFRA_FAILURE', { reasonCode: 'provider_failure' }),
      ['Retry'],
    );
    assert.deepEqual(
      getContextualNextActions('BUDGET_EXHAUSTED', { reasonCode: 'budget_exhausted' }),
      ['Follow-up to continue'],
    );
  });

  test('unknown reason does not fabricate a cause', () => {
    const card = buildReviewCard({ status: 'blocked', reasonCode: 'unknown' });
    assert.match(card.body, /not established/i);
  });

  test('cancelled keeps the existing diff affordance only when files changed', () => {
    assert.deepEqual(
      getContextualNextActions('CANCELLED', { reasonCode: 'cancelled', changedFiles: ['a.ts'] }),
      ['[D] Diff (if workspace changed)'],
    );
    assert.deepEqual(
      getContextualNextActions('CANCELLED', { reasonCode: 'cancelled' }),
      [],
    );
  });

  test('explicit caller nextActions still win over reason guidance', () => {
    assert.deepEqual(
      getContextualNextActions('BLOCKED', {
        reasonCode: 'recovery_exhausted',
        nextActions: ['Custom'],
      }),
      ['Custom'],
    );
  });

  test('cards without a reason code are byte-identical to the legacy path', () => {
    const legacy = buildReviewCard({ outcome: 'BLOCKED_POLICY', status: 'blocked' });
    assert.match(legacy.body, /Review the blocked capability/);
    assert.doesNotMatch(legacy.body, /No progress after recovery/);
  });
});


test('context refusal names the blocked dispatch, never promises an unadmitted fallback, and retains accounting', () => {
  // A context-preparation refusal is emitted only when dispatch was refused.
  // Unavailable repository coverage *alone* is not a refusal — V2 continuation
  // installs and dispatches (inTurnContextOrdering / contextPreparation
  // integration tests) — so the refusal guidance must not promise continuation.
  const card = buildReviewCard({ outcome: 'BLOCKED_POLICY', status: 'blocked', reasonCode: 'context_preparation_failed',
    causeClass: 'harness', costUsd: 0.039075115852, unknownChargeCount: 1, usageScope: 'task', tokens: 3162714 })
  assert.match(card.body, /operational authority|durable state/i)
  assert.doesNotMatch(card.body, /conversation/i)
  assert.doesNotMatch(card.body, /--project-root/)
  assert.match(card.body, /0.0391 known subtotal this task/)
  assert.match(card.body, /1 unresolved charge/)
  assert.match(card.body, /3,162,714 cumulative tokens/)
  assert.doesNotMatch(card.body, /Unknown failure|Retry$/)
})


test('missing subtotal is unavailable rather than zero and incomplete scope stays qualified', () => {
  const missing = buildReviewCard({ outcome: 'BLOCKED_POLICY', unknownChargeCount: 1, tokens: 10 })
  assert.doesNotMatch(missing.body, /\$0.0000/)
  assert.match(missing.body, /cost unavailable/i)
  const incomplete = buildReviewCard({ outcome: 'BLOCKED_POLICY', costUsd: 0.0391, costComplete: false })
  assert.match(incomplete.body, /known subtotal/)
  assert.match(incomplete.body, /cost incomplete/)
})

test('published usage estimates remain separate from known task charges', () => {
  const card = buildReviewCard({ outcome: 'BLOCKED_POLICY', costUsd: 0, estimatedCostUsd: 0.01, costComplete: false })
  assert.match(card.body, /0.0000 known subtotal/)
  assert.match(card.body, /0.0100 usage estimate/)
  assert.doesNotMatch(card.body, /0.0100 known/)
})
