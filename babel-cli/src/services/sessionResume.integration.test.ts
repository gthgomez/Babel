import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HISTORY_CELL_SCHEMA_VERSION } from '../ui/historyCells/types.js';
import { transcriptPath } from '../cli/runsLayout.js';
import { HistoryCellViewport } from '../ui/historyCells/viewport.js';
import { ScreenManager } from '../ui/screenManager.js';
import type { AgentTargetContext } from './targetResolver.js';
import { appendTurnCells } from './threadStore/index.js';
import { listResumableSessions } from './chatSessionIndex.js';
import { resumeChatSession } from '../interactive/chatSessionResume.js';
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