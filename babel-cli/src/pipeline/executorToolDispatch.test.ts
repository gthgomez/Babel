import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutorKernel } from '../executor/kernel.js';

import type { ToolCallRequest, ToolResult } from '../localTools.js';
import {
  buildBlockedExecutorToolCallEntry,
  buildExecutorToolCallEntry,
  buildNonRecoverableToolFailureCondition,
  buildTruncationArtifactConditions,
  getSuccessfulFileReadCacheEntry,
  scopeExecutorKernel,
} from './executorToolDispatch.js';

test('Plan dispatch allows in-scope writes and denies unscoped paths, hard links and arbitrary verifier commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-plan-dispatch-'));
  try {
    writeFileSync(join(root, 'allowed.txt'), 'ok');
    linkSync(join(root, 'allowed.txt'), join(root, 'linked.txt'));
    let calls = 0;
    const base = createExecutorKernel('deep');
    const kernel = scopeExecutorKernel({ ...base, tools: { async execute() { calls++; return { exit_code: 0, stdout: 'ok', stderr: '' }; } } }, { projectRoot: root, allowedPaths: ['allowed.txt', 'linked.txt'] });
    const context = { agentId: 'executor', runId: 'fixture', runDir: root, babelRoot: root };
    assert.equal((await kernel.tools.execute({ tool: 'file_read', path: 'outside.txt' }, context)).exit_code, 126);
    assert.equal((await kernel.tools.execute({ tool: 'file_read', path: '../allowed.txt' }, context)).exit_code, 126);
    assert.equal((await kernel.tools.execute({ tool: 'file_read', path: 'linked.txt' }, context)).exit_code, 126);
    assert.equal((await kernel.tools.execute({ tool: 'test_run', command: 'node malicious.js' }, context)).exit_code, 126);
    assert.equal(calls, 0);
    rmSync(join(root, 'linked.txt'));
    assert.equal((await kernel.tools.execute({ tool: 'file_write', path: 'outside.txt', content: 'unqualified write' }, context)).exit_code, 126);
    assert.equal((await kernel.tools.execute({ tool: 'file_write', path: 'allowed.txt', content: 'scoped write' }, context)).exit_code, 0);
    assert.equal((await kernel.tools.execute({ tool: 'file_read', path: 'allowed.txt' }, context)).exit_code, 0);
    assert.equal(calls, 2);
    const empty = scopeExecutorKernel(base, { projectRoot: root, allowedPaths: [] });
    assert.equal((await empty.tools.execute({ tool: 'file_read', path: 'allowed.txt' }, context)).exit_code, 126);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tool dispatch builds canonical log entries from executor tool results', () => {
  const req = { tool: 'file_read', path: 'src/input.ts' } satisfies ToolCallRequest;
  const result = {
    exit_code: 0,
    stdout: 'content',
    stderr: '',
    checkpoint_ids: ['cp-1'],
  } satisfies ToolResult;

  assert.deepEqual(
    buildExecutorToolCallEntry({
      step: 4,
      req,
      toolResult: result,
    }),
    {
      step: 4,
      tool: 'file_read',
      target: 'src/input.ts',
      exit_code: 0,
      stdout: 'content',
      stderr: '',
      checkpoint_ids: ['cp-1'],
      verified: true,
    },
  );
});

test('tool dispatch builds blocked entries without executing tools', () => {
  const req = {
    tool: 'shell_exec',
    command: 'npm test',
    working_directory: '.',
    timeout_seconds: 120,
  } satisfies ToolCallRequest;

  assert.deepEqual(
    buildBlockedExecutorToolCallEntry({
      step: 2,
      req,
      stderr: 'blocked',
    }),
    {
      step: 2,
      tool: 'shell_exec',
      target: 'npm test',
      exit_code: 126,
      stdout: '(blocked before execution)',
      stderr: 'blocked',
      verified: false,
    },
  );
});

test('tool dispatch formats non-recoverable shell failures with verifier context', () => {
  const req = {
    tool: 'shell_exec',
    command: 'npm test',
    working_directory: '.',
    timeout_seconds: 120,
  } satisfies ToolCallRequest;
  const result = {
    exit_code: 1,
    stdout: '',
    stderr: 'failed assertion',
  } satisfies ToolResult;

  assert.equal(
    buildNonRecoverableToolFailureCondition(req, result),
    '[VERIFIER_FAILED] Tool shell_exec on "npm test" exited with code 1. stderr: failed assertion',
  );
});

test('tool dispatch exposes successful file-read cache entries', () => {
  const req = { tool: 'file_read', path: 'src/input.ts' } satisfies ToolCallRequest;
  const result = {
    exit_code: 0,
    stdout: 'full file content',
    stderr: '',
  } satisfies ToolResult;

  assert.deepEqual(getSuccessfulFileReadCacheEntry(req, result), {
    key: 'src/input.ts',
    stdout: 'full file content',
  });
});

test('tool dispatch keeps truncation artifact halt text stable', () => {
  assert.deepEqual(buildTruncationArtifactConditions('src/output.ts'), {
    reportCondition:
      '[TRUNCATION_ARTIFACT] file_write for "src/output.ts" contains the "... [N chars truncated] ..." history marker in its content. ' +
      'The executor copied truncated execution history instead of the FILE_READ_CACHE. Re-read the file from FILE_READ_CACHE and apply only the plan-specified changes.',
    resultCondition:
      '[TRUNCATION_ARTIFACT] file_write for "src/output.ts" contains truncation marker from execution history. Use FILE_READ_CACHE instead.',
  });
});
