import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ToolCallRequest, ToolContext } from '../localTools.js';
import {
  createExecutorToolRegistry,
  type ExecutorToolDefinition,
} from './executorRegistry.js';

const context: ToolContext = {
  agentId: 'test-agent',
  runId: 'test-run',
  babelRoot: process.cwd(),
};

function makeDefinition(name: ToolCallRequest['tool']): ExecutorToolDefinition {
  return {
    name,
    category: 'filesystem',
    description: 'Test tool',
    mutating: false,
    dryRunBehavior: 'live',
    policyTags: ['test'],
    input: {
      required: [],
      optional: [],
    },
    handler: () => ({
      exit_code: 0,
      stdout: name,
      stderr: '',
    }),
  };
}

describe('executor tool registry', () => {
  it('rejects duplicate registrations', () => {
    const definition = makeDefinition('file_read');

    assert.throws(
      () => createExecutorToolRegistry([definition, definition]),
      /Duplicate executor tool registration: file_read/,
    );
  });

  it('dispatches through registered handlers and exposes handler-free snapshots', async () => {
    const registry = createExecutorToolRegistry([makeDefinition('file_read')]);
    const result = await registry.dispatch({
      tool: 'file_read',
      path: 'README.md',
    }, context);

    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'file_read');

    const snapshots = registry.list();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.name, 'file_read');
    assert.equal('handler' in (snapshots[0] ?? {}), false);
  });
});
