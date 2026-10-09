/**
 * Fuzzy assist decisions must be attributable like any governed write:
 * auto-applied fuzzy writes carry the fuzzyAssisted receipt annotation, and
 * ambiguous equal-similarity candidates never apply.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import type { ToolContext, ToolResult } from '../localTools.js';
import type { AgentAction } from './actions.js';
import { governedStrReplace } from './governedMutations.js';
import { createToolExecutor, resetCircuitBreaker, type ToolExecutor } from './toolExecutor.js';

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ctx(root: string): ToolContext {
  return {
    agentId: 'gov-fuzzy',
    runId: `gov-fuzzy-${randomUUID()}`,
    runDir: root,
    babelRoot: root,
  };
}

function writingExecutor(projectRoot: string): ToolExecutor {
  return createToolExecutor({
    executeTool: async (req): Promise<ToolResult> => {
      if (req.tool === 'file_write') {
        const target = resolve(projectRoot, req.path);
        writeFileSync(target, req.content, 'utf8');
        return { exit_code: 0, stdout: `Written: ${target}`, stderr: '' };
      }
      return { exit_code: 0, stdout: '', stderr: '' };
    },
  });
}

describe('governed fuzzy assist receipt annotation', { concurrency: false }, () => {
  test('high-similarity not_found auto-applies and annotates the receipt', async () => {
    resetCircuitBreaker();
    const projectRoot = tmpRoot('babel-gov-fuzzy-hit-');
    const filePath = join(projectRoot, 'target.ts');
    try {
      writeFileSync(filePath, 'alpha\nconst value = 2\nomega\n', 'utf8');
      const result = await governedStrReplace(
        { file_path: 'target.ts', old_str: 'const value = 1', new_str: 'const value = 9' },
        {
          projectRoot,
          context: ctx(projectRoot),
          preset: 'workspace_write',
          executor: writingExecutor(projectRoot),
        },
      );
      assert.equal(result.exit_code, 0, result.observation);
      assert.equal(result.fuzzyAssisted, true);
      assert.ok(result.fuzzySimilarity !== undefined && result.fuzzySimilarity >= 0.9);
      assert.match(result.observation, /fuzzy_assist: similarity 0\.9\d/);
      assert.match(result.observation, /recorded in mutation receipt/);
      assert.equal(readFileSync(filePath, 'utf8'), 'alpha\nconst value = 9\nomega\n');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('ambiguous equal-similarity candidates surface suggestion without applying', async () => {
    resetCircuitBreaker();
    const projectRoot = tmpRoot('babel-gov-fuzzy-amb-');
    const filePath = join(projectRoot, 'target.ts');
    try {
      const original = 'const value = 2\nconst value = 3\n';
      writeFileSync(filePath, original, 'utf8');
      const result = await governedStrReplace(
        { file_path: 'target.ts', old_str: 'const value = 1', new_str: 'const value = 9' },
        {
          projectRoot,
          context: ctx(projectRoot),
          preset: 'workspace_write',
          executor: writingExecutor(projectRoot),
        },
      );
      assert.equal(result.exit_code, 1);
      assert.equal(result.preDispatchNoEffect, true);
      assert.equal(result.fuzzyAssisted, undefined);
      assert.match(result.observation, /similarity 0\.9\d/);
      assert.equal(readFileSync(filePath, 'utf8'), original);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
