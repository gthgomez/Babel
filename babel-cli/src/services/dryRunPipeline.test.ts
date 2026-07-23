/**
 * dryRunPipeline.test.ts — Tests for dry-run pipeline verification.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  dryRunPipeline,
  createDryRunExecuteTool,
  type DryRunPipelineResult,
} from './dryRunPipeline.js';

// ── createDryRunExecuteTool ──────────────────────────────────────────────────

describe('createDryRunExecuteTool', () => {
  it('records file_read without executing', async () => {
    const { execute, getTrace } = createDryRunExecuteTool();
    await execute({ tool: 'file_read', path: 'src/main.ts' });
    const trace = getTrace();
    assert.equal(trace.length, 1);
    assert.equal(trace[0]!.tool, 'file_read');
    assert.equal(trace[0]!.target, 'src/main.ts');
  });

  it('records file_write with content preview', async () => {
    const { execute, getTrace } = createDryRunExecuteTool();
    await execute({
      tool: 'file_write',
      path: 'output.txt',
      content: 'hello world this is test content',
    });
    const trace = getTrace();
    assert.equal(trace.length, 1);
    assert.equal(trace[0]!.tool, 'file_write');
    assert.equal(trace[0]!.target, 'output.txt');
    assert.ok(trace[0]!.contentPreview!.includes('hello world'));
  });

  it('records shell_exec as command', async () => {
    const { execute, getTrace } = createDryRunExecuteTool();
    await execute({ tool: 'shell_exec', path: 'npm test' });
    const trace = getTrace();
    assert.equal(trace[0]!.command, 'npm test');
  });

  it('records multiple calls in order', async () => {
    const { execute, getTrace } = createDryRunExecuteTool();
    await execute({ tool: 'file_read', path: 'a.txt' });
    await execute({ tool: 'file_write', path: 'b.txt', content: 'x' });
    await execute({ tool: 'shell_exec', path: 'npm test' });
    const trace = getTrace();
    assert.equal(trace.length, 3);
    assert.equal(trace[0]!.turn, 1);
    assert.equal(trace[1]!.turn, 2);
    assert.equal(trace[2]!.turn, 3);
  });

  it('returns mock success for common tool types', async () => {
    const { execute } = createDryRunExecuteTool();
    const tools = ['file_read', 'file_write', 'shell_exec', 'directory_list'];
    for (const tool of tools) {
      const result = await execute({ tool, path: 'test' });
      assert.equal(result.exit_code, 0);
      assert.ok(result.stdout.includes('[DRY-RUN]'));
    }
  });
});

// ── dryRunPipeline ───────────────────────────────────────────────────────────

describe('dryRunPipeline', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) restore();
  });

  it('returns success with all four stage results', async () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    const result = await dryRunPipeline('Regression backend verified lane: fix a typo in README.', {
      mode: 'deep',
    });
    assert.equal(result.success, true);
    assert.ok(result.orchestrator !== null, 'Should have orchestrator result');
    assert.ok(result.swePlan !== null, 'Should have SWE plan result');
    assert.ok(result.qaVerdict !== null, 'Should have QA verdict result');
  });

  it('returns orchestrator domain and mode', async () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    const result = await dryRunPipeline('fix a bug', { mode: 'deep' });
    assert.ok(result.orchestrator!.domain.length > 0);
    assert.ok(result.orchestrator!.pipelineMode.length > 0);
  });

  it('returns SWE plan type and action count', async () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    const result = await dryRunPipeline('add a feature', { mode: 'deep' });
    assert.ok(result.swePlan!.planType.length > 0);
    assert.ok(result.swePlan!.actionCount >= 0);
  });

  it('returns QA verdict with PASS or REJECT', async () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    const result = await dryRunPipeline('refactor module', { mode: 'deep' });
    assert.ok(['PASS', 'REJECT'].includes(result.qaVerdict!.verdict));
    assert.ok(result.qaVerdict!.confidence >= 0);
  });

  it('returns executor trace from plan actions', async () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    const result = await dryRunPipeline('inspect the codebase', { mode: 'deep' });
    assert.ok(Array.isArray(result.executorTrace));
    assert.ok(result.estimatedToolCalls >= 0);
  });

  it('handles mode parameter', async () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    const result = await dryRunPipeline('test', { mode: 'deep' });
    assert.equal(result.mode, 'deep');
  });

  it('produces valid result shape', async () => {
    restore = setEnv('BABEL_PIPELINE_V9_OFFLINE', '1');
    const result = await dryRunPipeline('test', {});
    // Verify all expected top-level fields exist
    assert.ok('success' in result);
    assert.ok('mode' in result);
    assert.ok('orchestrator' in result);
    assert.ok('swePlan' in result);
    assert.ok('qaVerdict' in result);
    assert.ok('executorTrace' in result);
    assert.ok('estimatedToolCalls' in result);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function setEnv(key: string, value: string | undefined): () => void {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return () => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };
}
