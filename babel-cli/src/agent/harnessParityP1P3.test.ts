/**
 * P1–P3 harness parity gating tests.
 * Drive shipped modules (reducer, progress, event log, approvals, capabilities,
 * chat compile, mutations, input arbiter) — not re-implementations.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  foldAgentLoop,
  planToolBatches,
  preservesToolOrder,
  flattenBatchPlan,
  reduceAgentLoop,
  initialAgentLoopState,
  type AgentLoopEvent,
  type OrderedToolAction,
} from './agentLoopReducer.js';
import {
  createProgressLedger,
  recordProgressCycle,
  scoreProgressIntervention,
} from './progressReceipt.js';
import {
  arbitratePolicy,
  formatPolicyPrecedenceTable,
  POLICY_PRECEDENCE,
  policyPrecedenceRank,
} from './policyPrecedence.js';
import {
  createThreadEventLog,
  startTurn,
  recordAssistantToolCalls,
  recordToolResult,
  endTurn,
  rebuildProviderMessagesFromEvents,
  validateRepoIdentityOnResume,
  parseThreadEventLog,
  serializeThreadEventLog,
  THREAD_EVENT_LOG_VERSION,
  latestTurnSnapshot,
} from './threadEventLog.js';
import {
  createApprovalSession,
  buildApprovalRequest,
  resolveApprovalHeadless,
  applyApprovalDecision,
  deriveSubagentApprovalSession,
  isPreApproved,
  inferCapabilityFromCommand,
  ruleMatchesRequest,
} from './approvalRequests.js';
import {
  computeContextBudget,
  resolveProviderCapabilities,
  shouldCompactByTokens,
  decideProToFlashFailover,
  buildCompactionCapsule,
  formatCompactionCapsule,
  contextBudgetForModel,
} from './providerCapabilities.js';
import { governedStrReplace } from './governedMutations.js';
import { resetCircuitBreaker } from './toolExecutor.js';
import {
  compileChatStack,
  chatStackExcludesDeepStages,
  chatManifestHashForPaths,
} from './chatStackCompile.js';
import {
  reduceInputArbiter,
  initialInputArbiterState,
  activeStdinOwners,
  wiredFooterShortcuts,
} from '../ui/inputArbiterModes.js';
import { compileChatStackForRun } from '../interactive/execution/chatCore.js';
import { getContextLimit } from '../ui/tokenBar.js';

// ─── (a) stream vs non-stream identical outcome fixture ─────────────────────

describe('P1-A agent loop reducer', () => {
  test('stream vs non-stream identical outcome on golden fixture', () => {
    const events: AgentLoopEvent[] = [
      { type: 'user_turn', task: 'fix bug in foo.ts' },
      {
        type: 'tool_calls',
        tools: [{ id: '1', name: 'read_file', mutating: false }],
      },
      {
        type: 'tool_results',
        results: [{ id: '1', name: 'read_file', exitCode: 0 }],
      },
      { type: 'progress', hasDelta: true },
      {
        type: 'tool_calls',
        tools: [{ id: '2', name: 'str_replace', mutating: true }],
      },
      {
        type: 'tool_results',
        results: [{ id: '2', name: 'str_replace', exitCode: 0 }],
      },
      { type: 'complete', verified: true },
    ];

    // "Stream" and "non-stream" surfaces feed the same event sequence.
    const streamState = foldAgentLoop(events, 'fix bug in foo.ts');
    const nonStreamState = foldAgentLoop([...events], 'fix bug in foo.ts');

    assert.equal(streamState.outcome, 'VERIFIED_COMPLETE');
    assert.equal(nonStreamState.outcome, streamState.outcome);
    assert.equal(nonStreamState.phase, streamState.phase);
    assert.equal(nonStreamState.terminal, true);
    assert.deepEqual(
      { ...streamState, reason: streamState.reason },
      { ...nonStreamState, reason: nonStreamState.reason },
    );
  });

  test('write→read order preserved by batch planner', () => {
    const actions: OrderedToolAction[] = [
      { index: 0, name: 'write_file', mutating: true, readOnly: false },
      { index: 1, name: 'read_file', mutating: false, readOnly: true },
      { index: 2, name: 'run_command', mutating: true, readOnly: false },
      { index: 3, name: 'grep', mutating: false, readOnly: true },
      { index: 4, name: 'read_file', mutating: false, readOnly: true },
    ];
    const plan = planToolBatches(actions);
    assert.ok(preservesToolOrder(actions, plan));
    const flat = flattenBatchPlan(plan);
    // Write at 0 must execute before read at 1 (not all-reads-first).
    assert.ok(flat.indexOf(0) < flat.indexOf(1));
    assert.ok(flat.indexOf(2) < flat.indexOf(3));
    // Consecutive reads 3,4 may be one parallel batch.
    const lastBatch = plan[plan.length - 1]!;
    assert.equal(lastBatch.kind, 'parallel_reads');
    if (lastBatch.kind === 'parallel_reads') {
      assert.deepEqual(lastBatch.indices, [3, 4]);
    }
  });

  test('circuit breaker terminal stops loop immediately', () => {
    let state = initialAgentLoopState('task');
    state = reduceAgentLoop(state, { type: 'user_turn', task: 'task' }).state;
    state = reduceAgentLoop(state, {
      type: 'circuit_breaker',
      reason: '5 consecutive policy blocks',
    }).state;
    assert.equal(state.terminal, true);
    assert.equal(state.outcome, 'BLOCKED_POLICY');
    // Further events ignored
    state = reduceAgentLoop(state, { type: 'complete', verified: true }).state;
    assert.equal(state.outcome, 'BLOCKED_POLICY');
  });

  test('at most one policy intervention per cycle', () => {
    let state = initialAgentLoopState('t');
    state = reduceAgentLoop(state, { type: 'user_turn', task: 't' }).state;
    const r1 = reduceAgentLoop(state, {
      type: 'policy_decision',
      intervention: 'force_mutate',
    });
    assert.equal(r1.effects.length, 1);
    state = r1.state;
    const r2 = reduceAgentLoop(state, {
      type: 'policy_decision',
      intervention: 'read_thrash',
    });
    assert.equal(r2.effects.length, 0);
    assert.equal(r2.state.policyInterventionThisCycle, 'force_mutate');
  });
});

// ─── (c) str_replace uses governed mutation path ────────────────────────────

describe('P1-A governed str_replace', () => {
  test('mutation path not bypassed — file written via policy gate', async () => {
    resetCircuitBreaker();
    const dir = mkdtempSync(join(tmpdir(), 'babel-gov-mut-'));
    try {
      const file = join(dir, 'sample.ts');
      writeFileSync(file, 'const x = 1;\n', 'utf-8');
      const result = await governedStrReplace(
        { file_path: 'sample.ts', old_str: 'const x = 1;', new_str: 'const x = 2;' },
        {
          projectRoot: dir,
          context: {
            agentId: 'test',
            runId: `gov-${Date.now()}`,
            runDir: dir,
            babelRoot: dir,
          },
          preset: 'workspace_write',
        },
      );
      assert.equal(result.exit_code, 0, result.observation);
      assert.equal(result.policyBlocked, false);
      const body = readFileSync(file, 'utf-8');
      assert.match(body, /const x = 2/);
      assert.match(result.observation, /str_replace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('governed str_replace honors BABEL_DRY_RUN (does not clear it)', async () => {
    resetCircuitBreaker();
    const dir = mkdtempSync(join(tmpdir(), 'babel-gov-dry-'));
    const prevDry = process.env['BABEL_DRY_RUN'];
    process.env['BABEL_DRY_RUN'] = '1';
    try {
      writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n', 'utf-8');
      await governedStrReplace(
        { file_path: 'a.ts', old_str: 'const a = 1;', new_str: 'const a = 2;' },
        {
          projectRoot: dir,
          context: {
            agentId: 'test',
            runId: `dry-${Date.now()}`,
            runDir: dir,
            babelRoot: dir,
          },
          preset: 'workspace_write',
        },
      );
      // Env must still be set after the call (never cleared by governed path).
      assert.equal(process.env['BABEL_DRY_RUN'], '1');
    } finally {
      if (prevDry === undefined) delete process.env['BABEL_DRY_RUN'];
      else process.env['BABEL_DRY_RUN'] = prevDry;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('read_only preset blocks str_replace mutation', async () => {
    resetCircuitBreaker();
    const dir = mkdtempSync(join(tmpdir(), 'babel-gov-deny-'));
    try {
      writeFileSync(join(dir, 'a.ts'), 'a', 'utf-8');
      const result = await governedStrReplace(
        { file_path: 'a.ts', old_str: 'a', new_str: 'b' },
        {
          projectRoot: dir,
          context: {
            agentId: 'test',
            runId: `deny-${Date.now()}`,
            runDir: dir,
            babelRoot: dir,
          },
          preset: 'read_only',
        },
      );
      assert.equal(result.policyBlocked, true);
      assert.equal(readFileSync(join(dir, 'a.ts'), 'utf-8'), 'a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── (d) localization-as-progress / same-target-read no-progress ─────────────

describe('P1-B progress receipts', () => {
  test('localization counts as progress; same-target unchanged read does not', () => {
    const ledger = createProgressLedger();
    const r1 = recordProgressCycle(ledger, {
      at_turn: 0,
      localizedPaths: ['src/foo.ts'],
      reads: [{ path: 'src/foo.ts', contentHash: 'abc' }],
    });
    assert.equal(r1.hasDelta, true);
    assert.ok(r1.deltas.includes('localization'));

    const r2 = recordProgressCycle(ledger, {
      at_turn: 1,
      reads: [{ path: 'src/foo.ts', contentHash: 'abc' }],
    });
    assert.equal(r2.hasDelta, false);
    assert.ok(r2.deltas.includes('no_progress'));
    assert.equal(r2.noProgressReason, 'repeated_unchanged_reads');
  });

  test('failed patch + changed hypothesis resets stall', () => {
    const ledger = createProgressLedger();
    recordProgressCycle(ledger, {
      at_turn: 0,
      patchAttempted: true,
      patchFailed: true,
    });
    // Force no-progress streak
    recordProgressCycle(ledger, { at_turn: 1 });
    recordProgressCycle(ledger, { at_turn: 2 });
    assert.ok(ledger.consecutiveNoProgress >= 1);

    const afterHyp = recordProgressCycle(ledger, {
      at_turn: 3,
      hypothesisKey: 'bug-is-in-bar',
      patchFailed: false,
    });
    assert.equal(afterHyp.hasDelta, true);
    assert.equal(ledger.consecutiveNoProgress, 0);
  });

  test('scoreProgressIntervention prefers recovery over kill-by-proxy', () => {
    const ledger = createProgressLedger();
    for (let i = 0; i < 6; i++) {
      recordProgressCycle(ledger, { at_turn: i });
    }
    const mid = scoreProgressIntervention(ledger, { recoveryAlreadyTried: false });
    assert.equal(mid.action, 'recover');

    for (let i = 0; i < 5; i++) {
      recordProgressCycle(ledger, { at_turn: 10 + i });
    }
    const term = scoreProgressIntervention(ledger, { recoveryAlreadyTried: true });
    assert.equal(term.action, 'terminal');
  });

  test('policy precedence table is human-readable and ordered', () => {
    assert.ok(policyPrecedenceRank('hard_ceiling') < policyPrecedenceRank('force_mutate'));
    assert.ok(policyPrecedenceRank('progress_nudge') < policyPrecedenceRank('zero_write'));
    const table = formatPolicyPrecedenceTable();
    assert.match(table, /Policy precedence/);
    assert.ok(POLICY_PRECEDENCE.includes('hard_ceiling'));

    const winner = arbitratePolicy([
      { source: 'force_mutate', action: 'nudge', message: 'mutate' },
      { source: 'hard_ceiling', action: 'terminal', message: 'budget' },
      { source: 'read_thrash', action: 'nudge', message: 'thrash' },
    ]);
    assert.equal(winner?.source, 'hard_ceiling');
  });
});

// ─── (e) resume restores tool results without re-call ───────────────────────

describe('P1-C durable event log resume', () => {
  test('resume rebuilds provider messages including tool results', () => {
    const log = createThreadEventLog('thread-resume-1');
    const turnId = startTurn(log, {
      task: 'edit bar.ts',
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      projectRoot: 'C:/proj',
      policyPreset: 'workspace_write',
    });
    recordAssistantToolCalls(log, turnId, 'Reading…', [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"bar.ts"}' },
      },
    ]);
    recordToolResult(log, turnId, {
      tool_call_id: 'call_1',
      tool_name: 'read_file',
      content: 'export const bar = 1;',
      exit_code: 0,
    });
    endTurn(log, turnId, 'BLOCKED_POLICY', 'blocked');

    const messages = rebuildProviderMessagesFromEvents(log, {
      systemPrompt: 'You are Babel.',
    });
    assert.equal(messages[0]?.role, 'system');
    assert.ok(messages.some((m) => m.role === 'user' && m.content.includes('edit bar')));
    const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistant?.tool_calls?.[0]?.id === 'call_1');
    const tool = messages.find((m) => m.role === 'tool');
    assert.equal(tool?.tool_call_id, 'call_1');
    assert.match(tool?.content ?? '', /export const bar/);

    // Partial/blocked turn retained outcome
    const snap = latestTurnSnapshot(log);
    assert.equal(snap?.outcome, 'BLOCKED_POLICY');
    assert.equal(snap?.model, 'deepseek-v4-pro');
  });

  test('event log is versioned and round-trips', () => {
    const log = createThreadEventLog();
    startTurn(log, {
      task: 't',
      model: 'm',
      provider: 'p',
      projectRoot: '/r',
      policyPreset: 'workspace_write',
    });
    const raw = serializeThreadEventLog(log);
    const parsed = parseThreadEventLog(raw);
    assert.equal(parsed.schema_version, THREAD_EVENT_LOG_VERSION);
    assert.equal(parsed.events.length, log.events.length);
  });

  test('repo identity mismatch requires confirm on resume', () => {
    const log = createThreadEventLog();
    startTurn(log, {
      task: 't',
      model: 'm',
      provider: 'p',
      projectRoot: 'C:/old-root',
      policyPreset: 'workspace_write',
    });
    const check = validateRepoIdentityOnResume(log, 'C:/new-root');
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.match(check.reason, /root changed/i);
    }
  });
});

// ─── (f) approval deny / allow_once / session ───────────────────────────────

describe('P1-D scoped approvals', () => {
  test('deny / allow_once / allow_session decisions', () => {
    const state = createApprovalSession('t1');
    const req = buildApprovalRequest({
      thread_id: 't1',
      turn_id: 'turn1',
      command: 'npm install lodash',
      cwd: '/proj',
      capability: 'install',
      reason: 'policy denied install',
    });
    assert.equal(inferCapabilityFromCommand(req.command), 'install');

    const denied = applyApprovalDecision(state, req, 'deny');
    assert.equal(denied.decision, 'deny');
    assert.equal(isPreApproved(state, req), false);

    const once = applyApprovalDecision(state, req, 'allow_once');
    assert.equal(once.decision, 'allow_once');
    // allow_once does not persist
    assert.equal(isPreApproved(state, req), false);

    const session = applyApprovalDecision(state, req, 'allow_session');
    assert.equal(session.decision, 'allow_session');
    assert.equal(isPreApproved(state, req), true);
  });

  test('headless fails truthfully when approval cannot be surfaced', () => {
    const state = createApprovalSession('headless');
    const req = buildApprovalRequest({
      thread_id: 'headless',
      turn_id: 't',
      command: 'curl https://evil.example',
      cwd: '/proj',
      capability: 'network',
      reason: 'network',
    });
    const res = resolveApprovalHeadless(state, req);
    assert.equal(res.decision, 'deny');
  });

  test('subagent cannot exceed parent permission scope', () => {
    const parent = createApprovalSession('parent', ['shell', 'write']);
    const child = deriveSubagentApprovalSession(parent, 'child', [
      'shell',
      'write',
      'network',
    ]);
    assert.ok(!child.parentScopeCeiling.includes('network'));
    const req = buildApprovalRequest({
      thread_id: 'child',
      turn_id: 't',
      command: 'curl x',
      cwd: '/',
      capability: 'network',
      reason: 'net',
    });
    const res = applyApprovalDecision(child, req, 'allow_session');
    assert.equal(res.decision, 'deny');
  });

  test('approval rules do not over-match via bare substring', () => {
    const state = createApprovalSession('rules');
    const evil = buildApprovalRequest({
      thread_id: 'rules',
      turn_id: 't',
      command: 'npm-cache-evil purge',
      cwd: '/',
      capability: 'shell',
      reason: 'test',
      proposed_scope: 'shell:npm-cache-evil',
    });
    applyApprovalDecision(state, evil, 'narrow_rule', 'npm');
    // "npm" must not pre-approve "npm-cache-evil" via substring
    assert.equal(isPreApproved(state, evil), false);
    assert.equal(
      ruleMatchesRequest('npm', {
        ...evil,
        command: 'npm install lodash',
        proposed_scope: 'install:npm',
      }),
      true,
    );
  });

  test('subagent inherits only ceiling-safe rules', () => {
    const parent = createApprovalSession('parent', [
      'shell',
      'write',
      'network',
      'install',
    ]);
    parent.rules.push('curl https://registry.npmjs.org/*', 'npm test');
    const child = deriveSubagentApprovalSession(parent, 'child', ['shell', 'write']);
    assert.ok(!child.rules.some((r) => /curl/i.test(r)));
    assert.ok(child.rules.some((r) => /npm test/i.test(r)));
  });
});

// ─── (g) context budget formula + no conflicting DeepSeek hard-code ─────────

describe('P1-E provider capabilities', () => {
  test('context budget formula and DeepSeek window', () => {
    const budget = computeContextBudget({
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      toolSchemaReserve: 4_096,
      safetyMargin: 1_024,
    });
    assert.equal(budget.contextBudget, 128_000 - 8_192 - 4_096 - 1_024);

    const caps = resolveProviderCapabilities('deepseek-v4-pro');
    assert.equal(caps.contextWindow, 128_000);
    assert.notEqual(caps.contextWindow, 1_000_000);

    const bar = getContextLimit('deepseek-v4-pro');
    assert.equal(bar.tokens, 128_000);

    assert.equal(shouldCompactByTokens(budget.contextBudget + 1, 'deepseek-v4-pro'), true);
    assert.equal(shouldCompactByTokens(100, 'deepseek-v4-pro'), false);
  });

  test('Pro→Flash failover preserves non-verification flag', () => {
    const d = decideProToFlashFailover(
      'deepseek-v4-pro',
      new Error('429 rate limit exceeded'),
    );
    assert.ok(d);
    assert.equal(d!.toModel, 'deepseek-v4-flash');
    assert.equal(d!.countsAsVerification, false);
    assert.match(d!.reason, /failing over/i);

    const capsule = buildCompactionCapsule({
      task: 'fix x',
      progressSummary: 'localized foo',
      recentToolResults: ['read_file foo'],
    });
    const text = formatCompactionCapsule(capsule);
    assert.match(text, /fix x/);
    assert.match(text, /localized foo/);
  });
});

// ─── (h) chat manifest hash recorded ────────────────────────────────────────

describe('P2-A compiled chat stack', () => {
  test('chat compile records selected entries + manifest hash; excludes deep stages', () => {
    const root = process.cwd().includes('babel-cli')
      ? join(process.cwd(), '..')
      : process.cwd();
    const stack = compileChatStack({
      projectRoot: root,
      babelRoot: root,
      task: 'fix the CLI argument parser',
      modelId: 'deepseek-v4-pro',
    });
    assert.ok(stack.manifest_hash.length >= 16);
    assert.ok(stack.selected_entries.length >= 3);
    assert.equal(stack.deep_stages_excluded, true);
    assert.ok(chatStackExcludesDeepStages(stack));
    assert.ok(stack.selected_entries.some((e) => e.layer === 'safety'));
    assert.ok(stack.selected_entries.some((e) => e.layer === 'provider'));
    assert.ok(stack.system_context.length > 50);

    // Catalog-ish path change alters hash
    const h1 = chatManifestHashForPaths(stack.selected_entries);
    const h2 = chatManifestHashForPaths([
      ...stack.selected_entries,
      { id: 'extra', layer: 'skill', path: '/new' },
    ]);
    assert.notEqual(h1, h2);

    // Entry point used by chat runs
    const viaCore = compileChatStackForRun({
      projectRoot: root,
      task: 'add a unit test',
      model: 'deepseek-v4-flash',
    });
    assert.ok(viaCore.manifest_hash);
    assert.equal(viaCore.deep_stages_excluded, true);
  });
});

// ─── P2-B input arbiter ─────────────────────────────────────────────────────

describe('P2-B input arbiter modes', () => {
  test('single stdin owner; first Ctrl+C cancels, second exits', () => {
    let s = initialInputArbiterState();
    assert.deepEqual(activeStdinOwners(s), ['prompt']);

    let r = reduceInputArbiter(s, { type: 'run_started' });
    s = r.state;
    assert.equal(s.mode, 'running');
    assert.deepEqual(activeStdinOwners(s), ['running']);

    r = reduceInputArbiter(s, { type: 'ctrl_c' });
    s = r.state;
    assert.ok(r.effects.some((e) => e.type === 'cancel_turn'));
    assert.equal(s.cancelArmed, true);

    r = reduceInputArbiter(s, { type: 'ctrl_c' });
    assert.ok(r.effects.some((e) => e.type === 'exit_process'));

    const wired = wiredFooterShortcuts();
    assert.ok(wired.some((w) => w.key === 'Ctrl+C'));
    // Escape is host/REPL-owned — not claimed as engine-wired.
    assert.ok(!wired.some((w) => w.key === 'Escape'));
  });
});
