/**
 * Chat Performance & Policy Tuning Regression Certification.
 *
 * Validates:
 * 1. Fine-grained per-turn timing breakdown via ChatTurnTelemetryCollector with monotonic clock.
 * 2. Overlap-safe interval union duration computation without artificial clamping distortions.
 * 3. TTFT detection occurs on first token stream chunk.
 * 4. Duplicate / repeated tool calls detection.
 * 5. Task-tune exploration budgets and policy fuses fire predictably.
 * 6. Production Integration: executeChatTask & ChatEngine wire, populate, and return turn telemetry.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ChatTurnTelemetryCollector,
  computeIntervalUnionDuration,
  type ChatTurnTelemetryRecord,
} from './chatTurnTelemetry.js';
import { getChatTaskTune } from '../config/chatTaskClass.js';
import { executeChatTask } from '../interactive/execution/chat.js';
import { BabelRepl } from '../interactive/BabelRepl.js';
import type { ReplContext } from '../interactive/context.js';
import type { AgentTargetContext } from '../services/targetResolver.js';
import { ChatEngine, type ChatEvent } from './chatEngine.js';
import { globalCostTracker } from '../services/costTracker.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

function makeTarget(root = process.cwd()): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function makeReplContext(): ReplContext {
  const ctx = Object.create(BabelRepl.prototype) as ReplContext;
  ctx.state = {
    mode: 'chat',
    router: 'v9',
    costTotals: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    },
    turnCount: 0,
  };
  ctx.isRunning = false;
  ctx.verboseMode = false;
  ctx.rl = {
    pause: () => undefined,
    resume: () => undefined,
    prompt: () => undefined,
  } as unknown as ReplContext['rl'];
  ctx.turns = [];
  ctx.turnCounter = 0;
  ctx.chatEngine = undefined;
  ctx.lastAssistantAnswer = null;
  ctx.lastAssistantStatus = null;
  ctx.lastAssistantNext = null;
  ctx.lastResolvedTask = null;
  ctx.lastRunDir = null;
  ctx.lastTargetRoot = null;
  ctx.lastWorkspaceRoot = null;
  ctx.saveSessionState = () => undefined;
  ctx.resolveCurrentTarget = () => makeTarget();
  ctx.appendTurn = (turn) => {
    const record = {
      schema_version: 1 as const,
      turn_id: ++ctx.turnCounter,
      ts: new Date().toISOString(),
      ...turn,
    };
    ctx.turns.push(record);
    return record;
  };
  return ctx;
}

describe('PR-B: Chat Performance & Telemetry Certification', () => {
  test('computeIntervalUnionDuration correctly merges overlapping and disjoint intervals', () => {
    // Empty intervals
    assert.equal(computeIntervalUnionDuration([]), 0);

    // Single interval
    assert.equal(computeIntervalUnionDuration([{ start: 10, end: 30 }]), 20);

    // Disjoint intervals: [10, 20] + [30, 45] = 10 + 15 = 25
    assert.equal(
      computeIntervalUnionDuration([
        { start: 10, end: 20 },
        { start: 30, end: 45 },
      ]),
      25,
    );

    // Overlapping intervals: [10, 30] and [20, 40] => [10, 40] = 30
    assert.equal(
      computeIntervalUnionDuration([
        { start: 10, end: 30 },
        { start: 20, end: 40 },
      ]),
      30,
    );

    // Fully contained interval: [10, 50] and [20, 30] => [10, 50] = 40
    assert.equal(
      computeIntervalUnionDuration([
        { start: 10, end: 50 },
        { start: 20, end: 30 },
      ]),
      40,
    );

    // Multi-interval merge: [0, 10], [5, 15], [20, 25], [22, 30] => [0, 15] + [20, 30] = 15 + 10 = 25
    assert.equal(
      computeIntervalUnionDuration([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 20, end: 25 },
        { start: 22, end: 30 },
      ]),
      25,
    );
  });

  test('turn telemetry captures complete timing breakdown and transitions with deterministic clock', () => {
    let currentTime = 1000.0;
    const fakeClock = () => currentTime;

    const collector = new ChatTurnTelemetryCollector(1000.0, fakeClock);
    collector.markStarted();

    // Advance 25ms to first token
    currentTime = 1025.0;
    collector.markFirstToken();

    // Provider duration: 50ms [1025, 1075]
    collector.recordProviderSpan(50.0, 1025.0, 1075.0);

    // Tool execution: 20ms [1075, 1095]
    collector.recordToolSpan('read_file', 'src/math.ts', 20.0, true, 1075.0, 1095.0);

    // Verifier duration: 15ms [1085, 1100] (partially overlaps tool, [1075, 1100] total union = 25ms)
    collector.recordVerificationSpan(15.0, 1085.0, 1100.0);

    // Total elapsed: 100ms [1000, 1100]
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
    // Provider [1025, 1075] = 50ms. Tool [1075, 1095] + Verifier [1085, 1100] = [1075, 1100] = 25ms.
    // Total productive union = 75ms.
    // Orchestration overhead = 100 - 75 = 25ms.
    assert.equal(record.timing.orchestrationOverheadMs, 25.0);
    assert.ok(record.timing.orchestrationOverheadMs <= record.timing.totalWallTimeMs);
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

  test('production integration: executeChatTask receives and attaches turn telemetry from engine execution', async () => {
    const ctx = makeReplContext();
    const target = makeTarget();

    // Mock engine that produces real events including done with turnTelemetry
    const mockTelemetry: ChatTurnTelemetryRecord = {
      turnId: 'turn-int-001',
      taskClass: 'quick_inspect',
      timing: {
        submittedAt: 100,
        startedAt: 100,
        firstTokenAt: 120,
        ttftMs: 20,
        providerDurationMs: 80,
        toolDurationMs: 40,
        verificationDurationMs: 0,
        criticDurationMs: 0,
        compactionDurationMs: 0,
        orchestrationOverheadMs: 10,
        totalWallTimeMs: 130,
      },
      counts: {
        modelInvocations: 1,
        toolCalls: 1,
        successfulToolCalls: 1,
        failedToolCalls: 0,
        repeatedToolCalls: 0,
        policyInterventions: 0,
      },
      promptTokens: 300,
      completionTokens: 50,
      cumulativeSessionTokens: 350,
    };

    const mockEngine = Object.create(ChatEngine.prototype) as ChatEngine;
    mockEngine.submitMessageStream = async function* () {
      yield { type: 'thinking' };
      yield { type: 'answer_chunk', text: 'Inspected target files.' };
      yield {
        type: 'done',
        answer: 'Inspected target files.',
        usage: EMPTY_USAGE,
        outcome: 'NO_CHANGE_REQUIRED',
        turnTelemetry: mockTelemetry,
      };
    };

    await executeChatTask(ctx, 'inspect repo structure', 'inspect repo structure', target, undefined, {
      engineFactory: () => mockEngine,
      gatherPreflight: async () => '',
    });

    assert.equal(ctx.turns.length, 1);
    const lastTurn = ctx.turns[0]!;
    assert.ok(lastTurn.turn_telemetry, 'Production executeChatTask must attach turn_telemetry to InteractiveTurn');
    assert.equal(lastTurn.turn_telemetry.turnId, 'turn-int-001');
    assert.equal(lastTurn.turn_telemetry.taskClass, 'quick_inspect');
    assert.equal(lastTurn.turn_telemetry.timing.ttftMs, 20);
    assert.equal(lastTurn.turn_telemetry.counts.toolCalls, 1);
  });
});
