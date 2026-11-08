import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ToolCallRequest, ToolContext, ToolResult } from '../../localTools.js';
import { createToolExecutor } from '../toolExecutor.js';
import { runCoordinatedSmallFixMutationLoop, runSmallFixMutationLoop } from './smallFixLoop.js';

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
      let verifierStarted = false;

      const result = await runSmallFixMutationLoop({
        targetFile: 'src/math.js',
        projectRoot: root,
        verifierCommand: 'npm test',
        replacementContent: 'export const add = (a, b) => a + b;\n',
        toolContext: context,
        hostFallbackAllowed: true,
        onVerifyStart: () => {
          assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), 'export const add = (a, b) => a + b;\n');
          verifierStarted = true;
        },
      });

      assert.equal(verifierStarted, true);
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
      let verifierStarted = false;
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
        onVerifyStart: () => { verifierStarted = true; },
      });

      assert.equal(result.policyBlocked, true);
      assert.equal(verifierStarted, false);
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

  it('retains an uncertain write outcome when cancellation follows a physical write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-cancel-write-'));
    const controller = new AbortController();
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      let verifierStarted = false;
      let writeObserved = false;
      const executor = createToolExecutor({
        executeTool: async (): Promise<ToolResult> => {
          writeFileSync(join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
          writeObserved = readFileSync(join(root, 'src', 'math.js'), 'utf8').includes('(a, b)');
          controller.abort();
          return { exit_code: 0, stdout: '', stderr: '' };
        },
      });
      const result = await runSmallFixMutationLoop({
        targetFile: 'src/math.js', projectRoot: root, verifierCommand: 'npm test',
        replacementContent: 'export const add = (a, b) => a + b;\n',
        toolContext: { ...context, signal: controller.signal }, executor,
        onVerifyStart: () => { verifierStarted = true; },
      });
      assert.equal(result.cancelled, true);
      assert.equal(result.writeOutcome, 'unknown');
      assert.equal(verifierStarted, false);
      assert.equal(writeObserved, true);
      assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'export const add = () => 0;\n');
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('marks a failed single write uncertain when the handler had an effect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-single-failed-write-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LIVE'] = 'true';
      const executor = createToolExecutor({ executeTool: async (): Promise<ToolResult> => {
        writeFileSync(join(root, 'src', 'math.js'), 'effect before failure\n');
        return { exit_code: 1, stdout: '', stderr: 'synthetic write failure' };
      } });
      const result = await runSmallFixMutationLoop({
        targetFile: 'src/math.js', projectRoot: root, verifierCommand: 'npm test',
        replacementContent: 'intended\n', toolContext: context, executor,
      });
      assert.equal(result.writeOutcome, 'unknown');
      assert.equal(result.testResult, null);
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      if (originalLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = originalLive;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('verifies once after two governed coordinated writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-pass-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      writeFileSync(join(root, 'src', 'other.js'), 'original\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LIVE'] = 'true';
      process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
      let verifierStarts = 0;
      const result = await runCoordinatedSmallFixMutationLoop({
        projectRoot: root, verifierCommand: 'npm test', toolContext: context, hostFallbackAllowed: true,
        writes: [
          { path: 'src/math.js', content: 'export const add = (a, b) => a + b;\n' },
          { path: 'src/other.js', content: 'changed\n' },
        ],
        onVerifyStart: () => { verifierStarts += 1; },
      });
      assert.equal(result.policyBlocked, false);
      assert.equal(result.failure, undefined);
      assert.deepEqual(result.completedWrites.map(write => write.path), ['src/math.js', 'src/other.js']);
      assert.equal(result.testResult?.exit_code, 0);
      assert.equal(verifierStarts, 1);
      assert.equal(readFileSync(join(root, 'src', 'other.js'), 'utf8'), 'changed\n');
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
  it('retains prior coordinated work and marks an interrupted write uncertain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-cancel-'));
    const controller = new AbortController();
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      writeFileSync(join(root, 'src', 'other.js'), 'original\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LIVE'] = 'true';
      let calls = 0;
      let verifierStarted = false;
      const executor = createToolExecutor({ executeTool: async (): Promise<ToolResult> => {
        calls += 1;
        if (calls === 1) writeFileSync(join(root, 'src', 'math.js'), 'first\n');
        else { writeFileSync(join(root, 'src', 'other.js'), 'second\n'); controller.abort(); }
        return { exit_code: 0, stdout: '', stderr: '' };
      } });
      const result = await runCoordinatedSmallFixMutationLoop({
        projectRoot: root, verifierCommand: 'npm test', toolContext: { ...context, signal: controller.signal }, executor,
        writes: [{ path: 'src/math.js', content: 'first\n' }, { path: 'src/other.js', content: 'second\n' }],
        onVerifyStart: () => { verifierStarted = true; },
      });
      assert.equal(result.cancelled, true);
      assert.equal(result.unknownWritePath, 'src/other.js');
      assert.deepEqual(result.completedWrites.map(write => write.path), ['src/math.js']);
      assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'first\n');
      assert.equal(verifierStarted, false);
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      if (originalLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = originalLive;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not treat a nonzero coordinated write as proof of no effect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-failed-write-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LIVE'] = 'true';
      const executor = createToolExecutor({ executeTool: async (): Promise<ToolResult> => {
        writeFileSync(join(root, 'src', 'math.js'), 'effect before failure\n');
        return { exit_code: 1, stdout: '', stderr: 'synthetic write failure' };
      } });
      const result = await runCoordinatedSmallFixMutationLoop({
        projectRoot: root, verifierCommand: 'npm test', toolContext: context, executor,
        writes: [{ path: 'src/math.js', content: 'intended\n' }],
      });
      assert.equal(result.policyBlocked, false);
      assert.equal(result.unknownWritePath, 'src/math.js');
      assert.equal(result.failedWrite?.result?.exit_code, 1);
      assert.equal(result.testResult, null);
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      if (originalLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = originalLive;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('governs each coordinated write and preserves the first change when the second is denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-deny-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      writeFileSync(join(root, 'src', 'other.js'), 'original\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LIVE'] = 'true';
      let verifierStarted = false;
      const result = await runCoordinatedSmallFixMutationLoop({
        projectRoot: root, verifierCommand: 'npm test', toolContext: context,
        writes: [
          { path: 'src/math.js', content: 'export const add = (a, b) => a + b;\n' },
          { path: 'src/other.js', content: 'changed\n' },
        ],
        decide: action => action.type === 'write_file' && action.path === 'src/other.js' ? 'deny' : 'allow',
        onVerifyStart: () => { verifierStarted = true; },
      });
      assert.equal(result.policyBlocked, true);
      assert.deepEqual(result.completedWrites.map(write => write.path), ['src/math.js']);
      assert.equal(result.testResult, null);
      assert.equal(verifierStarted, false);
      assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
      assert.equal(readFileSync(join(root, 'src', 'other.js'), 'utf8'), 'original\n');
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      if (originalLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = originalLive;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not announce verifier dispatch when policy denies it after the write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-verifier-deny-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['BABEL_LIVE'] = 'true';
      let verifierStarted = false;
      const result = await runSmallFixMutationLoop({
        targetFile: 'src/math.js',
        projectRoot: root,
        verifierCommand: 'npm test',
        replacementContent: 'export const add = (a, b) => a + b;\n',
        toolContext: context,
        decide: (action) => action.type === 'run_command' ? 'deny' : 'allow',
        onVerifyStart: () => { verifierStarted = true; },
      });
      assert.equal(result.writeResult?.exit_code, 0);
      assert.equal(result.policyBlocked, true);
      assert.equal(verifierStarted, false);
      assert.match(result.blockedReason ?? '', /Policy denied run_command/);
    } finally {
      if (originalProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
      else process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
      if (originalLive === undefined) delete process.env['BABEL_LIVE'];
      else process.env['BABEL_LIVE'] = originalLive;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
