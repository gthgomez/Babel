import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runBeforeCompleteHooks,
  runPreToolUseHooks,
} from './hooks.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

function successfulCommand(target: string): ToolCallLog {
  return {
    step: 1,
    tool: 'shell_exec',
    target,
    exit_code: 0,
    stdout: '',
    stderr: '',
    verified: true,
  };
}

test('PreToolUse hook rewrites generic git bundle inspection to a capability command', () => {
  const result = runPreToolUseHooks({
    request: {
      tool: 'shell_exec',
      command: 'file bundle1.bundle',
      working_directory: '.',
      timeout_seconds: 120,
    },
    rawTask: 'Terminal-Bench 2 task: merge-diff-arc-agi-task',
    executionProfileName: 'benchmark_container',
  });

  assert.equal(result.blocked, false);
  assert.equal(result.traces[0]?.decision, 'rewrite');
  assert.equal(
    result.request.tool === 'shell_exec' ? result.request.command : '',
    'git bundle verify bundle1.bundle',
  );
});

test('PreToolUse hook rewrites plain Python benchmark verifier to pytest', () => {
  const result = runPreToolUseHooks({
    request: {
      tool: 'shell_exec',
      command: 'python test_outputs.py',
      working_directory: '.',
      timeout_seconds: 120,
    },
    rawTask: 'Terminal-Bench 2 task: break-filter-js-from-html',
    executionProfileName: 'benchmark_container',
  });

  assert.equal(result.blocked, false);
  assert.equal(result.traces[0]?.decision, 'rewrite');
  assert.equal(
    result.request.tool === 'shell_exec' ? result.request.command : '',
    'python -m pytest -q test_outputs.py',
  );
});

test('PreToolUse hook blocks pytest verifier when benchmark inventory lacks pytest', () => {
  const result = runPreToolUseHooks({
    request: {
      tool: 'test_run',
      command: 'python -m pytest -q test_outputs.py',
      working_directory: '.',
      timeout_seconds: 120,
    },
    rawTask: 'Terminal-Bench 2 task: break-filter-js-from-html',
    executionProfileName: 'benchmark_container',
    runtimeInventory: {
      dockerImage: 'example/task:latest',
      status: 'available',
      commands: [
        { command: 'python', available: true, resolvedPath: '/usr/bin/python' },
        { command: 'pytest', available: false, resolvedPath: null },
      ],
      stdout: '',
      stderr: '',
      exitCode: 0,
    },
  });

  assert.equal(result.blocked, true);
  assert.match(result.message ?? '', /Missing requirements: pytest/);
});

test('BeforeComplete hook blocks benchmark completion without local verifier evidence', () => {
  const rawTask = 'Terminal-Bench 2 task: write-compressor\nWrite data.comp.';
  const failed = runBeforeCompleteHooks({
    rawTask,
    toolCallLog: [successfulCommand('gzip data.txt')],
  });

  assert.equal(failed.blocked, true);
  assert.match(failed.message ?? '', /decompressor/);

  const passed = runBeforeCompleteHooks({
    rawTask,
    toolCallLog: [successfulCommand('cat data.comp | ./decomp > out.txt && diff data.txt out.txt')],
  });
  assert.equal(passed.blocked, false);
  assert.equal(passed.traces[0]?.decision, 'allow');
});

test('BeforeComplete hook blocks CoreWars file-only completion', () => {
  const rawTask = 'Terminal-Bench 2 task: winning-avg-corewars\nWrite my_warrior.red.';
  const failed = runBeforeCompleteHooks({
    rawTask,
    toolCallLog: [
      {
        step: 1,
        tool: 'file_write',
        target: 'my_warrior.red',
        exit_code: 0,
        stdout: '',
        stderr: '',
        verified: true,
      },
    ],
  });

  assert.equal(failed.blocked, true);
  assert.match(failed.message ?? '', /pMARS/);

  const passed = runBeforeCompleteHooks({
    rawTask,
    toolCallLog: [successfulCommand('pmars -b -r 100 -f my_warrior.red warriors/stone.red')],
  });
  assert.equal(passed.blocked, false);
});

test('BeforeComplete hook blocks generic external benchmark file-only completion', () => {
  const failed = runBeforeCompleteHooks({
    rawTask: 'Terminal-Bench 2 task: not-yet-cataloged\nWrite output.txt.',
    toolCallLog: [
      {
        step: 1,
        tool: 'file_write',
        target: 'output.txt',
        exit_code: 0,
        stdout: '',
        stderr: '',
        verified: true,
      },
    ],
  });

  assert.equal(failed.blocked, true);
  assert.equal(failed.traces[0]?.details?.['failure_category'], 'missing_verifier_evidence');

  const passed = runBeforeCompleteHooks({
    rawTask: 'Terminal-Bench 2 task: not-yet-cataloged\nWrite output.txt.',
    toolCallLog: [successfulCommand('python verify_output.py')],
  });
  assert.equal(passed.blocked, false);
});
