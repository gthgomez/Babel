/**
 * Projection Consistency Certification Suite.
 *
 * Asserts that the canonical pure view projector produces mutually consistent
 * state across the status bar, review card, and transcript cells under all terminal outcomes.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { projectTurnViewState } from './turnViewProjector.js';
import type { CanonicalTurnEvent } from './canonicalEvents.js';
import type { VerifierReceipt } from '../../agent/completionGatePolicy.js';

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
});
