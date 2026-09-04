import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ToolCallRequest, ToolContext, ToolResult } from '../../localTools.js';
import { createToolExecutor } from '../toolExecutor.js';
import { runSmallFixMutationLoop } from './smallFixLoop.js';

const originalProjectRoot = process.env['BABEL_PROJECT_ROOT'];
const originalLive = process.env['BABEL_LIVE'];
const originalHostFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];

const context: ToolContext = {
  agentId: 'small-fix-loop-test',
  runId: 'run-loop',
  babelRoot: process.cwd(),
};

function writeNodeFixture(root: string, implementation: string): void {
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        type: 'module',
        scripts: { test: 'node src/math.test.js' },
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(join(root, 'src', 'math.js'), implementation, 'utf-8');
  writeFileSync(
    join(root, 'src', 'math.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './math.js';",
      '',
      "test('add sums two numbers', () => {",
      '  assert.equal(add(1, 2), 3);',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe('runSmallFixMutationLoop', () => {
  it('runs observe→act→verify with policy allow on fix preset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-loop-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LIVE'] = 'true';
      // This fixture intentionally executes npm on the host; declare test-only escalation to both
      // the policy layer and the sandbox transport.
      process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';

      const result = await runSmallFixMutationLoop({
        targetFile: 'src/math.js',
        projectRoot: root,
        verifierCommand: 'npm test',
        replacementContent: 'export const add = (a, b) => a + b;\n',
        toolContext: context,
        hostFallbackAllowed: true,
      });

      assert.equal(result.policyBlocked, false);
      assert.equal(result.writeResult?.exit_code, 0);
      assert.equal(
        result.testResult?.exit_code,
        0,
        result.testResult?.stderr || result.testResult?.stdout || 'verifier returned no output',
      );
      assert.equal(
        readFileSync(join(root, 'src', 'math.js'), 'utf-8'),
        'export const add = (a, b) => a + b;\n',
      );
      assert.deepEqual(
        result.steps.map((step) => step.phase),
        ['observe', 'act', 'verify', 'finish'],
      );
      assert.ok(result.sessionLoopSteps.length >= 2);
      assert.equal(result.sessionLoopSteps.at(-1)?.phase, 'finish');
      assert.equal(result.steps[1]?.policyDecision, 'allow');
      assert.equal(result.steps[2]?.policyDecision, 'allow');
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      if (originalLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = originalLive;
      if (originalHostFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
      else process.env['BABEL_ALLOW_HOST_FALLBACK'] = originalHostFallback;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks mutations under read_only preset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-loop-deny-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;

      let invoked = false;
      const executor = createToolExecutor({
        executeTool: async (request: ToolCallRequest): Promise<ToolResult> => {
          invoked = true;
          return { exit_code: 0, stdout: request.tool, stderr: '' };
        },
      });

      const result = await runSmallFixMutationLoop({
        targetFile: 'src/math.js',
        projectRoot: root,
        verifierCommand: 'npm test',
        replacementContent: 'export const add = (a, b) => a + b;\n',
        toolContext: context,
        executor,
        preset: 'read_only',
      });

      assert.equal(result.policyBlocked, true);
      assert.equal(invoked, false);
      assert.match(result.blockedReason ?? '', /Policy denied write_file/);
      assert.equal(result.sessionLoopSteps.at(-1)?.phase, 'blocked');
      assert.equal(
        readFileSync(join(root, 'src', 'math.js'), 'utf-8'),
        'export const add = () => 0;\n',
      );
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
