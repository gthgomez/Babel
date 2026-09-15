/**
 * F6 — subagent / delegation truthfulness.
 *
 * Distinguishes child success, no-op, round exhaustion, provider failure,
 * timeout, cancellation (including abort-while-active), policy block,
 * environment failure, and two-root isolation. Parent progress helpers
 * must not treat failed/no-op children as mutations.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ToolContext, ToolResult } from '../localTools.js';
import type { AgentAction } from './actions.js';
import { hasSubAgentWrites } from './chatEngineCriticBudget.js';
import {
  runImplementWorktreeAgent,
  runImplementWorktreeAgents,
  type ImplementWorktreeAgentSpec,
} from './implementWorktreeAgent.js';
import { runReadOnlyAgentLoop } from './lanes/readOnlyAgentLoop.js';
import {
  classifySubagentFailure,
  runMutationAgentLoop,
  subagentCountsAsMutation,
  subagentFinishedCleanly,
  type SubagentAttribution,
} from './lanes/runMutationAgentLoop.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf-8' });
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function createGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-f6-sub-'));
  tempRoots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'babel-test@example.com']);
  git(root, ['config', 'user.name', 'Babel Test']);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const hello = 1;\n', 'utf-8');
  writeFileSync(join(root, 'lib', 'util.ts'), 'export const util = 1;\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function toolContext(root: string, id: string): ToolContext {
  return {
    agentId: id,
    runId: `run-${id}`,
    babelRoot: root,
  };
}

type MockResults = Record<string, ToolResult>;

function mockExecutor(results: MockResults): import('./toolExecutor.js').ToolExecutor {
  return {
    mapAction(action: AgentAction) {
      if (action.type === 'write_file') {
        return [{ kind: 'execute' as const, request: { tool: 'file_write' as const, path: action.path, content: action.content } }];
      }
      if (action.type === 'read_file') {
        return [{ kind: 'execute' as const, request: { tool: 'file_read' as const, path: action.path } }];
      }
      if (action.type === 'run_command') {
        return [{ kind: 'execute' as const, request: { tool: 'shell_exec' as const, command: action.command } }];
      }
      if (action.type === 'list_dir') {
        return [{ kind: 'execute' as const, request: { tool: 'directory_list' as const, path: action.path } }];
      }
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return [{ kind: 'terminal' as const, action }];
      }
      return [];
    },
    async execute(action: AgentAction) {
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return { action, terminal: true, results: [] };
      }
      const key =
        action.type === 'write_file'
          ? `write:${action.path}`
          : action.type === 'read_file'
            ? `read:${action.path}`
            : action.type === 'run_command'
              ? `run:${action.command}`
              : `${action.type}`;
      const result = results[key] ?? { exit_code: 0, stdout: '', stderr: '' };
      return { action, terminal: false, results: [result] };
    },
  };
}

describe('F6 attribution helpers', () => {
  const matrix: Array<{
    name: string;
    input: Parameters<typeof classifySubagentFailure>[0];
    expected: SubagentAttribution;
  }> = [
    { name: 'success', input: { success: true, error: null, changedFilesCount: 2 }, expected: 'child_success' },
    { name: 'noop', input: { success: true, error: null, changedFilesCount: 0 }, expected: 'child_noop' },
    { name: 'round exhaustion', input: { success: false, error: 'Round limit reached without finish', changedFilesCount: 0 }, expected: 'child_round_exhaustion' },
    { name: 'provider', input: { success: false, error: 'Failed to resolve agent actions: 503 Service Unavailable', changedFilesCount: 0 }, expected: 'child_provider_failure' },
    { name: 'timeout', input: { success: false, error: 'Child timed out after 20ms', changedFilesCount: 0 }, expected: 'child_timeout' },
    { name: 'policy', input: { success: false, error: 'Write blocked: "x" is outside write scope', changedFilesCount: 0 }, expected: 'child_policy_block' },
    { name: 'environment', input: { success: false, error: 'Worktree create failed: not a git repo', changedFilesCount: 0 }, expected: 'child_environment_failure' },
    { name: 'cancellation', input: { success: false, error: null, changedFilesCount: 0, aborted: true }, expected: 'child_cancellation' },
    { name: 'cleanup failure', input: { success: false, error: 'worktree_cleanup_failed: EPERM', changedFilesCount: 1 }, expected: 'child_environment_failure' },
  ];

  for (const row of matrix) {
    it(`classifies ${row.name} as ${row.expected}`, () => {
      assert.equal(classifySubagentFailure(row.input), row.expected);
    });
  }

  it('parent progress helpers ignore 0 changed and failed attributions', () => {
    assert.equal(subagentCountsAsMutation('3 steps, 0 changed, attribution=child_noop'), false);
    assert.equal(subagentCountsAsMutation('failed: Round limit reached without finish, attribution=child_round_exhaustion'), false);
    assert.equal(subagentCountsAsMutation('2 steps, 1 changed, attribution=child_success'), true);
    assert.equal(hasSubAgentWrites([{ tool: 'sub_agent', target: 'x', detail: '3 steps, 0 changed' }]), false);
    assert.equal(subagentFinishedCleanly('child_success'), true);
    assert.equal(subagentFinishedCleanly('child_noop'), true);
    assert.equal(subagentFinishedCleanly('child_round_exhaustion'), false);
  });
});

describe('Canary F: Subagent Truthfulness', () => {
  it('Scenario 1: 0 changed is child_noop and never mutation progress', async () => {
    const root = createGitRepo();
    const result = await runMutationAgentLoop({
      agentId: 'child-noop',
      task: 'Inspect code without modifying anything',
      writeScope: ['src'],
      projectRoot: root,
      toolContext: toolContext(root, 'child-noop'),
      useDeterministicMock: false,
      executor: mockExecutor({
        'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
      }),
      actionResolver: async () => [
        { type: 'read_file', path: 'src/index.ts' },
        { type: 'finish', summary: 'Everything inspected, no change required', verification: [] },
      ],
    });
    assert.equal(result.success, true);
    assert.equal(result.changedFiles.length, 0);
    assert.equal(result.attribution, 'child_noop');
    assert.match(result.summary, /0 changed \(no-op\)/);
    assert.equal(
      hasSubAgentWrites([{ tool: 'sub_agent', target: 'child-noop', detail: result.summary }]),
      false,
    );
  });

  it('Scenario 2: child explicit success classifies as child_success', async () => {
    const root = createGitRepo();
    const implResult = await runImplementWorktreeAgent(
      {
        id: 'child-success',
        task: 'Add a new result file',
        writeScope: ['src'],
        maxRounds: 3,
      },
      {
        projectRoot: root,
        useDeterministicMock: true,
        cleanupWorktree: true,
      },
    );
    assert.equal(implResult.success, true);
    assert.equal(implResult.attribution, 'child_success');
    assert.equal(implResult.parentTreeClean, true);
    const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' }).stdout ?? '';
    // Implement runs may leave `.babel/` artifacts; child writes must not dirty tracked parent files.
    assert.equal(
      gitStatus
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith('.babel/') && !line.includes('.babel/'))
        .join(''),
      '',
    );
  });

  it('Scenario 3a: mutation loop round exhaustion is child_round_exhaustion', async () => {
    const root = createGitRepo();
    const result = await runMutationAgentLoop({
      agentId: 'child-exhaustion',
      task: 'Loop endlessly without calling finish',
      writeScope: ['src'],
      projectRoot: root,
      maxRounds: 2,
      toolContext: toolContext(root, 'child-exhaustion'),
      useDeterministicMock: false,
      executor: mockExecutor({
        'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
      }),
      actionResolver: async () => [{ type: 'read_file', path: 'src/index.ts' }],
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Round limit reached without finish');
    assert.equal(result.attribution, 'child_round_exhaustion');
  });

  it('Scenario 3b: read-only round exhaustion reports completed:false roundExhausted:true', async () => {
    const root = createGitRepo();
    const result = await runReadOnlyAgentLoop({
      verb: 'plan',
      task: 'Inspect until exhausted',
      projectRoot: root,
      maxRounds: 2,
      toolContext: toolContext(root, 'ro-exhausted'),
      useDeterministicMock: false,
      executor: mockExecutor({
        'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
      }),
      actionResolver: async () => [{ type: 'read_file', path: 'src/index.ts' }],
    });
    assert.equal(result.completed, false);
    assert.equal(result.roundExhausted, true);
    assert.equal(result.degraded, true);
    assert.match(result.observations, /round limit reached without finish/i);
  });

  it('Scenario 4: provider error after partial observations is child_provider_failure', async () => {
    const root = createGitRepo();
    let round = 0;
    const result = await runMutationAgentLoop({
      agentId: 'child-provider-fail',
      task: 'Read then explode on turn 2',
      writeScope: ['src'],
      projectRoot: root,
      maxRounds: 4,
      toolContext: toolContext(root, 'child-provider-fail'),
      useDeterministicMock: false,
      executor: mockExecutor({
        'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
      }),
      actionResolver: async () => {
        round++;
        if (round === 1) return [{ type: 'read_file', path: 'src/index.ts' }];
        throw new Error('LLM provider rate limit / 503 Service Unavailable');
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.attribution, 'child_provider_failure');
    assert.match(result.error ?? '', /503 Service Unavailable/);
    assert.equal(typeof result.rollback, 'function');
    assert.ok(result.toolCallLog.length >= 1, 'partial observations retained');
  });

  it('Scenario 5a: already-aborted signal is child_cancellation', async () => {
    const root = createGitRepo();
    const controller = new AbortController();
    controller.abort();
    const result = await runMutationAgentLoop({
      agentId: 'child-cancelled',
      task: 'Cancelled task',
      writeScope: ['src'],
      projectRoot: root,
      abortSignal: controller.signal,
      toolContext: toolContext(root, 'child-cancelled'),
      useDeterministicMock: false,
      actionResolver: async () => [
        { type: 'finish', summary: 'should not run', verification: [] },
      ],
    });
    assert.equal(result.success, false);
    assert.equal(result.attribution, 'child_cancellation');
    assert.match(result.error ?? '', /abort/i);
  });

  it('Scenario 5b: parent cancellation WHILE child is executing', async () => {
    const root = createGitRepo();
    const controller = new AbortController();
    const resultPromise = runMutationAgentLoop({
      agentId: 'child-cancel-active',
      task: 'Cancel during resolver wait',
      writeScope: ['src'],
      projectRoot: root,
      abortSignal: controller.signal,
      toolContext: toolContext(root, 'child-cancel-active'),
      useDeterministicMock: false,
      actionResolver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return [{ type: 'finish', summary: 'too late', verification: [] }];
      },
    });
    setTimeout(() => controller.abort(), 40);
    const result = await resultPromise;
    assert.equal(result.success, false);
    assert.equal(result.attribution, 'child_cancellation');
  });

  it('Scenario 5c: child timeout is child_timeout', async () => {
    const root = createGitRepo();
    const result = await runMutationAgentLoop({
      agentId: 'child-timeout',
      task: 'Exceed child timeout',
      writeScope: ['src'],
      projectRoot: root,
      timeoutMs: 25,
      maxRounds: 8,
      toolContext: toolContext(root, 'child-timeout'),
      useDeterministicMock: false,
      actionResolver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return [{ type: 'read_file', path: 'src/index.ts' }];
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.attribution, 'child_timeout');
    assert.match(result.error ?? '', /timed out/i);
  });

  it('Scenario 6: two roots isolate; overlapping scopes policy-blocked', async () => {
    const root = createGitRepo();
    const disjointSpecs: ImplementWorktreeAgentSpec[] = [
      { id: 'agent-src', task: 'work on src', writeScope: ['src'] },
      { id: 'agent-lib', task: 'work on lib', writeScope: ['lib'] },
    ];
    const results = await runImplementWorktreeAgents(disjointSpecs, {
      projectRoot: root,
      useDeterministicMock: true,
      cleanupWorktree: true,
    });
    assert.equal(results.length, 2);
    assert.equal(results[0]?.success, true);
    assert.equal(results[0]?.attribution, 'child_success');
    assert.equal(results[1]?.success, true);
    assert.equal(results[1]?.attribution, 'child_success');

    const conflictResults = await runImplementWorktreeAgents(
      [
        { id: 'agent-1', task: 'edit src root', writeScope: ['src'] },
        { id: 'agent-2', task: 'edit src index', writeScope: ['src/index.ts'] },
      ],
      { projectRoot: root, useDeterministicMock: true },
    );
    assert.equal(conflictResults[0]?.success, false);
    assert.equal(conflictResults[0]?.attribution, 'child_policy_block');
    assert.equal(conflictResults[1]?.attribution, 'child_policy_block');
  });
});
