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
