/**
 * Projection Consistency Certification Suite.
 *
 * Asserts that the canonical pure view projector produces mutually consistent
 * state across the status bar, review card, and transcript cells under all terminal outcomes,
 * and validates production session pipeline projection and multi-turn state isolation.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  projectTurnViewState,
  projectTurnViewStateFromSessionEvents,
  renderProjectedStatusBar,
  renderProjectedReviewCard,
} from './turnViewProjector.js';
import type { CanonicalTurnEvent } from './canonicalEvents.js';
import type { VerifierReceipt } from '../../agent/completionGatePolicy.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordMutationBatch,
  recordVerifierAttempt,
  recordCompletionDecision,
  recordTurnEnded,
} from '../../agent/sessionEvents.js';

describe('PR-C: Canonical Turn View Projection', () => {
  test('cancellation produces honest Cancelled card without patch actions', () => {
    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-1',
        timestamp: 1000,
        userInput: 'make changes',
        taskClass: 'default',
        model: 'DeepSeek v4 Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'assistant_chunk_received',
        timestamp: 1050,
        textChunk: 'Starting...',
      },
      {
        type: 'tool_completed',
        toolId: 't-1',
        toolName: 'write_file',
        target: 'src/index.ts',
        timestamp: 1100,
        durationMs: 20,
        exitCode: 0,
        isMutating: true,
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 1200,
        outcome: 'CANCELLED',
        status: 'cancelled',
        finalAnswer: 'Turn was interrupted by user.',
      },
    ];

    const view = projectTurnViewState(events);

    assert.equal(view.isTerminal, true);
    assert.equal(view.reviewCard.terminalOutcome, 'CANCELLED');
    assert.equal(view.reviewCard.title, 'Cancelled');
    assert.equal(view.reviewCard.showPatchActions, false);
    assert.equal(view.statusBar.statusLabel, 'cancelled');
    assert.equal(view.transcriptCell.assistantAnswer, 'Turn was interrupted by user.');
  });

  test('verification failure produces unverified/failed badge, never verified complete', () => {
    const receipt: VerifierReceipt = {
      command: 'npm test',
      exit_code: 1,
      exitCode: 1,
      summary: '1 test failed',
      receiptId: 'v-1',
      authority: true,
      authoritySource: 'built_in_runner',
      verifierId: 'test-runner',
      capturedAt: 1200,
      boundRevision: {
        gitCommitHash: null,
        compositeTreeHash: 'sha256:tree',
        fileHashes: {},
        capturedAt: 1200,
      },
    };

    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-2',
        timestamp: 1000,
        userInput: 'fix test',
        taskClass: 'default',
        model: 'DeepSeek v4 Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'tool_completed',
        toolId: 't-1',
        toolName: 'write_file',
        target: 'src/math.ts',
        timestamp: 1100,
        durationMs: 15,
        exitCode: 0,
        isMutating: true,
      },
      {
        type: 'verification_evaluated',
        timestamp: 1200,
        command: 'npm test',
        exitCode: 1,
        receipt,
        passed: false,
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 1300,
        outcome: 'UNVERIFIED_PATCH',
        status: 'completed',
        finalAnswer: 'Fix applied but tests failed.',
      },
    ];

    const view = projectTurnViewState(events);

    assert.equal(view.reviewCard.title, 'Verification failed');
    assert.equal(view.reviewCard.verifiedBadge, 'failed');
    assert.notEqual(view.reviewCard.verifiedBadge, 'verified');
    assert.equal(view.reviewCard.hasMutations, true);
    assert.equal(view.reviewCard.showPatchActions, true);
  });

  test('read-only task with zero writes produces no-mutation state', () => {
    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-3',
        timestamp: 1000,
        userInput: 'inspect repo',
        taskClass: 'quick_inspect',
        model: 'DeepSeek v4 Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'tool_completed',
        toolId: 't-1',
        toolName: 'read_file',
        target: 'src/index.ts',
        timestamp: 1050,
        durationMs: 10,
        exitCode: 0,
        isMutating: false,
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 1100,
        outcome: 'NO_CHANGE_REQUIRED',
        status: 'completed',
        finalAnswer: 'src/index.ts exports 4 methods.',
      },
    ];

    const view = projectTurnViewState(events);

    assert.equal(view.reviewCard.hasMutations, false);
    assert.equal(view.reviewCard.showPatchActions, false);
    assert.equal(view.reviewCard.verifiedBadge, 'not_applicable');
    assert.equal(view.reviewCard.title, 'Complete');
  });

  test('helper model usage preserves conversation model active context meter', () => {
    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-4',
        timestamp: 1000,
        userInput: 'large SWE task',
        taskClass: 'general_swe',
        model: 'Claude 3.5 Sonnet',
        modelId: 'claude-3-5-sonnet',
      },
      {
        type: 'provider_usage_recorded',
        requestId: 'req-main-1',
        timestamp: 1100,
        modelId: 'claude-3-5-sonnet',
        promptTokens: 42_000,
        completionTokens: 500,
        costUsd: 0.12,
        isHelperModel: false,
      },
      {
        type: 'provider_usage_recorded',
        requestId: 'req-helper-critic',
        timestamp: 1200,
        modelId: 'deepseek-v4-flash',
        promptTokens: 3_000,
        completionTokens: 50,
        costUsd: 0.001,
        isHelperModel: true, // Helper model
      },
    ];

    const view = projectTurnViewState(events, 10_000, 0.05, 1);

    // Active context meter should reflect main conversation model (42,000), not helper (3,000)
    assert.equal(view.statusBar.activeContextTokens, 42_000);
    // Cumulative session tokens includes both
    assert.equal(view.statusBar.cumulativeSessionTokens, 10_000 + 42_500 + 3_050);
  });

  test('model switch updates status bar model and modelId atomically', () => {
    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-5',
        timestamp: 1000,
        userInput: '/model deepseek-v4-pro',
        taskClass: 'default',
        model: 'DeepSeek v4 Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'model_switched',
        timestamp: 1050,
        newModel: 'DeepSeek v4 Pro',
        newModelId: 'deepseek-v4-pro',
      },
    ];

    const view = projectTurnViewState(events);

    assert.equal(view.statusBar.model, 'DeepSeek v4 Pro');
    assert.equal(view.statusBar.modelId, 'deepseek-v4-pro');
  });

  test('production integration: session event log projects to UI views with verified success', () => {
    const log = createSessionEventLog('test-session-001');

    recordUserSubmitted(log, {
      turn_id: 'turn-1',
      task: 'fix calculation bug in math.ts and verify',
      model: 'DeepSeek v4 Flash',
      provider: 'deepseek',
      taskClass: 'general_swe',
    });

    recordToolProposed(log, {
      turn_id: 'turn-1',
      tool_name: 'write_file',
      tool_call_id: 'call-1',
      idempotency_key: 'call-1',
      effect_class: 'reconcilable_mutation',
    });

    recordToolStarted(log, {
      turn_id: 'turn-1',
      tool_name: 'write_file',
      tool_call_id: 'call-1',
      idempotency_key: 'call-1',
      effect_class: 'reconcilable_mutation',
    });

    recordToolTerminal(log, {
      turn_id: 'turn-1',
      tool_name: 'write_file',
      tool_call_id: 'call-1',
      idempotency_key: 'call-1',
      exit_code: 0,
    });

    recordMutationBatch(log, 'turn-1', {
      paths: ['src/math.ts'],
      status: 'applied',
    });

    recordVerifierAttempt(log, {
      turn_id: 'turn-1',
      command_preview: 'npm test',
      exit_code: 0,
      authoritative: true,
    });

    recordCompletionDecision(log, 'turn-1', {
      requestedOutcome: 'VERIFIED_COMPLETE',
      finalOutcome: 'VERIFIED_COMPLETE',
      allowed: true,
      reason: 'Mutation verified successfully with exit 0 tests',
      evidenceRefs: ['ev-1'],
      policyVersion: 'v1',
    });

    recordTurnEnded(log, {
      turn_id: 'turn-1',
      status: 'completed',
      outcome: 'VERIFIED_COMPLETE',
    });

    const view = projectTurnViewStateFromSessionEvents(log.events);

    assert.equal(view.isTerminal, true);
    assert.equal(view.reviewCard.terminalOutcome, 'VERIFIED_COMPLETE');
    assert.equal(view.reviewCard.title, 'Verified complete');
    assert.equal(view.reviewCard.verifiedBadge, 'verified');
    assert.equal(view.reviewCard.hasMutations, true);

    // Verify projected view components render cleanly
    const statusStr = renderProjectedStatusBar(view);
    assert.ok(statusStr.includes('DeepSeek v4 Flash') || statusStr.includes('deepseek'));

    const review = renderProjectedReviewCard(view);
    assert.equal(review.kind, 'VERIFIED_COMPLETE');
    assert.ok(review.body.includes('Verified'));
  });

  test('multi-turn session projection guarantees lack of stale state carryover', () => {
    // Turn 1: Mutating turn
    const turn1Events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-1',
        timestamp: 1000,
        userInput: 'edit file',
        taskClass: 'general_swe',
        model: 'DeepSeek v4 Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'tool_completed',
        toolId: 't-1',
        toolName: 'write_file',
        target: 'src/app.ts',
        timestamp: 1100,
        durationMs: 30,
        exitCode: 0,
        isMutating: true,
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 1200,
        outcome: 'UNVERIFIED_PATCH',
        status: 'completed',
        finalAnswer: 'Edited app.ts',
      },
    ];

    const turn1View = projectTurnViewState(turn1Events);
    assert.equal(turn1View.reviewCard.hasMutations, true);
    assert.equal(turn1View.reviewCard.changedFiles.length, 1);
    assert.equal(turn1View.reviewCard.showPatchActions, true);

    // Turn 2: Fresh read-only turn (isolated event sequence for Turn 2)
    const turn2Events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-2',
        timestamp: 2000,
        userInput: 'what time is it?',
        taskClass: 'quick_inspect',
        model: 'DeepSeek v4 Flash',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'assistant_chunk_received',
        timestamp: 2050,
        textChunk: 'It is 12:00 PM.',
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 2100,
        outcome: 'NO_CHANGE_REQUIRED',
        status: 'completed',
        finalAnswer: 'It is 12:00 PM.',
      },
    ];

    const turn2View = projectTurnViewState(
      turn2Events,
      turn1View.statusBar.cumulativeSessionTokens,
      turn1View.statusBar.totalCostUsd,
      1,
    );

    // Turn 2 MUST have clean state — no leftover changed files or mutation badges from Turn 1
    assert.equal(turn2View.reviewCard.hasMutations, false);
    assert.equal(turn2View.reviewCard.changedFiles.length, 0);
    assert.equal(turn2View.reviewCard.showPatchActions, false);
    assert.equal(turn2View.reviewCard.verifiedBadge, 'not_applicable');
    assert.equal(turn2View.reviewCard.title, 'Complete');
    assert.equal(turn2View.transcriptCell.userInput, 'what time is it?');
    assert.equal(turn2View.transcriptCell.assistantAnswer, 'It is 12:00 PM.');
    assert.equal(turn2View.statusBar.turnCount, 2);
  });

  test('adversarial sequence: authoritative failure cannot be overwritten by later sparse completion', () => {
    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-adv-1',
        timestamp: 1000,
        userInput: 'risky edit',
        taskClass: 'default',
        model: 'unknown',
        modelId: 'unknown',
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 1100,
        outcome: 'BLOCKED_POLICY',
        status: 'blocked',
        finalAnswer: 'Blocked by safe path policy.',
      },
      // Adversarial later sparse event
      {
        type: 'turn_terminal_resolved',
        timestamp: 1200,
        outcome: 'NO_CHANGE_REQUIRED',
        status: 'completed',
        finalAnswer: '',
      },
    ];

    const view = projectTurnViewState(events);
    assert.equal(view.reviewCard.terminalOutcome, 'BLOCKED_POLICY');
    assert.equal(view.reviewCard.status, 'blocked');
    assert.equal(view.reviewCard.title, 'Blocked by policy');
    assert.equal(view.statusBar.statusLabel, 'blocked');
  });

  test('adversarial sequence: cancellation cannot be overwritten by generic end event', () => {
    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-adv-2',
        timestamp: 1000,
        userInput: 'cancel me',
        taskClass: 'default',
        model: 'unknown',
        modelId: 'unknown',
      },
      {
        type: 'turn_terminal_resolved',
        timestamp: 1100,
        outcome: 'CANCELLED',
        status: 'cancelled',
        finalAnswer: 'Turn cancelled.',
      },
      // Adversarial generic end event
      {
        type: 'turn_terminal_resolved',
        timestamp: 1200,
        outcome: 'NO_CHANGE_REQUIRED',
        status: 'completed',
        finalAnswer: '',
      },
    ];

    const view = projectTurnViewState(events);
    assert.equal(view.reviewCard.terminalOutcome, 'CANCELLED');
    assert.equal(view.reviewCard.status, 'cancelled');
    assert.equal(view.reviewCard.title, 'Cancelled');
  });

  test('unknown model fallback represents unknown truthfully without fabricating identity', () => {
    const events: CanonicalTurnEvent[] = [
      {
        type: 'turn_started',
        turnId: 'turn-unknown',
        timestamp: 1000,
        userInput: 'hello',
        taskClass: 'default',
        model: 'unknown',
        modelId: 'unknown',
      },
    ];

    const view = projectTurnViewState(events);
    assert.equal(view.statusBar.model, 'unknown');
    assert.equal(view.statusBar.modelId, 'unknown');
  });
});
