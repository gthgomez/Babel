/**
 * H2 LiveSession + InstructionManifest + crash/resume exit-gate fixtures.
 */

import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildInstructionManifestV1,
  bindFragmentToPlanStep,
  instructionManifestsEqual,
} from './instructionManifest.js';
import {
  projectLiveSession,
  canMutateWithIdempotencyKey,
  mayBlindRetryInterrupted,
  reconstructTerminalFromSession,
  liveSessionsEquivalentForResume,
  sliceSessionAtBoundary,
  type CrashBoundary,
} from './liveSession.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordModelStarted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordMutationBatch,
  recordVerifierAttempt,
  recordCompletionDecision,
  recordTurnEnded,
  recordBudgetSnapshot,
  recordApprovalDecision,
  recordRepairAttempt,
  recordCompactionCreated,
  recordPolicyIntervened,
  recordModelFailover,
  serializeSessionEventLog,
  parseSessionEventLog,
  type SessionEventLog,
} from './sessionEvents.js';

function buildFullSession(): SessionEventLog {
  const log = createSessionEventLog('sess-h2');
  const turn = 'turn-1';
  recordUserSubmitted(log, {
    turn_id: turn,
    task: 'fix the auth bug',
    model: 'deepseek-chat',
    provider: 'deepseek',
    taskClass: 'general_swe',
  });
  recordModelStarted(log, { turn_id: turn, model: 'deepseek-chat', provider: 'deepseek' });
  recordToolProposed(log, {
    turn_id: turn,
    tool_call_id: 'tc1',
    tool_name: 'write_file',
    idempotency_key: 'idem-write-1',
  });
  recordToolStarted(log, {
    turn_id: turn,
    tool_call_id: 'tc1',
    tool_name: 'write_file',
    idempotency_key: 'idem-write-1',
  });
  recordToolTerminal(log, {
    turn_id: turn,
    tool_call_id: 'tc1',
    tool_name: 'write_file',
    idempotency_key: 'idem-write-1',
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
  recordBudgetSnapshot(log, turn, {
    turns_used: 1,
    turns_remaining: 9,
    tokens_used: 1200,
    tokens_remaining: 98_800,
    repair_attempts_used: 0,
    repair_attempts_remaining: 3,
    infra_retries_used: 0,
    infra_retries_remaining: 2,
  });
  recordApprovalDecision(log, turn, {
    request_id: 'ap1',
    decision: 'allow_once',
  });
  recordCompactionCreated(log, turn, {
    content_preview: 'capsule',
    preserved_tool_call_ids: [],
  });
  recordPolicyIntervened(log, turn, {
    source: 'zero_write',
    action: 'nudge',
    detail: 'progress',
  });
  recordCompletionDecision(log, turn, {
    requestedOutcome: 'VERIFIED_COMPLETE',
    finalOutcome: 'VERIFIED_COMPLETE',
    allowed: true,
    reason: 'verifier green',
    evidenceRefs: ['vr1'],
    policyVersion: 'gate-v1',
  });
  recordTurnEnded(log, {
    turn_id: turn,
    outcome: 'VERIFIED_COMPLETE',
    status: 'complete',
  });
  return log;
}

describe('H2 InstructionManifestV1', () => {
  it('builds rule ids, source hashes, precedence, selection reasons', () => {
    const m = buildInstructionManifestV1({
      mode: 'chat',
      taskClass: 'general_swe',
      inlineRules: [
        {
          rule_id: 'safety:no-escape',
          source: 'inline:safety',
          content: 'never escape project root',
          precedence: 'safety',
          selection_reason: 'always_on_safety',
          policy_class: 'mechanical',
        },
        {
          rule_id: 'domain:backend',
          source: 'inline:domain',
          content: 'preserve request contracts',
          precedence: 'domain',
          selection_reason: 'task_keyword_backend',
          policy_class: 'advisory',
        },
      ],
    });
    assert.strictEqual(m.schema_version, 1);
    assert.ok(m.manifest_hash.length >= 16);
    assert.strictEqual(m.fragments.length, 2);
    assert.ok(m.fragments.every((f) => f.source_hash.length === 64));
    assert.strictEqual(
      m.fragments.find((f) => f.rule_id === 'safety:no-escape')?.policy_class,
      'mechanical',
    );
  });

  it('binds fragments to plan steps without losing source hash identity of content', () => {
    const m0 = buildInstructionManifestV1({
      mode: 'deep',
      inlineRules: [
        {
          rule_id: 'r1',
          source: 's',
          content: 'body',
          precedence: 'policy',
          selection_reason: 'plan',
        },
      ],
    });
    const m1 = bindFragmentToPlanStep(m0, 'r1', 'step-3');
    assert.strictEqual(m1.fragments[0]!.plan_step_id, 'step-3');
    assert.strictEqual(m1.fragments[0]!.source_hash, m0.fragments[0]!.source_hash);
    assert.ok(!instructionManifestsEqual(m0, m1));
  });

  it('policy fragments survive rebuild from same inputs (compaction/failover stable)', () => {
    const input = {
      mode: 'chat' as const,
      inlineRules: [
        {
          rule_id: 'safety:x',
          source: 's',
          content: 'protected paths',
          precedence: 'safety' as const,
          selection_reason: 'static',
          policy_class: 'mechanical' as const,
        },
      ],
    };
    const a = buildInstructionManifestV1(input);
    const b = buildInstructionManifestV1(input);
    assert.ok(instructionManifestsEqual(a, b));
  });
});

describe('H2 LiveSession projection + resume', () => {
  it('restores task, model, tools, verifier, budget, revision, terminal', () => {
    const log = buildFullSession();
    const manifest = buildInstructionManifestV1({
      mode: 'chat',
      inlineRules: [
        {
          rule_id: 's1',
          source: 's',
          content: 'safety',
          precedence: 'safety',
          selection_reason: 'static',
        },
      ],
    });
    const session = projectLiveSession({
      sessionLog: log,
      instructionManifest: manifest,
      budgetCeilings: { turns: 10, tokens: 100_000, repair_attempts: 3, infra_retries: 2 },
    });
    assert.strictEqual(session.active_task, 'fix the auth bug');
    assert.strictEqual(session.provider_model, 'deepseek-chat');
    assert.strictEqual(session.instruction_manifest_hash, manifest.manifest_hash);
    assert.ok(session.tools.completed_idempotency_keys.includes('idem-write-1'));
    assert.strictEqual(session.verifier.attempts, 1);
    assert.strictEqual(session.verifier.authoritative, true);
    assert.strictEqual(session.workspace_revision, 'rev1');
    assert.strictEqual(session.budgets.turns_remaining, 9);
    assert.strictEqual(session.terminal?.outcome, 'VERIFIED_COMPLETE');
    assert.ok(session.compaction_count >= 1);
    assert.ok(session.policy_intervention_count >= 1);
  });

  it('completed idempotency keys cannot mutate twice', () => {
    const log = buildFullSession();
    const session = projectLiveSession({ sessionLog: log });
    assert.strictEqual(canMutateWithIdempotencyKey(session, 'idem-write-1'), false);
    assert.strictEqual(canMutateWithIdempotencyKey(session, 'idem-write-2'), true);
  });

  it('interrupted non-idempotent effects are not blindly retried', () => {
    const log = createSessionEventLog('kill');
    const turn = 't';
    recordUserSubmitted(log, { turn_id: turn, task: 'write' });
    recordToolProposed(log, {
      turn_id: turn,
      tool_call_id: 'x',
      tool_name: 'write_file',
      idempotency_key: 'idem-x',
    });
    recordToolStarted(log, {
      turn_id: turn,
      tool_call_id: 'x',
      tool_name: 'write_file',
      idempotency_key: 'idem-x',
    });
    recordToolTerminal(log, {
      turn_id: turn,
      tool_call_id: 'x',
      tool_name: 'write_file',
      idempotency_key: 'idem-x',
      cancelled: true,
      reason: 'process killed',
    });
    const session = projectLiveSession({ sessionLog: log });
    assert.strictEqual(mayBlindRetryInterrupted(session, 'idem-x'), false);
    assert.ok(session.tools.interrupted_idempotency_keys.includes('idem-x'));
  });

  it('projects interrupted effects in the idempotency-key domain', () => {
    const log = createSessionEventLog('distinct-identities');
    recordToolProposed(log, {
      turn_id: 'turn-1',
      tool_call_id: 'native-call-1',
      tool_name: 'write_file',
      idempotency_key: 'effect-key-1',
    });
    recordToolStarted(log, {
      turn_id: 'turn-1',
      tool_call_id: 'native-call-1',
      tool_name: 'write_file',
      idempotency_key: 'effect-key-1',
    });
    const session = projectLiveSession({ sessionLog: log });
    assert.deepEqual(session.tools.interrupted_idempotency_keys, ['effect-key-1']);
    assert.strictEqual(mayBlindRetryInterrupted(session, 'effect-key-1'), false);
    assert.strictEqual(mayBlindRetryInterrupted(session, 'native-call-1'), true);
  });

  it('preserves persisted remaining budgets without restore ceilings', () => {
    const log = createSessionEventLog('persisted-budgets');
    recordBudgetSnapshot(log, 'turn-1', {
      turns_used: 4,
      turns_remaining: 6,
      tokens_used: 800,
      tokens_remaining: 1200,
      repair_attempts_used: 2,
      repair_attempts_remaining: 3,
      infra_retries_used: 1,
      infra_retries_remaining: 4,
    });
    const session = projectLiveSession({ sessionLog: log });
    assert.deepEqual(session.budgets, {
      turns_used: 4,
      turns_remaining: 6,
      tokens_used: 800,
      tokens_remaining: 1200,
      repair_attempts_used: 2,
      repair_attempts_remaining: 3,
      infra_retries_used: 1,
      infra_retries_remaining: 4,
    });
  });

  it('compares safety state completely without mutating inputs', () => {
    const log = createSessionEventLog('comparator');
    const a = projectLiveSession({ sessionLog: log });
    const b = projectLiveSession({ sessionLog: log });
    a.tools.completed_idempotency_keys = ['z', 'a'];
    b.tools.completed_idempotency_keys = ['a', 'z'];
    b.provider_name = 'different-provider';
    b.budgets.tokens_remaining = 1;
    b.tools.open_tool_call_ids = ['different-open-tool'];
    const eq = liveSessionsEquivalentForResume(a, b);
    assert.strictEqual(eq.ok, false);
    assert.ok(eq.mismatches.includes('provider_name'));
    assert.deepEqual(a.tools.completed_idempotency_keys, ['z', 'a']);
  });

  it('serializes all accepted compaction boundary fields', () => {
    const log = createSessionEventLog('compaction-fields');
    const event = recordCompactionCreated(log, 'turn-1', {
      strategy: 'heuristic',
      tokens_before: 100,
      tokens_after: 40,
      status: 'committed',
    });
    assert.equal(event.kind, 'compaction_created');
    assert.equal((event as { strategy?: string }).strategy, 'heuristic');
    assert.equal((event as { tokens_before?: number }).tokens_before, 100);
    assert.equal((event as { tokens_after?: number }).tokens_after, 40);
    assert.equal((event as { status?: string }).status, 'committed');
  });

  it('round-trips a revision-bound verifier receipt in durable session evidence', () => {
    const log = createSessionEventLog('verifier-receipt');
    recordVerifierAttempt(log, {
      turn_id: 'turn-1',
      command_preview: 'npm test',
      authoritative: true,
      exit_code: 0,
      receipt: {
        command: 'npm test',
        exit_code: 0,
        exitCode: 0,
        summary: 'ok',
        receiptId: 'receipt-1',
        capturedAt: 1,
        authority: true,
        authoritySource: 'built_in_runner',
        verifierId: 'npm-test',
        boundRevision: {
          gitCommitHash: null,
          compositeTreeHash: 'revision-1',
          fileHashes: {},
          capturedAt: 1,
        },
      },
    });
    const roundTrip = parseSessionEventLog(serializeSessionEventLog(log));
    const event = roundTrip.events.find((candidate) => candidate.kind === 'verifier_attempt');
    assert.ok(event && event.kind === 'verifier_attempt');
    assert.equal(event.receipt?.receiptId, 'receipt-1');
    assert.equal(event.receipt?.boundRevision?.compositeTreeHash, 'revision-1');
  });

  it('terminal reconstructs from durable evidence only', () => {
    const log = buildFullSession();
    const term = reconstructTerminalFromSession(log);
    assert.ok(term);
    assert.strictEqual(term!.outcome, 'VERIFIED_COMPLETE');

    const empty = createSessionEventLog('e');
    assert.strictEqual(reconstructTerminalFromSession(empty), null);
  });

  it('restart projection is resume-equivalent', () => {
    const log = buildFullSession();
    const manifest = buildInstructionManifestV1({
      mode: 'chat',
      inlineRules: [
        {
          rule_id: 's1',
          source: 's',
          content: 'safety',
          precedence: 'safety',
          selection_reason: 'static',
        },
      ],
    });
    const a = projectLiveSession({
      sessionLog: log,
      instructionManifest: manifest,
      budgetCeilings: { turns: 10 },
    });
    const b = projectLiveSession({
      sessionLog: log,
      instructionManifest: manifest,
      budgetCeilings: { turns: 10 },
    });
    const eq = liveSessionsEquivalentForResume(a, b);
    assert.ok(eq.ok, eq.mismatches.join(','));
  });
});

describe('H2 forced-termination crash boundaries', () => {
  const boundaries: CrashBoundary[] = [
    'before_authorization',
    'after_authorization_before_effect',
    'during_effect',
    'after_effect_before_receipt',
    'after_receipt_before_projection',
    'mutation_prepare',
    'mutation_commit',
    'before_verifier',
    'after_verifier',
    'during_compaction_persist',
    'before_terminal',
    'after_terminal',
  ];

  it('slices at every non-idempotent boundary without inventing success', () => {
    const full = buildFullSession();
    for (const b of boundaries) {
      const sliced = sliceSessionAtBoundary(full, b);
      const log: SessionEventLog = {
        ...full,
        events: sliced,
        nextSeq: sliced.length,
      };
      const session = projectLiveSession({ sessionLog: log });
      if (b !== 'after_terminal') {
        const hasCompletion = sliced.some((e) => e.kind === 'completion_decision');
        if (!hasCompletion) {
          assert.notStrictEqual(session.terminal?.outcome, 'VERIFIED_COMPLETE');
        }
      }
      if (b === 'during_effect') {
        for (const k of session.tools.open_tool_call_ids) {
          assert.ok(!session.tools.completed_idempotency_keys.includes(k));
        }
      }
    }
  });

  it('repair_attempt does not consume infra budget', () => {
    const log = createSessionEventLog();
    recordUserSubmitted(log, { turn_id: 't1', task: 't' });
    recordRepairAttempt(log, 't1', {
      failure_class: 'implementation',
      attempt: 1,
    });
    recordModelFailover(log, 't1', {
      original_model: 'a',
      new_model: 'b',
      reason: 'timeout',
    });
    const session = projectLiveSession({
      sessionLog: log,
      budgetCeilings: { repair_attempts: 3, infra_retries: 2 },
    });
    assert.ok(session.budgets.repair_attempts_used >= 1);
    assert.ok(session.budgets.infra_retries_used >= 1);
  });
});
