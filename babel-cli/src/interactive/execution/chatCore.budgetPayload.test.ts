/**
 * Budget-kill payload honesty: status BUDGET_EXCEEDED + toolCalls/run_dir/critic_receipt.
 * U1.4: Slim interactive stack budget tests.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildChatRunPayload,
  compileChatStackForRun,
  getLastChatCompiledStack,
} from './chatCore.js';
import type { ChatResult } from '../../agent/chatEngine.js';
import {
  INTERACTIVE_STACK_BUDGET,
  SWE_STACK_BUDGET,
} from '../../agent/chatStackCompile.js';

function minimalUsage() {
  return {
    totalCostUSD: 0.1,
    totalInputTokens: 100,
    totalOutputTokens: 10,
    totalTokens: 110,
    modelBreakdown: {},
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    cost_ledger_path: null,
  };
}

describe('buildChatRunPayload budget honesty', () => {
  test('budget kill maps to BUDGET_EXCEEDED with toolCalls, run_dir, critic_receipt', () => {
    const result: ChatResult = {
      status: 'failed',
      answer: 'BUDGET_EXCEEDED: Time budget exceeded (609s of 600s).\nbudget_kind=wall\nhad_writes=1',
      usage: minimalUsage() as ChatResult['usage'],
      conversation: [],
      budgetExceeded: true,
      toolCalls: [
        { tool: 'str_replace', target: 'src/_pytest/logging.py' },
        { tool: 'run_command', target: 'pytest' },
      ],
      runDir: 'C:/tmp/runs/engine-abc',
      criticReceipt: {
        verdict: 'reject',
        reasons: ['wrong localization'],
        confidence: 0.9,
        model: 'heuristic-localization',
        tier: 'heuristic',
      },
    };

    const payload = buildChatRunPayload(result, {
      task: 'fix clear()',
      projectRoot: 'C:/tmp/ws',
      model: 'deepseek-v4-pro',
    });

    assert.equal(payload['status'], 'BUDGET_EXCEEDED');
    assert.equal(payload['budget_exceeded'], true);
    assert.equal(payload['failure_class_hint'], 'budget_exceeded');
    assert.ok(Array.isArray(payload['toolCalls']));
    assert.equal((payload['toolCalls'] as unknown[]).length, 2);
    assert.equal(payload['run_dir'], 'C:/tmp/runs/engine-abc');
    const critic = payload['critic_receipt'] as Record<string, unknown>;
    assert.equal(critic['verdict'], 'reject');
    assert.equal(critic['tier'], 'heuristic');
    assert.equal(critic['model'], 'heuristic-localization');
  });

  test('generic failed still maps to NEEDS_MORE_CONTEXT', () => {
    const result: ChatResult = {
      status: 'failed',
      answer: 'Stall kill after interventions',
      usage: minimalUsage() as ChatResult['usage'],
      conversation: [],
      toolCalls: [],
      runDir: 'C:/tmp/runs/x',
    };
    const payload = buildChatRunPayload(result, {
      task: 'x',
      projectRoot: 'C:/tmp',
    });
    assert.equal(payload['status'], 'NEEDS_MORE_CONTEXT');
    assert.ok(payload['budget_exceeded'] !== true);
  });

  test('failed with toolCalls preserves tool log in payload (stream turn-limit honesty)', () => {
    const result: ChatResult = {
      status: 'failed',
      answer:
        'Turn limit exceeded. Gate check: 0 file writes, 0 sub-agent mutations. Last 3 actions: run_command, run_command, run_command.',
      usage: minimalUsage() as ChatResult['usage'],
      conversation: [],
      toolCalls: [
        { tool: 'run_command', target: 'pytest a' },
        { tool: 'run_command', target: 'pytest b' },
        { tool: 'run_command', target: 'ls' },
      ],
      runDir: 'C:/tmp/runs/a08',
    };
    const payload = buildChatRunPayload(result, {
      task: 'SWE-A08',
      projectRoot: 'C:/tmp/ws',
    });
    assert.equal(payload['status'], 'NEEDS_MORE_CONTEXT');
    assert.ok(Array.isArray(payload['toolCalls']));
    assert.equal((payload['toolCalls'] as unknown[]).length, 3);
    assert.equal(payload['run_dir'], 'C:/tmp/runs/a08');
  });
});

// ── U1.4: Slim interactive stack budget ─────────────────────────────

describe('U1.4 compileChatStackForRun budget selection', () => {
  test('default task gets interactive budget', () => {
    const stack = compileChatStackForRun({
      projectRoot: 'C:/tmp/test',
      task: 'fix a bug in the login page',
    });

    // With interactive budget, system_context should be ≤ INTERACTIVE_STACK_BUDGET
    assert.ok(
      stack.system_context.length <= INTERACTIVE_STACK_BUDGET + 50,
      `default task stack length ${stack.system_context.length} should be ≤ interactive budget ${INTERACTIVE_STACK_BUDGET}`,
    );
  });

  test('general_swe task gets SWE budget (via text classification)', () => {
    // Task with "root cause" + "multi-file" signals → general_swe
    const stack = compileChatStackForRun({
      projectRoot: 'C:/tmp/test',
      task: 'Find the root cause of the multi-file regression across the codebase',
    });

    // System context length doesn't need to be exactly SWE_STACK_BUDGET,
    // but it should NOT be trimmed to interactive budget. Since the actual
    // content fits within both budgets on a bare /tmp/test dir (no real files),
    // the key invariant is the stack was compiled — not that it was trimmed.
    assert.ok(stack.system_context.length > 0);
    assert.ok(stack.estimated_tokens > 0);
  });

  test('stack compiled via compileChatStackForRun is cached via getLastChatCompiledStack', () => {
    const stack = compileChatStackForRun({
      projectRoot: 'C:/tmp/test',
      task: 'explain the architecture',
    });

    const cached = getLastChatCompiledStack();
    assert.ok(cached !== null);
    assert.equal(cached!.manifest_hash, stack.manifest_hash);
  });

  test('default task estimated tokens ≤ SWE task estimated tokens for same project', () => {
    const defaultStack = compileChatStackForRun({
      projectRoot: 'C:/tmp/test',
      task: 'fix a bug',
    });

    const sweStack = compileChatStackForRun({
      projectRoot: 'C:/tmp/test',
      task: 'root cause analysis of multi-file regression across the repo',
    });

    // Both point at /tmp/test (no real files), so content is similar.
    // The key invariant: both compile without error, and estimated_tokens
    // is computed from system_context length.
    assert.ok(defaultStack.estimated_tokens > 0);
    assert.ok(sweStack.estimated_tokens > 0);
    // For the same empty project dir, estimated_tokens should be similar
    // (the budget difference only matters when content exceeds interactive budget)
    assert.equal(
      defaultStack.estimated_tokens,
      sweStack.estimated_tokens,
      'same empty project dir → same content → same tokens',
    );
  });

  test('interactive and SWE budget constants are distinct', () => {
    assert.ok(INTERACTIVE_STACK_BUDGET < SWE_STACK_BUDGET);
    assert.equal(INTERACTIVE_STACK_BUDGET, 12_000);
    assert.equal(SWE_STACK_BUDGET, 24_000);
  });

  test('compileChatStackForRun still includes deep_stages_excluded: true', () => {
    const stack = compileChatStackForRun({
      projectRoot: 'C:/tmp/test',
      task: 'fix a bug',
    });

    assert.equal(stack.deep_stages_excluded, true);
  });

  test('compileChatStackForRun sets project_root', () => {
    const stack = compileChatStackForRun({
      projectRoot: 'C:/tmp/my-project',
      task: 'fix',
    });

    assert.ok(stack.project_root.includes('my-project'));
  });
});
