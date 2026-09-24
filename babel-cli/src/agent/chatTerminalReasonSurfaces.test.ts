/**
 * D03 — terminal reasons survive the production arbiter and projection.
 *
 * Packet gate D-T09: canonical reasons survive persistence/replay and all
 * clients; no prose-derived authority. These tests exercise the production
 * arbiter + projection + card path rather than a copied helper.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createParityRuntime,
  parityArbitrateCycle,
  parityRecordToolBatch,
} from './chatEngineParityBridge.js';
import { recordProgressCycle } from './progressReceipt.js';
import {
  mapSessionEventToCanonicalTurnEvent,
  type TurnTerminalResolvedEvent,
} from '../interactive/projection/canonicalEvents.js';
import {
  projectTurnViewStateFromSessionEvents,
  renderProjectedReviewCard,
} from '../interactive/projection/turnViewProjector.js';
import { recordTurnEnded, createSessionEventLog } from './sessionEvents.js';
import type { SessionEvent } from './sessionEvents.js';
import { mapChatEventToTurnStreamEvent } from '../protocol/mapChatEvent.js';
import { buildChatRunPayload, consumeChatStream } from '../interactive/execution/chatCore.js';
import type { ChatResult } from './chatEngine.js';
import { ChatEngine } from './chatEngine.js';
import { loadSessionEventLogFromDir } from './sessionEvents.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import type { ToolStreamEvent } from '../runners/base.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeProgressExhaustionRuntime(id: string) {
  const rt = createParityRuntime(id);
  // First read localizes; eight unchanged re-reads exhaust the bound.
  recordProgressCycle(rt.progress, {
    at_turn: 1,
    reads: [{ path: 'src/a.ts', contentHash: 'h1' }],
  });
  for (let cycle = 2; cycle <= 9; cycle += 1) {
    recordProgressCycle(rt.progress, {
      at_turn: cycle,
      reads: [{ path: 'src/a.ts', contentHash: 'h1' }],
    });
  }
  rt.recoveryTried = true;
  return rt;
}

describe('D03 arbiter carries structured terminal reasons', () => {
  test('recovery exhaustion yields recovery_exhausted + model cause', () => {
    const rt = makeProgressExhaustionRuntime('d03-recovery');
    const arb = parityArbitrateCycle({ rt, fuseLabels: [] });
    assert.equal(arb.policySource, 'progress_terminal');
    assert.ok(arb.terminalAnswer);
    assert.equal(arb.terminalReason?.code, 'recovery_exhausted');
    // The read ledger proves the model re-read unchanged bytes.
    assert.equal(arb.terminalReason?.cause_class, 'model');
  });

  test('env block yields external_dependency/environment, never recovery', () => {
    const rt = createParityRuntime('d03-env');
    const arb = parityArbitrateCycle({
      rt,
      fuseLabels: [],
      envBlockedSignal: 'pytest missing on host',
    });
    assert.equal(arb.policySource, 'env_blocked');
    assert.equal(arb.terminalReason?.code, 'external_dependency');
    assert.equal(arb.terminalReason?.cause_class, 'environment');
  });

  test('hard ceiling yields budget_exhausted/harness', () => {
    const rt = createParityRuntime('d03-budget');
    const arb = parityArbitrateCycle({
      rt,
      fuseLabels: [],
      hardCeiling: true,
      hardCeilingReason: 'wall clock budget exceeded',
    });
    assert.equal(arb.policySource, 'hard_ceiling');
    assert.equal(arb.terminalReason?.code, 'budget_exhausted');
    assert.equal(arb.terminalReason?.cause_class, 'harness');
  });

  test('read-only hard cap is a budget reason, not a permission block', () => {
    const rt = createParityRuntime('d03-readonly-cap');
    const arb = parityArbitrateCycle({
      rt,
      fuseLabels: [],
      isReadOnlyInspection: true,
      readOnlyHardCapTerminal: 'Inspection tool budget reached.',
    });
    assert.equal(arb.policySource, 'read_only_hard_cap');
    assert.equal(arb.terminalReason?.code, 'budget_exhausted');
    assert.notEqual(arb.terminalReason?.code, 'permission_denied');
  });

  test('nudge-only arbitration carries no terminal reason (no fabrication)', () => {
    const rt = createParityRuntime('d03-nudge');
    const arb = parityArbitrateCycle({
      rt,
      fuseLabels: [],
      forceMutateMessage: 'write something',
    });
    assert.equal(arb.terminalAnswer, null);
    assert.equal(arb.terminalReason, undefined);
  });
});

describe('D03 reason survives session-event projection to the review card', () => {
  test('turn_ended.reason_code reaches the card and outranks prose', () => {
    const log = createSessionEventLog('d03-proj');
    recordTurnEnded(log, {
      turn_id: 'turn-1',
      outcome: 'BLOCKED_POLICY',
      status: 'blocked',
      reason: { code: 'recovery_exhausted', cause_class: 'model' },
    });

    const state = projectTurnViewStateFromSessionEvents(log.events);
    assert.equal(state.reviewCard.reasonCode, 'recovery_exhausted');
    assert.equal(state.reviewCard.causeClass, 'model');

    const card = renderProjectedReviewCard(state, {
      // A misleading summary must not re-route the guidance.
      summary: 'permission denied by policy',
    });
    assert.equal(card.kind, 'BLOCKED');
    assert.match(card.body, /No progress after recovery/);
    assert.match(card.body, /Inspect diagnostics/);
    assert.doesNotMatch(card.body, /Review the blocked capability/);
    assert.doesNotMatch(card.body, /Review permission/);
  });

  test('canonical turn event carries reason_code and cause_class', () => {
    const log = createSessionEventLog('d03-canon');
    recordTurnEnded(log, {
      turn_id: 'turn-1',
      outcome: 'BLOCKED_EXTERNAL',
      status: 'blocked',
      reason: { code: 'external_dependency', cause_class: 'environment' },
    });
    const mapped = log.events
      .map((e) => mapSessionEventToCanonicalTurnEvent(e as SessionEvent))
      .filter((e): e is TurnTerminalResolvedEvent => e?.type === 'turn_terminal_resolved');
    assert.equal(mapped.at(-1)?.reason_code, 'external_dependency');
    assert.equal(mapped.at(-1)?.cause_class, 'environment');
  });

  test('turn_ended without a reason projects no reason (unknown stays unknown)', () => {
    const log = createSessionEventLog('d03-unknown');
    recordTurnEnded(log, { turn_id: 'turn-1', status: 'failed' });
    const state = projectTurnViewStateFromSessionEvents(log.events);
    assert.equal(state.reviewCard.reasonCode, undefined);
  });
});

describe('D03 protocol client and run payload carry the reason', () => {
  test('mapChatEventToTurnStreamEvent preserves done/failed reason_code', () => {
    const done = mapChatEventToTurnStreamEvent({
      type: 'done',
      answer: 'stopped',
      usage: {
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        modelBreakdown: {},
      },
      status: 'blocked',
      outcome: 'BLOCKED_POLICY',
      reason_code: 'recovery_exhausted',
      cause_class: 'model',
    } as never);
    assert.equal(done?.type, 'done');
    assert.equal(
      done && 'reason_code' in done ? done.reason_code : undefined,
      'recovery_exhausted',
    );
    assert.equal(done && 'cause_class' in done ? done.cause_class : undefined, 'model');

    const failed = mapChatEventToTurnStreamEvent({
      type: 'failed',
      error: 'provider hard failure',
      status: 'failed',
      outcome: 'INFRA_FAILURE',
      reason_code: 'provider_failure',
      cause_class: 'provider',
    } as never);
    assert.equal(
      failed && 'reason_code' in failed ? failed.reason_code : undefined,
      'provider_failure',
    );

    const unknown = mapChatEventToTurnStreamEvent({
      type: 'failed',
      error: 'unclassifiable',
      status: 'failed',
    } as never);
    assert.equal(unknown && 'reason_code' in unknown ? unknown.reason_code : undefined, undefined);
  });

  test('buildChatRunPayload emits reason_code and cause_class', () => {
    const result: ChatResult = {
      status: 'blocked',
      outcome: 'BLOCKED_POLICY',
      reason_code: 'recovery_exhausted',
      cause_class: 'model',
      answer: 'No progress after recovery',
      usage: {
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        modelBreakdown: {},
      },
      conversation: [],
    };
    const payload = buildChatRunPayload(result, { task: 'd03', projectRoot: '/tmp/d03' });
    assert.equal(payload['reason_code'], 'recovery_exhausted');
    assert.equal(payload['cause_class'], 'model');
    assert.equal(payload['terminal_outcome'], 'BLOCKED_POLICY');
  });
});

describe('D03 production engine: recovery exhaustion reaches every surface', () => {
  test('the real stream loop yields corrected next-action text, not a capability block', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'd03-engine-'));
    writeFileSync(join(projectRoot, 'hello.txt'), 'hello\n', 'utf-8');
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
    try {
      const engine = new ChatEngine({
        task: 'Fix hello.txt',
        projectRoot,
        model: 'deepseek-v4-flash',
        maxTurns: 40,
      });
      const anyEngine = engine as unknown as {
        deliberationRunner: unknown;
        synthesisRunner: unknown;
        shouldUseNativeTools: () => boolean;
      };
      // Scripted provider: read the same unchanged file every cycle. After the
      // recovery attempt the evidence-based progress bound must terminal.
      const runner = {
        executeWithToolsStream:
          async function* (): AsyncGenerator<ToolStreamEvent, void, undefined> {
            yield {
              type: 'tool_use',
              id: `read_${Math.random()}`,
              name: 'read_file',
              input: { path: 'hello.txt' },
            };
            yield { type: 'done', finishReason: 'tool_calls' };
          },
        execute: async () => ({ type: 'completion', answer: 'x' }),
        getLastInvocationMetadata: () => null,
      };
      anyEngine.deliberationRunner = runner;
      anyEngine.synthesisRunner = runner;
      anyEngine.shouldUseNativeTools = () => true;

      const result = await consumeChatStream(
        engine.submitMessageStream('Fix hello.txt'),
        null,
      );

      // Engine result carries the structured reason.
      assert.equal(result.reason_code, 'recovery_exhausted');
      assert.equal(result.cause_class, 'model');
      assert.equal(result.status, 'blocked');

      // Durable session log carries it (persistence/replay).
      const log = loadSessionEventLogFromDir(chatSessionDir(engine.getEngineRunId()));
      const ended = log?.events.filter((e) => e.kind === 'turn_ended').at(-1) as
        | { reason_code?: string; cause_class?: string }
        | undefined;
      assert.equal(ended?.reason_code, 'recovery_exhausted');
      assert.equal(ended?.cause_class, 'model');

      // The projected review card shows the corrected guidance.
      assert.ok(log, 'durable session log must exist');
      const state = projectTurnViewStateFromSessionEvents(log!.events);
      assert.equal(state.reviewCard.reasonCode, 'recovery_exhausted');
      const card = renderProjectedReviewCard(state);
      assert.match(card.body, /No progress after recovery/);
      assert.match(card.body, /Inspect diagnostics/);
      assert.match(card.body, /Narrow scope/);
      assert.doesNotMatch(card.body, /Review the blocked capability/);
      assert.doesNotMatch(card.body, /permission/i);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    }
  });

  // D03 (I3): on the read-only synthesis-failure path the outcome, the persisted
  // blocked report and the reason must agree. Previously the report had no
  // reason_code and the outcome was BLOCKED_EXTERNAL while the reason said
  // recovery_exhausted.
  test('read-only synthesis failure reconciles outcome, report and reason', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'd03-readonly-'));
    writeFileSync(join(projectRoot, 'hello.txt'), 'hello\n', 'utf-8');
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
    try {
      const engine = new ChatEngine({
        task: 'investigate hello.txt',
        projectRoot,
        model: 'deepseek-v4-flash',
        maxTurns: 40,
      });
      const anyEngine = engine as unknown as {
        deliberationRunner: unknown;
        synthesisRunner: unknown;
        shouldUseNativeTools: () => boolean;
      };
      // The synthesis runner has no executeRaw, so answer synthesis fails after
      // the inspection bound terminals.
      const runner = {
        executeWithToolsStream:
          async function* (): AsyncGenerator<ToolStreamEvent, void, undefined> {
            yield {
              type: 'tool_use',
              id: `read_${Math.random()}`,
              name: 'read_file',
              input: { path: 'hello.txt' },
            };
            yield { type: 'done', finishReason: 'tool_calls' };
          },
        execute: async () => ({ type: 'completion', answer: 'x' }),
        getLastInvocationMetadata: () => null,
      };
      anyEngine.deliberationRunner = runner;
      anyEngine.synthesisRunner = runner;
      anyEngine.shouldUseNativeTools = () => true;

      const result = await consumeChatStream(
        engine.submitMessageStream('investigate hello.txt'),
        null,
      );

      assert.equal(result.reason_code, 'recovery_exhausted');
      assert.equal(result.cause_class, 'model');
      // The reason and the (now reason-aware) outcome agree: a recovery
      // exhaustion is a policy block, not an external dependency.
      assert.equal(result.outcome, 'BLOCKED_POLICY');
      assert.equal(result.blockedReport?.reason_code, 'recovery_exhausted');

      const log = loadSessionEventLogFromDir(chatSessionDir(engine.getEngineRunId()));
      const ended = log?.events.filter((e) => e.kind === 'turn_ended').at(-1) as
        | { outcome?: string; reason_code?: string }
        | undefined;
      assert.equal(ended?.outcome, 'BLOCKED_POLICY');
      assert.equal(ended?.reason_code, 'recovery_exhausted');

      const payload = buildChatRunPayload(result, {
        task: 'investigate hello.txt',
        projectRoot,
      });
      assert.equal(payload['terminal_outcome'], 'BLOCKED_POLICY');
      assert.equal(payload['reason_code'], 'recovery_exhausted');
      assert.equal(
        (payload['blocked_report'] as { reason_code?: string } | undefined)?.reason_code,
        'recovery_exhausted',
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    }
  });
});
