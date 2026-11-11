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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { getOpenAdmissionStoreCount } from '../runtime/admissionTestHooks.js';
import { HistoryCellViewport } from '../ui/historyCells/viewport.js';
import { ScreenManager } from '../ui/screenManager.js';
import type { AgentTargetContext } from '../services/targetResolver.js';
import type { ReplContext } from './context.js';
import { resumeChatSession } from './chatSessionResume.js';
import type { SessionState } from './types.js';
import { loadExecutionPolicyRecord, persistExecutionPolicyRecord } from '../config/executionPolicySelection.js';
import { acquireSessionPolicyLease } from '../config/sessionPolicyLease.js';

test('session resume refuses an active or preparing task before replacing its owner', async () => {
  for (const busy of [{ isRunning: true }, { preparingRun: true }]) {
    const engine = { closeAdmissionStore() { throw new Error('must not detach active owner') } }
    const ctx = { ...busy, chatEngine: engine } as unknown as ReplContext
    const outcome = await resumeChatSession(ctx, 'synthetic-missing-session')
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.match(outcome.message, /active|wait|settle/i)
    assert.equal(ctx.chatEngine, engine)
  }
})

test('resuming the already active session does not open a competing owner', async () => {
  let closed = 0
  const engine = { getEngineRunId: () => 'same-session', closeAdmissionStore() { closed++ } }
  const ctx = { isRunning: false, chatEngine: engine } as unknown as ReplContext
  const result = await resumeChatSession(ctx, 'same-session')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /already active/i)
  assert.equal(ctx.chatEngine, engine); assert.equal(closed, 0); assert.notEqual(ctx.preparingRun, true)
})

test('session resume holds admission until its asynchronous completion', async () => {
  const ctx = { isRunning: false } as unknown as ReplContext
  const first = resumeChatSession(ctx, 'synthetic-missing-session')
  assert.equal(ctx.preparingRun, true)
  const second = await resumeChatSession(ctx, 'another-missing-session')
  assert.equal(second.ok, false)
  if (!second.ok) assert.match(second.message, /active|wait|settle/i)
  await first
  assert.equal(ctx.preparingRun, false)
})

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-d04-seam-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_RUNS_DIR'] = root;
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
  return {
    root,
    cleanup() {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
      else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
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
    model: 'deepseek-v4-flash-openrouter',
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
  // These tests isolate repository identity; give the fixture a known policy.
  persistExecutionPolicyRecord(sessionDir,{profile:'safe_repo',source:'explicit'},{kind:'docker'});
  return sessionDir;
}

function writeThreadIdentity(sessionDir: string, sessionId: string, projectRoot: string): void {
  const log = createThreadEventLog(sessionId);
  startTurn(log, { task: 't', model: 'm', provider: 'p', projectRoot, policyPreset: 'workspace_write' });
  persistThreadEventLog(sessionDir, log);
}

test('an unknown legacy policy needs a deliberate selection before interactive resume',async()=>{
  const fixture=withTempRunsDir();const target=mkdtempSync(join(tmpdir(),'babel-resume-policy-'));
  const ctx=makeResumeCtx(makeTarget(target));const id='legacy-policy-unknown';
  try{
    const directory=writeTranscript(fixture.root,id,'fixture history');
    unlinkSync(join(directory,'execution-policy.json'));
    const denied=await resumeChatSession(ctx,id,{confirmUnknownIdentity:true});
    assert.equal(denied.ok,false);
    if(!denied.ok)assert.match(denied.message,/explicit execution profile/i);
    const free=acquireSessionPolicyLease(id);free.release();
    process.env['BABEL_EXECUTION_PROFILE']='host_native';
    const resumed=await resumeChatSession(ctx,id,{confirmUnknownIdentity:true,executionProfile:'host_native'});
    assert.equal(resumed.ok,true);
    assert.equal(loadExecutionPolicyRecord(directory)?.source,'migration');
    assert.throws(()=>acquireSessionPolicyLease(id),/already owned|unavailable/i);
  }finally{
    ctx.chatEngine?.closeAdmissionStore();fixture.cleanup();rmSync(target,{recursive:true,force:true});
  }
});

test('interactive resume retains saved Docker policy when the ambient default is host',async()=>{
  const fixture=withTempRunsDir();const target=mkdtempSync(join(tmpdir(),'babel-resume-docker-'));
  const ctx=makeResumeCtx(makeTarget(target));const id='saved-docker-policy';
  try{
    writeTranscript(fixture.root,id,'fixture history');
    process.env['BABEL_EXECUTION_PROFILE']='host_native';
    const outcome=await resumeChatSession(ctx,id,{confirmUnknownIdentity:true});
    assert.equal(outcome.ok,true);
    assert.equal(ctx.chatEngine?.getExecutionPolicy()?.profile,'safe_repo');
    assert.equal(ctx.chatEngine?.getExecutionPolicy()?.expectedBoundary,'docker');
    assert.equal(process.env['BABEL_EXECUTION_PROFILE'],'host_native');
  }finally{ctx.chatEngine?.closeAdmissionStore();fixture.cleanup();rmSync(target,{recursive:true,force:true});}
});

test('delayed transcript restoration retains admission until the engine settles', async () => {
  const fixture = withTempRunsDir()
  const targetRoot = mkdtempSync(join(tmpdir(), 'babel-resume-delay-'))
  const ctx = makeResumeCtx(makeTarget(targetRoot))
  const original = ChatEngine.restore
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  try {
    const sessionId = 'delayed-transcript'
    writeTranscript(fixture.root, sessionId, 'fixture history')
    ChatEngine.restore = async (...args) => { entered(); await gate; return original.apply(ChatEngine, args) }
    const first = resumeChatSession(ctx, sessionId, { confirmUnknownIdentity: true })
    await started
    assert.equal(ctx.preparingRun, true)
    const second = await resumeChatSession(ctx, sessionId, { confirmUnknownIdentity: true })
    assert.equal(second.ok, false)
    if (!second.ok) assert.match(second.message, /active|wait|settle/i)
    release()
    const result = await first
    assert.equal(result.ok, true)
    assert.equal(ctx.preparingRun, false)
  } finally {
    release()
    ChatEngine.restore = original
    ctx.chatEngine?.closeAdmissionStore()
    fixture.cleanup()
    rmSync(targetRoot, { recursive: true, force: true })
  }
})

test('cancelled transcript restoration settles without replacing the previous engine', async () => {
  const { handleCancelTurn } = await import('./commands/review.js')
  const fixture = withTempRunsDir()
  const targetRoot = mkdtempSync(join(tmpdir(), 'babel-resume-cancel-'))
  const ctx = makeResumeCtx(makeTarget(targetRoot))
  let oldClosed = 0
  const previous = { closeAdmissionStore() { oldClosed++ }, abortTurn() { throw new Error('wrong owner') } } as unknown as ChatEngine
  ctx.chatEngine = previous
  const original = ChatEngine.restore
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  try {
    writeTranscript(fixture.root, 'cancelled-transcript', 'fixture history')
    ChatEngine.restore = async (...args) => { entered(); await gate; return original.apply(ChatEngine, args) }
    const pending = resumeChatSession(ctx, 'cancelled-transcript', { confirmUnknownIdentity: true })
    await started
    handleCancelTurn(ctx)
    assert.equal(ctx.preparingRun, true)
    assert.equal(ctx.chatEngine, previous)
    release()
    const result = await pending
    assert.equal(result.ok, false)
    if (!result.ok) { assert.equal(result.reason, 'cancelled'); assert.match(result.message, /cancel/i) }
    assert.equal(ctx.chatEngine, previous)
    assert.equal(oldClosed, 0)
    assert.equal(ctx.preparingRun, false)
    assert.equal(getOpenAdmissionStoreCount(), 0, 'cancelled restoration releases its admission handle')
  } finally {
    release(); ChatEngine.restore = original
    if (ctx.chatEngine !== previous) ctx.chatEngine?.closeAdmissionStore()
    fixture.cleanup(); rmSync(targetRoot, { recursive: true, force: true })
  }
})

test('a late restore error after cancellation remains a cancelled attempt', async () => {
  const { handleCancelTurn } = await import('./commands/review.js')
  const fixture = withTempRunsDir(); const targetRoot = mkdtempSync(join(tmpdir(), 'babel-resume-cancel-error-'))
  const ctx = makeResumeCtx(makeTarget(targetRoot)); const original = ChatEngine.restore
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  try {
    writeTranscript(fixture.root, 'cancelled-error', 'fixture history')
    ChatEngine.restore = async () => { entered(); await gate; throw new Error('late restore failure') }
    const pending = resumeChatSession(ctx, 'cancelled-error', { confirmUnknownIdentity: true })
    await started; handleCancelTurn(ctx); release()
    const result = await pending
    assert.equal(result.ok, false)
    if (!result.ok) { assert.equal(result.reason, 'cancelled'); assert.match(result.message, /cancel/i); assert.match(result.message, /late restore failure/i) }
    assert.equal(ctx.preparingRun, false)
    assert.equal(getOpenAdmissionStoreCount(), 0)
  } finally { release(); ChatEngine.restore = original; fixture.cleanup(); rmSync(targetRoot, { recursive: true, force: true }) }
})

test('canonical display archive cannot enter the REPL transcript-only fallback after log loss',async()=>{
  const fixture=withTempRunsDir(),targetRoot=mkdtempSync(join(tmpdir(),'babel-archive-fallback-'))
  const ctx=makeResumeCtx(makeTarget(targetRoot))
  try {
    const sessionId='orphan-canonical-archive'
    const directory=writeTranscript(fixture.root,sessionId,'fixture')
    writeFileSync(join(directory,'transcript.jsonl'),JSON.stringify({role:'assistant',content:'Unaccepted archive candidate',archive_source:'thread_events',archive_kind:'model_candidate',source_event_id:'orphan-event'})+'\n')
    const result=await resumeChatSession(ctx,sessionId,{confirmUnknownIdentity:true})
    assert.equal(result.ok,false,'CANONICAL_ARCHIVE_CONTEXT_ACCEPTED')
    assert.equal(ctx.chatEngine,undefined)
    assert.equal(getOpenAdmissionStoreCount(),0,'rejected archive fallback releases admission ownership')
  }finally{ctx.chatEngine?.closeAdmissionStore();fixture.cleanup();rmSync(targetRoot,{recursive:true,force:true})}
})

test('D04 resume seam identity', { concurrency: false }, async (t) => {
  await t.test('verified thread-log identity resumes without degraded flag', async () => {
    const fixture = withTempRunsDir();
    const targetRoot = mkdtempSync(join(tmpdir(), 'd04-seam-root-'));
    let ctx: ReplContext | undefined;
    try {
      const sessionId = 'd04-seam-verified';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'verified history');
      writeThreadIdentity(sessionDir, sessionId, targetRoot);

      ctx = makeResumeCtx(makeTarget(targetRoot));
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.degraded, undefined);
      assert.equal(outcome.source, 'transcript');
      assert.ok(ctx.chatEngine, 'engine admitted for verified identity');
    } finally {
      ctx?.chatEngine?.closeAdmissionStore();
      assert.equal(getOpenAdmissionStoreCount(), 0, 'resume owner releases its admission handle');
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
    let ctx: ReplContext | undefined;
    try {
      const sessionId = 'd04-seam-events-match';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'events identity match');
      // A real resumed session has live-session authority on disk; the minimal
      // engine construction persists it, mirroring the integration fixture.
      new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: 'events identity match', projectRoot: targetRoot, runId: sessionId });
      const log = createSessionEventLog(sessionId);
      recordUserSubmitted(log, { turn_id: 'turn-1', task: 't', projectRoot: targetRoot });
      flushSessionEventLog(sessionDir, log);

      ctx = makeResumeCtx(makeTarget(targetRoot));
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.degraded, undefined);
    } finally {
      ctx?.chatEngine?.closeAdmissionStore();
      assert.equal(getOpenAdmissionStoreCount(), 0, 'resume owner releases its admission handle');
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
    let ctx: ReplContext | undefined;
    try {
      symlinkSync(realRoot, linkRoot, 'dir');
      const sessionId = 'd04-seam-symlink';
      const sessionDir = writeTranscript(fixture.root, sessionId, 'symlink history');
      writeThreadIdentity(sessionDir, sessionId, realRoot);

      ctx = makeResumeCtx(makeTarget(linkRoot));
      const outcome = await resumeChatSession(ctx, sessionId);
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.degraded, undefined);
    } finally {
      ctx?.chatEngine?.closeAdmissionStore();
      fixture.cleanup();
      rmSync(linkRoot, { force: true });
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  await t.test('R0-3: legacy session with no durable identity requires explicit rebind', async () => {
    const fixture = withTempRunsDir();
    const targetRoot = mkdtempSync(join(tmpdir(), 'd04-seam-legacy-'));
    let ctx2: ReplContext | undefined;
    try {
      const sessionId = 'd04-seam-legacy';
      writeTranscript(fixture.root, sessionId, 'legacy history');

      // Without confirmation, unknown identity must not admit execution.
      const ctx = makeResumeCtx(makeTarget(targetRoot));
      const refused = await resumeChatSession(ctx, sessionId);
      assert.equal(refused.ok, false, 'unknown identity must not silently admit execution');
      if (refused.ok) return;
      assert.equal(refused.reason, 'repo_identity_unknown');
      assert.match(refused.message, /identity/i);
      assert.match(refused.message, /--confirm-repo-identity/);

      // Explicit rebind resumes as degraded history, never verified.
      ctx2 = makeResumeCtx(makeTarget(targetRoot));
      const confirmed = await resumeChatSession(ctx2, sessionId, { confirmUnknownIdentity: true });
      assert.equal(confirmed.ok, true, 'explicit rebind resumes');
      if (!confirmed.ok) return;
      assert.equal(confirmed.degraded, true);
      assert.match(confirmed.degradedReason ?? '', /identity/i);
      assert.equal(confirmed.source, 'transcript');
    } finally {
      ctx2?.chatEngine?.closeAdmissionStore();
      assert.equal(getOpenAdmissionStoreCount(), 0, 'explicit rebind owner releases its handle');
      fixture.cleanup();
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});
