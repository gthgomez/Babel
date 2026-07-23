/**
 * Budget-kill honesty + force-mutate + token-explosion pure policy tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  buildForceMutateMessage,
  buildZeroWriteHardStopMessage,
  classifyBudgetKillReason,
  formatBudgetExceededAnswer,
  isBudgetExceededText,
  mapChatResultToPayloadStatus,
  evaluateTokenExplosionAfterTurn,
  shouldAbortTokenExplosion,
  shouldForceMutateEscalation,
  shouldHardBlockZeroWrite,
} from './budgetKillPolicy.js';

describe('budgetKillPolicy', () => {
  test('classifies wall and cost reasons', () => {
    assert.equal(
      classifyBudgetKillReason('Time budget exceeded (609s of 600s).'),
      'wall',
    );
    assert.equal(
      classifyBudgetKillReason('Cost budget exceeded ($2.10 of $2.00).'),
      'cost',
    );
    assert.equal(
      classifyBudgetKillReason('Token explosion with zero mutations: 250000 tokens'),
      'token_explosion',
    );
  });

  test('mapChatResultToPayloadStatus uses BUDGET_EXCEEDED not NEEDS_MORE_CONTEXT', () => {
    assert.equal(
      mapChatResultToPayloadStatus({
        status: 'failed',
        answer: 'Time budget exceeded (609s of 600s).',
      }),
      'BUDGET_EXCEEDED',
    );
    assert.equal(
      mapChatResultToPayloadStatus({
        status: 'failed',
        budgetExceeded: true,
        answer: 'anything',
      }),
      'BUDGET_EXCEEDED',
    );
    assert.equal(
      mapChatResultToPayloadStatus({
        status: 'failed',
        answer: 'some other failure',
      }),
      'NEEDS_MORE_CONTEXT',
    );
    assert.equal(
      mapChatResultToPayloadStatus({ status: 'completed', answer: 'ok' }),
      'ANSWER_READY',
    );
    assert.equal(
      mapChatResultToPayloadStatus({ status: 'blocked', answer: 'BLOCKED' }),
      'BLOCKED',
    );
  });

  test('formatBudgetExceededAnswer is machine-classifiable', () => {
    const text = formatBudgetExceededAnswer('Time budget exceeded (10s of 10s).', {
      hadWrites: true,
      criticVerdict: 'reject',
    });
    assert.ok(isBudgetExceededText(text));
    assert.match(text, /BUDGET_EXCEEDED/);
    assert.match(text, /budget_kind=wall/);
    assert.match(text, /had_writes=1/);
    assert.match(text, /critic_verdict=reject/);
  });

  test('shouldAbortTokenExplosion only when no writes and over ceiling', () => {
    assert.equal(
      shouldAbortTokenExplosion({
        tokensThisTurn: 300_000,
        maxTokensPerRound: 200_000,
        hasAnyWrites: false,
      }),
      true,
    );
    assert.equal(
      shouldAbortTokenExplosion({
        tokensThisTurn: 300_000,
        maxTokensPerRound: 200_000,
        hasAnyWrites: true,
      }),
      false,
    );
    assert.equal(
      shouldAbortTokenExplosion({
        tokensThisTurn: 50_000,
        maxTokensPerRound: 200_000,
        hasAnyWrites: false,
      }),
      false,
    );
  });

  test('evaluateTokenExplosionAfterTurn uses real end-of-turn delta (not pre-reset 0)', () => {
    // Bug pattern: reset start=now then compute delta → always 0 → never abort
    const preResetDead = evaluateTokenExplosionAfterTurn({
      tokensAtTurnStart: 500_000,
      tokensNow: 500_000,
      maxTokensPerRound: 200_000,
      hasAnyWrites: false,
    });
    assert.equal(preResetDead.tokensThisTurn, 0);
    assert.equal(preResetDead.abort, false);

    // Correct end-of-turn: start snapshot then LLM usage increases counter
    const afterTurn = evaluateTokenExplosionAfterTurn({
      tokensAtTurnStart: 500_000,
      tokensNow: 500_000 + 250_000,
      maxTokensPerRound: 200_000,
      hasAnyWrites: false,
    });
    assert.equal(afterTurn.tokensThisTurn, 250_000);
    assert.equal(afterTurn.abort, true);

    // Writes present: never abort even on large delta
    assert.equal(
      evaluateTokenExplosionAfterTurn({
        tokensAtTurnStart: 0,
        tokensNow: 1_000_000,
        maxTokensPerRound: 200_000,
        hasAnyWrites: true,
      }).abort,
      false,
    );
  });

  test('chatEngine wiring uses evaluateTokenExplosionAfterTurn after deliberateTurn', () => {
    // Structural proof: monomorphic stream loop calls the end-of-turn helper
    // (submitMessage is a thin consumer of submitMessageStream — one body).
    const src = readFileSync(
      new URL('./chatEngine.ts', import.meta.url),
      'utf8',
    );
    assert.match(src, /evaluateTokenExplosionAfterTurn/);
    const callSites = [...src.matchAll(/evaluateTokenExplosionAfterTurn\s*\(/g)];
    assert.ok(
      callSites.length >= 1,
      'stream loop must call end-of-turn evaluator (monomorphic submitMessage path)',
    );
    // Dead pre-turn check removed
    assert.doesNotMatch(
      src,
      /tokensThisTurnPre\s*=\s*this\.apiTokenCount\s*-\s*this\.apiTokenCountAtTurnStart/,
    );
  });

  test('force-mutate escalation for execute with zero writes after N turns', () => {
    assert.equal(
      shouldForceMutateEscalation({
        executeIntent: true,
        turnsWithoutWrite: 3,
        threshold: 3,
        hasAnyWrites: false,
      }),
      true,
    );
    assert.equal(
      shouldForceMutateEscalation({
        executeIntent: true,
        turnsWithoutWrite: 2,
        threshold: 3,
        hasAnyWrites: false,
      }),
      false,
    );
    assert.equal(
      shouldForceMutateEscalation({
        executeIntent: false,
        turnsWithoutWrite: 10,
        threshold: 3,
        hasAnyWrites: false,
      }),
      false,
    );
    assert.equal(
      shouldForceMutateEscalation({
        executeIntent: true,
        turnsWithoutWrite: 10,
        threshold: 3,
        hasAnyWrites: true,
      }),
      false,
    );
    const msg = buildForceMutateMessage(3);
    assert.match(msg, /STOP READING/);
    assert.match(msg, /str_replace/);
    assert.match(msg, /Do NOT grep, read_file, or read_range again/i);
  });

  test('zero-write hard stop after N completed turns with no mutations', () => {
    assert.equal(
      shouldHardBlockZeroWrite({
        executeIntent: true,
        completedTurns: 8,
        threshold: 8,
        hasAnyWrites: false,
      }),
      true,
    );
    assert.equal(
      shouldHardBlockZeroWrite({
        executeIntent: true,
        completedTurns: 7,
        threshold: 8,
        hasAnyWrites: false,
      }),
      false,
    );
    assert.equal(
      shouldHardBlockZeroWrite({
        executeIntent: true,
        completedTurns: 20,
        threshold: 8,
        hasAnyWrites: true,
      }),
      false,
    );
    assert.equal(
      shouldHardBlockZeroWrite({
        executeIntent: false,
        completedTurns: 20,
        threshold: 8,
        hasAnyWrites: false,
      }),
      false,
    );
    assert.equal(
      shouldHardBlockZeroWrite({
        executeIntent: true,
        completedTurns: 20,
        threshold: 0,
        hasAnyWrites: false,
      }),
      false,
      'threshold 0 disables hard stop',
    );
    const stopMsg = buildZeroWriteHardStopMessage(8, 8);
    assert.match(stopMsg, /BLOCKED/);
    assert.match(stopMsg, /zero successful file mutations/i);
  });
});
