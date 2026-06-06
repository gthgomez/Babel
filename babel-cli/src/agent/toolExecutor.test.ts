import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ToolCallRequest, ToolContext, ToolResult } from '../localTools.js';
import type { AgentAction } from './actions.js';
import {
  createToolExecutor,
  executeActionWithPolicy,
  isTerminalAgentAction,
  mapAgentActionToToolCalls,
} from './toolExecutor.js';

const context: ToolContext = {
  agentId: 'agent-b',
  runId: 'run-b',
  babelRoot: process.cwd(),
};

describe('mapAgentActionToToolCalls', () => {
  it('maps read-only actions to executor read tools', () => {
    assert.deepEqual(
      mapAgentActionToToolCalls({ type: 'read_file', path: 'src/a.ts' }),
      [{ kind: 'execute', request: { tool: 'file_read', path: 'src/a.ts' } }],
    );
    assert.deepEqual(
      mapAgentActionToToolCalls({ type: 'list_dir', path: 'src' }),
      [{ kind: 'execute', request: { tool: 'directory_list', path: 'src' } }],
    );
    assert.deepEqual(
      mapAgentActionToToolCalls({ type: 'search', query: 'small fix' }),
      [{ kind: 'execute', request: { tool: 'semantic_search', query: 'small fix' } }],
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
      assert.match(shellRequest.request.command, /git apply/);
    }
  });

  it('routes test-like run_command actions to test_run', () => {
    const mapped = mapAgentActionToToolCalls({
      type: 'run_command',
      command: 'npm test',
      cwd: 'babel-cli',
    });
    assert.deepEqual(mapped, [{
      kind: 'execute',
      request: {
        tool: 'test_run',
        command: 'npm test',
        working_directory: 'babel-cli',
      },
    }]);
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

    const result = await executor.execute({
      type: 'apply_patch',
      patch: 'diff',
    }, context);

    assert.equal(result.terminal, false);
    assert.equal(result.results.length, 2);
    assert.deepEqual(calls.map((call) => call.tool), ['file_write', 'shell_exec']);
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

    const result = await executor.execute({
      type: 'finish',
      summary: 'complete',
      verification: ['npm test'],
    }, context);

    assert.equal(invoked, false);
    assert.equal(result.terminal, true);
    assert.deepEqual(result.results, []);
  });
});
