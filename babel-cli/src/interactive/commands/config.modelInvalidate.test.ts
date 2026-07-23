import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReplContext } from '../context.js';
import { handleClear, handleMode, handleProject, handleRetarget } from './config.js';

function makeCtx(partial?: Partial<ReplContext>): ReplContext {
  const state: ReplContext['state'] = {
    mode: 'chat',
    router: 'v9',
    costTotals: {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
    },
    turnCount: 0,
    ...(partial?.state ?? {}),
  };
  return {
    chatEngine: { marker: true } as unknown as ReplContext['chatEngine'],
    state,
    saveSessionState: () => {},
    printIdleHeader: () => {},
    verboseMode: false,
    resolveCurrentTarget: () => ({
      targetRoot: process.cwd(),
      source: 'cwd',
      workspaceRoot: process.cwd(),
    }),
    ...partial,
  } as ReplContext;
}

test('handleClear invalidates chatEngine so next turn rebuilds', () => {
  const ctx = makeCtx();
  assert.ok(ctx.chatEngine);
  handleClear(ctx, []);
  assert.equal(ctx.chatEngine, undefined);
});

test('handleProject invalidates chatEngine for next-turn root/model truth', () => {
  const ctx = makeCtx();
  handleProject(ctx, ['some-project']);
  assert.equal(ctx.chatEngine, undefined);
  assert.equal(ctx.state.project, 'some-project');
});

test('handleRetarget invalidates chatEngine so tools use new root next turn', () => {
  const ctx = makeCtx();
  handleRetarget(ctx, [process.cwd()]);
  assert.equal(ctx.chatEngine, undefined);
});

test('operator /mode hard-plan invalidates chatEngine for next turn', () => {
  const ctx = makeCtx();
  handleMode(ctx, ['hard-plan']);
  assert.equal(ctx.chatEngine, undefined);
  assert.equal(ctx.state.operatorMode, 'hard_plan');
});
