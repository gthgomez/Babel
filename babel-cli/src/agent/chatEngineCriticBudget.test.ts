/**
 * C1: pre-completion critic early paths must always leave a skip receipt
 * so harness rollups never report criticVerdict=null after a complete.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildCriticSkipReceipt,
  buildPostWriteRepairMessage,
  computeCriticRepairCostCap,
  computePostWriteRepairWallMs,
  executeCriticWithTimeout,
  hasAnyWrites,
  POST_WRITE_REPAIR_WALL_MAX_MS,
  POST_WRITE_REPAIR_WALL_MIN_MS,
  resolveOrCreateCriticProRunner,
  resolveOrCreateCriticRunner,
  runAsymmetricDiffCritic,
  type AsymmetricCriticState,
  type CriticRunner,
} from './chatEngineCriticBudget.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
import type { RunnerCallbacks } from '../runners/base.js';

const EXACT_GLM_MODEL = 'z-ai/glm-5.3-flash';
const GLM_BACKEND_KEY = 'glm-5.3-flash';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function baseState(
  overrides: Partial<AsymmetricCriticState> = {},
): AsymmetricCriticState {
  const stubRunner = {} as CriticRunner;
  return {
    toolCallLog: [],
    conversation: [],
    projectRoot: process.cwd(),
    task: 'fix a bug',
    lastVerifierReceipt: null,
    lastCriticReceipt: null,
    criticStrikes: 0,
    criticRunner: null,
    criticProRunner: null,
    cancelled: false,
    abortController: new AbortController(),
    turnTimeoutMs: 5_000,
    resolveDeliberationRunner: () => stubRunner,
    trackRunnerUsage: () => {},
    ...overrides,
  };
}

test('critic forwards provider lifecycle callbacks to its isolated runner', async () => {
  let observed = false;
  const runner = {
    executeRaw: async (
      _prompt: string,
      callbacks?: RunnerCallbacks,
    ): Promise<string> => {
      callbacks?.onInvocationPhase?.({
        inference_id: 'critic-inference',
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        phase: 'response_normalized',
      });
      return '{"verdict":"pass","confidence":0.9,"reasons":["ok"]}';
    },
  } as unknown as CriticRunner;

  await executeCriticWithTimeout(
    runner,
    'review this patch',
    undefined,
    {
      cancelled: false,
      abortController: new AbortController(),
      timeoutMs: 5_000,
    },
    {
      onInvocationPhase: () => {
        observed = true;
      },
    },
  );
  assert.equal(observed, true);
});

test('exact GLM critic phases ignore mixed-model overrides and stay on OpenRouter', () => {
  const previousFlash = process.env['BABEL_DIFF_CRITIC_MODEL'];
  const previousPro = process.env['BABEL_DIFF_CRITIC_PRO_MODEL'];
  process.env['BABEL_DIFF_CRITIC_MODEL'] = 'deepseek-v4-flash';
  process.env['BABEL_DIFF_CRITIC_PRO_MODEL'] = 'deepseek-v4-pro';
  try {
    const noFallback = (): CriticRunner => {
      throw new Error('fallback must not be reached for exact GLM');
    };
    const flash = resolveOrCreateCriticRunner(EXACT_GLM_MODEL, null, noFallback);
    const pro = resolveOrCreateCriticProRunner(EXACT_GLM_MODEL, null, noFallback);
    assert.ok(flash.runner instanceof OpenRouterApiRunner);
    assert.ok(pro.runner instanceof OpenRouterApiRunner);
  } finally {
    if (previousFlash === undefined) delete process.env['BABEL_DIFF_CRITIC_MODEL'];
    else process.env['BABEL_DIFF_CRITIC_MODEL'] = previousFlash;
    if (previousPro === undefined) delete process.env['BABEL_DIFF_CRITIC_PRO_MODEL'];
    else process.env['BABEL_DIFF_CRITIC_PRO_MODEL'] = previousPro;
  }
});

test('GLM backend key is normalized to the exact OpenRouter critic route', () => {
  const noFallback = (): CriticRunner => {
    throw new Error('fallback must not be reached for exact GLM');
  };
  const flash = resolveOrCreateCriticRunner(GLM_BACKEND_KEY, null, noFallback);
  const pro = resolveOrCreateCriticProRunner(GLM_BACKEND_KEY, null, noFallback);
  assert.ok(flash.runner instanceof OpenRouterApiRunner);
  assert.ok(pro.runner instanceof OpenRouterApiRunner);
});

describe('buildCriticSkipReceipt', () => {
  test('emits skip verdict with reason codes', () => {
    const r = buildCriticSkipReceipt('no_writes', 'no mutations');
    assert.equal(r.verdict, 'skip');
    assert.equal(r.skippedReason, 'no_writes');
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.reasons, ['no mutations']);
  });
});

describe('computeCriticRepairCostCap', () => {
  test('caps remaining spend to a repair window under session max', () => {
    // Spent $2.00 of $3.00 → remaining $1.00 → window min(0.75, max(0.25, 0.35)) = 0.35
    const r = computeCriticRepairCostCap({ spentUsd: 2.0, sessionMaxCostUsd: 3.0 });
    assert.ok(r.repairWindowUsd > 0);
    assert.ok(r.repairWindowUsd <= 0.75);
    assert.equal(r.capUsd, 2.0 + r.repairWindowUsd);
    assert.ok(r.capUsd <= 3.0);
  });

  test('never exceeds session max when little remaining', () => {
    const r = computeCriticRepairCostCap({ spentUsd: 2.9, sessionMaxCostUsd: 3.0 });
    assert.ok(r.capUsd <= 3.0 + 1e-9);
    assert.ok(r.repairWindowUsd <= 0.1 + 1e-9);
  });

  test('zero remaining leaves cap at session max', () => {
    const r = computeCriticRepairCostCap({ spentUsd: 3.0, sessionMaxCostUsd: 3.0 });
    assert.equal(r.repairWindowUsd, 0);
    assert.equal(r.capUsd, 3.0);
  });
});

describe('computePostWriteRepairWallMs', () => {
  test('caps remaining wall to repair window under session max', () => {
    // elapsed 300s of 600s → remaining 300s → window clamp to [90s, 180s] of 40% = 120s
    const r = computePostWriteRepairWallMs({
      elapsedMs: 300_000,
      sessionMaxWallMs: 600_000,
    });
    assert.ok(r.repairWindowMs >= POST_WRITE_REPAIR_WALL_MIN_MS);
    assert.ok(r.repairWindowMs <= POST_WRITE_REPAIR_WALL_MAX_MS);
    assert.equal(r.capMs, 300_000 + r.repairWindowMs);
    assert.ok(r.capMs <= 600_000);
  });

  test('uses all remaining when under min window', () => {
    const r = computePostWriteRepairWallMs({
      elapsedMs: 550_000,
      sessionMaxWallMs: 600_000,
    });
    assert.equal(r.repairWindowMs, 50_000);
    assert.equal(r.capMs, 600_000);
  });

  test('zero remaining leaves cap at session max', () => {
    const r = computePostWriteRepairWallMs({
      elapsedMs: 600_000,
      sessionMaxWallMs: 600_000,
    });
    assert.equal(r.repairWindowMs, 0);
    assert.equal(r.capMs, 600_000);
  });

  test('buildPostWriteRepairMessage mentions mutate + verify without lockout', () => {
    const msg = buildPostWriteRepairMessage({
      repairWindowSec: 120,
      remainingWallSec: 300,
    });
    assert.match(msg, /post-write repair window/i);
    assert.match(msg, /mutate \+ verify/i);
    assert.match(msg, /Investigation tools/);
  });
});

describe('runAsymmetricDiffCritic early paths (C1)', () => {
  test('confirmed mutation paths count as writes', () => {
    assert.equal(
      hasAnyWrites([
        { tool: 'run_command', target: 'generator', mutation_paths: ['src/generated.ts'] },
      ]),
      true,
    );
    assert.equal(
      hasAnyWrites([
        { tool: 'run_command', target: 'generator', mutation_paths: [] },
      ]),
      false,
    );
  });

  test('non-execute intent sets skip receipt non_execute', async () => {
    const state = baseState();
    const decision = await runAsymmetricDiffCritic(state, 'done', 'explain');
    assert.equal(decision, 'allow');
    assert.ok(state.lastCriticReceipt);
    assert.equal(state.lastCriticReceipt!.verdict, 'skip');
    assert.equal(state.lastCriticReceipt!.skippedReason, 'non_execute');
  });

  test('disabled critic sets skip receipt disabled', async () => {
    const prev = process.env['BABEL_DIFF_CRITIC'];
    const headless = process.env['BABEL_HEADLESS'];
    const ci = process.env['CI'];
    try {
      process.env['BABEL_DIFF_CRITIC'] = '0';
      process.env['BABEL_HEADLESS'] = '1';
      const state = baseState({
        toolCallLog: [{ tool: 'str_replace', target: 'a.py' }],
      });
      const decision = await runAsymmetricDiffCritic(state, 'done', 'execute');
      assert.equal(decision, 'allow');
      assert.equal(state.lastCriticReceipt?.verdict, 'skip');
      assert.equal(state.lastCriticReceipt?.skippedReason, 'disabled');
    } finally {
      restoreEnv('BABEL_DIFF_CRITIC', prev);
      restoreEnv('BABEL_HEADLESS', headless);
      restoreEnv('CI', ci);
    }
  });

  test('no writes sets skip receipt no_writes', async () => {
    const prev = process.env['BABEL_DIFF_CRITIC'];
    try {
      process.env['BABEL_DIFF_CRITIC'] = '1';
      const state = baseState({
        toolCallLog: [
          { tool: 'read_file', target: 'a.py' },
          { tool: 'run_command', target: 'del junk.py' },
        ],
      });
      const decision = await runAsymmetricDiffCritic(state, 'done', 'execute');
      assert.equal(decision, 'allow');
      assert.equal(state.lastCriticReceipt?.verdict, 'skip');
      assert.equal(state.lastCriticReceipt?.skippedReason, 'no_writes');
    } finally {
      restoreEnv('BABEL_DIFF_CRITIC', prev);
    }
  });
});
