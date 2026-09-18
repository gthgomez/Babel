import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { rmSync } from 'node:fs';

import {
  ChatEngine,
  type ChatCallbacks,
  type ChatEvent,
} from './chatEngine.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { globalCostTracker } from '../services/costTracker.js';

const createdRunDirs: string[] = [];

afterEach(() => {
  for (const runDir of createdRunDirs.splice(0)) {
    rmSync(runDir, { recursive: true, force: true });
  }
});

function engineWithRecordedEvents(events: readonly ChatEvent[]): ChatEngine {
  const engine = new ChatEngine({
    task: 'replay canonical chat events',
    projectRoot: process.cwd(),
    model: 'deepseek-v4-flash',
    maxTurns: 2,
  });
  createdRunDirs.push(chatSessionDir(engine.getEngineRunId()));
  (engine as unknown as { submitMessageStream: ChatEngine['submitMessageStream'] }).submitMessageStream =
    async function* () {
      for (const event of events) yield event;
    };
  return engine;
}

function doneEvent(): ChatEvent {
  return {
    type: 'done',
    answer: 'recorded sequence complete',
    usage: globalCostTracker.getSessionSummary(),
    outcome: 'NO_CHANGE_REQUIRED',
  };
}

describe('ChatEngine callback event adapter', () => {
  test('non-stream result derives failed status from authoritative AGENT_FAILURE', async () => {
    const engine = engineWithRecordedEvents([
      {
        type: 'done',
        answer: 'partial output before failure',
        usage: globalCostTracker.getSessionSummary(),
        outcome: 'AGENT_FAILURE',
      },
    ]);

    const result = await engine.submitMessage('replay', {});

    assert.equal(result.outcome, 'AGENT_FAILURE');
    assert.equal(result.status, 'failed');
  });

  test('preserves each tool_start callback id through out-of-order tool settlement', async () => {
    const events: ChatEvent[] = [
      {
        type: 'tool_start',
        toolCallId: 'call-a',
        tool: 'read_file',
        target: 'src/a.ts',
      },
      {
        type: 'tool_start',
        toolCallId: 'call-b',
        tool: 'read_file',
        target: 'src/b.ts',
      },
      {
        type: 'tool_complete',
        toolCallId: 'call-b',
        tool: 'read_file',
        target: 'src/b.ts',
        detail: 'b complete',
        exitCode: 0,
      },
      {
        type: 'tool_complete',
        toolCallId: 'call-a',
        tool: 'read_file',
        target: 'src/a.ts',
        detail: 'a complete',
        exitCode: 0,
      },
      doneEvent(),
    ];
    const engine = engineWithRecordedEvents(events);
    const startedIds = new Map<string, number>();
    const completedIds: number[] = [];
    let nextId = 40;

    await engine.submitMessage('replay', {
      onToolStart: (_tool, target) => {
        const id = ++nextId;
        startedIds.set(target, id);
        return id;
      },
      onToolComplete: (id) => completedIds.push(id),
    });

    assert.deepEqual(completedIds, [startedIds.get('src/b.ts'), startedIds.get('src/a.ts')]);
    assert.ok(completedIds.every((id) => id >= 0), 'settled tools must never use sentinel id -1');
  });

  test('forwards tool_failed, file_changed, and sub-agent lifecycle events', async () => {
    const events: ChatEvent[] = [
      {
        type: 'tool_start',
        toolCallId: 'call-failed',
        tool: 'run_command',
        target: 'npm test',
      },
      {
        type: 'tool_failed',
        toolCallId: 'call-failed',
        tool: 'run_command',
        target: 'npm test',
        detail: 'tests failed',
        error: 'exit 1',
        exitCode: 1,
      },
      {
        type: 'file_changed',
        path: 'src/a.ts',
        additions: 3,
        deletions: 1,
        content: '+new line',
      },
      { type: 'sub_agent_start', id: 'child-1', label: 'review', model: 'test-model' },
      { type: 'sub_agent_complete', id: 'child-1', summary: 'reviewed', tokens: 12 },
      { type: 'sub_agent_start', id: 'child-2', label: 'verify' },
      { type: 'sub_agent_failed', id: 'child-2', error: 'child failed' },
      doneEvent(),
    ];
    const engine = engineWithRecordedEvents(events);
    const observed: string[] = [];
    const callbacks: ChatCallbacks = {
      onToolStart: () => 77,
      onToolComplete: (id, detail, error, exitCode) => {
        observed.push(`tool:${id}:${detail}:${error}:${exitCode}`);
      },
      onFileChanged: (path, additions, deletions, content) => {
        observed.push(`file:${path}:${additions}:${deletions}:${content}`);
      },
      onSubAgentStart: ({ id, label, model }) => {
        observed.push(`child-start:${id}:${label}:${model ?? ''}`);
      },
      onSubAgentComplete: ({ id, summary, tokens }) => {
        observed.push(`child-complete:${id}:${summary}:${tokens ?? ''}`);
      },
      onSubAgentFailed: ({ id, error }) => {
        observed.push(`child-failed:${id}:${error}`);
      },
    };

    await engine.submitMessage('replay', callbacks);

    assert.deepEqual(observed, [
      'tool:77:tests failed:exit 1:1',
      'file:src/a.ts:3:1:+new line',
      'child-start:child-1:review:test-model',
      'child-complete:child-1:reviewed:12',
      'child-start:child-2:verify:',
      'child-failed:child-2:child failed',
    ]);
  });
});
