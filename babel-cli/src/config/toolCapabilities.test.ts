import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildToolCapabilityPromptLines,
  formatToolCapabilityResolutionForFeedback,
  resolveToolCapabilityForCommand,
} from './toolCapabilities.js';
import type { BenchmarkRuntimeInventory } from './benchmarkContainer.js';

function inventory(commands: Record<string, boolean>): BenchmarkRuntimeInventory {
  return {
    dockerImage: 'example/task:latest',
    status: 'available',
    commands: Object.entries(commands).map(([command, available]) => ({
      command,
      available,
      resolvedPath: available ? `/usr/bin/${command}` : null,
    })),
    stdout: '',
    stderr: '',
    exitCode: 0,
  };
}

test('tool capability broker replaces generic file inspection for git bundles', () => {
  const resolution = resolveToolCapabilityForCommand('file bundle1.bundle', {
    rawTask: 'Terminal-Bench 2 task: merge-diff-arc-agi-task',
    executionProfileName: 'benchmark_container',
    allowedCommandBases: ['file', 'git'],
    runtimeInventory: inventory({ git: true, file: true }),
  });

  assert.equal(resolution.status, 'suggest_replacement');
  assert.equal(resolution.capabilityId, 'inspect.git_bundle');
  assert.equal(resolution.replacementCommand, 'git bundle verify bundle1.bundle');
  assert.match(formatToolCapabilityResolutionForFeedback(resolution), /TOOL_CAPABILITY_BROKER/);
});

test('tool capability broker reports missing requirements instead of allowing probe loops', () => {
  const resolution = resolveToolCapabilityForCommand('file bundle1.bundle', {
    rawTask: 'Terminal-Bench 2 task: merge-diff-arc-agi-task',
    executionProfileName: 'benchmark_container',
    allowedCommandBases: ['file', 'git'],
    runtimeInventory: inventory({ git: false, file: true }),
  });

  assert.equal(resolution.status, 'blocked_missing_requirement');
  assert.deepEqual(resolution.missingRequirements, ['git']);
  assert.match(resolution.message, /no implementation is usable/);
});

test('tool capability broker keeps unrelated commands untouched', () => {
  const resolution = resolveToolCapabilityForCommand('python solve.py', {
    rawTask: 'Terminal-Bench 2 task: log-summary-date-ranges',
    executionProfileName: 'benchmark_container',
    allowedCommandBases: ['python'],
    runtimeInventory: inventory({ python: true }),
  });

  assert.equal(resolution.status, 'none');
});

test('tool capability broker rewrites pytest-style test_outputs.py to real pytest execution', () => {
  const resolution = resolveToolCapabilityForCommand('python test_outputs.py', {
    rawTask: 'Terminal-Bench 2 task: break-filter-js-from-html',
    executionProfileName: 'benchmark_container',
    allowedCommandBases: ['python', 'pytest'],
    runtimeInventory: inventory({ python: true, pytest: true }),
  });

  assert.equal(resolution.status, 'suggest_replacement');
  assert.equal(resolution.capabilityId, 'run.pytest_test_outputs');
  assert.equal(resolution.replacementCommand, 'python -m pytest -q test_outputs.py');
});

test('tool capability broker blocks pytest-style verifier rewrite when pytest is missing', () => {
  const resolution = resolveToolCapabilityForCommand('python test_outputs.py', {
    rawTask: 'Terminal-Bench 2 task: break-filter-js-from-html',
    executionProfileName: 'benchmark_container',
    allowedCommandBases: ['python', 'pytest'],
    runtimeInventory: inventory({ python: true, pytest: false }),
  });

  assert.equal(resolution.status, 'blocked_missing_requirement');
  assert.deepEqual(resolution.missingRequirements, ['pytest']);
  assert.match(resolution.message, /no implementation is usable/);
  const feedback = formatToolCapabilityResolutionForFeedback(resolution);
  assert.match(feedback, /Do not retry the same capability/);
  assert.doesNotMatch(feedback, /Suggestions:/);
});

test('tool capability broker blocks canonical python -m pytest when pytest is missing', () => {
  const resolution = resolveToolCapabilityForCommand('python -m pytest -q test_outputs.py', {
    rawTask: 'Terminal-Bench 2 task: break-filter-js-from-html',
    executionProfileName: 'benchmark_container',
    allowedCommandBases: ['python', 'pytest'],
    runtimeInventory: inventory({ python: true, pytest: false }),
  });

  assert.equal(resolution.status, 'blocked_missing_requirement');
  assert.deepEqual(resolution.missingRequirements, ['pytest']);
});

test('tool capability prompt lines expose capability-first guidance', () => {
  const lines = buildToolCapabilityPromptLines('benchmark_container').join('\n');
  assert.match(lines, /Tool capability broker/);
  assert.match(lines, /run\.pytest_test_outputs/);
  assert.match(lines, /inspect\.git_bundle/);
  assert.match(lines, /git bundle verify/);
  assert.match(lines, /Do not substitute a different file format/);
  assert.match(lines, /Do not copy unavailable replacement commands/);
});
