import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { ToolCallRequest, ToolContext, ToolResult } from '../localTools.js';
import type { AgentAction } from './actions.js';
import {
  createToolExecutor,
  executeActionWithPolicy,
  isTerminalAgentAction,
  mapAgentActionToToolCalls,
  resetCircuitBreaker,
  getCircuitBreakerState,
  validatePatchContent,
  ToolExecutionTimeoutError,
  ToolExecutionCapacityError,
  DEFAULT_TOOL_BUDGET,
} from './toolExecutor.js';

const context: ToolContext = {
  agentId: 'agent-b',
  runId: 'run-b',
  babelRoot: process.cwd(),
};

describe('mapAgentActionToToolCalls', () => {
  it('maps read-only actions to executor read tools', () => {
    assert.deepEqual(mapAgentActionToToolCalls({ type: 'read_file', path: 'src/a.ts' }), [
      { kind: 'execute', request: { tool: 'file_read', path: 'src/a.ts' } },
    ]);
    assert.deepEqual(mapAgentActionToToolCalls({ type: 'list_dir', path: 'src' }), [
      { kind: 'execute', request: { tool: 'directory_list', path: 'src' } },
    ]);
    assert.deepEqual(mapAgentActionToToolCalls({ type: 'search', query: 'small fix' }), [
      { kind: 'execute', request: { tool: 'semantic_search', query: 'small fix' } },
    ]);
    assert.deepEqual(
      mapAgentActionToToolCalls({ type: 'grep', pattern: 'session_loop', path: 'src' }),
      [{ kind: 'execute', request: { tool: 'grep', pattern: 'session_loop', path: 'src' } }],
    );
    assert.deepEqual(mapAgentActionToToolCalls({ type: 'glob', pattern: 'src/**/*.ts' }), [
      { kind: 'execute', request: { tool: 'glob', pattern: 'src/**/*.ts' } },
    ]);
    assert.deepEqual(mapAgentActionToToolCalls({ type: 'git_context', format: 'summary' }), [
      { kind: 'execute', request: { tool: 'git_context', format: 'summary' } },
    ]);
    assert.deepEqual(
      mapAgentActionToToolCalls({
        type: 'test_run',
        command: 'npm test',
        cwd: 'babel-cli',
        timeout_seconds: 120,
      }),
      [
        {
          kind: 'execute',
          request: {
            tool: 'test_run',
            command: 'npm test',
            working_directory: 'babel-cli',
            timeout_seconds: 120,
          },
        },
      ],
    );
  });

  it('maps mutating actions to file_write, patch staging, and shell_exec', () => {
    assert.deepEqual(
      mapAgentActionToToolCalls({ type: 'write_file', path: 'x.txt', content: 'ok' }),
      [{ kind: 'execute', request: { tool: 'file_write', path: 'x.txt', content: 'ok' } }],
    );

    const patchCalls = mapAgentActionToToolCalls({
      type: 'apply_patch',
      patch: '--- a/README.md\n+++ b/README.md\n',
    });
    assert.equal(patchCalls.length, 2);
    assert.equal(patchCalls[0]?.kind, 'execute');
    assert.equal(patchCalls[1]?.kind, 'execute');
    const shellRequest = patchCalls[1];
    assert.equal(shellRequest?.kind, 'execute');
    if (shellRequest?.kind === 'execute' && shellRequest.request.tool === 'shell_exec') {
      // H1: --unsafe-paths must be absent from the generated command
      assert.match(shellRequest.request.command, /git apply/);
      assert.equal(
        shellRequest.request.command.includes('--unsafe-paths'),
        false,
        '--unsafe-paths must not be used in git apply command',
      );
    }
  });

  it('routes test-like run_command actions to shell_exec (M9: unified sandbox dispatch)', () => {
    const mapped = mapAgentActionToToolCalls({
      type: 'run_command',
      command: 'npm test',
      cwd: 'babel-cli',
    });
    assert.deepEqual(mapped, [
      {
        kind: 'execute',
        request: {
          tool: 'shell_exec',
          command: 'npm test',
          working_directory: 'babel-cli',
        },
      },
    ]);
  });

  it('marks finish and ask_approval as terminal', () => {
    const finish: AgentAction = { type: 'finish', summary: 'done', verification: [] };
    const ask: AgentAction = {
      type: 'ask_approval',
      reason: 'needs write',
      requested_action: { type: 'read_file', path: 'a.ts' },
    };

    assert.equal(isTerminalAgentAction(finish), true);
    assert.equal(isTerminalAgentAction(ask), true);
    assert.deepEqual(mapAgentActionToToolCalls(finish), [{ kind: 'terminal', action: finish }]);
    assert.deepEqual(mapAgentActionToToolCalls(ask), [{ kind: 'terminal', action: ask }]);
  });
});

describe('createToolExecutor', () => {
  it('executes mapped tool calls in order', async () => {
    const calls: ToolCallRequest[] = [];
    const executor = createToolExecutor({
      executeTool: async (request) => {
        calls.push(request);
        return {
          exit_code: 0,
          stdout: request.tool,
          stderr: '',
        } satisfies ToolResult;
      },
    });

    const result = await executor.execute(
      {
        type: 'apply_patch',
        patch: 'diff',
      },
      context,
    );

    assert.equal(result.terminal, false);
    assert.equal(result.results.length, 2);
    assert.deepEqual(
      calls.map((call) => call.tool),
      ['file_write', 'shell_exec'],
    );
  });

  it('executeActionWithPolicy blocks read_file outside project_root under read_only', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-tool-scope-'));
    writeFileSync(join(projectRoot, 'README.md'), '# local\n', 'utf-8');
    const outsideRoot = resolve(tmpdir(), 'babel-tool-scope-outside-parent.md');
    writeFileSync(outsideRoot, '# outside\n', 'utf-8');

    const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
    process.env['BABEL_PROJECT_ROOT'] = projectRoot;
    try {
      let invoked = false;
      const executor = createToolExecutor({
        executeTool: async () => {
          invoked = true;
          return { exit_code: 0, stdout: 'ok', stderr: '' };
        },
      });

      const result = await executeActionWithPolicy(
        { type: 'read_file', path: outsideRoot },
        'read_only',
        context,
        { executor },
      );

      assert.equal(invoked, false);
      assert.equal(result.policyBlocked, true);
      assert.equal(result.policyDecision, 'deny');
      assert.match(result.results[0]?.stderr ?? '', /outside project_root/);
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
    }
  });

  it('executeActionWithPolicy allows read_file inside project_root under read_only', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'babel-tool-scope-allow-'));
    writeFileSync(join(projectRoot, 'README.md'), '# local\n', 'utf-8');

    const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
    process.env['BABEL_PROJECT_ROOT'] = projectRoot;
    try {
      let invoked = false;
      const executor = createToolExecutor({
        executeTool: async () => {
          invoked = true;
          return { exit_code: 0, stdout: 'ok', stderr: '' };
        },
      });

      const result = await executeActionWithPolicy(
        { type: 'read_file', path: 'README.md' },
        'read_only',
        context,
        { executor },
      );

      assert.equal(invoked, true);
      assert.equal(result.policyBlocked, false);
      assert.equal(result.policyDecision, 'allow');
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
    }
  });

  it('executeActionWithPolicy blocks mutating actions under read_only', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: '', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'x' },
      'read_only',
      context,
      { executor },
    );

    assert.equal(invoked, false);
    assert.equal(result.policyBlocked, true);
    assert.equal(result.policyDecision, 'deny');
    assert.equal(result.results[0]?.exit_code, 1);
    assert.match(result.results[0]?.stderr ?? '', /Policy denied/);
  });

  it('executeActionWithPolicy runs mutation when onAskApproval returns true', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: 'ok', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'x' },
      'ask_before_mutation',
      context,
      {
        executor,
        onAskApproval: async () => true,
      },
    );

    assert.equal(invoked, true);
    assert.equal(result.policyBlocked, false);
    assert.equal(result.policyDecision, 'allow');
  });

  it('executeActionWithPolicy blocks mutation when onAskApproval returns false', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: 'ok', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'x' },
      'ask_before_mutation',
      context,
      {
        executor,
        onAskApproval: async () => false,
      },
    );

    assert.equal(invoked, false);
    assert.equal(result.policyBlocked, true);
    assert.equal(result.policyDecision, 'deny');
    assert.match(result.results[0]?.stderr ?? '', /User denied approval/);
  });

  it('executeActionWithPolicy allows mutations under workspace_write', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: 'ok', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'write_file', path: 'a.ts', content: 'x' },
      'workspace_write',
      context,
      { executor },
    );

    assert.equal(invoked, true);
    assert.equal(result.policyBlocked, false);
    assert.equal(result.policyDecision, 'allow');
  });

  it('returns terminal results without invoking tools', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: '', stderr: '' };
      },
    });

    const result = await executor.execute(
      {
        type: 'finish',
        summary: 'complete',
        verification: ['npm test'],
      },
      context,
    );

    assert.equal(invoked, false);
    assert.equal(result.terminal, true);
    assert.deepEqual(result.results, []);
  });
});

// ─── H1: Patch validation ──────────────────────────────────────────────

describe('validatePatchContent (H1)', () => {
  const projectRoot = process.cwd();

  it('accepts a valid in-scope patch', () => {
    const patch = [
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,3 +1,3 @@',
      ' old',
      '-removed',
      '+new',
    ].join('\n');
    const violations = validatePatchContent(patch, projectRoot);
    assert.deepEqual(violations, []);
  });

  it('rejects a patch with path traversal', () => {
    const patch = [
      '--- a/../../etc/passwd',
      '+++ b/../../etc/passwd',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const violations = validatePatchContent(patch, projectRoot);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.includes('outside project_root')));
  });

  it('rejects an oversized patch', () => {
    const largePatch = 'x'.repeat(2_000_000); // > 1MB
    const violations = validatePatchContent(largePatch, projectRoot);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.includes('size')));
  });

  it('rejects a patch with too many hunks', () => {
    const hunks = Array.from(
      { length: 101 },
      (_, i) => `@@ -${i},1 +${i},1 @@\n-old${i}\n+new${i}`,
    );
    const patch = ['--- a/file.ts', '+++ b/file.ts', ...hunks].join('\n');
    const violations = validatePatchContent(patch, projectRoot);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.includes('hunk')));
  });

  it('rejects a patch with no hunks', () => {
    const patch = '--- a/file.ts\n+++ b/file.ts\n';
    const violations = validatePatchContent(patch, projectRoot);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.includes('hunks')));
  });

  it('handles /dev/null in patch headers (file creation/deletion)', () => {
    const patch = ['--- /dev/null', '+++ b/src/newfile.ts', '@@ -0,0 +1,1 @@', '+new content'].join(
      '\n',
    );
    const violations = validatePatchContent(patch, projectRoot);
    assert.deepEqual(violations, []);
  });

  it('handles multiple files in a patch', () => {
    const patch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '-old2',
      '+new2',
    ].join('\n');
    const violations = validatePatchContent(patch, projectRoot);
    assert.deepEqual(violations, []);
  });

  it('executeActionWithPolicy blocks apply_patch with out-of-scope targets', async () => {
    const maliciousPatch = [
      '--- a/../../etc/hosts',
      '+++ b/../../etc/hosts',
      '@@ -1,1 +1,1 @@',
      '-127.0.0.1 localhost',
      '+127.0.0.1 localhost compromised',
    ].join('\n');

    const result = await executeActionWithPolicy(
      { type: 'apply_patch', patch: maliciousPatch },
      'workspace_write',
      context,
    );

    assert.equal(result.policyBlocked, true);
    assert.equal(result.policyDecision, 'deny');
    assert.match(result.results[0]?.stderr ?? '', /Patch rejected/);
  });
});

// ─── H2: Timeout and budget ─────────────────────────────────────────────

describe('tool execution budget (H2)', () => {
  it('executes normally within budget', async () => {
    const executor = createToolExecutor({
      executeTool: async (request) => ({
        exit_code: 0,
        stdout: request.tool,
        stderr: '',
      }),
    });

    const result = await executor.execute({ type: 'read_file', path: 'a.ts' }, context, {
      perToolTimeoutMs: 5000,
      maxIterations: 10,
    });

    assert.equal(result.terminal, false);
    assert.equal(result.results.length, 1);
  });

  it('rejects when action maps to more than maxIterations tool calls', async () => {
    const executor = createToolExecutor({
      executeTool: async () => ({ exit_code: 0, stdout: '', stderr: '' }),
    });

    // apply_patch maps to 2 tool calls, budget maxIterations=1
    await assert.rejects(
      () =>
        executor.execute({ type: 'apply_patch', patch: 'diff' }, context, {
          perToolTimeoutMs: 5000,
          maxIterations: 1,
        }),
      (error: unknown) => error instanceof ToolExecutionCapacityError,
    );
  });

  it('times out slow tools', async () => {
    const executor = createToolExecutor({
      executeTool: async () => {
        // Simulate a slow tool
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { exit_code: 0, stdout: '', stderr: '' };
      },
    });

    await assert.rejects(
      () =>
        executor.execute({ type: 'run_command', command: 'slow' }, context, {
          perToolTimeoutMs: 50,
          maxIterations: 10,
        }),
      (error: unknown) => error instanceof ToolExecutionTimeoutError,
    );
  });

  it('aborts the tool signal when the outer tool budget expires', async () => {
    let observedAbort = false;
    const executor = createToolExecutor({
      executeTool: async (_request, toolContext) =>
        new Promise<ToolResult>((resolveTool) => {
          toolContext.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              resolveTool({ exit_code: 1, stdout: '', stderr: 'aborted' });
            },
            { once: true },
          );
        }),
    });

    await assert.rejects(
      () =>
        executor.execute({ type: 'run_command', command: 'slow' }, context, {
          perToolTimeoutMs: 25,
          maxIterations: 10,
        }),
      (error: unknown) => error instanceof ToolExecutionTimeoutError,
    );
    assert.equal(observedAbort, true);
  });

  it('executeActionWithPolicy forwards budget to executor', async () => {
    const calls: Array<{ request: unknown; timeout: number }> = [];
    const executor = createToolExecutor({
      executeTool: async (request) => {
        calls.push({ request, timeout: 0 });
        return { exit_code: 0, stdout: '', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'read_file', path: 'a.ts' },
      'workspace_write',
      context,
      { executor, budget: { perToolTimeoutMs: 30_000, maxIterations: 10 } },
    );

    assert.equal(result.policyBlocked, false);
    assert.equal(calls.length, 1);
  });
});

// ─── M3b: Scope enforcement fallback ────────────────────────────────────

describe('scope enforcement cwd fallback (M3b)', () => {
  it('blocks writes outside cwd when BABEL_PROJECT_ROOT is unset under read_only', async () => {
    const previous = process.env['BABEL_PROJECT_ROOT'];
    delete process.env['BABEL_PROJECT_ROOT'];
    try {
      let invoked = false;
      const executor = createToolExecutor({
        executeTool: async () => {
          invoked = true;
          return { exit_code: 0, stdout: '', stderr: '' };
        },
      });

      // Use an absolute path outside cwd
      const result = await executeActionWithPolicy(
        { type: 'write_file', path: 'C:\\outside\\file.ts', content: 'x' },
        'read_only',
        context,
        { executor },
      );

      assert.equal(invoked, false);
      assert.equal(result.policyBlocked, true);
      assert.equal(result.policyDecision, 'deny');
    } finally {
      if (previous === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previous;
      }
    }
  });
});

// ─── M3d: Adversarial scope tests ───────────────────────────────────────

describe('adversarial scope tests (M3d)', () => {
  it('blocks parent directory traversal (..)', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: '', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'read_file', path: '../outside/file.ts' },
      'read_only',
      context,
      { executor },
    );

    assert.equal(invoked, false);
    assert.equal(result.policyBlocked, true);
    assert.equal(result.policyDecision, 'deny');
  });

  it('blocks deeply nested path traversal', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: '', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'list_dir', path: 'src/../../../etc' },
      'read_only',
      context,
      { executor },
    );

    assert.equal(invoked, false);
    assert.equal(result.policyBlocked, true);
    assert.equal(result.policyDecision, 'deny');
  });

  it('blocks absolute paths outside project root', async () => {
    let invoked = false;
    const executor = createToolExecutor({
      executeTool: async () => {
        invoked = true;
        return { exit_code: 0, stdout: '', stderr: '' };
      },
    });

    const result = await executeActionWithPolicy(
      { type: 'read_file', path: '/etc/passwd' },
      'read_only',
      context,
      { executor },
    );

    assert.equal(invoked, false);
    assert.equal(result.policyBlocked, true);
    assert.equal(result.policyDecision, 'deny');
  });
});

// ─── S1: Circuit breaker ────────────────────────────────────────────────

describe('circuit breaker (S1)', () => {
  // Reset before each describe block since circuit-breaker is module-level state
  it('resetCircuitBreaker starts fresh', () => {
    resetCircuitBreaker();
    const state = getCircuitBreakerState(context.runId);
    assert.equal(state.consecutiveBlocks, 0);
    assert.equal(state.tripped, false);
  });

  it('trips after consecutive policy blocks', async () => {
    resetCircuitBreaker();

    // Block 5 times consecutively
    for (let i = 0; i < 5; i++) {
      const result = await executeActionWithPolicy(
        { type: 'write_file', path: 'a.ts', content: 'x' },
        'read_only', // This will deny write_file
        context,
      );
      assert.equal(result.policyBlocked, true);
      assert.equal(result.policyDecision, 'deny');
    }

    const state = getCircuitBreakerState(context.runId);
    assert.equal(state.tripped, true);

    // The 6th call should be the circuit-breaker result
    const cbResult = await executeActionWithPolicy(
      { type: 'read_file', path: 'a.ts' },
      'read_only',
      context,
    );

    assert.equal(cbResult.terminal, true);
    assert.equal(cbResult.policyBlocked, true);
    assert.match(cbResult.results[0]?.stderr ?? '', /CIRCUIT_BREAKER/);
  });

  it('resets counter after a successful action', async () => {
    resetCircuitBreaker();

    // Block 2 times
    await executeActionWithPolicy(
      { type: 'write_file', path: 'x.ts', content: 'x' },
      'read_only',
      context,
    );
    await executeActionWithPolicy(
      { type: 'write_file', path: 'y.ts', content: 'y' },
      'read_only',
      context,
    );

    let state = getCircuitBreakerState(context.runId);
    assert.equal(state.consecutiveBlocks, 2);

    // Success resets — use workspace_write which allows writes
    await executeActionWithPolicy({ type: 'read_file', path: 'a.ts' }, 'workspace_write', context);

    state = getCircuitBreakerState(context.runId);
    assert.equal(state.consecutiveBlocks, 0);
    assert.equal(state.tripped, false);
  });

  it('resetCircuitBreaker clears tripped state', async () => {
    resetCircuitBreaker();

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      await executeActionWithPolicy(
        { type: 'write_file', path: 'a.ts', content: 'x' },
        'read_only',
        context,
      );
    }

    assert.equal(getCircuitBreakerState(context.runId).tripped, true);

    resetCircuitBreaker();
    assert.equal(getCircuitBreakerState(context.runId).tripped, false);
    assert.equal(getCircuitBreakerState(context.runId).consecutiveBlocks, 0);
  });
});
