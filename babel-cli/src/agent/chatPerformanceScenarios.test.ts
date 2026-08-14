/**
 * Chat Performance & Policy Tuning Regression Certification.
 *
 * Validates:
 * 1. Fine-grained per-turn timing breakdown via ChatTurnTelemetryCollector with monotonic clock.
 * 2. Non-provider Babel orchestration overhead accounting without clamping false zeroes.
 * 3. TTFT detection occurs on first token stream chunk.
 * 4. Duplicate / repeated tool calls detection.
 * 5. Task-tune exploration budgets and policy fuses fire predictably.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ChatTurnTelemetryCollector } from './chatTurnTelemetry.js';
import { getChatTaskTune } from '../config/chatTaskClass.js';

describe('PR-B: Chat Performance & Telemetry Certification', () => {
  test('turn telemetry captures complete timing breakdown and transitions with deterministic clock', () => {
    let currentTime = 1000.0;
    const fakeClock = () => currentTime;

    const collector = new ChatTurnTelemetryCollector(1000.0, fakeClock);
    collector.markStarted();

    // Advance 25ms to first token
    currentTime = 1025.0;
    collector.markFirstToken();

    // Provider duration: 50ms
    collector.recordProviderSpan(50.0);

    // Tool execution: 20ms
    collector.recordToolSpan('read_file', 'src/math.ts', 20.0, true);

    // Verifier duration: 15ms
    collector.recordVerificationSpan(15.0);

    // Total elapsed: 100ms
    currentTime = 1100.0;

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
    assert.equal(record.timing.ttftMs, 25.0);
    assert.equal(record.timing.providerDurationMs, 50.0);
    assert.equal(record.timing.toolDurationMs, 20.0);
    assert.equal(record.timing.verificationDurationMs, 15.0);
    assert.equal(record.timing.totalWallTimeMs, 100.0);
    // Productive time = 50 + 20 + 15 = 85. Orchestration overhead = 100 - 85 = 15ms.
    assert.equal(record.timing.orchestrationOverheadMs, 15.0);
    assert.ok(record.timing.orchestrationOverheadMs < 50.0);
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
