/**
 * H3–H7 exit-gate fixtures driving shipped modules.
 */

import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTaskContractV1,
  freezeTaskContract,
  withAcceptanceCriteria,
  decideHonestTaskOutcome,
  FailureClassBudgetTracker,
  makeFailureCapsule,
  buildTerminalSurfaceAgreement,
  isAllowedTerminal,
} from './taskContract.js';
import {
  checkToolCapability,
  beginEffectTransaction,
  commitEffectTransaction,
  rollbackEffectTransaction,
  wouldSilentHostFallback,
  safeRepoIsolationMessage,
  captureWorkspaceRevisionIdentity,
} from './capabilityBroker.js';
import {
  executeActionWithPolicy,
  resetCircuitBreaker,
  getCircuitBreakerState,
  defaultIdempotencyKeyForAction,
} from './toolExecutor.js';
import type { AgentAction } from './actions.js';
import {
  buildVerifierReceiptV2,
  evaluateVerifierPromotion,
  evaluateCleanRoomPromotion,
  profileForTaskClass,
} from './verifierKernel.js';
import {
  replayTerminalDecision,
  projectCrossSurfaceFacts,
  buildLiveGoldenEpisode,
  validateGoldenEpisode,
  runAndValidateLiveGolden,
  inspectSessionHistory,
} from './episodeReplay.js';
import {
  computeCoreMetrics,
  computePairedDeltas,
  appendFailureLedger,
  validatePromotionRecord,
  runLocalEvalSubstrateSmoke,
  runOfflineHarnessFactorial,
  environmentDigest,
  controlsMatch,
  writeEvalReport,
  H7_DEDICATED_SUITES,
  type FixedEvalControls,
  type EvalTaskResult,
} from './harnessEval.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordCompletionDecision,
  recordTurnEnded,
  recordCompactionCreated,
  recordVerifierAttempt,
  recordMutationBatch,
} from './sessionEvents.js';
import { classifyToolEffect } from '../executor/contracts.js';
import {
  isPassingOutcome,
  terminalOutcomeExitCode,
  type TerminalOutcome,
} from '../schemas/agentContracts.js';
import {
  userFacingStatusFromOutcome,
  exitCodeFromOutcome,
} from '../cli/userFacingStatus.js';

// ─── H3 ──────────────────────────────────────────────────────────────────────

describe('H3 TaskContractV1 + outcomes + failure budgets', () => {
  it('freezes acceptance criteria against silent drift', () => {
    const c0 = freezeTaskContract(
      buildTaskContractV1({
        mode: 'chat',
        user_request: 'fix bug',
        acceptance_criteria: ['tests pass'],
      }),
    );
    assert.throws(
      () => withAcceptanceCriteria(c0, ['tests pass', 'sneaky new criterion']),
      /frozen/,
    );
  });

  it('already-fixed and invalid tasks do not action-bias mutate', () => {
    const c = freezeTaskContract(
      buildTaskContractV1({
        mode: 'chat',
        user_request: 'fix bug',
        acceptance_criteria: ['done'],
        baseline_reproduction: 'npm test was already green',
        baseline_verifier_state: { command: 'npm test', exit_code: 0 },
      }),
    );
    assert.strictEqual(
      decideHonestTaskOutcome({
        contract: c,
        acceptanceAlreadyMet: true,
        taskInvalid: false,
        needsHuman: false,
      }),
      'NO_CHANGE_REQUIRED',
    );
    assert.strictEqual(
      decideHonestTaskOutcome({
        contract: c,
        acceptanceAlreadyMet: false,
        taskInvalid: true,
        needsHuman: false,
      }),
      'INVALID_TASK',
    );
    assert.strictEqual(
      decideHonestTaskOutcome({
        contract: c,
        acceptanceAlreadyMet: false,
        taskInvalid: false,
        needsHuman: true,
      }),
      'NEEDS_HUMAN_DECISION',
    );
  });

  it('infrastructure retries do not consume implementation-repair budget', () => {
    const tracker = new FailureClassBudgetTracker({
      implementation_repair: 3,
      infra_retry: 2,
      provider_retry: 2,
    });
    const infra = makeFailureCapsule('infrastructure', 'timeout', 'docker down');
    assert.strictEqual(infra.budget_key, 'infra_retry');
    assert.ok(tracker.consume(infra));
    assert.strictEqual(tracker.remainingBudgets().implementation_repair, 3);
    assert.strictEqual(tracker.remainingBudgets().infra_retry, 1);

    const impl = makeFailureCapsule('implementation', 'logic', 'wrong fix');
    assert.ok(tracker.consume(impl));
    assert.strictEqual(tracker.remainingBudgets().implementation_repair, 2);
  });

  it('Chat/TUI/headless/persistence/exit code agree on terminal outcome', () => {
    const outcomes: TerminalOutcome[] = [
      'VERIFIED_COMPLETE',
      'NO_CHANGE_REQUIRED',
      'INVALID_TASK',
      'NEEDS_HUMAN_DECISION',
      'AGENT_FAILURE',
    ];
    for (const o of outcomes) {
      const a = buildTerminalSurfaceAgreement(o, {
        userFacingStatus: userFacingStatusFromOutcome,
        exitCode: exitCodeFromOutcome,
      });
      assert.strictEqual(a.headless_json_outcome, a.persistence_outcome);
      assert.strictEqual(a.headless_json_outcome, o);
      assert.strictEqual(a.exit_code, exitCodeFromOutcome(o));
      assert.strictEqual(a.process_exit_code, terminalOutcomeExitCode(o));
      assert.ok(typeof a.chat_status === 'string' && a.chat_status.length > 0);
      // Live mappers: isPassingOutcome ⇒ exit 0
      if (isPassingOutcome(o)) {
        assert.strictEqual(a.exit_code, 0);
        assert.strictEqual(a.chat_status, 'success');
      }
    }
  });

  it('Plan cannot authorize executor-style verified completion via contract mode', () => {
    const plan = freezeTaskContract(
      buildTaskContractV1({
        mode: 'plan',
        user_request: 'plan a fix',
        allowed_effects: ['read_only'],
      }),
    );
    assert.strictEqual(plan.mode, 'plan');
    assert.ok(plan.allowed_effects.every((e) => e === 'read_only'));
    // Honest outcome for plan does not return VERIFIED_COMPLETE
    assert.strictEqual(
      decideHonestTaskOutcome({
        contract: plan,
        acceptanceAlreadyMet: false,
        taskInvalid: false,
        needsHuman: false,
        planMode: true,
      }),
      null,
    );
  });

  it('NO_CHANGE_REQUIRED is a passing outcome', () => {
    assert.ok(isPassingOutcome('NO_CHANGE_REQUIRED'));
  });
});

// ─── H4 ──────────────────────────────────────────────────────────────────────

describe('H4 capability broker + transactional effects', () => {
  it('unknown effects fail conservatively', () => {
    const effect = classifyToolEffect('totally_unknown_tool_xyz');
    const check = checkToolCapability({
      toolName: 'totally_unknown_tool_xyz',
      effectClass: effect,
      allowedEffects: ['read_only', 'idempotent', 'reconcilable_mutation'],
      mode: 'chat',
    });
    assert.strictEqual(check.allowed, false);
    assert.ok(
      check.denial === 'unknown_tool_conservative' ||
        check.denial === 'effect_not_allowed',
    );
  });

  it('reconcilable mutations are revision-linked with true rollback reporting', () => {
    let tx = beginEffectTransaction({
      tool_name: 'write_file',
      effect_class: 'reconcilable_mutation',
      paths: ['a.ts'],
      task_id: 't1',
      plan_step_id: 's1',
      policy_decision_id: 'p1',
      pre_revision: { compositeTreeHash: 'pre' },
    });
    assert.strictEqual(tx.status, 'prepare');
    tx = commitEffectTransaction(tx, { compositeTreeHash: 'post' });
    assert.strictEqual(tx.status, 'commit');
    assert.strictEqual(
      (tx.post_revision as { compositeTreeHash: string }).compositeTreeHash,
      'post',
    );
    const failed = rollbackEffectTransaction(tx, 'failed');
    assert.strictEqual(failed.status, 'rollback_failed');
    assert.strictEqual(failed.rollback_result, 'failed');
    const ok = rollbackEffectTransaction(tx, 'success');
    assert.strictEqual(ok.rollback_result, 'success');
  });

  it('dirty-tree and protected-path fail-safe via executeActionWithPolicy (live path)', async () => {
    resetCircuitBreaker();
    const mockExec = {
      mapAction: () => [],
      execute: async () => ({
        action: { type: 'write_file', path: 'a.ts', content: 'x' } as AgentAction,
        terminal: false,
        results: [{ exit_code: 0, stdout: '', stderr: '' }],
      }),
    };
    const ctx = {
      runId: 'h4-live',
      agentId: 'a',
      projectRoot: process.cwd(),
      cwd: process.cwd(),
      babelRoot: process.cwd(),
    } as never;

    const dirty = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'x' },
      'workspace_write',
      ctx,
      { executor: mockExec as never, mode: 'chat', dirtyTree: true },
    );
    assert.strictEqual(dirty.policyBlocked, true);
    assert.ok(String(dirty.results[0]?.stderr).includes('dirty_tree'));

    const prot = await executeActionWithPolicy(
      { type: 'write_file', path: '.env', content: 'x' },
      'workspace_write',
      ctx,
      { executor: mockExec as never, mode: 'chat', protectedPaths: ['.env'] },
    );
    assert.strictEqual(prot.policyBlocked, true);
    assert.ok(String(prot.results[0]?.stderr).includes('protected_path'));
  });

  it('isolation unavailability never silently becomes host execution (live path)', async () => {
    assert.ok(
      wouldSilentHostFallback({
        isolationRequired: true,
        isolationAvailable: false,
        hostFallbackAllowed: false,
      }),
    );
    const mockExec = {
      mapAction: () => [],
      execute: async () => ({
        action: { type: 'run_command', command: 'echo hi' } as AgentAction,
        terminal: false,
        results: [{ exit_code: 0, stdout: '', stderr: '' }],
      }),
    };
    const result = await executeActionWithPolicy(
      { type: 'run_command', command: 'echo hi' },
      'workspace_write',
      {
        runId: 'h4-iso',
        agentId: 'a',
        projectRoot: process.cwd(),
        cwd: process.cwd(),
        babelRoot: process.cwd(),
      } as never,
      {
        executor: mockExec as never,
        mode: 'deep',
        isolationRequired: true,
        isolationAvailable: false,
        hostFallbackAllowed: false,
      },
    );
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(String(result.results[0]?.stderr).includes('isolation_unavailable'));

    const msg = safeRepoIsolationMessage({
      isolationAvailable: false,
      hostFallbackAllowed: false,
    });
    assert.strictEqual(msg.ok, false);
  });

  it('plan mode denies mutations via executeActionWithPolicy', async () => {
    const mockExec = {
      mapAction: () => [],
      execute: async () => ({
        action: { type: 'write_file', path: 'a.ts', content: 'x' } as AgentAction,
        terminal: false,
        results: [{ exit_code: 0, stdout: '', stderr: '' }],
      }),
    };
    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'x' },
      'read_only',
      {
        runId: 'h4-plan',
        agentId: 'a',
        projectRoot: process.cwd(),
        cwd: process.cwd(),
        babelRoot: process.cwd(),
      } as never,
      { executor: mockExec as never, mode: 'plan' },
    );
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(
      String(result.results[0]?.stderr).includes('CAPABILITY_DENIED') ||
        result.policyDecision === 'deny',
    );
  });

  it('CAPABILITY_DENIED increments circuit breaker on live path', async () => {
    resetCircuitBreaker();
    process.env['BABEL_CIRCUIT_BREAKER_LIMIT'] = '3';
    try {
      const mockExec = {
        mapAction: () => [],
        execute: async () => ({
          action: { type: 'write_file', path: '.env', content: 'x' } as AgentAction,
          terminal: false,
          results: [{ exit_code: 0, stdout: '', stderr: '' }],
        }),
      };
      const runId = 'h4-cb';
      for (let i = 0; i < 3; i++) {
        await executeActionWithPolicy(
          { type: 'write_file', path: '.env', content: 'x' },
          'workspace_write',
          {
            runId,
            agentId: 'a',
            projectRoot: process.cwd(),
            cwd: process.cwd(),
            babelRoot: process.cwd(),
          } as never,
          { executor: mockExec as never, mode: 'chat', protectedPaths: ['.env'] },
        );
      }
      const state = getCircuitBreakerState(runId);
      assert.ok(state.consecutiveBlocks >= 3);
      assert.strictEqual(state.tripped, true);
    } finally {
      delete process.env['BABEL_CIRCUIT_BREAKER_LIMIT'];
      resetCircuitBreaker();
    }
  });

  it('idempotency_replay fires via defaultIdempotencyKey on executeActionWithPolicy', async () => {
    const action: AgentAction = { type: 'write_file', path: 'dup.ts', content: 'x' };
    const key = defaultIdempotencyKeyForAction(action)!;
    const mockExec = {
      mapAction: () => [],
      execute: async () => ({
        action,
        terminal: false,
        results: [{ exit_code: 0, stdout: '', stderr: '' }],
      }),
    };
    const result = await executeActionWithPolicy(
      action,
      'workspace_write',
      {
        runId: 'h4-idemp',
        agentId: 'a',
        projectRoot: process.cwd(),
        cwd: process.cwd(),
        babelRoot: process.cwd(),
      } as never,
      {
        executor: mockExec as never,
        mode: 'chat',
        completedIdempotencyKeys: [key],
      },
    );
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(String(result.results[0]?.stderr).includes('idempotency_replay'));
  });
});

// ─── H5 ──────────────────────────────────────────────────────────────────────

describe('H5 verifier promotion + adversarial fixtures', () => {
  const rev = { compositeTreeHash: 'rev-current' };

  function receipt(
    overrides: Partial<Parameters<typeof buildVerifierReceiptV2>[0]> & {
      scope?: 'full_suite' | 'targeted' | 'smoke' | 'property' | 'security';
      exit_code?: number;
      freshness?: 'fresh' | 'stale';
    } = {},
  ) {
    return buildVerifierReceiptV2({
      receipt_id: 'r1',
      verifier_id: 'v1',
      argv: ['npm', 'test'],
      cwd: '/proj',
      env_profile_hash: 'env1',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: overrides.exit_code ?? 0,
      stdout: 'ok',
      stderr: '',
      workspace_revision: overrides.workspace_revision ?? rev,
      scope: overrides.scope ?? 'full_suite',
      command: overrides.command ?? 'npm test',
      authoritative: overrides.authoritative ?? true,
      freshness: overrides.freshness ?? 'fresh',
      ...overrides,
    });
  }

  it('empty required-verifier plan cannot green a mutating task', () => {
    const r = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: [],
      receipts: [],
      current_revision_hash: 'rev-current',
    });
    assert.strictEqual(r.authorize_verified_complete, false);
    assert.ok(r.denials.includes('empty_verifier_plan'));
  });

  it('targeted runs cannot satisfy full-suite requirements', () => {
    const r = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: ['npm test'],
      receipts: [receipt({ scope: 'targeted', command: 'npm test' })],
      current_revision_hash: 'rev-current',
    });
    assert.strictEqual(r.authorize_verified_complete, false);
    assert.ok(r.denials.includes('targeted_cannot_satisfy_full'));
  });

  it('smoke, property, and security receipts cannot satisfy full-suite requirements', () => {
    for (const scope of ['smoke', 'property', 'security'] as const) {
      const r = evaluateVerifierPromotion({
        mutating: true,
        task_class: 'general_swe',
        required_verifier_commands: ['npm test'],
        receipts: [receipt({ scope, command: 'npm test' })],
        current_revision_hash: 'rev-current',
      });
      assert.strictEqual(r.authorize_verified_complete, false, scope);
      assert.ok(r.denials.includes('targeted_cannot_satisfy_full'), scope);
    }
  });

  it('timed out, signalled, nonzero, or failed-test receipts cannot authorize completion', () => {
    for (const overrides of [
      { timed_out: true },
      { signal: 'SIGTERM' },
      { exit_code: 1 },
      { tests_failed: 1 },
    ]) {
      const r = evaluateVerifierPromotion({
        mutating: true,
        task_class: 'general_swe',
        required_verifier_commands: ['npm test'],
        receipts: [receipt({ command: 'npm test', ...overrides })],
        current_revision_hash: 'rev-current',
      });
      assert.strictEqual(r.authorize_verified_complete, false);
      assert.ok(r.denials.includes('failed_verifier_receipt'));
    }
  });

  it('stale or wrong-revision receipts cannot authorize completion', () => {
    const stale = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: ['npm test'],
      receipts: [receipt({ freshness: 'stale', command: 'npm test' })],
      current_revision_hash: 'rev-current',
    });
    assert.ok(stale.denials.includes('stale_receipt'));

    const wrong = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: ['npm test'],
      receipts: [
        receipt({
          command: 'npm test',
          workspace_revision: { compositeTreeHash: 'other' },
        }),
      ],
      current_revision_hash: 'rev-current',
    });
    assert.ok(wrong.denials.includes('wrong_revision'));
  });

  it('verifier tampering and shortcut solutions fail (kernel adversarial signals)', () => {
    // Pure VerifierKernel: adversarial flags are first-class inputs for specialized
    // detectors / review roles. Live wrong-revision is tested via
    // evaluateCompletionGateForEngine + currentWorkspaceRevisionHash in
    // toolExecutor.h4live.test.ts (not receipt self-hash).
    const r = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'high_assurance',
      required_verifier_commands: ['npm test'],
      receipts: [receipt({ command: 'npm test' })],
      current_revision_hash: 'rev-current',
      adversarial: {
        verifier_def_tampered: true,
        shortcut_noop: true,
        hardcoded_fixture: true,
        tests_deleted: true,
        flaky_green: true,
        baseline_failing: true,
      },
    });
    assert.strictEqual(r.authorize_verified_complete, false);
    assert.ok(r.denials.includes('tampered_verifier_def'));
    assert.ok(r.denials.includes('shortcut_noop'));
    assert.ok(r.denials.includes('hardcoded_fixture'));
  });

  it('wrong_revision denies when live hash differs from receipt (not tautological)', () => {
    const r = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: ['npm test'],
      receipts: [
        receipt({
          command: 'npm test',
          workspace_revision: { compositeTreeHash: 'receipt-old' },
        }),
      ],
      current_revision_hash: 'live-workspace-new',
    });
    assert.ok(r.denials.includes('wrong_revision'));
    assert.strictEqual(r.authorize_verified_complete, false);
  });

  it('legitimate solutions still pass after hardening', () => {
    const r = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: ['npm test'],
      receipts: [receipt({ command: 'npm test', scope: 'full_suite', exit_code: 0 })],
      current_revision_hash: 'rev-current',
    });
    assert.strictEqual(r.authorize_verified_complete, true);
    assert.deepStrictEqual(r.denials, []);
  });

  it('clean-room promotion required for high_assurance', () => {
    const profile = profileForTaskClass('high_assurance');
    const deny = evaluateCleanRoomPromotion({
      profile,
      clean_room_receipts: [],
      primary_receipts: [receipt()],
    });
    assert.strictEqual(deny.promote, false);
    const ok = evaluateCleanRoomPromotion({
      profile,
      clean_room_receipts: [receipt({ receipt_id: 'cr1' })],
      primary_receipts: [receipt()],
    });
    assert.strictEqual(ok.promote, true);
  });
});

// ─── H6 ──────────────────────────────────────────────────────────────────────

describe('H6 replay, cross-surface, live golden', () => {
  function makeLog() {
    const log = createSessionEventLog('gold-1');
    const turn = 't1';
    recordUserSubmitted(log, { turn_id: turn, task: 'fix', model: 'm' });
    recordToolProposed(log, {
      turn_id: turn,
      tool_call_id: 'c1',
      tool_name: 'write_file',
      idempotency_key: 'k1',
    });
    recordToolStarted(log, {
      turn_id: turn,
      tool_call_id: 'c1',
      tool_name: 'write_file',
      idempotency_key: 'k1',
    });
    recordToolTerminal(log, {
      turn_id: turn,
      tool_call_id: 'c1',
      tool_name: 'write_file',
      idempotency_key: 'k1',
      exit_code: 0,
    });
    recordMutationBatch(log, turn, {
      paths: ['a.ts'],
      status: 'commit',
      ending_revision: 'r1',
    });
    recordVerifierAttempt(log, {
      turn_id: turn,
      command_preview: 'npm test',
      authoritative: true,
      exit_code: 0,
    });
    recordCompactionCreated(log, turn, { content_preview: 'cap' });
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
    return log;
  }

  it('replay reaches same terminal without model inference', () => {
    const log = makeLog();
    const r1 = replayTerminalDecision(log);
    const r2 = replayTerminalDecision(log);
    assert.strictEqual(r1.outcome, 'VERIFIED_COMPLETE');
    assert.strictEqual(r2.outcome, r1.outcome);
    assert.strictEqual(r1.invented, false);
  });

  it('TUI/headless/persistence/CLI agree on facts', () => {
    const log = makeLog();
    const facts = projectCrossSurfaceFacts(log, {
      exitCodeForOutcome: terminalOutcomeExitCode as (o: string) => number,
      userFacingStatus: (o) => userFacingStatusFromOutcome(o as TerminalOutcome),
    });
    assert.ok(facts.agree);
    // Headless/persistence keep canonical outcome; TUI uses user-facing label
    assert.strictEqual(facts.headless_json.outcome, 'VERIFIED_COMPLETE');
    assert.strictEqual(facts.persistence.outcome, 'VERIFIED_COMPLETE');
    assert.strictEqual(facts.tui.outcome, 'success');
    assert.strictEqual(facts.cli_status.exit_code, 0);
  });

  it('one command validates runtime-generated golden through workspace path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-h6-'));
    try {
      const log = makeLog();
      // Synthetic durable log: live_runtime false unless caller asserts controller provenance
      const artifact = buildLiveGoldenEpisode({
        sessionLog: log,
        workspace_path: dir,
        live_runtime: false,
      });
      assert.strictEqual(artifact.live_runtime, false);
      const v = validateGoldenEpisode(artifact);
      assert.ok(v.ok, v.errors.join('; '));
      // Replay integrity still holds without claiming live controller provenance
      const result = runAndValidateLiveGolden({
        sessionLog: log,
        workspace_path: dir,
      });
      assert.ok(result.ok, result.validation.errors.join('; '));
      assert.ok(result.artifact_path.endsWith('live-golden-episode.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inspectSessionHistory surfaces policy/compaction/tool/mutation/verifier counts', () => {
    const h = inspectSessionHistory(makeLog());
    assert.ok(h.tools > 0);
    assert.ok(h.mutations > 0);
    assert.ok(h.verifiers > 0);
    assert.ok(h.compaction > 0);
    assert.ok(h.completions > 0);
  });

  it('replay does not invent terminals for empty logs', () => {
    const empty = createSessionEventLog('e');
    const r = replayTerminalDecision(empty);
    assert.strictEqual(r.outcome, null);
    assert.strictEqual(r.source, 'none');
  });
});

// ─── H7 ──────────────────────────────────────────────────────────────────────

describe('H7 model-fixed eval substrate', () => {
  const controls: FixedEvalControls = {
    task_set_id: 'h7-min',
    model_snapshot: 'deepseek-chat@fixed',
    sampling: { temperature: 0 },
    repository_revision: 'rev-test',
    permissions_profile: 'safe_repo',
    verifier_profile: 'general_swe',
    resource_profile: 'default',
    environment_digest: environmentDigest({ os: 'windows', node: process.version }),
  };

  it('computes core metrics without best-run cherry-picking', () => {
    const results: EvalTaskResult[] = [
      {
        task_id: 'a',
        variant: 'v',
        verified_complete_no_policy_violation: true,
        tokens: 100,
        duration_ms: 1000,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: true,
        critical_fact_retention: 1,
        infrastructure_failure: false,
        agent_failure: false,
        human_intervention: false,
        clean_room_pass: true,
      },
      {
        task_id: 'b',
        variant: 'v',
        verified_complete_no_policy_violation: false,
        tokens: 100,
        duration_ms: 1000,
        false_completion: true,
        instruction_policy_violation: true,
        resume_state_equivalent: false,
        critical_fact_retention: 0.5,
        infrastructure_failure: true,
        agent_failure: false,
        human_intervention: true,
        clean_room_pass: false,
      },
    ];
    const m = computeCoreMetrics(results);
    assert.strictEqual(m.n_tasks, 2);
    assert.strictEqual(m.false_completion_rate, 0.5);
    assert.strictEqual(m.infrastructure_failure_rate, 0.5);
    assert.strictEqual(m.agent_failure_rate, 0);
    // Infrastructure and agent failures remain separate
    assert.notStrictEqual(m.infrastructure_failure_rate, m.agent_failure_rate);
  });

  it('single-trial paired deltas disclose zero measured uncertainty', () => {
    const base: EvalTaskResult[] = [
      {
        task_id: 't1',
        variant: 'base',
        verified_complete_no_policy_violation: true,
        tokens: 1000,
        duration_ms: 1,
        false_completion: false,
        instruction_policy_violation: false,
        resume_state_equivalent: null,
        critical_fact_retention: null,
        infrastructure_failure: false,
        agent_failure: false,
        human_intervention: false,
        clean_room_pass: null,
      },
    ];
    const cand: EvalTaskResult[] = [{ ...base[0]!, variant: 'cand', tokens: 800 }];
    const deltas = computePairedDeltas(base, cand, 'tokens');
    assert.strictEqual(deltas.length, 1);
    assert.strictEqual(deltas[0]!.delta, -200);
    assert.strictEqual(deltas[0]!.uncertainty, 0);
  });

  it('repeated paired trials report measured uncertainty', () => {
    const base: EvalTaskResult[] = [
      { task_id: 't1', trial_index: 0, variant: 'base', verified_complete_no_policy_violation: true, tokens: 100, duration_ms: 1, false_completion: false, instruction_policy_violation: false, resume_state_equivalent: null, critical_fact_retention: null, infrastructure_failure: false, agent_failure: false, human_intervention: false, clean_room_pass: null },
      { task_id: 't1', trial_index: 1, variant: 'base', verified_complete_no_policy_violation: true, tokens: 100, duration_ms: 1, false_completion: false, instruction_policy_violation: false, resume_state_equivalent: null, critical_fact_retention: null, infrastructure_failure: false, agent_failure: false, human_intervention: false, clean_room_pass: null },
    ];
    const candidate: EvalTaskResult[] = [
      { ...base[0]!, variant: 'candidate', tokens: 80 },
      { ...base[1]!, variant: 'candidate', tokens: 60 },
    ];
    const deltas = computePairedDeltas(base, candidate, 'tokens');
    assert.ok(deltas.every((delta) => delta.uncertainty > 0));
  });

  it('promotion requires pre-fail, post-pass, held-out, rollback', () => {
    const bad = validatePromotionRecord({
      change_id: 'c1',
      pre_fix_fixture: '',
      pre_fix_failed: true,
      post_fix_fixture: 'f',
      post_fix_passed: true,
      held_out_non_regression: false,
      rollback_path: '',
    });
    assert.strictEqual(bad.ok, false);

    const good = validatePromotionRecord({
      change_id: 'c1',
      pre_fix_fixture: 'pre.test.ts',
      pre_fix_failed: true,
      post_fix_fixture: 'post.test.ts',
      post_fix_passed: true,
      held_out_non_regression: true,
      rollback_path: 'git revert HEAD',
    });
    assert.strictEqual(good.ok, true);
  });

  it('local substrate smoke is not experimental evidence', () => {
    const report = runLocalEvalSubstrateSmoke(controls);
    assert.strictEqual(report.experimental_evidence, false);
    assert.ok(report.notes.some((n) => /not measured/i.test(n)));
    assert.ok(H7_DEDICATED_SUITES.includes('false_completion'));
    assert.ok(H7_DEDICATED_SUITES.includes('crash_resume'));
  });

  it('failure ledger links episodes to fixtures and fixes', () => {
    const ledger = appendFailureLedger([], {
      episode_id: 'ep1',
      failure_class: 'false_completion',
      regression_fixture: 'h5-adversarial.test.ts',
      fixing_commit: 'abc123',
      held_out: true,
    });
    assert.strictEqual(ledger.length, 1);
    assert.strictEqual(ledger[0]!.fixing_commit, 'abc123');
  });

  it('controlsMatch detects uncontrolled comparisons', () => {
    const b = { ...controls, model_snapshot: 'other-model' };
    const m = controlsMatch(controls, b);
    assert.strictEqual(m.ok, false);
    assert.ok(m.deviations.includes('model_snapshot'));
  });

  it('offline harness-factor factorial drives shipped paths under fixed controls', () => {
    const report = runOfflineHarnessFactorial(controls);
    assert.strictEqual(report.experimental_evidence, true);
    assert.ok(report.notes.some((n) => /NOT same-model Chat\/Deep LLM/i.test(n)));
    assert.ok(report.paired_deltas.length >= 1);
    assert.strictEqual(report.paired_deltas[0]!.uncertainty, 0);
    assert.strictEqual(
      report.metrics.infrastructure_failure_rate !== undefined &&
        report.metrics.agent_failure_rate !== undefined,
      true,
    );
    // Infrastructure and agent remain separate fields
    assert.ok('infrastructure_failure_rate' in report.metrics);
    assert.ok('agent_failure_rate' in report.metrics);
    const hardened = report.results.find((r) => r.variant === 'hardened-offline');
    assert.ok(hardened);
    assert.strictEqual(hardened!.verified_complete_no_policy_violation, true);
    assert.strictEqual(hardened!.false_completion, false);
    assert.strictEqual(hardened!.instruction_policy_violation, false);
    assert.strictEqual(hardened!.resume_state_equivalent, true);
    assert.strictEqual(hardened!.critical_fact_retention, 1);

    const dir = mkdtempSync(join(tmpdir(), 'babel-h7-'));
    try {
      const path = writeEvalReport(dir, report);
      assert.ok(existsSync(path));
      assert.throws(
        () => writeEvalReport('undefined', report),
        /invalid output directory/,
      );
      assert.throws(
        () => writeEvalReport(undefined as unknown as string, report),
        /invalid output directory/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('same-model LLM factorial without API key reports experimental_evidence:false', async () => {
    const { runSameModelLlmFactorial } = await import('./harnessEval.js');
    const prev = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const report = await runSameModelLlmFactorial({
        controls,
        workspace_path: process.cwd(),
        model_id: 'openai/gpt-4o-mini',
        max_tasks: 1,
      });
      assert.strictEqual(report.experimental_evidence, false);
      assert.ok(report.notes.some((n) => /BLOCKED|missing/i.test(n)));
    } finally {
      if (prev !== undefined) process.env['OPENROUTER_API_KEY'] = prev;
    }
  });
});

describe('credential read boundaries', () => {
  it('workspace identity excludes credential-class paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-broker-credential-'));
    try {
      mkdirSync(join(root, '.aws'));
      writeFileSync(join(root, 'safe.txt'), 'safe\n', 'utf-8');
      writeFileSync(join(root, '.env'), 'SYNTHETIC=only\n', 'utf-8');
      writeFileSync(join(root, '.aws', 'credentials'), 'synthetic\n', 'utf-8');
      writeFileSync(join(root, 'id_rsa'), 'synthetic\n', 'utf-8');

      const identity = captureWorkspaceRevisionIdentity(root);
      assert.ok(identity.fileHashes['safe.txt']);
      assert.equal(identity.fileHashes['.env'], undefined);
      assert.equal(identity.fileHashes['.aws/credentials'], undefined);
      assert.equal(identity.fileHashes['id_rsa'], undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
it('workspace identity rejects credential symlink targets', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-broker-credential-link-'));
  try {
    writeFileSync(join(root, '.env'), 'SYNTHETIC=only\n', 'utf-8');
    writeFileSync(join(root, 'safe.txt'), 'safe\n', 'utf-8');
    symlinkSync(join(root, '.env'), join(root, 'config.json'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Babel Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', 'safe.txt', 'config.json'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });

    const identity = captureWorkspaceRevisionIdentity(root);
    assert.equal(identity.fileHashes['config.json'], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});