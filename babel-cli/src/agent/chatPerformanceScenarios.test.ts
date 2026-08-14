/**
 * Chat Performance & Policy Tuning Regression Certification.
 *
 * Validates:
 * 1. Fine-grained per-turn timing breakdown via ChatTurnTelemetryCollector.
 * 2. Non-provider Babel orchestration overhead stays strictly bounded (< 50ms).
 * 3. TTFT detection occurs on first token stream chunk.
 * 4. Zero duplicate / repeated tool calls under healthy execution.
 * 5. Task-tune exploration budgets and policy fuses fire predictably.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ChatTurnTelemetryCollector } from './chatTurnTelemetry.js';
import { getChatTaskTune, classifyChatTaskClassFromText } from '../config/chatTaskClass.js';

describe('PR-B: Chat Performance & Telemetry Certification', () => {
  test('turn telemetry captures complete timing breakdown and transitions', async () => {
    const collector = new ChatTurnTelemetryCollector();
    collector.markStarted();

    // Simulate provider dispatch + TTFT
    await new Promise((r) => setTimeout(r, 15));
    collector.markFirstToken();

    // Simulate provider stream span
    await new Promise((r) => setTimeout(r, 20));
    collector.recordProviderSpan(35);

    // Simulate tool execution span
    await new Promise((r) => setTimeout(r, 10));
    collector.recordToolSpan('read_file', 'src/math.ts', 10, true);

    // Simulate verifier span
    collector.recordVerificationSpan(15);

    const record = collector.finalize({
      turnId: 'perf-turn-001',
      taskClass: 'quick_inspect',
      promptTokens: 450,
      completionTokens: 80,
      cumulativeSessionTokens: 1200,
    });

    assert.equal(record.turnId, 'perf-turn-001');
    assert.equal(record.taskClass, 'quick_inspect');
    assert.equal(record.counts.modelInvocations, 1);
    assert.equal(record.counts.toolCalls, 1);
    assert.equal(record.counts.successfulToolCalls, 1);
    assert.equal(record.counts.failedToolCalls, 0);
    assert.equal(record.counts.repeatedToolCalls, 0);

    // Timing assertions
    assert.ok(record.timing.ttftMs !== null && record.timing.ttftMs >= 10, 'Expected valid TTFT');
    assert.equal(record.timing.providerDurationMs, 35);
    assert.equal(record.timing.toolDurationMs, 10);
    assert.equal(record.timing.verificationDurationMs, 15);
    assert.ok(record.timing.totalWallTimeMs >= 40, 'Total wall time should cover elapsed work');
    // Non-provider Babel orchestration overhead is strictly bounded
    assert.ok(record.timing.orchestrationOverheadMs < 50, `Orchestration overhead ${record.timing.orchestrationOverheadMs}ms exceeds 50ms threshold`);
  });

  test('telemetry detects repeated tool calls and tracks failed calls', () => {
    const collector = new ChatTurnTelemetryCollector();
    collector.markStarted();

    collector.recordToolSpan('read_file', 'src/math.ts', 5, true);
    collector.recordToolSpan('read_file', 'src/math.ts', 5, true); // Repeat!
    collector.recordToolSpan('run_command', 'npm run build', 15, false); // Failed tool

    const record = collector.finalize({
      turnId: 'perf-turn-002',
      taskClass: 'default',
      cumulativeSessionTokens: 500,
    });

    assert.equal(record.counts.toolCalls, 3);
    assert.equal(record.counts.successfulToolCalls, 2);
    assert.equal(record.counts.failedToolCalls, 1);
    assert.equal(record.counts.repeatedToolCalls, 1);
  });

  test('quick_inspect tuning balances responsiveness with bounded exploration', () => {
    const tune = getChatTaskTune('quick_inspect');
    assert.equal(tune.verificationPolicy, 'none');
    assert.ok(tune.investigateToolBudget >= 4, 'Quick inspect provides at least 4 exploratory tools');
    assert.ok(tune.investigateToolHardCap <= 12, 'Quick inspect caps exploration to prevent wandering');
    assert.equal(tune.forceMutateTurns, 99, 'Quick inspect imposes no mutation pressure');
  });

  test('general_swe and governance tuning enforce appropriate verification policies', () => {
    const sweTune = getChatTaskTune('general_swe');
    assert.equal(sweTune.verificationPolicy, 'required');
    assert.ok(sweTune.investigateToolBudget >= 8, 'General SWE provides sufficient investigation headroom');

    const govTune = getChatTaskTune('governance');
    assert.equal(govTune.verificationPolicy, 'strict');
  });
});
