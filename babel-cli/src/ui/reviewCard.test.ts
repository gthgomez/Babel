import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stripAnsi } from './theme.js';
import {
  ALL_REVIEW_KINDS,
  buildReviewCard,
  classifyReviewCard,
  looksLikeVerifiedSuccess,
  presentChatReview,
  reviewCardKindToken,
} from './reviewCard.js';

describe('review card — truthful terminal states', () => {
  it('treats verifier-passed complete as VERIFIED_COMPLETE', () => {
    const card = presentChatReview({
      outcome: 'VERIFIED_COMPLETE',
      changedFiles: ['src/foo.ts'],
      verification: { ran: true, passed: true, command: 'npm test', exitCode: 0 },
      summary: 'Fixed retry leak',
      costUsd: 0.0123,
    });
    assert.equal(card.kind, 'VERIFIED_COMPLETE');
    assert.equal(card.looksLikeVerifiedSuccess, true);
    const text = stripAnsi(card.body);
    assert.match(text, /Verified complete/);
    assert.match(text, /src\/foo\.ts/);
    assert.match(text, /npm test/);
    assert.match(text, /REVIEW_KIND:VERIFIED_COMPLETE/);
  });

  it('does not treat mutation with no verifier as verified success', () => {
    const card = presentChatReview({
      outcome: 'UNVERIFIED_PATCH',
      changedFiles: ['src/foo.ts'],
      verification: { ran: false },
      summary: 'Edited foo',
    });
    assert.equal(card.kind, 'COMPLETE_UNVERIFIED');
    assert.equal(card.looksLikeVerifiedSuccess, false);
    const text = stripAnsi(card.body);
    assert.match(text, /unverified|Not run/i);
    assert.doesNotMatch(text, /Verified complete/);
    assert.match(text, /REVIEW_KIND:COMPLETE_UNVERIFIED/);
  });

  it('does not treat verification nonzero as verified success', () => {
    const card = presentChatReview({
      outcome: 'UNVERIFIED_PATCH',
      changedFiles: ['src/foo.ts'],
      verification: { ran: true, passed: false, command: 'npm test', exitCode: 1 },
    });
    assert.equal(card.kind, 'VERIFICATION_FAILED');
    assert.equal(looksLikeVerifiedSuccess(card.kind), false);
    const text = stripAnsi(card.body);
    assert.match(text, /Verification failed/);
    assert.match(text, /exit 1/);
  });

  it('classifies blocked, cancelled, budget, infra, and agent failure distinctly', () => {
    const cases = [
      { outcome: 'BLOCKED_POLICY', kind: 'BLOCKED' },
      { outcome: 'CANCELLED', kind: 'CANCELLED' },
      { outcome: 'BUDGET_EXHAUSTED', kind: 'BUDGET_EXHAUSTED' },
      { outcome: 'INFRA_FAILURE', kind: 'INFRA_FAILURE' },
      { outcome: 'AGENT_FAILURE', kind: 'AGENT_FAILURE' },
    ] as const;
    const titles = new Set<string>();
    for (const c of cases) {
      const card = presentChatReview({ outcome: c.outcome, summary: 'details' });
      assert.equal(card.kind, c.kind);
      assert.equal(card.looksLikeVerifiedSuccess, false);
      titles.add(card.title);
      assert.match(card.body, new RegExp(reviewCardKindToken(c.kind).replace(':', '\\:')));
    }
    assert.equal(titles.size, cases.length);
  });

  it('exposes every required kind as visually distinct', () => {
    const rendered = ALL_REVIEW_KINDS.map((kind) => {
      const card = presentChatReview({
        outcome:
          kind === 'COMPLETE_UNVERIFIED'
            ? 'UNVERIFIED_PATCH'
            : kind === 'VERIFICATION_FAILED'
              ? 'UNVERIFIED_PATCH'
              : kind,
        verification:
          kind === 'VERIFIED_COMPLETE'
            ? { ran: true, passed: true, command: 't', exitCode: 0 }
            : kind === 'VERIFICATION_FAILED'
              ? { ran: true, passed: false, command: 't', exitCode: 2 }
              : { ran: false },
        changedFiles: ['a.ts'],
      });
      return stripAnsi(card.body);
    });
    assert.equal(new Set(rendered).size, ALL_REVIEW_KINDS.length);
    for (const kind of ALL_REVIEW_KINDS) {
      assert.ok(
        rendered.some((r) => r.includes(`REVIEW_KIND:${kind}`)),
        `missing ${kind}`,
      );
    }
  });

  it('maps VERIFIED_COMPLETE without a verifier to unverified', () => {
    assert.equal(
      classifyReviewCard({ outcome: 'VERIFIED_COMPLETE', verification: { ran: false } }),
      'COMPLETE_UNVERIFIED',
    );
  });
});
