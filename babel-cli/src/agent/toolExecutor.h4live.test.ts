/**
 * H4 live-path fixtures: executeActionWithPolicy must fire protected-path,
 * dirty-tree, isolation, and idempotency denials — and open effect transactions
 * for reconcilable mutations. Also proves capability denials trip the circuit breaker.
 */

import * as assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  executeActionWithPolicy,
  resetCircuitBreaker,
  getCircuitBreakerState,
  targetPathFromAction,
  defaultIdempotencyKeyForAction,
  type ToolExecutor,
} from './toolExecutor.js';
import type { AgentAction } from './actions.js';
import type { ToolContext } from '../localTools.js';

function ctx(runId: string, projectRoot: string): ToolContext {
  return {
    runId,
    agentId: 'test-agent',
    projectRoot,
    cwd: projectRoot,
    babelRoot: projectRoot,
  } as unknown as ToolContext;
}

const mockExecutor = {
  mapAction() {
    return [];
  },
  async execute() {
    return {
      action: { type: 'write_file' as const, path: 'x.ts', content: 'x' },
      terminal: false,
      results: [{ exit_code: 0, stdout: 'ok', stderr: '' }],
    };
  },
} as unknown as ToolExecutor;

describe('H4 targetPathFromAction / defaultIdempotencyKey', () => {
  it('extracts path from write_file', () => {
    assert.strictEqual(
      targetPathFromAction({ type: 'write_file', path: '.env', content: 'x' }),
      '.env',
    );
    assert.strictEqual(
      defaultIdempotencyKeyForAction({ type: 'write_file', path: 'a.ts', content: 'x' }),
      'write_file:a.ts',
    );
  });
});

describe('H4 executeActionWithPolicy live capability gates', () => {
  let tmp: string;
  beforeEach(() => {
    resetCircuitBreaker();
    tmp = mkdtempSync(join(tmpdir(), 'babel-h4-'));
  });

  it('denies protected_path when targetPath matches protectedPaths', async () => {
    const action: AgentAction = { type: 'write_file', path: '.env', content: 'SECRET=1' };
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r1', tmp), {
      executor: mockExecutor,
      mode: 'chat',
      protectedPaths: ['.env', '.git'],
    });
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(String(result.results[0]?.stderr).includes('protected_path'));
  });

  it('denies dirty_tree for reconcilable mutations', async () => {
    const action: AgentAction = { type: 'write_file', path: 'a.ts', content: 'x' };
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r2', tmp), {
      executor: mockExecutor,
      mode: 'chat',
      dirtyTree: true,
    });
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(String(result.results[0]?.stderr).includes('dirty_tree'));
  });

  it('denies isolation_unavailable without host fallback', async () => {
    const action: AgentAction = { type: 'run_command', command: 'echo hi' };
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r3', tmp), {
      executor: mockExecutor,
      mode: 'deep',
      isolationRequired: true,
      isolationAvailable: false,
      hostFallbackAllowed: false,
    });
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(String(result.results[0]?.stderr).includes('isolation_unavailable'));
  });

  it('does not deny read_file when isolation unavailable (filesystem tools are not Docker-gated)', async () => {
    const action: AgentAction = { type: 'read_file', path: 'hello.txt' };
    writeFileSync(join(tmp, 'hello.txt'), 'hi', 'utf-8');
    const fileExec = {
      mapAction() {
        return [];
      },
      async execute() {
        return {
          action,
          terminal: false,
          results: [{ exit_code: 0, stdout: 'hi', stderr: '' }],
        };
      },
    } as unknown as ToolExecutor;
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r3-read', tmp), {
      executor: fileExec,
      mode: 'chat',
      isolationRequired: true,
      isolationAvailable: false,
      hostFallbackAllowed: false,
    });
    assert.strictEqual(
      result.policyBlocked,
      false,
      'read_file must not be CAPABILITY_DENIED solely for isolation_unavailable',
    );
  });

  it('does not deny write_file when isolation unavailable (shell isolation only)', async () => {
    const file = join(tmp, 'w.ts');
    const action: AgentAction = { type: 'write_file', path: file, content: 'x' };
    const fileExec = {
      mapAction() {
        return [];
      },
      async execute() {
        writeFileSync(file, 'x', 'utf-8');
        return {
          action,
          terminal: false,
          results: [{ exit_code: 0, stdout: '', stderr: '' }],
        };
      },
    } as unknown as ToolExecutor;
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r3-write', tmp), {
      executor: fileExec,
      mode: 'chat',
      isolationRequired: true,
      isolationAvailable: false,
      hostFallbackAllowed: false,
    });
    assert.strictEqual(result.policyBlocked, false);
  });

  it('denies idempotency_replay when key already completed', async () => {
    const action: AgentAction = { type: 'write_file', path: 'a.ts', content: 'x' };
    const key = defaultIdempotencyKeyForAction(action)!;
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r4', tmp), {
      executor: mockExecutor,
      mode: 'chat',
      completedIdempotencyKeys: [key],
      // idempotencyKey defaults from action
    });
    assert.strictEqual(result.policyBlocked, true);
    assert.ok(String(result.results[0]?.stderr).includes('idempotency_replay'));
  });

  it('capability denials increment circuit breaker', async () => {
    const runId = 'r-cb';
    process.env['BABEL_CIRCUIT_BREAKER_LIMIT'] = '3';
    try {
      for (let i = 0; i < 3; i++) {
        await executeActionWithPolicy(
          { type: 'write_file', path: '.env', content: 'x' },
          'workspace_write',
          ctx(runId, tmp),
          { executor: mockExecutor, mode: 'chat', protectedPaths: ['.env'] },
        );
      }
      const state = getCircuitBreakerState(runId);
      assert.ok(state.consecutiveBlocks >= 3);
      assert.strictEqual(state.tripped, true);
    } finally {
      delete process.env['BABEL_CIRCUIT_BREAKER_LIMIT'];
    }
  });

  it('opens effectTransaction on successful write_file mutation', async () => {
    // Real write into temp dir so WorkspaceTransactionManager works
    const file = join(tmp, 'mut.ts');
    writeFileSync(file, 'before', 'utf-8');
    const action: AgentAction = {
      type: 'write_file',
      path: file,
      content: 'after',
    };
    const realish = {
      mapAction() {
        return [];
      },
      async execute() {
        writeFileSync(file, 'after', 'utf-8');
        return {
          action,
          terminal: false,
          results: [{ exit_code: 0, stdout: 'ok', stderr: '' }],
        };
      },
    } as unknown as ToolExecutor;
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r-tx', tmp), {
      executor: realish,
      mode: 'chat',
      taskId: 'task-1',
      planStepId: 'step-1',
    });
    assert.strictEqual(result.policyBlocked, false);
    assert.ok(result.effectTransaction, 'effectTransaction must be present');
    assert.strictEqual(result.effectTransaction!.status, 'commit');
    assert.strictEqual(result.effectTransaction!.task_id, 'task-1');
    assert.strictEqual(result.effectTransaction!.plan_step_id, 'step-1');
    assert.ok(result.effectTransaction!.pre_revision);
    assert.ok(result.effectTransaction!.post_revision);
    assert.ok(result.mutationPaths?.length);
  });

  it('does not commit an effect transaction when a tool returns a nonzero exit code', async () => {
    const file = join(tmp, 'failed-mut.ts');
    writeFileSync(file, 'before', 'utf-8');
    const action: AgentAction = { type: 'write_file', path: file, content: 'after' };
    const failing = {
      mapAction() { return []; },
      async execute() {
        writeFileSync(file, 'after', 'utf-8');
        return { action, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: 'failed' }] };
      },
    } as unknown as ToolExecutor;
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r-failed-tx', tmp), {
      executor: failing,
      mode: 'chat',
    });
    assert.ok(result.effectTransaction);
    assert.notStrictEqual(result.effectTransaction!.status, 'commit');
    assert.strictEqual(readFileSync(file, 'utf-8'), 'before');
  });

  it('captures shell pre/post revisions and policy linkage', async () => {
    const file = join(tmp, 'shell-mutated.txt');
    const action: AgentAction = { type: 'run_command', command: 'synthetic mutation' };
    const shellExecutor = {
      mapAction() { return []; },
      async execute() {
        writeFileSync(file, 'after', 'utf-8');
        return { action, terminal: false, results: [{ exit_code: 0, stdout: 'ok', stderr: '' }] };
      },
    } as unknown as ToolExecutor;
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r-shell', tmp), {
      executor: shellExecutor,
      mode: 'chat',
      taskId: 'task-shell',
      planStepId: 'step-shell',
    });
    const tx = result.effectTransaction!;
    assert.strictEqual(tx.status, 'commit');
    assert.ok(tx.policy_decision_id);
    assert.strictEqual(tx.task_id, 'task-shell');
    assert.strictEqual(tx.plan_step_id, 'step-shell');
    assert.ok(tx.pre_revision);
    assert.ok(tx.post_revision);
    assert.notStrictEqual(
      tx.pre_revision!.compositeTreeHash,
      tx.post_revision!.compositeTreeHash,
    );
  });

  it('marks failed shell effects for reconciliation with observed post state', async () => {
    const file = join(tmp, 'shell-failed.txt');
    const action: AgentAction = { type: 'run_command', command: 'synthetic failure' };
    const shellExecutor = {
      mapAction() { return []; },
      async execute() {
        writeFileSync(file, 'partial', 'utf-8');
        return { action, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: 'failed' }] };
      },
    } as unknown as ToolExecutor;
    const result = await executeActionWithPolicy(action, 'workspace_write', ctx('r-shell-fail', tmp), {
      executor: shellExecutor,
      mode: 'chat',
    });
    const tx = result.effectTransaction!;
    assert.strictEqual(tx.status, 'reconcile_needed');
    assert.ok(tx.pre_revision);
    assert.ok(tx.post_revision);
    assert.ok(tx.policy_decision_id);
  });
});

describe('H5 evaluateCompletionGateForEngine live revision', () => {
  it('missing revision and missing scope fail closed', async () => {
    const { evaluateVerifierPromotion, buildVerifierReceiptV2 } = await import('./verifierKernel.js');
    const { receiptScopeFromLedgerEntry } = await import('./completionGatePolicy.js');
    assert.strictEqual(receiptScopeFromLedgerEntry({ command: 'npm test' }), 'unknown');
    const receipt = buildVerifierReceiptV2({
      receipt_id: 'missing-rev', verifier_id: 'v', argv: ['npm', 'test'], cwd: '.',
      env_profile_hash: 'e', started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      exit_code: 0, stdout: 'ok', stderr: '', workspace_revision: { compositeTreeHash: '' },
      scope: 'unknown', command: 'npm test', authoritative: true,
    });
    const promo = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: ['npm test'],
      receipts: [receipt],
      current_revision_hash: '',
    });
    assert.ok(promo.denials.includes('missing_revision'));
    assert.ok(promo.denials.includes('insufficient_verifier_scope'));
    assert.strictEqual(promo.authorize_verified_complete, false);
  });

  it('wrong_revision denies when currentWorkspaceRevisionHash differs from receipt', async () => {
    const { evaluateCompletionGateForEngine } = await import('./completionGatePolicy.js');
    const decision = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task: 'fix bug\n\nRequired: npm test',
      taskClass: 'general_swe',
      toolCallLog: [
        { tool: 'write_file', target: 'a.ts', exit_code: 0 },
        { tool: 'run_command', target: 'npm test', exit_code: 0 },
      ],
      lastVerifierReceipt: {
        command: 'npm test',
        exit_code: 0,
        summary: 'ok',
        authority: true,
        authoritySource: 'project_discovery',
        boundRevision: {
          compositeTreeHash: 'receipt-old-hash',
          fileHashes: { 'a.ts': 'h1' },
          gitCommitHash: null,
          capturedAt: Date.now(),
        },
      } as never,
      executedVerifierLedger: [
        {
          command: 'npm test',
          exit_code: 0,
          exitCode: 0,
          summary: 'ok',
          authority: true,
          authoritySource: 'project_discovery',
          boundRevision: {
            compositeTreeHash: 'receipt-old-hash',
            fileHashes: { 'a.ts': 'h1' },
            gitCommitHash: null,
            capturedAt: Date.now(),
          },
        } as never,
      ],
      requiredVerifierCommands: ['npm test'],
      // Live hash differs from receipt → wrong_revision
      currentWorkspaceRevisionHash: 'live-current-hash',
    });
    // Policy may be 'required' not 'strict' for general_swe depending on task text.
    // Force by checking evaluateVerifierPromotion path only when strict.
    // When not strict, H5 promo block is skipped — assert the pure promo still denounces.
    const { evaluateVerifierPromotion, buildVerifierReceiptV2 } = await import(
      './verifierKernel.js'
    );
    const promo = evaluateVerifierPromotion({
      mutating: true,
      task_class: 'general_swe',
      required_verifier_commands: ['npm test'],
      receipts: [
        buildVerifierReceiptV2({
          receipt_id: 'r',
          verifier_id: 'v',
          argv: ['npm', 'test'],
          cwd: '.',
          env_profile_hash: 'e',
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          exit_code: 0,
          stdout: 'ok',
          stderr: '',
          workspace_revision: { compositeTreeHash: 'receipt-old-hash' },
          scope: 'full_suite',
          command: 'npm test',
          authoritative: true,
        }),
      ],
      current_revision_hash: 'live-current-hash',
    });
    assert.ok(promo.denials.includes('wrong_revision'));
    assert.strictEqual(promo.authorize_verified_complete, false);
    void decision;
  });

  it('evaluateCompletionGateForEngine rejects wrong revision on strict policy', async () => {
    const { evaluateCompletionGateForEngine } = await import('./completionGatePolicy.js');
    // governance task class defaults to verificationPolicy: 'strict'
    const decision = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task: 'policy review; run npm test after edits',
      taskClass: 'governance',
      toolCallLog: [
        { tool: 'write_file', target: 'a.ts', exit_code: 0 },
      ],
      lastVerifierReceipt: {
        command: 'npm test',
        exit_code: 0,
        summary: 'ok',
        authority: true,
        authoritySource: 'project_discovery',
        boundRevision: {
          compositeTreeHash: 'old',
          fileHashes: { 'a.ts': 'h' },
          gitCommitHash: null,
          capturedAt: Date.now(),
        },
      } as never,
      executedVerifierLedger: [
        {
          command: 'npm test',
          exit_code: 0,
          exitCode: 0,
          summary: 'ok',
          authority: true,
          authoritySource: 'project_discovery',
          boundRevision: {
            compositeTreeHash: 'old',
            fileHashes: { 'a.ts': 'h' },
            gitCommitHash: null,
            capturedAt: Date.now(),
          },
        } as never,
      ],
      requiredVerifierCommands: ['npm test'],
      currentWorkspaceRevisionHash: 'new-live-hash',
    });
    assert.strictEqual(
      decision,
      'reject',
      'strict policy + wrong live revision must reject completion',
    );
  });

  it('evaluateCompletionGateForEngine rejects targeted scope as full-suite (live path)', async () => {
    const { evaluateCompletionGateForEngine, receiptScopeFromLedgerEntry } = await import(
      './completionGatePolicy.js'
    );
    assert.strictEqual(
      receiptScopeFromLedgerEntry({ scope: 'targeted', command: 'npm test' }),
      'targeted',
    );
    const decision = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task: 'policy review; run npm test after edits',
      taskClass: 'governance',
      toolCallLog: [{ tool: 'write_file', target: 'a.ts', exit_code: 0 }],
      lastVerifierReceipt: {
        command: 'npm test',
        exit_code: 0,
        summary: 'ok',
        authority: true,
        authoritySource: 'project_discovery',
        scope: 'targeted',
        boundRevision: {
          compositeTreeHash: 'live-hash',
          fileHashes: { 'a.ts': 'h' },
          gitCommitHash: null,
          capturedAt: Date.now(),
        },
      } as never,
      executedVerifierLedger: [
        {
          command: 'npm test',
          exit_code: 0,
          exitCode: 0,
          summary: 'ok',
          authority: true,
          authoritySource: 'project_discovery',
          scope: 'targeted',
          boundRevision: {
            compositeTreeHash: 'live-hash',
            fileHashes: { 'a.ts': 'h' },
            gitCommitHash: null,
            capturedAt: Date.now(),
          },
        } as never,
      ],
      requiredVerifierCommands: ['npm test'],
      currentWorkspaceRevisionHash: 'live-hash',
    });
    assert.strictEqual(
      decision,
      'reject',
      'targeted ledger receipt must not authorize full-suite governance completion',
    );
  });

  it('evaluateCompletionGateForEngine rejects shortcut_noop adversarial signal on live path', async () => {
    const { evaluateCompletionGateForEngine } = await import('./completionGatePolicy.js');
    const decision = evaluateCompletionGateForEngine({
      turnType: 'completion',
      taskIntent: 'execute',
      task: 'policy review; run npm test after edits',
      taskClass: 'governance',
      toolCallLog: [{ tool: 'write_file', target: 'fix.noop', exit_code: 0 }],
      lastVerifierReceipt: null,
      executedVerifierLedger: [
        {
          command: 'npm test',
          exit_code: 0,
          exitCode: 0,
          summary: 'ok',
          authority: true,
          authoritySource: 'project_discovery',
          scope: 'full_suite',
          boundRevision: {
            compositeTreeHash: 'live-hash',
            fileHashes: {},
            gitCommitHash: null,
            capturedAt: Date.now(),
          },
        } as never,
      ],
      requiredVerifierCommands: ['npm test'],
      currentWorkspaceRevisionHash: 'live-hash',
    });
    assert.strictEqual(decision, 'reject', 'shortcut_noop write target must reject');
  });
});

describe('H4 detectWorkingTreeDirty + isolation profile mapping', () => {
  it('detectWorkingTreeDirty honors env override and git porcelain', async () => {
    const { detectWorkingTreeDirty } = await import('./capabilityBroker.js');
    process.env['BABEL_DIRTY_TREE'] = '1';
    try {
      assert.strictEqual(detectWorkingTreeDirty(process.cwd()), true);
    } finally {
      delete process.env['BABEL_DIRTY_TREE'];
    }
    process.env['BABEL_DIRTY_TREE'] = '0';
    try {
      assert.strictEqual(detectWorkingTreeDirty(process.cwd()), false);
    } finally {
      delete process.env['BABEL_DIRTY_TREE'];
    }
  });

  it('evaluateGovernedIsolation("chat") must not be used as isolation profile (safe_repo default trap)', async () => {
    const { evaluateGovernedIsolation, setDockerAvailableForTest, resetDockerAvailabilityCache } =
      await import('../config/benchmarkContainer.js');
    const { resolveExecutionProfile } = await import('../config/executionProfiles.js');
    // ChatExecutionProfile names are NOT ExecutionProfileNames
    assert.strictEqual(resolveExecutionProfile('chat').name, 'safe_repo');
    // Production path must use BABEL_EXECUTION_PROFILE (or undefined → env), never 'chat'
    resetDockerAvailabilityCache();
    setDockerAvailableForTest(false);
    try {
      const fromChatMode = evaluateGovernedIsolation('chat', '', {
        BABEL_ALLOW_HOST_FALLBACK: undefined,
        BABEL_DOCKER_DISABLE: undefined,
        BABEL_BENCHMARK_DOCKER_IMAGE: undefined,
      } as unknown as NodeJS.ProcessEnv);
      const fromDevLocal = evaluateGovernedIsolation(undefined, '', {
        BABEL_EXECUTION_PROFILE: 'dev_local',
      } as NodeJS.ProcessEnv);
      assert.strictEqual(fromChatMode.kind, 'fail_closed');
      assert.strictEqual(fromDevLocal.kind, 'host_profile');
    } finally {
      resetDockerAvailabilityCache();
    }
  });
});
