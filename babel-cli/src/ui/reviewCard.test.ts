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
    assert.equal(reviewCardKindToken(card.kind), 'REVIEW_KIND:VERIFIED_COMPLETE');
    const text = stripAnsi(card.body);
    assert.match(text, /Verified complete/);
    assert.match(text, /src\/foo\.ts/);
    assert.match(text, /npm test/);
    assert.doesNotMatch(text, /REVIEW_KIND:/);
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
    assert.equal(reviewCardKindToken(card.kind), 'REVIEW_KIND:COMPLETE_UNVERIFIED');
    const text = stripAnsi(card.body);
    assert.match(text, /unverified|Not run/i);
    assert.doesNotMatch(text, /Verified complete/);
    assert.doesNotMatch(text, /REVIEW_KIND:/);
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
    assert.doesNotMatch(text, /REVIEW_KIND:/);
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
      assert.equal(reviewCardKindToken(card.kind), `REVIEW_KIND:${c.kind}`);
      assert.doesNotMatch(card.body, /REVIEW_KIND:/);
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
  });

  it('maps VERIFIED_COMPLETE without a verifier to unverified', () => {
    assert.equal(
      classifyReviewCard({ outcome: 'VERIFIED_COMPLETE', verification: { ran: false } }),
      'COMPLETE_UNVERIFIED',
    );
  });

  // ── Acceptance Tests T13–T16: Mode-Aware Completion Cards ────────────────

  it('T13: Read-only query with 0 changed files omits Diff and Run verification actions', () => {
    const card = buildReviewCard({
      outcome: 'NO_CHANGE_REQUIRED',
      changedFiles: [],
      verificationPolicy: 'none',
    });
    const text = stripAnsi(card.body);
    assert.doesNotMatch(text, /\[Enter\] Continue/);
    assert.doesNotMatch(text, /\[D\] Diff/);
    assert.doesNotMatch(text, /\[R\] Run verification/);
    assert.doesNotMatch(text, /\nNext\n/);
  });

  it('T14: Mutating run with changed files provides Diff and Run verification actions', () => {
    const card = buildReviewCard({
      outcome: 'UNVERIFIED_PATCH',
      changedFiles: ['src/app.ts'],
      verification: { ran: false },
    });
    const text = stripAnsi(card.body);
    assert.match(text, /\[D\] Diff/);
    assert.match(text, /\[R\] Run verification/);
    assert.doesNotMatch(text, /\[Enter\] Continue/);
  });

  it('T15: Read-only query with verificationPolicy: none omits Not run — not verified', () => {
    const card = buildReviewCard({
      outcome: 'NO_CHANGE_REQUIRED',
      changedFiles: [],
      verificationPolicy: 'none',
    });
    const text = stripAnsi(card.body);
    assert.doesNotMatch(text, /Not run — not verified/);
  });

  it('T16: Blocked verification is distinct from test failure', () => {
    const blockedCard = buildReviewCard({
      outcome: 'BLOCKED',
      verification: { ran: false, status: 'blocked' },
    });
    const failedCard = buildReviewCard({
      outcome: 'UNVERIFIED_PATCH',
      verification: { ran: true, passed: false, command: 'npm test', exitCode: 1 },
    });
    const blockedText = stripAnsi(blockedCard.body);
    const failedText = stripAnsi(failedCard.body);

    assert.match(blockedText, /Verification blocked/);
    assert.match(failedText, /Verification failed/);
  });

  it('T16b: Read-only query with verificationApplicability: not_applicable displays clean Complete title', () => {
    const card = buildReviewCard({
      status: 'completed',
      outcome: 'COMPLETE_UNVERIFIED',
      changedFiles: [],
      verificationApplicability: 'not_applicable',
    });
    assert.equal(card.title, 'Complete');
    const text = stripAnsi(card.body);
    assert.match(text, /Complete/);
    assert.doesNotMatch(text, /Complete — unverified/);
    assert.doesNotMatch(text, /Not run — not verified/);
    assert.doesNotMatch(text, /\[D\] Diff/);
    assert.doesNotMatch(text, /\[R\] Run verification/);
    assert.doesNotMatch(text, /\[Enter\] Continue/);
    assert.doesNotMatch(text, /\nNext\n/);
  });

  it('omits always-on Continue and zero cost; keeps taxonomy and real next actions', () => {
    const readonly = presentChatReview({
      outcome: 'NO_CHANGE_REQUIRED',
      verificationPolicy: 'not_applicable',
      costUsd: 0,
      tokens: 0,
      summary: 'Answered from repo facts.',
    });
    const readonlyText = stripAnsi(readonly.body);
    assert.equal(readonly.kind, 'COMPLETE_UNVERIFIED');
    assert.equal(readonly.looksLikeVerifiedSuccess, false);
    assert.doesNotMatch(readonlyText, /Cost/);
    assert.doesNotMatch(readonlyText, /Next/);
    assert.doesNotMatch(readonlyText, /Not run — not verified/);

    const failed = presentChatReview({
      outcome: 'UNVERIFIED_PATCH',
      changedFiles: ['src/a.ts'],
      verification: { ran: true, passed: false, command: 'npm test', exitCode: 1 },
      costUsd: 0.02,
      tokens: 1200,
    });
    const failedText = stripAnsi(failed.body);
    assert.equal(failed.kind, 'VERIFICATION_FAILED');
    assert.match(failedText, /Verification failed/);
    assert.match(failedText, /\[F\] Fix/);
    assert.match(failedText, /\$0\.0200/);
    assert.doesNotMatch(failedText, /\[Enter\] Continue/);

    const cancelled = presentChatReview({ outcome: 'CANCELLED' });
    assert.equal(cancelled.kind, 'CANCELLED');
    assert.doesNotMatch(stripAnsi(cancelled.body), /\[Enter\] Continue/);
  });
});
