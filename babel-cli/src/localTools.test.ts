import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  executeTool,
  getExecutorToolRegistrySnapshot,
  getExecutorToolSnapshot,
  TOOL_CALL_REQUEST_TOOL_NAMES,
} from './localTools.js';
import { EXECUTOR_TOOL_NAMES } from './tools/toolContracts.js';

const context = {
  agentId: 'test-agent',
  runId: 'test-run',
  babelRoot: process.cwd(),
};

async function withToolPolicyEnv<T>(
  allowed: string | undefined,
  disallowed: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previousAllowed = process.env['BABEL_ALLOWED_TOOLS'];
  const previousDisallowed = process.env['BABEL_DISALLOWED_TOOLS'];

  if (allowed === undefined) {
    delete process.env['BABEL_ALLOWED_TOOLS'];
  } else {
    process.env['BABEL_ALLOWED_TOOLS'] = allowed;
  }

  if (disallowed === undefined) {
    delete process.env['BABEL_DISALLOWED_TOOLS'];
  } else {
    process.env['BABEL_DISALLOWED_TOOLS'] = disallowed;
  }

  try {
    return await fn();
  } finally {
    if (previousAllowed === undefined) {
      delete process.env['BABEL_ALLOWED_TOOLS'];
    } else {
      process.env['BABEL_ALLOWED_TOOLS'] = previousAllowed;
    }

    if (previousDisallowed === undefined) {
      delete process.env['BABEL_DISALLOWED_TOOLS'];
    } else {
      process.env['BABEL_DISALLOWED_TOOLS'] = previousDisallowed;
    }
  }
}

describe('executeTool policy enforcement', () => {
  it('keeps mutating tools in dry-run mode by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-dry-run-default-'));
    const previous = {
      projectRoot: process.env['BABEL_PROJECT_ROOT'],
      babelRoot: process.env['BABEL_ROOT'],
      dryRun: process.env['BABEL_DRY_RUN'],
      dryRunSource: process.env['BABEL_DRY_RUN_SOURCE'],
      live: process.env['BABEL_LIVE'],
    };

    try {
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_ROOT'] = root;
      delete process.env['BABEL_DRY_RUN'];
      delete process.env['BABEL_DRY_RUN_SOURCE'];
      delete process.env['BABEL_LIVE'];

      const result = await executeTool({
        tool: 'file_write',
        path: 'out.txt',
        content: 'live write should not happen\n',
      }, context);

      assert.equal(result.exit_code, 0);
      assert.match(result.stdout, /\[DRY RUN\]/);
      assert.equal(existsSync(join(root, 'out.txt')), false);
    } finally {
      if (previous.projectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = previous.projectRoot;
      if (previous.babelRoot === undefined) delete process.env['BABEL_ROOT'];
      else process.env['BABEL_ROOT'] = previous.babelRoot;
      if (previous.dryRun === undefined) delete process.env['BABEL_DRY_RUN'];
      else process.env['BABEL_DRY_RUN'] = previous.dryRun;
      if (previous.dryRunSource === undefined) delete process.env['BABEL_DRY_RUN_SOURCE'];
      else process.env['BABEL_DRY_RUN_SOURCE'] = previous.dryRunSource;
      if (previous.live === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = previous.live;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies tools listed in BABEL_DISALLOWED_TOOLS', async () => {
    const result = await withToolPolicyEnv(undefined, 'file_read', () => executeTool({
      tool: 'file_read',
      path: 'README.md',
    }, context));

    assert.equal(result.exit_code, 1);
    assert.equal(result.denial?.category, 'executor_policy');
    assert.equal(result.denial?.reason_code, 'tool_disallowed');
  });

  it('denies tools absent from BABEL_ALLOWED_TOOLS when an allowlist is set', async () => {
    const result = await withToolPolicyEnv('file_read', undefined, () => executeTool({
      tool: 'file_write',
      path: 'out.txt',
      content: 'x',
    }, context));

    assert.equal(result.exit_code, 1);
    assert.equal(result.denial?.category, 'executor_policy');
    assert.equal(result.denial?.reason_code, 'tool_not_allowed');
  });

  it('lets explicit deny rules take precedence over allow rules', async () => {
    const result = await withToolPolicyEnv('file_read', 'file_read', () => executeTool({
      tool: 'file_read',
      path: 'README.md',
    }, context));

    assert.equal(result.exit_code, 1);
    assert.equal(result.denial?.reason_code, 'tool_disallowed');
  });

  it('denies file writes listed in BABEL_LOCKED_FILES', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-locked-file-'));
    const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
    const previousLockedFiles = process.env['BABEL_LOCKED_FILES'];
    try {
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LOCKED_FILES'] = JSON.stringify(['test_outputs.py']);
      const result = await executeTool({
        tool: 'file_write',
        path: 'test_outputs.py',
        content: 'def test_fake(): pass\n',
      }, context);

      assert.equal(result.exit_code, 1);
      assert.match(result.stderr, /FILE_LOCK/);
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
      }
      if (previousLockedFiles === undefined) {
        delete process.env['BABEL_LOCKED_FILES'];
      } else {
        process.env['BABEL_LOCKED_FILES'] = previousLockedFiles;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('executor tool registry snapshot', () => {
  it('exposes the registered executor tools without handlers', () => {
    const tools = getExecutorToolRegistrySnapshot();
    const names = tools.map((tool) => tool.name);

    assert.deepEqual(names, [...EXECUTOR_TOOL_NAMES]);
    assert.deepEqual([...TOOL_CALL_REQUEST_TOOL_NAMES], [...EXECUTOR_TOOL_NAMES]);

    assert.equal(tools.some((tool) => 'handler' in tool), false);
  });

  it('supports inspecting one registered tool', () => {
    const tool = getExecutorToolSnapshot('shell_exec');

    assert.equal(tool?.name, 'shell_exec');
    assert.equal(tool?.category, 'process');
    assert.equal(tool?.mutating, true);
    assert.deepEqual(tool?.input.required, ['command']);
    assert.deepEqual(tool?.input.optional, ['working_directory', 'timeout_seconds']);
  });
});
