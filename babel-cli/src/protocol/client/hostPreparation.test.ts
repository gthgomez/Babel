/**
 * P02 — preparation/resume conformance on the protocol surface.
 *
 * A cold resume must restore durable conversation state (or refuse explicitly),
 * and deep must never be silently substituted with a labelled Chat engine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatEngine } from '../../agent/chatEngine.js';
import { SESSION_EVENTS_FILENAME } from '../../agent/sessionEvents.js';
import { chatSessionDir } from '../../cli/runsLayout.js';
import { appendTurnCells } from '../../services/threadStore/index.js';
import { HISTORY_CELL_SCHEMA_VERSION } from '../../ui/historyCells/types.js';
import type { HistoryCellRecord } from '../../ui/historyCells/types.js';
import { BabelProtocolErrorCode } from '../types.js';
import { createProtocolHostState, handleProtocolRequest } from './index.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-protocol-prep-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  return {
    root,
    cleanup() {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface ConversationMessage {
  role: string;
  content: string;
}

/** ChatEngine stub that records conversation hydration without a provider. */
class RecordingEngine {
  conversation: ConversationMessage[] = [];
  executions = 0;
  private pending: Array<() => void> = [];

  assignRunId(_runId: string): void {
    /* identity only */
  }

  cancel(): void {
    /* no-op */
  }

  getConversation(): ConversationMessage[] {
    return [...this.conversation];
  }

  replaceConversation(messages: ConversationMessage[]): void {
    this.conversation = [...messages];
  }

  replaceProviderConversation(_messages: unknown): void {
    /* provider mirror not under test */
  }

  restoreEventLog(_log: unknown): void {
    /* event-log identity not under test */
  }

  restoreSessionEventsFromDir(_dir?: string): void {
    /* no-op */
  }

  async *submitMessageStream(_message: string): AsyncGenerator<unknown> {
    this.executions += 1;
    await new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
    yield { type: 'done', answer: 'ok', usage: {} };
  }

  settleNext(): void {
    this.pending.shift()?.();
  }
}

async function createThread(
  state: ReturnType<typeof createProtocolHostState>,
  projectRoot: string,
  mode?: 'chat' | 'plan' | 'deep',
): Promise<string> {
  const response = await handleProtocolRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'thread.create',
      params: { project_root: projectRoot, ...(mode ? { mode } : {}) },
    },
    state,
  );
  assert.ok('result' in response, 'thread.create must succeed');
  return (response as { result: { thread_id: string } }).result.thread_id;
}

function cell(
  threadId: string,
  turnId: number,
  kind: 'user_message' | 'assistant_message',
  message: string,
  suffix: string,
): HistoryCellRecord {
  return {
    schema_version: HISTORY_CELL_SCHEMA_VERSION,
    cell_id: `cell-${suffix}`,
    thread_id: threadId,
    turn_id: turnId,
    ts: new Date().toISOString(),
    kind,
    lifecycle: 'committed',
    revision: 0,
    payload: { message },
  };
}

test('P02: cold resume hydrates stored cells before submission', async () => {
  const fixture = withTempRunsDir();
  try {
    const creator = createProtocolHostState();
    const threadId = await createThread(creator, fixture.root);
    appendTurnCells(threadId, 1, [
      cell(threadId, 1, 'user_message', 'remember the sentinel', 'u1'),
      cell(threadId, 1, 'assistant_message', 'stored answer', 'a1'),
    ]);

    const engine = new RecordingEngine();
    const host = createProtocolHostState({
      engineFactory: () => engine as unknown as ChatEngine,
      executeWithoutNotifications: true,
    });

    const resumed = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 2, method: 'thread.resume', params: { thread_id: threadId } },
      host,
    );
    assert.ok('result' in resumed);
    const restore = (resumed as { result: { restore?: { resumable: boolean; source: string; turnCount: number } } })
      .result.restore;
    assert.equal(restore?.resumable, true);
    assert.equal(restore?.source, 'history_cells');
    assert.equal(restore?.turnCount, 1);

    const submitted = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 3, method: 'turn.submit', params: { thread_id: threadId, message: 'what was the sentinel?' } },
      host,
    );
    assert.ok('result' in submitted);
    assert.equal(engine.executions, 1);
    assert.ok(
      engine.conversation.some((m) => m.content.includes('remember the sentinel')),
      'resumed engine must carry stored history, not start empty',
    );
  } finally {
    fixture.cleanup();
  }
});

test('P02: invalid durable state is explicitly non-resumable and refused', async () => {
  const fixture = withTempRunsDir();
  try {
    const creator = createProtocolHostState();
    const threadId = await createThread(creator, fixture.root);
    const sessionDir = chatSessionDir(threadId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, SESSION_EVENTS_FILENAME), '{ this is not valid jsonl');

    const host = createProtocolHostState({ executeWithoutNotifications: true });
    const resumed = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 2, method: 'thread.resume', params: { thread_id: threadId } },
      host,
    );
    assert.ok('result' in resumed);
    const restore = (resumed as { result: { restore?: { resumable: boolean; reason?: string } } }).result.restore;
    assert.equal(restore?.resumable, false);
    assert.match(restore?.reason ?? '', /SESSION_EVENT_LOG_INVALID/);

    const submitted = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 3, method: 'turn.submit', params: { thread_id: threadId, message: 'continue' } },
      host,
    );
    assert.ok('error' in submitted);
    assert.equal(
      (submitted as { error: { code: number } }).error.code,
      BabelProtocolErrorCode.THREAD_NOT_RESUMABLE,
    );
  } finally {
    fixture.cleanup();
  }
});

test('P02: deep is rejected explicitly and never constructs a Chat engine', async () => {
  const fixture = withTempRunsDir();
  try {
    const creator = createProtocolHostState();
    const threadId = await createThread(creator, fixture.root, 'deep');

    let factoryCalls = 0;
    const host = createProtocolHostState({
      engineFactory: () => {
        factoryCalls += 1;
        return new RecordingEngine() as unknown as ChatEngine;
      },
      executeWithoutNotifications: true,
    });

    const submitted = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 2, method: 'turn.submit', params: { thread_id: threadId, message: 'do deep work' } },
      host,
    );
    assert.ok('error' in submitted);
    assert.equal((submitted as { error: { code: number } }).error.code, BabelProtocolErrorCode.MODE_UNSUPPORTED);
    assert.equal(factoryCalls, 0, 'unsupported deep must not construct a ChatEngine');

    // History remains readable for the legacy/unsupported descriptor.
    const history = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 3, method: 'history.lookup', params: { thread_id: threadId } },
      host,
    );
    assert.ok('result' in history);
  } finally {
    fixture.cleanup();
  }
});

test('P02: a fresh thread reports no source and remains submittable', async () => {
  const fixture = withTempRunsDir();
  try {
    const host = createProtocolHostState({ executeWithoutNotifications: true });
    const threadId = await createThread(host, fixture.root);
    const resumed = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 2, method: 'thread.resume', params: { thread_id: threadId } },
      host,
    );
    assert.ok('result' in resumed);
    const restore = (resumed as { result: { restore?: { resumable: boolean; source: string } } }).result.restore;
    assert.equal(restore?.resumable, true);
    assert.equal(restore?.source, 'none');

    const submitted = await handleProtocolRequest(
      { jsonrpc: '2.0', id: 3, method: 'turn.submit', params: { thread_id: threadId, message: 'first task' } },
      host,
    );
    assert.ok('result' in submitted);
  } finally {
    fixture.cleanup();
  }
});
