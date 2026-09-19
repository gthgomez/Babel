/**
 * D04 — physical repository identity at the real resume seam.
 *
 * `resumeChatSession` must verify identity before any engine/execution context
 * is admitted. A durable mismatch fails closed (no engine); a session with no
 * durable identity resumes as inert history but is marked degraded rather than
 * presented as safely resumed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createThreadEventLog,
  persistThreadEventLog,
  startTurn,
} from '../agent/threadEventLog.js';
import {
  createSessionEventLog,
  flushSessionEventLog,
  recordUserSubmitted,
} from '../agent/sessionEvents.js';
import { ChatEngine } from '../agent/chatEngine.js';
import { HistoryCellViewport } from '../ui/historyCells/viewport.js';
import { ScreenManager } from '../ui/screenManager.js';
import type { AgentTargetContext } from '../services/targetResolver.js';
import type { ReplContext } from './context.js';
import { resumeChatSession } from './chatSessionResume.js';
import type { SessionState } from './types.js';

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-d04-seam-'));
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

function makeTarget(targetRoot: string): AgentTargetContext {
  return { targetRoot, workspaceRoot: null, project: null, source: 'cwd', cwd: targetRoot };
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
    costTotals: { totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 },
    turnCount: 0,
  };
  return {
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
}

function writeTranscript(runRoot: string, sessionId: string, content: string): string {
  const sessionDir = join(runRoot, 'chat-sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'transcript.jsonl'),
    `${JSON.stringify({ role: 'user', content })}\n`,
    'utf8',
  );
  return sessionDir;
}

function writeThreadIdentity(sessionDir: string, sessionId: string, projectRoot: string): void {
  const log = createThreadEventLog(sessionId);
  startTurn(log, { task: 't', model: 'm', provider: 'p', projectRoot, policyPreset: 'workspace_write' });
  persistThreadEventLog(sessionDir, log);
}

test('D04 resume seam identity', { concurrency: false }, async (t) => {
  await t.test('verified thread-log identity resumes without degraded flag', async () => {
    const fixture = withTempRunsDir();
    const targetRoot = mkdtempSync(join(tmpdir(), 'd04-seam-root-'));
    try {
      const sessionId = 'd04-seam-verified';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'verified history');
      writeThreadIdentity(sessionDir, sessionId, targetRoot);

      const ctx = makeResumeCtx(makeTarget(targetRoot));
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.degraded, undefined);
      assert.equal(outcome.source, 'transcript');
      assert.ok(ctx.chatEngine, 'engine admitted for verified identity');
    } finally {
      fixture.cleanup();
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  await t.test('workspace moved: durable mismatch fails closed before engine admission', async () => {
    const fixture = withTempRunsDir();
    const savedRoot = mkdtempSync(join(tmpdir(), 'd04-seam-old-'));
    const currentRoot = mkdtempSync(join(tmpdir(), 'd04-seam-new-'));
    try {
      const sessionId = 'd04-seam-moved';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'moved workspace history');
      writeThreadIdentity(sessionDir, sessionId, savedRoot);

      const ctx = makeResumeCtx(makeTarget(currentRoot));
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'repo_identity_mismatch');
      assert.match(outcome.message, /root changed/i);
      assert.match(outcome.message, new RegExp(savedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(ctx.chatEngine, undefined, 'no engine admitted on mismatch');
    } finally {
      fixture.cleanup();
      rmSync(savedRoot, { recursive: true, force: true });
      rmSync(currentRoot, { recursive: true, force: true });
    }
  });

  await t.test('session-events project_root mismatch fails closed without a thread log', async () => {
    const fixture = withTempRunsDir();
    const savedRoot = mkdtempSync(join(tmpdir(), 'd04-seam-ev-old-'));
    const currentRoot = mkdtempSync(join(tmpdir(), 'd04-seam-ev-new-'));
    try {
      const sessionId = 'd04-seam-events-mismatch';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'events identity history');
      const log = createSessionEventLog(sessionId);
      recordUserSubmitted(log, { turn_id: 'turn-1', task: 't', projectRoot: savedRoot });
      flushSessionEventLog(sessionDir, log);

      const ctx = makeResumeCtx(makeTarget(currentRoot));
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.reason, 'repo_identity_mismatch');
      assert.equal(ctx.chatEngine, undefined);
    } finally {
      fixture.cleanup();
      rmSync(savedRoot, { recursive: true, force: true });
      rmSync(currentRoot, { recursive: true, force: true });
    }
  });

  await t.test('session-events project_root match resumes without degraded flag', async () => {
    const fixture = withTempRunsDir();
    const targetRoot = mkdtempSync(join(tmpdir(), 'd04-seam-ev-match-'));
    try {
      const sessionId = 'd04-seam-events-match';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'events identity match');
      // A real resumed session has live-session authority on disk; the minimal
      // engine construction persists it, mirroring the integration fixture.
      new ChatEngine({ task: 'events identity match', projectRoot: targetRoot, runId: sessionId });
      const log = createSessionEventLog(sessionId);
      recordUserSubmitted(log, { turn_id: 'turn-1', task: 't', projectRoot: targetRoot });
      flushSessionEventLog(sessionDir, log);

      const outcome = await resumeChatSession(makeResumeCtx(makeTarget(targetRoot)), sessionId);
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.degraded, undefined);
    } finally {
      fixture.cleanup();
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  await t.test('symlink alias of the same physical repository resumes cleanly', async (tc) => {
    if (process.platform === 'win32') {
      tc.skip('symlink semantics differ on Windows');
      return;
    }
    const fixture = withTempRunsDir();
    const realRoot = mkdtempSync(join(tmpdir(), 'd04-seam-real-'));
    const linkRoot = join(tmpdir(), `d04-seam-link-${process.pid}-${Date.now()}`);
    try {
      symlinkSync(realRoot, linkRoot, 'dir');
      const sessionId = 'd04-seam-symlink';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'symlink history');
      writeThreadIdentity(sessionDir, sessionId, realRoot);

      const outcome = await resumeChatSession(makeResumeCtx(makeTarget(linkRoot)), sessionId);
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.degraded, undefined);
    } finally {
      fixture.cleanup();
      rmSync(linkRoot, { force: true });
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  await t.test('legacy session with no durable identity resumes degraded, never verified', async () => {
    const fixture = withTempRunsDir();
    const targetRoot = mkdtempSync(join(tmpdir(), 'd04-seam-legacy-'));
    try {
      const sessionId = 'd04-seam-legacy';
      writeTranscript(fixture.root, sessionId, 'legacy history');

      const ctx = makeResumeCtx(makeTarget(targetRoot));
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true, 'legacy transcript resume must not be hard-broken');
      if (!outcome.ok) return;
      assert.equal(outcome.degraded, true);
      assert.match(outcome.degradedReason ?? '', /identity/i);
      assert.equal(outcome.source, 'transcript');
    } finally {
      fixture.cleanup();
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});
