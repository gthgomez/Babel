/**
 * H2 controller-level fixtures: InstructionManifest + LiveSession on ChatEngine
 * dual-write / resume path. Proves restore equivalence of task, manifest,
 * policy, tool idempotency, revision, and budget.
 */

import * as assert from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatEngine } from './chatEngine.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolStarted,
  recordToolTerminal,
  recordMutationBatch,
  recordVerifierAttempt,
  recordCompletionDecision,
  recordTurnEnded,
  recordCompactionCreated,
  recordPolicyIntervened,
  flushSessionEventLog,
  serializeSessionEventLog,
  parseSessionEventLog,
  SESSION_EVENTS_FILENAME,
} from './sessionEvents.js';
import {
  createThreadEventLog,
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
import { finalizeParityTurnSync, checkpointParityEventLog } from './chatEngineParityBridge.js';
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
    );
    // Explicit cancel: blind retry forbidden
    recordToolTerminal(log, {
      turn_id: turn,
      tool_call_id: 'x',
      tool_name: 'write_file',
      idempotency_key: 'idem-kill',
      cancelled: true,
      reason: 'killed',
    });
    engine.restoreSessionEvents(log);
    const live2 = engine.getLiveSession();
    assert.strictEqual(mayBlindRetryInterrupted(live2, 'idem-kill'), false);
    // Cancelled keys are settled terminal — must not re-mutate with same key
    assert.strictEqual(canMutateWithIdempotencyKey(live2, 'idem-kill'), false);
  });

  it('every crash boundary projection never invents VERIFIED_COMPLETE', () => {
    const full = createSessionEventLog('b');
    const turn = 't';
    recordUserSubmitted(full, { turn_id: turn, task: 't' });
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
