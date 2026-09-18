/**
 * Production-path regressions for the remaining PR #185 Chat defects.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import {
  explicitFiniteCostOverride,
  resolveChatEngineLimits,
  shouldShrinkCostForPostWriteRepair,
} from '../config/chatEngineLimits.js';
import { consumeChatStream } from '../interactive/execution/chatCore.js';
import { classifyReviewCard } from '../ui/reviewCard.js';
import { nativeTurnFromStream, ProviderOutputTruncatedError } from './chatNativeTurn.js';
import { runReadOnlyAgentLoop } from './lanes/readOnlyAgentLoop.js';
import { defaultToolExecutor } from './toolExecutor.js';
import { runWithProjectRoot } from '../localTools.js';
import type { RunnerInvocationMetadata, ToolStreamEvent } from '../runners/base.js';
import { globalCostTracker } from '../services/costTracker.js';
import { chatSessionDir } from '../cli/runsLayout.js';

function installMockRunner(
  engine: ChatEngine,
  runner: {
    executeWithToolsStream: (
      ...args: unknown[]
    ) => AsyncGenerator<ToolStreamEvent, void, undefined>;
    execute?: () => Promise<{ type: string; answer: string }>;
    getLastInvocationMetadata?: () => null;
  },
): void {
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = {
    execute: async () => ({ type: 'completion', answer: 'x' }),
    getLastInvocationMetadata: () => null,
    ...runner,
  };
  anyEngine.synthesisRunner = anyEngine.deliberationRunner;
  anyEngine.shouldUseNativeTools = () => true;
}

describe('PR185 residual Chat runtime repairs', () => {
  const previousCost = process.env['BABEL_CHAT_MAX_COST'];
  let projectRoot: string;

  before(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'babel-astra-residual-'));
    writeFileSync(join(projectRoot, 'hello.txt'), 'hello\n');
    delete process.env['BABEL_CHAT_MAX_COST'];
  });

  after(() => {
    if (previousCost === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
    else process.env['BABEL_CHAT_MAX_COST'] = previousCost;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('native length finishReason is truncation, not a completion proposal', () => {
    assert.throws(
      () =>
        nativeTurnFromStream({
          answerText: 'The first part of an unfinished answer is',
          actions: [],
          finishReason: 'length',
        }),
      ProviderOutputTruncatedError,
    );
    const complete = nativeTurnFromStream({
      answerText: 'done',
      actions: [],
      finishReason: 'stop',
    });
    assert.equal(complete.type, 'completion');
  });

  it('ChatEngine native consumer does not complete a length-truncated stream', async () => {
    const engine = new ChatEngine({
      task: 'answer',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 2,
    });
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        yield { type: 'text_delta', text: 'The first part of an unfinished answer is' };
        yield { type: 'done', finishReason: 'length' };
      },
    });
    const result = await consumeChatStream(engine.submitMessageStream('continue'), null);
    assert.equal(result.status, 'budget_exhausted');
    assert.equal(result.outcome, 'BUDGET_EXHAUSTED');
    assert.match(result.answer, /finish_reason: length/);
    assert.equal(result.runAllowance?.terminatingLimiter, 'tokens');
    assert.equal(result.runAllowance?.terminalClassification, 'limit_tokens');
    assert.equal(classifyReviewCard({ status: result.status, outcome: result.outcome }), 'BUDGET_EXHAUSTED');
    const allowance = JSON.parse(readFileSync(join(result.runDir!, 'run-allowance.json'), 'utf8')) as {
      terminatingLimiter?: string;
      terminalClassification?: string;
    };
    assert.equal(allowance.terminatingLimiter, 'tokens');
    assert.equal(allowance.terminalClassification, 'limit_tokens');
  });

  it('unknown stream failure omits outcome through consumeChatStream', async () => {
    const engine = new ChatEngine({
      task: 'unknown fail',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 2,
    });
    let call = 0;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        call += 1;
        if (call === 1) {
          yield {
            type: 'tool_use',
            id: 'r1',
            name: 'read_file',
            input: { path: 'hello.txt' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'error', message: 'Unclassified persistence boundary failure' };
      },
    });
    const collected: ChatEvent[] = [];
    async function* tee(): AsyncGenerator<ChatEvent, void, undefined> {
      for await (const ev of engine.submitMessageStream('go')) {
        collected.push(ev);
        yield ev;
      }
    }
    const result = await consumeChatStream(tee(), null);
    const failed = collected.find((e) => e.type === 'failed');
    assert.ok(failed);
    if (failed?.type === 'failed') assert.equal(failed.outcome, undefined);
    assert.equal(result.status, 'failed');
    assert.equal(result.outcome, undefined);
    assert.equal(classifyReviewCard({ status: result.status, outcome: result.outcome }), 'UNKNOWN');
  });

  it('preparation does not promote a default cost into an explicit ceiling', () => {
    const initial = resolveChatEngineLimits();
    assert.equal(initial.costBudget?.explicitCostCeiling, false);
    assert.equal(explicitFiniteCostOverride(initial), undefined);
    assert.equal(shouldShrinkCostForPostWriteRepair(initial, 0), true);

    const engine = new ChatEngine({
      task: 'prep',
      projectRoot,
      model: 'deepseek-v4-flash',
    });
    engine.applyTurnPreparation({
      task: 'next task',
      limits: initial,
    });
    engine.applyUserSubmission({ userInput: 'next task' });
    const after = (engine as unknown as { limits: ReturnType<typeof resolveChatEngineLimits> }).limits;
    assert.equal(after.costBudget?.explicitCostCeiling, false);
    assert.equal(shouldShrinkCostForPostWriteRepair(after, 0), true);
    assert.notEqual(after.maxCostUsd, 100);
  });

  it('scopes cost enforcement to fresh tasks and preserves an explicit continuation across resume', () => {
    const runsRoot = mkdtempSync(join(tmpdir(), 'babel-astra-cost-runs-'));
    const previousRuns = process.env['BABEL_RUNS_DIR'];
    const previousTotals = globalCostTracker.getSessionSummary();
    process.env['BABEL_RUNS_DIR'] = runsRoot;
    globalCostTracker.resetSession();
    globalCostTracker.restoreSessionCost({
      totalCostUSD: 2.6,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    });

    try {
      const engine = new ChatEngine({
        task: 'fresh scoped task',
        projectRoot,
        model: 'deepseek-v4-flash',
        maxCostUsd: 0.01,
      });
      const first = engine.applyUserSubmission({ userInput: 'fresh scoped task' });
      const state = engine as unknown as {
        taskCostBaselineUsd: number;
        currentTaskCostUsd: () => number;
        checkBudgets: () => { ok: boolean; limiter?: string };
        getTaskAllowanceSnapshot: () => { taskOwnerId: string } | null;
      };
      assert.equal(state.taskCostBaselineUsd, 2.6);
      assert.equal(state.currentTaskCostUsd(), 0);
      assert.equal(state.checkBudgets().ok, true);

      const firstOwner = state.getTaskAllowanceSnapshot()!.taskOwnerId;
      globalCostTracker.trackUsage('deepseek-v4-flash', 1_000, 2_000, null, null, {
        taskOwnerId: firstOwner,
        chargeId: 'astra-first-small',
      });
      assert.ok(state.currentTaskCostUsd() > 0);
      assert.equal(state.checkBudgets().ok, true);
      globalCostTracker.trackUsage('deepseek-v4-flash', 100_000, 0, null, null, {
        taskOwnerId: firstOwner,
        chargeId: 'astra-first-large',
      });
      assert.equal(state.checkBudgets().ok, false);
      assert.equal(state.checkBudgets().limiter, 'cost');

      const second = engine.applyUserSubmission({ userInput: 'independent scoped task' });
      assert.equal(second.continuedTask, false);
      assert.ok(state.taskCostBaselineUsd > 2.6);
      assert.equal(state.currentTaskCostUsd(), 0);
      assert.equal(state.checkBudgets().ok, true);
      const freshBaseline = state.taskCostBaselineUsd;
      const secondOwner = state.getTaskAllowanceSnapshot()!.taskOwnerId;
      globalCostTracker.trackUsage('deepseek-v4-flash', 1_000, 0, null, null, {
        taskOwnerId: secondOwner,
        chargeId: 'astra-second-small',
      });
      (state as unknown as { persistTaskAllowance: () => void }).persistTaskAllowance();

      const runId = engine.getEngineRunId();
      const resumed = new ChatEngine({
        task: 'resume scoped task',
        projectRoot,
        runId,
        resumeExisting: true,
        model: 'deepseek-v4-flash',
        maxCostUsd: 0.01,
      });
      const continued = resumed.applyUserSubmission({
        userInput: 'continue the independent scoped task',
        continueTask: true,
      });
      const resumedState = resumed as unknown as {
        taskCostBaselineUsd: number;
        currentTaskCostUsd: () => number;
      };
      assert.equal(continued.continuedTask, true);
      assert.equal(resumedState.taskCostBaselineUsd, freshBaseline);
      assert.ok(resumedState.currentTaskCostUsd() > 0);
    } finally {
      globalCostTracker.resetSession();
      globalCostTracker.restoreSessionCost({
        totalCostUSD: previousTotals.totalCostUSD,
        totalInputTokens: previousTotals.totalInputTokens,
        totalOutputTokens: previousTotals.totalOutputTokens,
        totalTokens: previousTotals.totalTokens,
      });
      if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = previousRuns;
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('checkpoints provider usage before turn finalization so restart cannot mint continuation budget', () => {
    const runsRoot = mkdtempSync(join(tmpdir(), 'babel-astra-restart-runs-'));
    const previousRuns = process.env['BABEL_RUNS_DIR'];
    const previousTotals = globalCostTracker.getSessionSummary();
    process.env['BABEL_RUNS_DIR'] = runsRoot;
    globalCostTracker.resetSession();
    try {
      const engine = new ChatEngine({
        task: 'restart-safe scoped task',
        projectRoot,
        model: 'deepseek-v4-flash',
        maxCostUsd: 0.01,
      });
      engine.applyUserSubmission({ userInput: 'restart-safe scoped task' });
      const metadata: RunnerInvocationMetadata = {
        provider: 'deepseek',
        provider_model_id: 'deepseek-v4-flash',
        latency_ms: 0,
        prompt_tokens: 100_000,
        completion_tokens: 0,
        total_tokens: 100_000,
        estimated_cost_usd: null,
      };
      const state = engine as unknown as {
        trackRunnerUsage: (runner: { getLastInvocationMetadata: () => RunnerInvocationMetadata }) => void;
        currentTaskCostUsd: () => number;
      };
      state.trackRunnerUsage({ getLastInvocationMetadata: () => metadata });
      const spentBeforeRestart = state.currentTaskCostUsd();
      assert.ok(spentBeforeRestart > 0);

      const budgetPath = join(chatSessionDir(engine.getEngineRunId()), 'task-budget.json');
      const persistedBudget = JSON.parse(readFileSync(budgetPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(budgetPath, JSON.stringify({ ...persistedBudget, accountingEpoch: 'restarted-process' }));
      globalCostTracker.resetSession();
      globalCostTracker.trackUsage('deepseek-v4-flash', 100_000, 0);
      const resumed = new ChatEngine({
        task: 'restart-safe scoped task',
        projectRoot,
        model: 'deepseek-v4-flash',
        maxCostUsd: 0.02,
      });
      resumed.assignRunId(engine.getEngineRunId());
      const resumedState = resumed as unknown as {
        currentTaskCostUsd: () => number;
        checkBudgets: () => { ok: boolean; limiter?: string };
        renewAllowance: (grant: {
          grantId: string;
          provenance: string;
          costCapUsd: number;
          wallCapMs: number;
          turnCap: number;
        }) => void;
        getTaskAllowanceSnapshot: () => {
          grant: { wallCapMs: number; turnCap: number };
        } | null;
      };
      const continued = resumed.applyUserSubmission({
        userInput: 'continue after restart',
        continueTask: true,
      });
      assert.equal(continued.continuedTask, true);
      assert.ok(Math.abs(resumedState.currentTaskCostUsd() - spentBeforeRestart) < 1e-9);
      assert.equal(resumedState.checkBudgets().ok, false);
      const grant = resumedState.getTaskAllowanceSnapshot()!.grant;
      resumedState.renewAllowance({
        grantId: 'restart-renewal',
        provenance: 'test:explicit-restart-renewal',
        costCapUsd: 0.02,
        wallCapMs: grant.wallCapMs,
        turnCap: grant.turnCap,
      });
      assert.equal(resumedState.checkBudgets().ok, true);
    } finally {
      globalCostTracker.resetSession();
      globalCostTracker.restoreSessionCost({
        totalCostUSD: previousTotals.totalCostUSD,
        totalInputTokens: previousTotals.totalInputTokens,
        totalOutputTokens: previousTotals.totalOutputTokens,
        totalTokens: previousTotals.totalTokens,
      });
      if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = previousRuns;
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('unlimited prepared cost does not clamp to 100 on re-resolution', () => {
    const previous = process.env['BABEL_CHAT_MAX_COST'];
    try {
      process.env['BABEL_CHAT_MAX_COST'] = 'unlimited';
      const initial = resolveChatEngineLimits();
      assert.equal(initial.maxCostUsd, Infinity);
      const engine = new ChatEngine({
        task: 'unlimited',
        projectRoot,
        model: 'deepseek-v4-flash',
      });
      engine.applyTurnPreparation({ task: 'unlimited again', limits: initial });
      engine.applyUserSubmission({ userInput: 'unlimited again' });
      const after = (engine as unknown as { limits: ReturnType<typeof resolveChatEngineLimits> }).limits;
      assert.equal(after.maxCostUsd, Infinity);
      assert.equal(after.costBudget?.explicitCostCeiling, true);
    } finally {
      if (previous === undefined) delete process.env['BABEL_CHAT_MAX_COST'];
      else process.env['BABEL_CHAT_MAX_COST'] = previous;
    }
  });

  it('streaming completion carries runAllowance on the done event and result', async () => {
    const engine = new ChatEngine({
      task: 'hi',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 2,
    });
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        yield { type: 'text_delta', text: 'hello' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    const collected: ChatEvent[] = [];
    async function* tee(): AsyncGenerator<ChatEvent, void, undefined> {
      for await (const ev of engine.submitMessageStream('hi')) {
        collected.push(ev);
        yield ev;
      }
    }
    const result = await consumeChatStream(tee(), null);
    const done = collected.find((e) => e.type === 'done');
    assert.ok(done);
    if (done?.type === 'done') {
      assert.ok(done.runAllowance);
      assert.ok(done.costBudget);
    }
    assert.ok(result.runAllowance);
    assert.ok(result.costBudget);
  });

  it('read-only ask_approval is a permission block, not child_noop', async () => {
    const result = await runReadOnlyAgentLoop({
      verb: 'ask',
      task: 'inspect',
      projectRoot,
      toolContext: {
        agentId: 'child',
        runId: 'run',
        babelRoot: projectRoot,
      },
      maxRounds: 2,
      actionResolver: async () => [
        { type: 'ask_approval', reason: 'Need permission to continue', requested_action: { type: 'list_dir', path: '.' } },
      ],
    });
    assert.equal(result.needsApproval, true);
    assert.equal(result.policyBlocked, true);
    assert.equal(result.completed, true);
    assert.match(result.blockedReason ?? '', /Need permission/);
  });

  it('read-only provider error is retained and is not round exhaustion', async () => {
    const result = await runReadOnlyAgentLoop({
      verb: 'ask',
      task: 'inspect',
      projectRoot,
      toolContext: {
        agentId: 'child',
        runId: 'run',
        babelRoot: projectRoot,
      },
      maxRounds: 1,
      actionResolver: async () => {
        throw new Error('[deepSeekApi] upstream 500');
      },
    });
    assert.equal(result.roundExhausted, false);
    assert.equal(result.providerError, '[deepSeekApi] upstream 500');
    assert.match(result.observations, /Provider error/);
    assert.equal(result.completed, false);
    assert.equal(result.steps.some((step) => step.phase === 'finish'), false);
  });

  it('read-only provider failure after an observation remains incomplete', async () => {
    let round = 0;
    const result = await runReadOnlyAgentLoop({
      verb: 'ask',
      task: 'inspect then fail',
      projectRoot,
      toolContext: {
        agentId: 'child',
        runId: 'run-after-observation',
        babelRoot: projectRoot,
        projectRoot,
      },
      maxRounds: 2,
      executor: defaultToolExecutor,
      actionResolver: async () => {
        round += 1;
        if (round === 1) return [{ type: 'read_file', path: 'hello.txt' }];
        throw new Error('provider failed after observation');
      },
    });
    assert.equal(result.providerError, 'provider failed after observation');
    assert.equal(result.completed, false);
    assert.equal(result.roundExhausted, false);
    assert.ok(result.steps.some((step) => step.phase === 'observe'));
    assert.equal(result.steps.some((step) => step.phase === 'finish'), false);
  });

  it('read-only additional instructions reach the child prompt', async () => {
    let seen = '';
    await runReadOnlyAgentLoop({
      verb: 'ask',
      task: 'inspect',
      projectRoot,
      additionalInstructions: 'Focus on src/index.ts',
      toolContext: {
        agentId: 'child',
        runId: 'run',
        babelRoot: projectRoot,
      },
      maxRounds: 1,
      actionResolver: async (prompt) => {
        seen = prompt;
        return [{ type: 'finish', summary: 'done', verification: [] }];
      },
    });
    assert.equal((seen.match(/Focus on src\/index\.ts/g) ?? []).length, 1);
  });

  it('overlapping project roots stay bound to their declared root', async () => {
    const a = mkdtempSync(join(tmpdir(), 'babel-root-a-'));
    const b = mkdtempSync(join(tmpdir(), 'babel-root-b-'));
    writeFileSync(join(a, 'sentinel.txt'), 'A');
    writeFileSync(join(b, 'sentinel.txt'), 'B');
    try {
      const seen: string[] = [];
      const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
      delete process.env['BABEL_PROJECT_ROOT'];
      try {
        await Promise.all([a, b].map((root, index) => runWithProjectRoot(root, async () => {
          await new Promise((r) => setTimeout(r, index === 0 ? 20 : 5));
          const result = await runReadOnlyAgentLoop({
            verb: 'ask',
            task: 'read sentinel',
            projectRoot: root,
            seedPaths: ['sentinel.txt'],
            toolContext: {
              agentId: `child-${index}`,
              runId: `run-root-${index}`,
              babelRoot: root,
              projectRoot: root,
            },
            maxRounds: 1,
            actionResolver: async () => [{ type: 'read_file', path: 'sentinel.txt' }, { type: 'finish', summary: 'done', verification: [] }],
          });
          const observations = result.steps
            .filter((step) => step.action.type === 'read_file' && step.action.path === 'sentinel.txt')
            .flatMap((step) => step.toolResults)
            .map((toolResult) => toolResult.stdout.trim())
            .at(-1)
            ?.split(/\r?\n/)
            .at(-1)
            ?.replace(/^\d+│/, '');
          seen.push(observations ?? '');
        })));
      } finally {
        if (previousProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
        else process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
      assert.deepEqual(seen.sort(), ['A', 'B']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
