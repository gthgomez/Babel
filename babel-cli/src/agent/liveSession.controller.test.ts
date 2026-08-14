/**
 * H2 controller-level fixtures: InstructionManifest + LiveSession on ChatEngine
 * dual-write / resume path. Proves restore equivalence of task, manifest,
 * policy, tool idempotency, revision, and budget.
 */

import * as assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatEngine } from './chatEngine.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordMutationBatch,
  recordVerifierAttempt,
  recordCompletionDecision,
  recordTurnEnded,
  recordCompactionCreated,
  recordCompactionStarted,
  recordCompactionSummary,
  recordCompactionCommitted,
  recordPolicyIntervened,
  flushSessionEventLog,
  flushSessionEventLogStrict,
  loadSessionEventLogFromDir,
  serializeSessionEventLog,
  parseSessionEventLog,
  SESSION_EVENTS_FILENAME,
  operationFingerprint,
  interruptedToolRecoveries,
  markInterruptedToolsOnResume,
} from './sessionEvents.js';
import {
  createThreadEventLog,
  appendThreadEvent,
  startTurn,
  persistThreadEventLog,
  THREAD_EVENT_LOG_FILENAME,
} from './threadEventLog.js';
import {
  INSTRUCTION_MANIFEST_FILENAME,
  TASK_CONTRACT_FILENAME,
  LIVE_SESSION_SNAPSHOT_FILENAME,
  resumeEquivalenceFromDisk,
  projectFromDurableSession,
  loadLiveSessionAuthority,
} from './liveSessionBridge.js';
import {
  canMutateWithIdempotencyKey,
  mayBlindRetryInterrupted,
  sliceSessionAtBoundary,
  type CrashBoundary,
} from './liveSession.js';
import {
  createParityRuntime,
  parityOnUserTurn,
  paritySettleProposeTools,
  paritySettleToolStarted,
  finalizeParityTurnSync,
  checkpointParityEventLog,
} from './chatEngineParityBridge.js';
import { withAcceptanceCriteria } from './taskContract.js';
import {
  buildLiveGoldenEpisode,
  validateGoldenEpisode,
  replayTerminalDecision,
} from './episodeReplay.js';
import {
  makeFailureCapsule,
  applyHonestTaskOutcomeToCompletion,
  freezeTaskContract,
  buildTaskContractV1,
} from './taskContract.js';
import { executeActionWithPolicy } from './toolExecutor.js';
import { checkToolCapability } from './capabilityBroker.js';
import { startBackgroundShell } from './backgroundShell.js';

describe('H2 ChatEngine live authority freeze', () => {
  it('constructor freezes InstructionManifestV1 + TaskContractV1 and persists them', () => {
    const engine = new ChatEngine({
      task: 'fix auth bug without expanding scope',
      projectRoot: process.cwd(),
    });
    const man = engine.getInstructionManifest();
    const tc = engine.getTaskContract();
    assert.ok(man, 'instruction manifest present');
    assert.ok(tc, 'task contract present');
    assert.ok(man!.manifest_hash.length >= 16);
    assert.strictEqual(tc!.frozen, true);
    assert.strictEqual(tc!.user_request.includes('auth bug'), true);

    const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
    assert.ok(existsSync(join(runDir, INSTRUCTION_MANIFEST_FILENAME)));
    assert.ok(existsSync(join(runDir, TASK_CONTRACT_FILENAME)));

    // Frozen: acceptance cannot drift
    assert.throws(() => withAcceptanceCriteria(tc!, ['sneaky']), /frozen/);
  });

  it('policy fragments on manifest survive serialize/deserialize (handoff/resume)', () => {
    const engine = new ChatEngine({
      task: 't',
      projectRoot: process.cwd(),
    });
    const man = engine.getInstructionManifest()!;
    const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
    const reloaded = loadLiveSessionAuthority(runDir);
    assert.ok(reloaded);
    assert.strictEqual(reloaded!.instructionManifest.manifest_hash, man.manifest_hash);
    assert.ok(
      reloaded!.instructionManifest.fragments.some((f) => f.rule_id === 'safety:workspace-scope'),
    );
  });
});

describe('H2 ChatEngine resume + LiveSession projection', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-h2-ctrl-'));
  });

  after(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function seedFullSession(runDir: string, task: string) {
    const log = createSessionEventLog('ctrl-sess');
    const turn = 'turn-ctrl-1';
    recordUserSubmitted(log, {
      turn_id: turn,
      task,
      model: 'deepseek-chat',
      provider: 'deepseek',
      taskClass: 'general_swe',
    });
    recordToolProposed(log, {
      turn_id: turn,
      tool_call_id: 'tc1',
      tool_name: 'write_file',
      idempotency_key: 'idem-ctrl-1',
    });
    recordToolStarted(log, {
      turn_id: turn,
      tool_call_id: 'tc1',
      tool_name: 'write_file',
      idempotency_key: 'idem-ctrl-1',
    });
    recordToolTerminal(log, {
      turn_id: turn,
      tool_call_id: 'tc1',
      tool_name: 'write_file',
      idempotency_key: 'idem-ctrl-1',
      exit_code: 0,
    });
    recordMutationBatch(log, turn, {
      paths: ['src/auth.ts'],
      batch_id: 'b1',
      starting_revision: 'rev0',
      ending_revision: 'rev1',
      status: 'commit',
    });
    recordVerifierAttempt(log, {
      turn_id: turn,
      command_preview: 'npm test',
      authoritative: true,
      exit_code: 0,
    });
    recordCompactionCreated(log, turn, { content_preview: 'capsule' });
    recordPolicyIntervened(log, turn, {
      source: 'zero_write',
      action: 'nudge',
    });
    recordCompletionDecision(log, turn, {
      requestedOutcome: 'VERIFIED_COMPLETE',
      finalOutcome: 'VERIFIED_COMPLETE',
      allowed: true,
      reason: 'ok',
      evidenceRefs: ['e1'],
      policyVersion: 'v1',
    });
    recordTurnEnded(log, {
      turn_id: turn,
      outcome: 'VERIFIED_COMPLETE',
      status: 'done',
    });
    flushSessionEventLog(runDir, log);
    return log;
  }

  it('restoreSessionEvents reloads authority and projects LiveSession with task/manifest/tools/revision/terminal', () => {
    const engine = new ChatEngine({
      task: 'fix auth bug',
      projectRoot: process.cwd(),
    });
    const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
    // Overwrite with seeded events while keeping authority files from constructor
    const log = seedFullSession(runDir, 'fix auth bug');

    // Simulate cold resume on a fresh engine instance
    const engine2 = new ChatEngine({
      task: 'placeholder',
      projectRoot: process.cwd(),
    });
    // Point restore at first engine's run dir
    const interrupted = engine2.restoreSessionEvents(log, { runDir });
    assert.ok(interrupted >= 0);

    const live = engine2.getLiveSession({ turns: 10 });
    assert.strictEqual(live.active_task, 'fix auth bug');
    assert.ok(live.tools.completed_idempotency_keys.includes('idem-ctrl-1'));
    assert.strictEqual(live.workspace_revision, 'rev1');
    assert.strictEqual(live.terminal?.outcome, 'VERIFIED_COMPLETE');
    assert.ok(live.compaction_count >= 1);
    assert.ok(live.policy_intervention_count >= 1);

    // Double mutation blocked
    assert.strictEqual(engine2.canMutateIdempotencyKey('idem-ctrl-1'), false);
    assert.strictEqual(engine2.canMutateIdempotencyKey('idem-other'), true);

    // Manifest identity restored from disk when present
    const man = engine2.getInstructionManifest();
    assert.ok(man);
    assert.ok(man!.manifest_hash.length >= 16);
  });

  it('checkpoint dual-writes budget_snapshot and live-session snapshot', () => {
    const engine = new ChatEngine({
      task: 'checkpoint task',
      projectRoot: process.cwd(),
    });
    const rt = engine.getParityRuntime();
    const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
    // Simulate a user turn event
    recordUserSubmitted(rt.sessionEvents, {
      turn_id: 't1',
      task: 'checkpoint task',
      model: 'm',
    });
    rt.turnId = 't1';
    checkpointParityEventLog(rt, runDir);

    const hasBudget = rt.sessionEvents.events.some((e) => e.kind === 'budget_snapshot');
    assert.ok(hasBudget, 'budget_snapshot dual-written');
    assert.ok(existsSync(join(runDir, LIVE_SESSION_SNAPSHOT_FILENAME)));
    assert.ok(rt.liveSession, 'liveSession projected on checkpoint');
    assert.strictEqual(rt.liveSession!.active_task, 'checkpoint task');
  });

  it('required session flush blocks an effect boundary on persistence failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-session-flush-'));
    const invalidRunDir = join(root, 'run-file');
    writeFileSync(invalidRunDir, 'not a directory');
    const rt = createParityRuntime('flush-failure');
    parityOnUserTurn(rt, {
      task: 'flush boundary',
      model: 'test-model',
      provider: 'test-provider',
      projectRoot: root,
    });
    assert.throws(
      () => paritySettleProposeTools(rt, [{ id: 'call-1', name: 'write_file' }], invalidRunDir),
      /session event persistence failed/,
    );
    assert.equal(existsSync(join(invalidRunDir, SESSION_EVENTS_FILENAME)), false);
    assert.throws(() => flushSessionEventLogStrict(invalidRunDir, rt.sessionEvents));
    rmSync(root, { recursive: true, force: true });
  });

  it('disk resume equivalence of projected LiveSession', () => {
    const engine = new ChatEngine({
      task: 'resume eq',
      projectRoot: process.cwd(),
    });
    const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
    seedFullSession(runDir, 'resume eq');
    // Ensure authority + snapshot via finalize
    const rt = engine.getParityRuntime();
    finalizeParityTurnSync(rt, runDir, 'VERIFIED_COMPLETE', 'done');

    const eq = resumeEquivalenceFromDisk(runDir);
    assert.ok(eq.ok, eq.mismatches.join(','));
    assert.ok(eq.live);
    assert.strictEqual(eq.live!.active_task, 'resume eq');
  });
});

describe('H2 forced-termination at controller-visible boundaries', () => {
  it('interrupted mid-effect is not blindly retried after restore settle', () => {
    const engine = new ChatEngine({
      task: 'kill mid write',
      projectRoot: process.cwd(),
    });
    const log = createSessionEventLog('kill');
    const turn = 't';
    recordUserSubmitted(log, { turn_id: turn, task: 'kill mid write' });
    recordToolProposed(log, {
      turn_id: turn,
      tool_call_id: 'x',
      tool_name: 'write_file',
      idempotency_key: 'idem-kill',
    });
    recordToolStarted(log, {
      turn_id: turn,
      tool_call_id: 'x',
      tool_name: 'write_file',
      idempotency_key: 'idem-kill',
    });
    // Restore mid-effect: settle may mark cancelled (not success)
    engine.restoreSessionEvents(log);
    const live = engine.getLiveSession();
    // Must not treat as successful completed mutation with green exit
    assert.ok(
      !live.tools.completed_idempotency_keys.includes('idem-kill') ||
        live.tools.interrupted_idempotency_keys.includes('idem-kill') ||
        live.tools.open_tool_call_ids.includes('x'),
      'mid-effect key must not look like clean success-only completion',
    );    // Restore settles the interrupted dispatch as a terminal cancellation; a second
    // terminal must now be rejected instead of becoming contradictory evidence.
    const live2 = engine.getLiveSession();
    assert.strictEqual(mayBlindRetryInterrupted(live2, 'idem-kill'), false);
    // Cancelled keys are settled terminal — must not re-mutate with same key
    assert.strictEqual(canMutateWithIdempotencyKey(live2, 'idem-kill'), false);
  });

  it('fails closed when direct restoration receives an orphan tool_started record', () => {
    const log = createSessionEventLog('orphan-start');
    log.events.push({
      schema_version: 1,
      event_id: 'orphan-start-event',
      session_id: log.session_id,
      turn_id: 't',
      seq: 0,
      ts: '2026-08-13T00:00:00.000Z',
      kind: 'tool_started',
      tool_call_id: 'orphan-call',
      tool_name: 'run_command',
      idempotency_key: 'orphan-key',
      effect_class: 'non_idempotent_local_effect',
    });
    log.nextSeq = 1;
    const engine = new ChatEngine({ task: 'reject orphan start', projectRoot: process.cwd() });
    assert.throws(
      () => engine.restoreSessionEvents(log),
      /tool_started requires exactly one prior tool_proposed/,
    );
  });
  it('fails closed when a persisted C2 commit does not match its durable thread capsule', () => {
    const engine = new ChatEngine({ task: 'reject forged C2 link', projectRoot: process.cwd() });
    const threadLog = engine.getParityRuntime().eventLog;
    const turn = startTurn(threadLog, {
      task: 'C2 restore', model: 'test', provider: 'test', projectRoot: process.cwd(), policyPreset: 'safe',
    });
    const capsule = appendThreadEvent(threadLog, {
      turn_id: turn,
      kind: 'compaction_capsule',
      content: 'durable C2 capsule',
      preserved_tool_call_ids: ['call-1'],
    });
    const digest = 'dfe562e56643a4a13ca7cecab3ef156518215ed5f9b0e0aa53dc30fbf4ca1aee';
    const log = createSessionEventLog('forged-c2-link');
    const start = {
      operation_id: 'c2-forged-link', strategy: 'sliding_window',
      replaces_thread_seq_start: 0, replaces_thread_seq_end: capsule.seq - 1, replaces_message_count: 1,
    };
    recordCompactionStarted(log, turn, start);
    recordCompactionSummary(log, turn, {
      operation_id: start.operation_id, capsule_digest: digest, raw_observation_refs: [], preserved_tool_call_ids: ['call-1'],
    });
    recordCompactionCommitted(log, turn, {
      ...start, thread_event_id: 'forged-thread-event', capsule_digest: digest, preserved_tool_call_ids: ['call-1'],
    });
    const persisted = parseSessionEventLog(serializeSessionEventLog(log));
    assert.throws(
      () => engine.restoreSessionEvents(persisted),
      /must link exactly one durable thread capsule/,
    );

    const forgedPreservedIds = structuredClone(log);
    for (const event of forgedPreservedIds.events) {
      if (event.kind === 'compaction_summary') event.preserved_tool_call_ids.push('forged-call');
      if (event.kind === 'compaction_committed') {
        event.thread_event_id = capsule.event_id;
        event.preserved_tool_call_ids.push('forged-call');
      }
    }
    const persistedPreservedIds = parseSessionEventLog(serializeSessionEventLog(forgedPreservedIds));
    assert.throws(
      () => engine.restoreSessionEvents(persistedPreservedIds),
      /does not match its durable thread capsule/,
    );
  });

  it('persists proposal and dispatch markers as separate reload boundaries', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-dispatch-boundary-'));
    try {
      const runtime = createParityRuntime('separate-boundaries');
      parityOnUserTurn(runtime, {
        task: 'run a guarded effect', model: 'test-model', provider: 'test-provider', projectRoot: process.cwd(),
      });
      paritySettleProposeTools(runtime, [{ id: 'call-1', name: 'run_command' }], runDir);
      const proposed = loadSessionEventLogFromDir(runDir)!;
      assert.strictEqual(proposed.events.filter((event) => event.kind === 'tool_proposed').length, 1);
      assert.strictEqual(proposed.events.filter((event) => event.kind === 'tool_started').length, 0);

      paritySettleToolStarted(runtime, { id: 'call-1', name: 'run_command' }, runDir);
      const dispatched = loadSessionEventLogFromDir(runDir)!;
      assert.strictEqual(dispatched.events.filter((event) => event.kind === 'tool_started').length, 1);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
  it('does not mark policy-denied actions started, but marks the post-authorization executor hook', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-post-auth-boundary-'));
    try {
      const runtime = createParityRuntime('post-auth-boundary');
      parityOnUserTurn(runtime, {
        task: 'guard dispatch', model: 'test', provider: 'test', projectRoot: process.cwd(),
      });
      paritySettleProposeTools(runtime, [{ id: 'denied', name: 'write_file' }], runDir);
      let startHookCalls = 0;
      const denied = await executeActionWithPolicy(
        { type: 'write_file', path: 'a.ts', content: 'x' }, 'read_only',
        { agentId: 'a', runId: 'post-auth-boundary', runDir, babelRoot: process.cwd() },
        { onBeforeExecutorExecute: () => { startHookCalls += 1; } },
      );
      assert.strictEqual(denied.policyBlocked, true);
      assert.strictEqual(startHookCalls, 0);
      assert.strictEqual(interruptedToolRecoveries(runtime.sessionEvents).at(0)!.state, 'TOOL_NOT_STARTED');

      const allowedRunDir = join(runDir, 'allowed');
      const runtime2 = createParityRuntime('post-executor-hook');
      parityOnUserTurn(runtime2, {
        task: 'dispatch', model: 'test', provider: 'test', projectRoot: process.cwd(),
      });
      paritySettleProposeTools(runtime2, [{ id: 'allowed', name: 'read_file' }], allowedRunDir);
      await executeActionWithPolicy(
        { type: 'read_file', path: 'a.ts' }, 'workspace_write',
        { agentId: 'a', runId: 'post-executor-hook', runDir: allowedRunDir, babelRoot: process.cwd() },
        {
          executor: { execute: async () => ({ action: { type: 'read_file', path: 'a.ts' }, terminal: false, results: [{ exit_code: 0, stdout: '', stderr: '' }] }) } as never,
          onBeforeExecutorExecute: () => paritySettleToolStarted(runtime2, { id: 'allowed', name: 'read_file' }, allowedRunDir),
        },
      );
      const afterHook = loadSessionEventLogFromDir(allowedRunDir)!;
      assert.strictEqual(interruptedToolRecoveries(afterHook).find((r) => r.idempotencyKey === 'allowed')!.state, 'TOOL_OUTCOME_UNKNOWN');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('persists direct background and MCP dispatches as unknown outcomes that block fresh ids after reload', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'babel-direct-dispatch-reload-'));
    try {
      const cases = [
        { id: 'background-original', name: 'run_command', action: { type: 'run_command' as const, command: 'echo background', background: true } },
        { id: 'mcp-original', name: 'mcp_request', action: { type: 'mcp_request' as const, server: 'fixture', query: 'mutate remote state' } },
      ];
      for (const entry of cases) {
        const caseRunDir = join(runDir, entry.id);
        const runtime = createParityRuntime(`direct-${entry.id}`);
        parityOnUserTurn(runtime, {
          task: `direct ${entry.name}`, model: 'test', provider: 'test', projectRoot: process.cwd(),
        });
        const fingerprint = operationFingerprint(entry.name, entry.action);
        paritySettleProposeTools(runtime, [{ id: entry.id, name: entry.name, argsDigest: fingerprint }], caseRunDir);
        // Fault injection boundary: this is the marker immediately before direct spawn/MCP request.
        paritySettleToolStarted(runtime, { id: entry.id, name: entry.name }, caseRunDir);
        const reloaded = loadSessionEventLogFromDir(caseRunDir)!;
        markInterruptedToolsOnResume(reloaded);
        const engine = new ChatEngine({ task: `direct ${entry.name}`, projectRoot: process.cwd() });
        engine.restoreSessionEvents(reloaded);
        const recovery = engine.getLiveSession().tools.recovery.find((item) => item.idempotencyKey === entry.id);
        assert.strictEqual(recovery?.state, 'TOOL_OUTCOME_UNKNOWN', entry.name);
        const authorization = (engine as unknown as {
          recoveredOperationDispatchAuthorization: (a: typeof entry.action) => { allowed: boolean };
        }).recoveredOperationDispatchAuthorization(entry.action);
        assert.strictEqual(authorization.allowed, false, `${entry.name} fresh id must reconcile`);
      }
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
  it('uses actual direct executeOneAction branches for persisted post-dispatch fault recovery', async () => {
    const cases = [
      { suffix: 'mcp', action: { type: 'mcp_request' as const, server: 'github', query: 'remote mutation' } },
      { suffix: 'background', action: { type: 'run_command' as const, command: 'echo babel-b2-background', background: true } },
      { suffix: 'web-search', action: { type: 'web_search' as const, query: 'Babel B2 harness' } },
      { suffix: 'web-fetch', action: { type: 'web_fetch' as const, url: 'https://example.test/b2' } },
      { suffix: 'lsp', action: { type: 'lsp' as const, operation: 'workspaceSymbol' as const, filePath: 'src/agent/chatEngine.ts', query: 'ChatEngine' } },
      { suffix: 'await', action: { type: 'await_command' as const, task_id: 'set-at-runtime' } },
    ];
    for (const entry of cases) {
      const runId = `b2-direct-${entry.suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const awaitJob = entry.suffix === 'await'
        ? startBackgroundShell({ command: 'echo babel-b2-await', cwd: process.cwd(), timeoutMs: 5_000 })
        : undefined;
      const action = entry.suffix === 'await'
        ? { type: 'await_command' as const, task_id: awaitJob!.id }
        : entry.action;
      const engine = new ChatEngine({ task: `direct ${entry.suffix}`, projectRoot: process.cwd(), runId });
      const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
      const toolName = action.type;
      const fingerprint = operationFingerprint(toolName, action);
      const log = createSessionEventLog(runId);
      recordUserSubmitted(log, { turn_id: 't', task: `direct ${entry.suffix}` });
      recordToolProposed(log, {
        turn_id: 't', tool_call_id: 'original-id', tool_name: toolName,
        idempotency_key: 'original-id',
        effect_class: toolName === 'run_command' || toolName === 'await_command'
          ? 'non_idempotent_local_effect' : 'external_side_effect',
        args_digest: fingerprint,
      });
      flushSessionEventLog(runDir, log);
      // Keep the proposal live; restore would settle the interruption before this fault boundary.
      const runtime = engine.getParityRuntime();
      runtime.sessionEvents = log;
      runtime.turnId = 't';
      const faultingEngine = engine as unknown as {
        persistToolStartedAtExecutorDispatch: (...args: unknown[]) => void;
        executeOneAction: (input: typeof action, context: object, callbacks: object, meta: { index: number; subAgentCounter: number; idempotencyKey: string }) => Promise<{ observation: string }>;
      };
      const persist = faultingEngine.persistToolStartedAtExecutorDispatch.bind(engine);
      faultingEngine.persistToolStartedAtExecutorDispatch = (...args) => {
        persist(...args);
        throw new Error('B2_FAULT_AFTER_PERSISTED_START');
      };
      let first: { observation: string };
      try {
        first = await faultingEngine.executeOneAction(action, {
          agentId: 'b2', runId, runDir, babelRoot: process.cwd(), signal: new AbortController().signal,
        }, {}, { index: 0, subAgentCounter: 0, idempotencyKey: 'original-id' });
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /B2_FAULT_AFTER_PERSISTED_START/);
        first = { observation: 'fault injected immediately after persisted start' };
      }
      const afterDispatch = loadSessionEventLogFromDir(runDir)!;
      assert.ok(
        afterDispatch.events.some((event) => event.kind === 'tool_started' && event.idempotency_key === 'original-id'),
        `${entry.suffix}: ${first.observation}`,
      );
      markInterruptedToolsOnResume(afterDispatch);
      flushSessionEventLog(runDir, afterDispatch);

      const resumed = new ChatEngine({ task: `direct ${entry.suffix}`, projectRoot: process.cwd(), runId, resumeExisting: true });
      resumed.restoreSessionEvents(loadSessionEventLogFromDir(runDir)!, { runDir });
      const blocked = await (resumed as unknown as {
        executeOneAction: (input: typeof action, context: object, callbacks: object, meta: { index: number; subAgentCounter: number; idempotencyKey: string }) => Promise<{ observation: string }>;
      }).executeOneAction(action, {
        agentId: 'b2', runId, runDir, babelRoot: process.cwd(), signal: new AbortController().signal,
      }, {}, { index: 0, subAgentCounter: 0, idempotencyKey: 'fresh-id' });
      assert.match(blocked.observation, /RECOVERY_RECONCILIATION_REQUIRED/, entry.suffix);
    }
  });

  it('keeps known-invalid MCP and await requests at TOOL_NOT_STARTED', async () => {
    const cases = [
      { suffix: 'mcp-invalid', action: { type: 'mcp_request' as const, server: 'missing-b2-server', query: 'never dispatch' } },
      { suffix: 'await-invalid', action: { type: 'await_command' as const, task_id: 'missing-b2-job' } },
    ];
    for (const entry of cases) {
      const runId = `b2-not-started-${entry.suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const engine = new ChatEngine({ task: entry.suffix, projectRoot: process.cwd(), runId });
      const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
      const log = createSessionEventLog(runId);
      recordUserSubmitted(log, { turn_id: 't', task: entry.suffix });
      recordToolProposed(log, {
        turn_id: 't', tool_call_id: 'original-id', tool_name: entry.action.type,
        idempotency_key: 'original-id', effect_class: entry.action.type === 'await_command' ? 'non_idempotent_local_effect' : 'external_side_effect',
        args_digest: operationFingerprint(entry.action.type, entry.action),
      });
      flushSessionEventLog(runDir, log);
      const runtime = engine.getParityRuntime();
      runtime.sessionEvents = log;
      runtime.turnId = 't';
      await (engine as unknown as {
        executeOneAction: (input: typeof entry.action, context: object, callbacks: object, meta: { index: number; subAgentCounter: number; idempotencyKey: string }) => Promise<unknown>;
      }).executeOneAction(entry.action, {
        agentId: 'b2', runId, runDir, babelRoot: process.cwd(), signal: new AbortController().signal,
      }, {}, { index: 0, subAgentCounter: 0, idempotencyKey: 'original-id' });
      const afterValidation = loadSessionEventLogFromDir(runDir)!;
      assert.ok(!afterValidation.events.some((event) => event.kind === 'tool_started'), entry.suffix);
      markInterruptedToolsOnResume(afterValidation);
      assert.strictEqual(interruptedToolRecoveries(afterValidation).length, 0, entry.suffix);
      assert.strictEqual(
        afterValidation.events.find((event) => event.kind === 'tool_cancelled')?.recovery_state,
        'TOOL_NOT_STARTED',
        entry.suffix,
      );
    }
  });
  it('requires and durably audits explicit reconciliation before an equivalent fresh-id retry', async () => {
    const action = { type: 'run_command' as const, command: 'echo guarded' };
    const fingerprint = operationFingerprint('run_command', action);
    const engine = new ChatEngine({ task: 'recover shell', projectRoot: process.cwd() });
    const log = createSessionEventLog('fresh-id-recovery');
    recordUserSubmitted(log, { turn_id: 't', task: 'recover shell' });
    recordToolProposed(log, {
      turn_id: 't', tool_call_id: 'original-id', tool_name: 'run_command',
      idempotency_key: 'original-id', effect_class: 'non_idempotent_local_effect', args_digest: fingerprint,
    });
    recordToolStarted(log, {
      turn_id: 't', tool_call_id: 'original-id', tool_name: 'run_command',
      idempotency_key: 'original-id', effect_class: 'non_idempotent_local_effect',
    });
    engine.restoreSessionEvents(log);
    const blockedAuthorization = (engine as unknown as {
      recoveredOperationDispatchAuthorization: (a: typeof action) => { allowed: boolean; message?: string };
    }).recoveredOperationDispatchAuthorization(action);
    const blocked = await executeActionWithPolicy(
      action, 'workspace_write',
      { agentId: 'a', runId: 'fresh-id-recovery', runDir: '', babelRoot: process.cwd(), signal: new AbortController().signal },
      {
        isolationRequired: false,
        idempotencyKey: 'fresh-id',
        onDispatchAuthorized: () => blockedAuthorization,
        executor: { execute: async () => { throw new Error('must not execute'); } } as never,
      },
    );
    assert.match(blocked.results[0]!.stderr, /RECOVERY_RECONCILIATION_REQUIRED/);

    assert.throws(
      () => engine.authorizeRecoveredOutcomeRetry(action, 'original-id', 'contains spaces'),
      /opaque, non-secret audit reference/,
    );
    engine.authorizeRecoveredOutcomeRetry(action, 'original-id', 'operator-ticket-B2-42');
    const durable = loadSessionEventLogFromDir((engine as unknown as { engineRunDir: string }).engineRunDir)!;
    assert.ok(durable.events.some((event) =>
      event.kind === 'recovery_reconciled' &&
      event.recovered_idempotency_key === 'original-id' &&
      event.reconciliation_ref === 'operator-ticket-B2-42',
    ));
    const afterAuthorization = (engine as unknown as {
      recoveredOperationDispatchAuthorization: (a: typeof action) => { allowed: boolean };
    }).recoveredOperationDispatchAuthorization(action);
    assert.strictEqual(afterAuthorization.allowed, true, 'only the explicitly reconciled prior unknown outcome is released');
  });
  it('rejects an in-memory P/S/unknown-cancelled/terminal/recovery authorization contradiction before restore', () => {
    const action = { type: 'run_command' as const, command: 'echo forged' };
    const fingerprint = operationFingerprint('run_command', action);
    const log = createSessionEventLog('forged-recovery-restore');
    recordToolProposed(log, {
      turn_id: 't', tool_call_id: 'forged-id', tool_name: 'run_command', idempotency_key: 'forged-id',
      effect_class: 'non_idempotent_local_effect', args_digest: fingerprint,
    });
    recordToolStarted(log, {
      turn_id: 't', tool_call_id: 'forged-id', tool_name: 'run_command', idempotency_key: 'forged-id',
      effect_class: 'non_idempotent_local_effect',
    });
    recordToolTerminal(log, {
      turn_id: 't', tool_call_id: 'forged-id', tool_name: 'run_command', idempotency_key: 'forged-id',
      cancelled: true, recovery_state: 'TOOL_OUTCOME_UNKNOWN',
      effect_class: 'non_idempotent_local_effect', args_digest: fingerprint,
    });
    const seqTerminal = log.nextSeq++;
    log.events.push({
      schema_version: 1, event_id: `forged-terminal-${seqTerminal}`, session_id: log.session_id,
      turn_id: 't', seq: seqTerminal, ts: '2026-08-13T00:00:00.000Z', kind: 'tool_completed',
      tool_call_id: 'forged-id', tool_name: 'run_command', idempotency_key: 'forged-id', exit_code: 0,
    });
    const seq = log.nextSeq++;
    log.events.push({
      schema_version: 1,
      event_id: `forged-recovery-${seq}`,
      session_id: log.session_id,
      turn_id: 't',
      seq,
      ts: '2026-08-13T00:00:00.000Z',
      kind: 'recovery_reconciled',
      recovered_idempotency_key: 'forged-id',
      operation_fingerprint: fingerprint,
      reconciliation_ref: 'operator-ticket-B2-forged',
    });

    const engine = new ChatEngine({ task: 'reject forged recovery', projectRoot: process.cwd() });
    assert.throws(
      () => engine.restoreSessionEvents(log),
      /tool lifecycle cannot record a terminal after a terminal/,
    );
  });  it('projects unknown outcomes and injects explicit repair guidance on restore', () => {
    const engine = new ChatEngine({ task: 'recover interrupted tool', projectRoot: process.cwd() });
    const log = createSessionEventLog('unknown-outcome');
    recordUserSubmitted(log, { turn_id: 't', task: 'recover interrupted tool' });
    recordToolProposed(log, {
      turn_id: 't', tool_call_id: 'shell-1', tool_name: 'run_command',
      idempotency_key: 'shell-1', effect_class: 'non_idempotent_local_effect',
    });
    recordToolStarted(log, {
      turn_id: 't', tool_call_id: 'shell-1', tool_name: 'run_command',
      idempotency_key: 'shell-1', effect_class: 'non_idempotent_local_effect',
    });

    engine.restoreSessionEvents(log);
    const live = engine.getLiveSession();
    assert.deepStrictEqual(live.tools.recovery, [{
      idempotencyKey: 'shell-1', toolCallId: 'shell-1', toolName: 'run_command',
      effectClass: 'non_idempotent_local_effect', state: 'TOOL_OUTCOME_UNKNOWN',
      reconciliation: 'manual_review_no_auto_retry',
    }]);
    assert.strictEqual(engine.canMutateIdempotencyKey('shell-1'), false);
    const conversation = (engine as unknown as { conversation: Array<{ role: string; content: string }> }).conversation;
    const repair = conversation.find((message) => message.content.includes('[RESUME_REPAIR]'));
    assert.ok(repair, 'the next model request receives durable repair guidance');
    assert.match(repair!.content, /inspect\/reconcile/i);
    assert.match(repair!.content, /never blindly retry/i);
  });
  it('every crash boundary projection never invents VERIFIED_COMPLETE', () => {
    const full = createSessionEventLog('b');
    const turn = 't';
    recordUserSubmitted(full, { turn_id: turn, task: 't' });
    recordToolProposed(full, {
      turn_id: turn,
      tool_call_id: 'c',
      tool_name: 'write_file',
      idempotency_key: 'k',
    });
    recordToolStarted(full, {
      turn_id: turn,
      tool_call_id: 'c',
      tool_name: 'write_file',
      idempotency_key: 'k',
    });
    recordToolTerminal(full, {
      turn_id: turn,
      tool_call_id: 'c',
      tool_name: 'write_file',
      idempotency_key: 'k',
      exit_code: 0,
    });
    recordMutationBatch(full, turn, {
      paths: ['a.ts'],
      status: 'commit',
      ending_revision: 'r1',
    });
    recordVerifierAttempt(full, {
      turn_id: turn,
      command_preview: 'npm test',
      authoritative: true,
      exit_code: 0,
    });
    recordCompactionCreated(full, turn, {});
    recordCompletionDecision(full, turn, {
      requestedOutcome: 'VERIFIED_COMPLETE',
      finalOutcome: 'VERIFIED_COMPLETE',
      allowed: true,
      reason: 'ok',
      evidenceRefs: [],
      policyVersion: 'v1',
    });
    recordTurnEnded(full, {
      turn_id: turn,
      outcome: 'VERIFIED_COMPLETE',
      status: 'done',
    });

    const boundaries: CrashBoundary[] = [
      'before_authorization',
      'during_effect',
      'before_verifier',
      'during_compaction_persist',
      'before_terminal',
      'after_terminal',
    ];
    const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
    for (const b of boundaries) {
      const events = sliceSessionAtBoundary(full, b);
      const partial = {
        ...full,
        events,
        nextSeq: events.length,
      };
      engine.restoreSessionEvents(partial);
      const live = engine.getLiveSession();
      if (b !== 'after_terminal') {
        const hasCompletion = events.some((e) => e.kind === 'completion_decision');
        if (!hasCompletion) {
          assert.notStrictEqual(
            live.terminal?.outcome,
            'VERIFIED_COMPLETE',
            `boundary ${b} invented VERIFIED_COMPLETE`,
          );
        }
      }
    }
  });
});

describe('H2 plan mode contract is read-only', () => {
  it('plan-profile TaskContract only allows read_only effects', () => {
    // ChatEngine uses executionProfile; construct with plan profile when available
    const engine = new ChatEngine({
      task: 'plan a fix',
      projectRoot: process.cwd(),
      executionProfile: 'plan',
    });
    const tc = engine.getTaskContract();
    assert.ok(tc);
    assert.strictEqual(tc!.mode, 'plan');
    assert.ok(tc!.allowed_effects.every((e) => e === 'read_only'));
  });
});

describe('H3/H4 live ChatEngine wiring', () => {
  it('failure budgets: infra consume does not touch implementation budget', () => {
    const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
    const before = engine.getFailureBudgets();
    assert.ok(engine.consumeFailureBudget(makeFailureCapsule('infrastructure', 't', 'timeout')));
    const after = engine.getFailureBudgets();
    assert.strictEqual(after.implementation_repair, before.implementation_repair);
    assert.strictEqual(after.infra_retry, before.infra_retry - 1);
  });

  it('applyHonestTaskOutcome: baseline-green no-mutation becomes NO_CHANGE_REQUIRED', () => {
    const c = freezeTaskContract(
      buildTaskContractV1({
        mode: 'chat',
        user_request: 'fix',
        baseline_verifier_state: { command: 'npm test', exit_code: 0 },
      }),
    );
    const o = applyHonestTaskOutcomeToCompletion({
      contract: c,
      requestedOutcome: 'VERIFIED_COMPLETE',
      hasMutation: false,
      planMode: false,
    });
    assert.strictEqual(o, 'NO_CHANGE_REQUIRED');
  });

  it('H4: completed idempotency keys deny double mutation', async () => {
    const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
    const log = createSessionEventLog('idemp');
    recordUserSubmitted(log, { turn_id: 't', task: 't' });
    recordToolProposed(log, {
      turn_id: 't', tool_call_id: 'c1', tool_name: 'write_file', idempotency_key: 'idem-double',
    });
    recordToolStarted(log, {
      turn_id: 't', tool_call_id: 'c1', tool_name: 'write_file', idempotency_key: 'idem-double',
    });
    recordToolTerminal(log, {
      turn_id: 't',
      tool_call_id: 'c1',
      tool_name: 'write_file',
      idempotency_key: 'idem-double',
      exit_code: 0,
    });
    engine.restoreSessionEvents(log);
    assert.strictEqual(engine.canMutateIdempotencyKey('idem-double'), false);
    const cap = checkToolCapability({
      toolName: 'write_file',
      effectClass: 'reconcilable_mutation',
      allowedEffects: ['reconcilable_mutation'],
      mode: 'chat',
      completedIdempotencyKeys: engine.getLiveSession().tools.completed_idempotency_keys,
      idempotencyKey: 'idem-double',
    });
    assert.strictEqual(cap.allowed, false);
    assert.strictEqual(cap.denial, 'idempotency_replay');
  });

  it('H4: plan mode executeActionWithPolicy denies write_file', async () => {
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'x' } as never,
      'read_only',
      {
        runId: 'r',
        agentId: 'a',
        projectRoot: process.cwd(),
        cwd: process.cwd(),
      } as never,
      { mode: 'plan' },
    );
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(
      String(result.results[0]?.stderr ?? '').includes('CAPABILITY_DENIED') ||
        result.policyDecision === 'deny',
    );
  });
});

describe('H6 golden from ChatEngine session path', () => {
  it('builds and validates golden from controller-owned session events with live_runtime provenance', () => {
    const engine = new ChatEngine({
      task: 'golden task',
      projectRoot: process.cwd(),
    });
    const runDir = (engine as unknown as { engineRunDir: string }).engineRunDir;
    const log = createSessionEventLog(engine.getParityRuntime().sessionEvents.session_id);
    const turn = 'tg';
    recordUserSubmitted(log, { turn_id: turn, task: 'golden task' });
    recordToolProposed(log, {
      turn_id: turn, tool_call_id: 'c', tool_name: 'write_file', idempotency_key: 'kg',
    });
    recordToolStarted(log, {
      turn_id: turn, tool_call_id: 'c', tool_name: 'write_file', idempotency_key: 'kg',
    });
    recordToolTerminal(log, {
      turn_id: turn,
      tool_call_id: 'c',
      tool_name: 'write_file',
      idempotency_key: 'kg',
      exit_code: 0,
    });
    recordCompletionDecision(log, turn, {
      requestedOutcome: 'VERIFIED_COMPLETE',
      finalOutcome: 'VERIFIED_COMPLETE',
      allowed: true,
      reason: 'ok',
      evidenceRefs: ['e'],
      policyVersion: 'v1',
    });
    recordTurnEnded(log, {
      turn_id: turn,
      outcome: 'VERIFIED_COMPLETE',
      status: 'done',
    });
    engine.restoreSessionEvents(log, { runDir });
    const live = engine.getLiveSession();
    assert.strictEqual(live.terminal?.outcome, 'VERIFIED_COMPLETE');
    // Controller-owned path: engine session + authority exist → live_runtime true
    const artifact = buildLiveGoldenEpisode({
      sessionLog: engine.getParityRuntime().sessionEvents,
      workspace_path: runDir,
      controller: 'chat',
      live_runtime: true,
    });
    assert.strictEqual(artifact.live_runtime, true);
    const v = validateGoldenEpisode(artifact);
    assert.ok(v.ok, v.errors.join('; '));
    const replay = replayTerminalDecision(engine.getParityRuntime().sessionEvents);
    assert.strictEqual(replay.outcome, 'VERIFIED_COMPLETE');
    assert.strictEqual(replay.invented, false);
  });
});
