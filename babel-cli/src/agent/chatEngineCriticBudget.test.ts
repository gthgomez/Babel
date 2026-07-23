/**
 * C1: pre-completion critic early paths must always leave a skip receipt
 * so harness rollups never report criticVerdict=null after a complete.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildCriticSkipReceipt,
  runAsymmetricDiffCritic,
  type AsymmetricCriticState,
  type CriticRunner,
} from './chatEngineCriticBudget.js';

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

describe('buildCriticSkipReceipt', () => {
  test('emits skip verdict with reason codes', () => {
    const r = buildCriticSkipReceipt('no_writes', 'no mutations');
    assert.equal(r.verdict, 'skip');
    assert.equal(r.skippedReason, 'no_writes');
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.reasons, ['no mutations']);
  });
});

describe('runAsymmetricDiffCritic early paths (C1)', () => {
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
