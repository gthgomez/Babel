import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HISTORY_CELL_SCHEMA_VERSION } from '../ui/historyCells/types.js';
import { transcriptPath } from '../cli/runsLayout.js';
import {
  createSessionEventLog,
  flushSessionEventLog,
  recordUserSubmitted,
  SESSION_EVENTS_FILENAME,
} from '../agent/sessionEvents.js';
import { HistoryCellViewport } from '../ui/historyCells/viewport.js';
import { ScreenManager } from '../ui/screenManager.js';
import type { AgentTargetContext } from './targetResolver.js';
import { appendTurnCells } from './threadStore/index.js';
import { listResumableSessions } from './chatSessionIndex.js';
import { resumeChatSession } from '../interactive/chatSessionResume.js';
import { ChatEngine } from '../agent/chatEngine.js';
import type { ReplContext } from '../interactive/context.js';
import type { SessionState } from '../interactive/types.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-session-resume-int-'));
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

function makeUserCell(threadId: string, message: string, cellId = 'cell-u1') {
  return {
    schema_version: HISTORY_CELL_SCHEMA_VERSION,
    cell_id: cellId,
    thread_id: threadId,
    turn_id: 1,
    ts: new Date().toISOString(),
    kind: 'user_message' as const,
    lifecycle: 'committed' as const,
    revision: 0,
    payload: { message },
  };
}

function makeResumeCtx(target: AgentTargetContext): ReplContext {
  const viewport = new HistoryCellViewport(80);
  const screenManager = new ScreenManager({
    model: 'test',
    mode: 'chat',
    project: 'test',
    totalTokens: 0,
    totalCost: 0,
    turnCount: 0,
  });
  screenManager.attachHistoryCellViewport(viewport);

  const state: SessionState = {
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

  const ctx = {
    state,
    turns: [],
    turnCounter: 0,
    chatEngine: undefined,
    screenManager,
    lastTargetRoot: target.targetRoot,
    lastWorkspaceRoot: target.workspaceRoot,
    saveSessionState: () => undefined,
    resolveCurrentTarget: () => target,
  } as unknown as ReplContext;

  return ctx;
}

test('sessionResume integration', { concurrency: false }, async (t) => {
  const target: AgentTargetContext = {
    targetRoot: process.cwd(),
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: process.cwd(),
  };

  await t.test('thread-only resume hydrates engine and viewport from cells', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-thread-only-int';
      appendTurnCells(sessionId, 1, [makeUserCell(sessionId, 'thread-only hello')]);

      const listed = await listResumableSessions({ limit: 10 });
      const entry = listed.find((s) => s.id === sessionId);
      assert.ok(entry);
      assert.equal(entry?.hasThreadStore, true);
      assert.equal(entry?.transcriptPath, transcriptPath(sessionId));

      const ctx = makeResumeCtx(target);
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.source, 'thread_store');
      assert.match(ctx.chatEngine?.getConversation().find((m) => m.role === 'user')?.content ?? '', /thread-only hello/);
      assert.equal(ctx.screenManager?.getHistoryCellViewport()?.cellEntries.length ?? 0, 1);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('transcript-only resume hydrates from transcript.jsonl', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-transcript-only-int';
      const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'transcript.jsonl'),
        `${JSON.stringify({ role: 'user', content: 'transcript-only hello' })}\n`,
        'utf8',
      );

      const ctx = makeResumeCtx(target);
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.source, 'transcript');
      assert.match(ctx.chatEngine?.getConversation().find((m) => m.role === 'user')?.content ?? '', /transcript-only hello/);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('valid transcript plus valid event log restores normally', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-valid-events-int';
      const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'transcript.jsonl'), `${JSON.stringify({ role: 'user', content: 'valid durable history' })}\n`, 'utf8');
      new ChatEngine({ task: 'valid durable history', projectRoot: target.targetRoot, runId: sessionId });
      const log = createSessionEventLog(sessionId);
      recordUserSubmitted(log, { turn_id: 'turn-1', task: 'valid durable history' });
      flushSessionEventLog(sessionDir, log);

      const outcome = await resumeChatSession(makeResumeCtx(target), sessionId);
      assert.equal(outcome.ok, true);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('malformed event evidence rejects resume instead of falling back', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-malformed-events-int';
      const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'transcript.jsonl'), `${JSON.stringify({ role: 'user', content: 'must not hide corruption' })}\n`, 'utf8');
      writeFileSync(join(sessionDir, SESSION_EVENTS_FILENAME), '{"schema_version":1}\n', 'utf8');

      const outcome = await resumeChatSession(makeResumeCtx(target), sessionId);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'error');
      assert.match(outcome.message, /session-events\.jsonl is invalid/);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('zero-byte and whitespace-only event logs reject resume', async () => {
    for (const [suffix, raw] of [['empty', ''], ['whitespace', ' \n\t']] as const) {
      const fixture = withTempRunsDir();
      try {
        const sessionId = 'chat-invalid-empty-events-int-' + suffix;
        const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
          join(sessionDir, 'transcript.jsonl'),
          JSON.stringify({ role: 'user', content: 'empty evidence is not legacy' }) + '\n',
          'utf8',
        );
        writeFileSync(join(sessionDir, SESSION_EVENTS_FILENAME), raw, 'utf8');

        const outcome = await resumeChatSession(makeResumeCtx(target), sessionId);
        assert.equal(outcome.ok, false, suffix);
        if (outcome.ok) continue;
        assert.match(outcome.message, /session-events\.jsonl is invalid/, suffix);
      } finally {
        fixture.cleanup();
      }
    }
  });

  await t.test('clean sequence truncation rejects resume', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-clean-truncation-events-int';
      const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'transcript.jsonl'),
        JSON.stringify({ role: 'user', content: 'clean truncation is not legacy' }) + '\n',
        'utf8',
      );
      const event = (id: string, seq: number): string =>
        JSON.stringify({
          schema_version: 1,
          event_id: id,
          session_id: sessionId,
          turn_id: null,
          seq,
          ts: '2026-08-13T00:00:00.000Z',
          kind: 'model_started',
        });
      writeFileSync(
        join(sessionDir, SESSION_EVENTS_FILENAME),
        event('event-0', 0) + '\n' + event('event-2', 2) + '\n',
        'utf8',
      );

      const outcome = await resumeChatSession(makeResumeCtx(target), sessionId);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.message, /contiguous|invalid/);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('event log copied from another session rejects resume', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-provenance-target-int';
      const sourceSessionId = 'chat-provenance-source-int';
      const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'transcript.jsonl'),
        JSON.stringify({ role: 'user', content: 'provenance must be bound' }) + '\n',
        'utf8',
      );
      const foreignLog = createSessionEventLog(sourceSessionId);
      recordUserSubmitted(foreignLog, { turn_id: 'turn-foreign', task: 'foreign durable evidence' });
      flushSessionEventLog(sessionDir, foreignLog);

      const outcome = await resumeChatSession(makeResumeCtx(target), sessionId);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.message, /does not match requested session|invalid/);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test('semantically invalid and truncated event evidence never becomes transcript-only success', async () => {
    for (const [suffix, raw] of [
      ['semantic', '{"schema_version":1,"event_id":"e","session_id":"chat-invalid-events-int-semantic","turn_id":null,"seq":0,"ts":"2026-08-13T00:00:00.000Z","kind":"user_submitted"}\n'],
      ['truncated', '{"schema_version":1,"event_id":"e"'],
    ] as const) {
      const fixture = withTempRunsDir();
      try {
        const sessionId = `chat-invalid-events-int-${suffix}`;
        const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'transcript.jsonl'), `${JSON.stringify({ role: 'user', content: 'not a fallback' })}\n`, 'utf8');
        writeFileSync(join(sessionDir, SESSION_EVENTS_FILENAME), raw, 'utf8');

        const outcome = await resumeChatSession(makeResumeCtx(target), sessionId);
        assert.equal(outcome.ok, false, suffix);
      } finally {
        fixture.cleanup();
      }
    }
  });

  await t.test('collision: thread-store cells win over stale transcript for same id', async () => {
    const fixture = withTempRunsDir();
    try {
      const sessionId = 'chat-collision-int';
      const sessionDir = join(fixture.root, 'chat-sessions', sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'transcript.jsonl'),
        `${JSON.stringify({ role: 'user', content: 'stale transcript message' })}\n`,
        'utf8',
      );
      appendTurnCells(sessionId, 1, [makeUserCell(sessionId, 'thread store wins')]);

      const ctx = makeResumeCtx(target);
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.source, 'thread_store');
      const userContent = ctx.chatEngine?.getConversation().find((m) => m.role === 'user')?.content;
      assert.match(String(userContent), /thread store wins/);
      assert.doesNotMatch(String(userContent), /stale transcript/);
      assert.equal(ctx.turns.find((turn) => turn.role === 'user')?.input, 'thread store wins');
    } finally {
      fixture.cleanup();
    }
  });
});
