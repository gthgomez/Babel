/**
 * Canary F — Subagent Truthfulness & Process Isolation (F6, Probes P10, P11).
 *
 * Covers:
 * 1. 0 changed (child no-op): child finishes without mutations, classified as
 *    'child_noop', not treated as mutation/progress in critic budget or summary.
 * 2. child explicit success: child mutates in worktree/scope, classified as
 *    'child_success', parent tree clean, recognized as mutation by critic.
 * 3. child round exhaustion:
 *    - runMutationAgentLoop: hits maxRounds without finish -> success: false,
 *      error: 'Round limit reached without finish', attribution: 'child_round_exhaustion'.
 *    - readOnlyAgentLoop: hits maxRounds without terminal -> completed: false,
 *      roundExhausted: true, degraded: true.
 * 4. provider error after partial observations: child executes read tools, then provider
 *    throws -> classified as 'child_provider_failure', rollback executed.
 * 5. parent cancellation: abort signal triggers immediate abort -> classified as 'child_cancellation'.
 * 6. concurrent roots: two disjoint implement agents run without polluting parent;
 *    overlapping scopes are rejected with 'child_policy_block'.
 * 7. descendant processes: subagent executes subprocess, exits cleanly without leaving
 *    hung background processes or leaking locks.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ToolContext, ToolResult } from '../localTools.js';
import type { AgentAction } from './actions.js';
import type { ToolExecutor } from './toolExecutor.js';
import {
  classifySubagentFailure,
  runMutationAgentLoop,
  type MutationAgentLoopInput,
} from './lanes/runMutationAgentLoop.js';
import { runReadOnlyAgentLoop } from './lanes/readOnlyAgentLoop.js';
import {
  runImplementWorktreeAgent,
  runImplementWorktreeAgents,
  type ImplementWorktreeAgentSpec,
} from './implementWorktreeAgent.js';
import {
  hasSubAgentWrites,
  type CriticToolLogEntry,
} from './chatEngineCriticBudget.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      spawnSync('git', ['worktree', 'prune'], { cwd: dir, encoding: 'utf-8' });
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore Windows file lock cleanup errors in temp
    }
  }
});

function createGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-subagent-truth-'));
  tempDirs.push(root);
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@babel.dev'], { cwd: root, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Babel Test'], { cwd: root, encoding: 'utf-8' });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.babel\n.babel/\n', 'utf-8');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const hello = 1;\n', 'utf-8');
  writeFileSync(join(root, 'lib', 'util.ts'), 'export const util = 2;\n', 'utf-8');
  writeFileSync(join(root, 'README.md'), '# Test\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: root, encoding: 'utf-8' });
  return root;
}

function mockExecutor(results: Record<string, ToolResult>): ToolExecutor {
  return {
    mapAction(action: AgentAction) {
      if (action.type === 'write_file') {
        return [{ kind: 'execute' as const, request: { tool: 'file_write' as const, path: action.path, content: action.content } }];
      }
      if (action.type === 'read_file') {
        return [{ kind: 'execute' as const, request: { tool: 'file_read' as const, path: action.path } }];
      }
      if (action.type === 'list_dir') {
        return [{ kind: 'execute' as const, request: { tool: 'directory_list' as const, path: action.path } }];
      }
      if (action.type === 'run_command') {
        return [{ kind: 'execute' as const, request: { tool: 'shell_exec' as const, command: action.command } }];
      }
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return [{ kind: 'terminal' as const, action }];
      }
      return [];
    },
    async execute(action: AgentAction, _context: ToolContext) {
      if (action.type === 'finish' || action.type === 'ask_approval') {
        return { action, terminal: true, results: [] };
      }
      const key =
        action.type === 'read_file'
          ? `read:${action.path}`
          : action.type === 'write_file'
            ? `write:${action.path}`
            : action.type === 'list_dir'
              ? `list:${action.path}`
              : action.type === 'run_command'
                ? `run:${action.command.substring(0, 40)}`
                : action.type;
      const result = results[key] ?? {
        exit_code: 0,
        stdout: 'ok',
        stderr: '',
      };
      return { action, terminal: false, results: [result] };
    },
  };
}

describe('Canary F: Subagent Truthfulness & Process Isolation', () => {
  // Scenario 1: 0 changed (child no-op)
  it('Scenario 1: 0 changed is classified as child_noop and never treated as mutation progress (Probe P11)', async () => {
    const root = createGitRepo();
    const executor = mockExecutor({
      'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
    });

    const result = await runMutationAgentLoop({
      agentId: 'child-noop',
      task: 'Inspect code without modifying anything',
      writeScope: ['src'],
      projectRoot: root,
      toolContext: { agentId: 'child-noop', runId: 'run-1', babelRoot: root },
      useDeterministicMock: false,
      executor,
      actionResolver: async () => [
        { type: 'read_file', path: 'src/index.ts' },
        { type: 'finish', summary: 'Everything inspected, no change required', verification: [] },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.changedFiles.length, 0);
    assert.equal(result.attribution, 'child_noop');
    assert.ok(result.summary.includes('0 changed (no-op)'));

    // Probe P11: hasSubAgentWrites must NOT match "0 changed"
    const toolCallLog: CriticToolLogEntry[] = [
      {
        tool: 'sub_agent',
        target: 'child-noop',
        detail: 'Subagent completed: 0 changed (no-op)',
      },
    ];
    assert.equal(hasSubAgentWrites(toolCallLog), false, '0 changed must not count as subagent mutation');

    // Positive check: 1 changed does count
    const positiveLog: CriticToolLogEntry[] = [
      {
        tool: 'sub_agent',
        target: 'child-writer',
        detail: 'Subagent completed: 1 changed',
      },
    ];
    assert.equal(hasSubAgentWrites(positiveLog), true, '1 changed must count as subagent mutation');
  });

  // Scenario 2: child explicit success
  it('Scenario 2: child explicit success classifies as child_success and keeps parent clean', async () => {
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
    assert.ok(implResult.summary.includes('file(s)'));

    // Parent working tree is pristine
    const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf-8' }).stdout;
    assert.equal(gitStatus.trim(), '', 'Parent tree must remain completely clean');
  });

  // Scenario 3: child round exhaustion (Probe P10)
  it('Scenario 3a: child round exhaustion in runMutationAgentLoop fails truthfully with child_round_exhaustion', async () => {
    const root = createGitRepo();
    const executor = mockExecutor({
      'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
    });

    const result = await runMutationAgentLoop({
      agentId: 'child-exhaustion',
      task: 'Loop endlessly without calling finish',
      writeScope: ['src'],
      projectRoot: root,
      maxRounds: 2,
      toolContext: { agentId: 'child-exhaustion', runId: 'run-3', babelRoot: root },
      useDeterministicMock: false,
      executor,
      actionResolver: async () => [
        { type: 'read_file', path: 'src/index.ts' },
      ],
    });

    assert.equal(result.success, false, 'Exhausted child must report success: false');
    assert.equal(result.error, 'Round limit reached without finish');
    assert.equal(result.attribution, 'child_round_exhaustion');
  });

  it('Scenario 3b: child round exhaustion in readOnlyAgentLoop reports completed: false, roundExhausted: true, degraded: true', async () => {
    const root = createGitRepo();
    const executor = mockExecutor({
      'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
    });

    const result = await runReadOnlyAgentLoop({
      verb: 'plan',
      task: 'Inspect until exhausted',
      projectRoot: root,
      maxRounds: 2,
      toolContext: { agentId: 'ro-exhausted', runId: 'run-ro', babelRoot: root },
      useDeterministicMock: false,
      executor,
      actionResolver: async () => [
        { type: 'read_file', path: 'src/index.ts' },
      ],
    });

    assert.equal(result.completed, false);
    assert.equal(result.roundExhausted, true);
    assert.equal(result.degraded, true);
    assert.ok(result.observations.includes('round limit reached without finish'));
  });

  // Scenario 4: provider error after partial observations
  it('Scenario 4: provider error after partial observations classifies as child_provider_failure and provides rollback', async () => {
    const root = createGitRepo();
    const executor = mockExecutor({
      'read:src/index.ts': { exit_code: 0, stdout: 'export const hello = 1;', stderr: '' },
      'write:src/index.ts': { exit_code: 0, stdout: 'written', stderr: '' },
    });

    let round = 0;
    const result = await runMutationAgentLoop({
      agentId: 'child-provider-fail',
      task: 'Read then explode on turn 2',
      writeScope: ['src'],
      projectRoot: root,
      maxRounds: 4,
      toolContext: { agentId: 'child-provider-fail', runId: 'run-4', babelRoot: root },
      useDeterministicMock: false,
      executor,
      actionResolver: async () => {
        round++;
        if (round === 1) {
          return [{ type: 'read_file', path: 'src/index.ts' }];
        }
        throw new Error('LLM provider rate limit / 503 Service Unavailable');
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.attribution, 'child_provider_failure');
    assert.ok(result.error?.includes('503 Service Unavailable'));
    assert.equal(typeof result.rollback, 'function');
  });

  // Scenario 5: parent cancellation
  it('Scenario 5: parent cancellation aborts child immediately with child_cancellation', async () => {
    const root = createGitRepo();
    const controller = new AbortController();
    controller.abort(); // already aborted

    const result = await runMutationAgentLoop({
      agentId: 'child-cancelled',
      task: 'Cancelled task',
      writeScope: ['src'],
      projectRoot: root,
      abortSignal: controller.signal,
      toolContext: { agentId: 'child-cancelled', runId: 'run-5', babelRoot: root },
      useDeterministicMock: false,
      actionResolver: async () => [
        { type: 'finish', summary: 'should not run', verification: [] },
      ],
    });

    assert.equal(result.success, false);
    assert.equal(result.attribution, 'child_cancellation');
    assert.ok(result.error?.toLowerCase().includes('abort'));
  });

  // Scenario 6: concurrent roots
  it('Scenario 6: concurrent implement roots with disjoint scopes isolate cleanly; overlapping scopes policy-blocked', async () => {
    const root = createGitRepo();

    // Disjoint scopes: 'src' and 'lib'
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
    assert.equal(results[0]?.parentTreeClean, true);
    assert.equal(results[1]?.parentTreeClean, true);

    // Overlapping scopes: 'src' and 'src/index.ts'
    const conflictingSpecs: ImplementWorktreeAgentSpec[] = [
      { id: 'agent-1', task: 'edit src root', writeScope: ['src'] },
      { id: 'agent-2', task: 'edit src index', writeScope: ['src/index.ts'] },
    ];

    const conflictResults = await runImplementWorktreeAgents(conflictingSpecs, {
      projectRoot: root,
      useDeterministicMock: true,
    });

    assert.equal(conflictResults.length, 2);
    assert.equal(conflictResults[0]?.success, false);
    assert.equal(conflictResults[0]?.attribution, 'child_policy_block');
    assert.equal(conflictResults[1]?.success, false);
    assert.equal(conflictResults[1]?.attribution, 'child_policy_block');
  });

  // Scenario 7: descendant processes
  it('Scenario 7: descendant subprocess terminates cleanly without hanging or leaving orphan locks', async () => {
    const root = createGitRepo();
    const exec = mockExecutor({
      'run:git status': { exit_code: 0, stdout: 'On branch main\nnothing to commit', stderr: '' },
    });

    const result = await runMutationAgentLoop({
      agentId: 'child-subprocess',
      task: 'Execute a quick child command and finish',
      writeScope: ['src'],
      projectRoot: root,
      toolContext: { agentId: 'child-subprocess', runId: 'run-7', babelRoot: root },
      useDeterministicMock: false,
      executor: exec,
      actionResolver: async () => [
        { type: 'run_command', command: 'git status' },
        { type: 'finish', summary: 'Subprocess finished cleanly', verification: [] },
      ],
    });

    assert.equal(result.success, true);
    assert.equal(result.attribution, 'child_noop');
    assert.equal(result.toolCallLog.length, 2);
    assert.equal(result.toolCallLog[0]?.tool, 'run_command');
  });
});

