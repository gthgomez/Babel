/**
 * Production-path regressions for the remaining PR #185 Chat defects.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { runWithProjectRoot } from '../localTools.js';
import type { ToolStreamEvent } from '../runners/base.js';

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
    assert.equal(result.status, 'failed');
    assert.equal(result.outcome, 'INFRA_FAILURE');
    assert.match(result.answer, /finish_reason: length/);
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
    assert.match(seen, /Focus on src\/index\.ts/);
  });

  it('overlapping project roots stay bound to their declared root', async () => {
    const a = mkdtempSync(join(tmpdir(), 'babel-root-a-'));
    const b = mkdtempSync(join(tmpdir(), 'babel-root-b-'));
    writeFileSync(join(a, 'sentinel.txt'), 'A');
    writeFileSync(join(b, 'sentinel.txt'), 'B');
    try {
      const seen: string[] = [];
      await Promise.all([
        runWithProjectRoot(a, async () => {
          await new Promise((r) => setTimeout(r, 20));
          const { readFileSync } = await import('node:fs');
          const { join: j } = await import('node:path');
          seen.push(readFileSync(j(a, 'sentinel.txt'), 'utf8'));
        }),
        runWithProjectRoot(b, async () => {
          await new Promise((r) => setTimeout(r, 5));
          const { readFileSync } = await import('node:fs');
          const { join: j } = await import('node:path');
          seen.push(readFileSync(j(b, 'sentinel.txt'), 'utf8'));
        }),
      ]);
      assert.deepEqual(seen.sort(), ['A', 'B']);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
