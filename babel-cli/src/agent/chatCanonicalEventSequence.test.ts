import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { rmSync } from 'node:fs';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import {
  createParityRuntime,
  parityEndTurn,
  parityOnUserTurn,
} from './chatEngineParityBridge.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { consumeChatStream } from '../interactive/execution/chatCore.js';
import { projectTurnViewStateFromSessionEvents } from '../interactive/projection/turnViewProjector.js';
import { mapChatEventToTurnStreamEvent } from '../protocol/mapChatEvent.js';
import { globalCostTracker } from '../services/costTracker.js';
import type { TerminalOutcome } from '../schemas/agentContracts.js';

const RECORDED_PREFIX: readonly ChatEvent[] = [
  { type: 'answer_chunk', text: 'partial output' },
  {
    type: 'tool_start',
    toolCallId: 'recorded-tool-1',
    tool: 'str_replace',
    target: 'src/a.ts',
  },
  {
    type: 'tool_complete',
    toolCallId: 'recorded-tool-1',
    tool: 'str_replace',
    target: 'src/a.ts',
    detail: 'applied',
    exitCode: 0,
    effect_status: 'confirmed_change',
    mutation_paths: ['src/a.ts'],
  },
  {
    type: 'file_changed',
    path: 'src/a.ts',
    additions: 2,
    deletions: 1,
    content: '+replacement',
  },
  {
    type: 'tool_start',
    toolCallId: 'recorded-tool-2',
    tool: 'run_command',
    target: 'npm test',
  },
  {
    type: 'tool_failed',
    toolCallId: 'recorded-tool-2',
    tool: 'run_command',
    target: 'npm test',
    detail: 'test failed',
    error: 'exit 1',
    exitCode: 1,
  },
  { type: 'sub_agent_start', id: 'child-ok', label: 'review', model: 'review-model' },
  { type: 'sub_agent_complete', id: 'child-ok', summary: 'approved', tokens: 21 },
  { type: 'sub_agent_start', id: 'child-failed', label: 'verify' },
  { type: 'sub_agent_failed', id: 'child-failed', error: 'verifier unavailable' },
];

type TerminalCase = {
  label: string;
  terminal: ChatEvent | null;
  expectedStatus: 'completed' | 'failed' | 'cancelled' | 'blocked' | 'budget_exhausted';
  expectedOutcome?: TerminalOutcome;
};

const TERMINAL_CASES: readonly TerminalCase[] = [
  {
    label: 'normal completion',
    terminal: {
      type: 'done',
      answer: 'complete',
      usage: globalCostTracker.getSessionSummary(),
      outcome: 'NO_CHANGE_REQUIRED',
    },
    expectedStatus: 'completed',
    expectedOutcome: 'NO_CHANGE_REQUIRED',
  },
  {
    label: 'policy block',
    terminal: {
      type: 'done',
      answer: 'blocked by policy',
      usage: globalCostTracker.getSessionSummary(),
      outcome: 'BLOCKED_POLICY',
    },
    expectedStatus: 'blocked',
    expectedOutcome: 'BLOCKED_POLICY',
  },
  {
    label: 'budget exhaustion',
    terminal: {
      type: 'done',
      answer: 'budget exhausted',
      usage: globalCostTracker.getSessionSummary(),
      outcome: 'BUDGET_EXHAUSTED',
    },
    expectedStatus: 'budget_exhausted',
    expectedOutcome: 'BUDGET_EXHAUSTED',
  },
  {
    label: 'cancellation',
    terminal: { type: 'cancelled' },
    expectedStatus: 'cancelled',
    expectedOutcome: 'CANCELLED',
  },
  {
    label: 'infrastructure failure',
    terminal: {
      type: 'failed',
      error: 'provider failed',
      outcome: 'INFRA_FAILURE',
    },
    expectedStatus: 'failed',
    expectedOutcome: 'INFRA_FAILURE',
  },
  {
    label: 'agent failure',
    terminal: {
      type: 'failed',
      error: 'agent invariant failed',
      outcome: 'AGENT_FAILURE',
    },
    expectedStatus: 'failed',
    expectedOutcome: 'AGENT_FAILURE',
  },
  {
    label: 'genuine unknown',
    terminal: null,
    expectedStatus: 'failed',
  },
];

const createdRunDirs: string[] = [];

afterEach(() => {
  for (const runDir of createdRunDirs.splice(0)) {
    rmSync(runDir, { recursive: true, force: true });
  }
});

async function* recordedStream(terminal: ChatEvent | null): AsyncGenerator<ChatEvent, void, undefined> {
  for (const event of RECORDED_PREFIX) yield event;
  if (terminal) yield terminal;
}

function recordedEngine(terminal: ChatEvent | null): ChatEngine {
  const engine = new ChatEngine({
    task: 'replay recorded canonical sequence',
    projectRoot: process.cwd(),
    model: 'deepseek-v4-flash',
    maxTurns: 2,
  });
  createdRunDirs.push(chatSessionDir(engine.getEngineRunId()));
  (engine as unknown as { submitMessageStream: ChatEngine['submitMessageStream'] }).submitMessageStream =
    async function* () {
      yield* recordedStream(terminal);
    };
  return engine;
}

describe('recorded canonical Chat event adaptation', () => {
  test('headless, callback, and protocol adapters preserve recorded event semantics', async () => {
    const terminal = TERMINAL_CASES[0]!.terminal;
    const headless = await consumeChatStream(recordedStream(terminal), null);
    assert.equal(
      (headless.toolCalls?.[0] as { toolCallId?: string } | undefined)?.toolCallId,
      'recorded-tool-1',
    );
    assert.deepEqual(headless.toolCalls?.[0]?.mutation_paths, ['src/a.ts']);
    assert.equal(
      (headless.toolCalls?.[1] as { toolCallId?: string } | undefined)?.toolCallId,
      'recorded-tool-2',
    );
    assert.equal(headless.toolCalls?.[1]?.error, 'exit 1');

    const protocolEvents = RECORDED_PREFIX.map(mapChatEventToTurnStreamEvent).filter(
      (event) => event !== null,
    );
    assert.deepEqual(protocolEvents, RECORDED_PREFIX);

    const engine = recordedEngine(terminal);
    const observed: string[] = [];
    let nextToolId = 54;
    await engine.submitMessage('replay', {
      onAnswerChunk: (chunk) => observed.push(`chunk:${chunk}`),
      onToolStart: () => ++nextToolId,
      onToolComplete: (id) => observed.push(`tool:${id}`),
      onFileChanged: (path) => observed.push(`file:${path}`),
      onSubAgentStart: ({ id }) => observed.push(`child-start:${id}`),
      onSubAgentComplete: ({ id }) => observed.push(`child-complete:${id}`),
      onSubAgentFailed: ({ id }) => observed.push(`child-failed:${id}`),
    });
    assert.deepEqual(observed, [
      'chunk:partial output',
      'tool:55',
      'file:src/a.ts',
      'tool:56',
      'child-start:child-ok',
      'child-complete:child-ok',
      'child-start:child-failed',
      'child-failed:child-failed',
    ]);
  });

  for (const terminalCase of TERMINAL_CASES) {
    test(`${terminalCase.label} has identical headless and non-stream terminal meaning`, async () => {
      const headless = await consumeChatStream(recordedStream(terminalCase.terminal), null);
      const direct = await recordedEngine(terminalCase.terminal).submitMessage('replay', {});

      assert.equal(headless.status, terminalCase.expectedStatus);
      assert.equal(headless.outcome, terminalCase.expectedOutcome);
      assert.equal(direct.status, terminalCase.expectedStatus);
      assert.equal(direct.outcome, terminalCase.expectedOutcome);

      if (terminalCase.terminal) {
        const protocol = mapChatEventToTurnStreamEvent(terminalCase.terminal);
        assert.ok(
          protocol &&
            (protocol.type === 'done' ||
              protocol.type === 'failed' ||
              protocol.type === 'cancelled'),
        );
        assert.equal(protocol.status, terminalCase.expectedStatus);
        assert.equal(protocol.outcome, terminalCase.expectedOutcome);
      }
    });
  }

  for (const terminalCase of TERMINAL_CASES) {
    test(`${terminalCase.label} durable terminal and TUI projection share canonical meaning`, () => {
      const runtime = createParityRuntime(`recorded-${terminalCase.label.replace(/\s+/g, '-')}`);
      parityOnUserTurn(runtime, {
        task: terminalCase.label,
        model: 'deepseek-v4-flash',
        provider: 'test',
        projectRoot: process.cwd(),
      });
      parityEndTurn(
        runtime,
        terminalCase.expectedOutcome,
        terminalCase.expectedOutcome ? 'completed' : terminalCase.expectedStatus,
      );

      const ended = runtime.sessionEvents.events.find((event) => event.kind === 'turn_ended');
      assert.equal(ended?.kind, 'turn_ended');
      if (ended?.kind !== 'turn_ended') return;
      assert.equal(ended.outcome, terminalCase.expectedOutcome);
      assert.equal(ended.status, terminalCase.expectedStatus);

      const view = projectTurnViewStateFromSessionEvents(runtime.sessionEvents.events);
      assert.equal(view.reviewCard.terminalOutcome, terminalCase.expectedOutcome);
      assert.equal(view.reviewCard.status, terminalCase.expectedStatus);
    });
  }
});
