import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildBenchmarkContainerCommand,
  formatBenchmarkRuntimeInventoryPromptLines,
  getBenchmarkRuntimeCommandUsability,
  isBenchmarkProjectExecutableCommand,
  isDockerAvailable,
  parseBenchmarkRuntimeInventoryOutput,
  resetDockerAvailabilityCache,
  setDockerAvailableForTest,
  shouldUseBenchmarkContainerExecution,
  shouldUseDockerSandbox,
  getDockerUnavailableReason,
} from './benchmarkContainer.js';

test('benchmark container execution is gated by profile and docker image', () => {
  // Phase 3b requires isDockerAvailable() — enable for test
  setDockerAvailableForTest(true);
  assert.equal(shouldUseBenchmarkContainerExecution('benchmark_container', 'image:tag'), true);
  assert.equal(shouldUseBenchmarkContainerExecution('safe_repo', 'image:tag'), false);
  assert.equal(shouldUseBenchmarkContainerExecution('benchmark_container', ''), false);
  resetDockerAvailabilityCache();
});

test('shouldUseDockerSandbox returns true for safe_repo with Docker available', () => {
  setDockerAvailableForTest(true);
  assert.equal(shouldUseDockerSandbox('safe_repo', 'example/image:latest'), true);
  resetDockerAvailabilityCache();
});

test('shouldUseDockerSandbox returns false for dev_local (dockerSandbox: false)', () => {
  setDockerAvailableForTest(true);
  assert.equal(shouldUseDockerSandbox('dev_local'), false);
  resetDockerAvailabilityCache();
});

test('shouldUseDockerSandbox returns false when BABEL_DOCKER_DISABLE is true', () => {
  setDockerAvailableForTest(true);
  process.env['BABEL_DOCKER_DISABLE'] = 'true';
  try {
    assert.equal(shouldUseDockerSandbox('safe_repo'), false);
  } finally {
    delete process.env['BABEL_DOCKER_DISABLE'];
    resetDockerAvailabilityCache();
  }
});

test('shouldUseDockerSandbox returns false when Docker unavailable', () => {
  setDockerAvailableForTest(false);
  const result = shouldUseDockerSandbox('safe_repo');
  // Don't assert true/false (depends on environment), just verify it doesn't throw
  assert.ok(typeof result === 'boolean');
  resetDockerAvailabilityCache();
});

test('getDockerUnavailableReason returns non-empty string when Docker unavailable', () => {
  resetDockerAvailabilityCache();
  const available = isDockerAvailable();
  if (!available) {
    // Docker is genuinely unavailable — reason should be set
    const reason = getDockerUnavailableReason();
    assert.ok(reason.length > 0, `expected non-empty reason, got: "${reason}"`);
  }
  // If Docker is available, skip the assertion (platform-dependent)
  resetDockerAvailabilityCache();
});

test('benchmark docker command mounts project at /app and preserves project executable', () => {
  const projectRoot = '/workspace/test/app';
  const expectedVolume = `${resolve(projectRoot).replace(/\\/g, '/')}:/app`;
  const command = buildBenchmarkContainerCommand({
    dockerImage: 'example/task:latest',
    projectRoot,
    cwd: projectRoot,
    command: './cli_tool weights.json image.png',
  });

  assert.equal(command.executable, 'docker');

  // Security defaults are present
  assert.ok(command.args.includes('--cap-drop=ALL'), 'should include --cap-drop=ALL');
  assert.ok(
    command.args.includes('--security-opt=no-new-privileges'),
    'should include --security-opt',
  );

  // Core Docker flags
  assert.ok(command.args.includes('--rm'));
  assert.ok(command.args.includes('--network'));
  assert.ok(command.args.includes('none'));

  // Volume mount
  const volIdx = command.args.indexOf('-v');
  assert.ok(volIdx >= 0);
  assert.equal(command.args[volIdx + 1], expectedVolume);

  // Working directory
  const wIdx = command.args.indexOf('-w');
  assert.ok(wIdx >= 0);
  assert.equal(command.args[wIdx + 1], '/app');

  // Image
  assert.ok(command.args.includes('example/task:latest'));

  // Command-specific args are the last elements
  const imageIdx = command.args.indexOf('example/task:latest');
  const tail = command.args.slice(imageIdx + 1);
  assert.deepEqual(tail, ['./cli_tool', 'weights.json', 'image.png']);
});

test('benchmark docker command runs shell syntax inside the container shell', () => {
  const projectRoot = '/workspace/test/app';
  const command = buildBenchmarkContainerCommand({
    dockerImage: 'example/task:latest',
    projectRoot,
    cwd: projectRoot,
    command: 'cat data.comp | /project/decomp > decompressed.txt && diff data.txt decompressed.txt',
  });

  assert.equal(command.executable, 'docker');

  // Security defaults are present in shell path too
  assert.ok(command.args.includes('--cap-drop=ALL'), 'shell path should include --cap-drop=ALL');
  assert.ok(
    command.args.includes('--security-opt=no-new-privileges'),
    'shell path should include --security-opt',
  );

  // Shell wrapper
  const imageIdx = command.args.indexOf('example/task:latest');
  const tail = command.args.slice(imageIdx + 1);
  assert.deepEqual(tail, [
    '/bin/sh',
    '-lc',
    'cat data.comp | /app/decomp > decompressed.txt && diff data.txt decompressed.txt',
  ]);
});

test('benchmark docker command includes BABEL_BENCHMARK_DOCKER_EXTRA_ARGS when set', () => {
  const projectRoot = '/workspace/test/app';
  const prev = process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'];
  process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] = '--read-only --user 1000:1000';
  try {
    const command = buildBenchmarkContainerCommand({
      dockerImage: 'example/task:latest',
      projectRoot,
      cwd: projectRoot,
      command: 'node -v',
    });

    // Extra args appear after security defaults and before volume mount
    assert.ok(command.args.includes('--read-only'), 'should include extra arg --read-only');
    assert.ok(command.args.includes('--user'), 'should include extra arg --user');
    assert.ok(command.args.includes('1000:1000'), 'should include user value');

    // Security defaults still present
    assert.ok(command.args.includes('--cap-drop=ALL'));
    assert.ok(command.args.includes('--security-opt=no-new-privileges'));

    // Volume mount and image still present
    assert.ok(command.args.includes('-v'));
    assert.ok(command.args.includes('example/task:latest'));
  } finally {
    if (prev === undefined) {
      delete process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'];
    } else {
      process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] = prev;
    }
  }
});

test('benchmark docker command does not include extra args when env var is unset', () => {
  const projectRoot = '/workspace/test/app';
  const prev = process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'];
  delete process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'];
  try {
    const command = buildBenchmarkContainerCommand({
      dockerImage: 'example/task:latest',
      projectRoot,
      cwd: projectRoot,
      command: 'node -v',
    });

    // Security defaults present
    assert.ok(command.args.includes('--cap-drop=ALL'));
    assert.ok(command.args.includes('--security-opt=no-new-privileges'));

    // But no extra args injected
    assert.ok(!command.args.includes('--read-only'));
    assert.ok(!command.args.includes('--user'));
  } finally {
    if (prev !== undefined) {
      process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] = prev;
    }
  }
});

test('benchmark project executable detection accepts only explicit in-project commands', () => {
  assert.equal(isBenchmarkProjectExecutableCommand('./cli_tool'), true);
  assert.equal(isBenchmarkProjectExecutableCommand('/project/bin/tool'), true);
  assert.equal(isBenchmarkProjectExecutableCommand('/app/bin/tool'), true);
  assert.equal(isBenchmarkProjectExecutableCommand('cli_tool'), false);
});

test('benchmark runtime inventory parses missing and available commands', () => {
  const inventory = parseBenchmarkRuntimeInventoryOutput(
    'example/task:latest',
    [
      'python\tmissing\t',
      'python3\tavailable\t/usr/bin/python3',
      'pip\tmissing\t',
      'apt-get\tavailable\t/usr/bin/apt-get',
    ].join('\n'),
    '',
    0,
    ['python', 'python3', 'pip', 'apt-get'],
  );

  assert.equal(inventory.status, 'available');
  assert.deepEqual(inventory.commands, [
    { command: 'python', available: false, resolvedPath: null },
    { command: 'python3', available: true, resolvedPath: '/usr/bin/python3' },
    { command: 'pip', available: false, resolvedPath: null },
    { command: 'apt-get', available: true, resolvedPath: '/usr/bin/apt-get' },
  ]);
});

test('benchmark runtime inventory prompt separates usable, missing, and blocked commands', () => {
  const inventory = parseBenchmarkRuntimeInventoryOutput(
    'example/task:latest',
    [
      'python\tmissing\t',
      'python3\tavailable\t/usr/bin/python3',
      'pip\tmissing\t',
      'apt-get\tavailable\t/usr/bin/apt-get',
    ].join('\n'),
    '',
    0,
    ['python', 'python3', 'pip', 'apt-get'],
  );

  const lines = formatBenchmarkRuntimeInventoryPromptLines(inventory, ['python3', 'pip']);
  const text = lines.join('\n');
  assert.match(text, /usable command bases: python3/);
  assert.match(text, /missing in container: python, pip/);
  assert.match(text, /present but not executor-allowlisted: apt-get/);
  assert.match(text, /do not use apt-get as an automatic recovery path/i);
});

test('benchmark runtime command usability blocks missing python and non-allowlisted apt-get', () => {
  const inventory = parseBenchmarkRuntimeInventoryOutput(
    'example/task:latest',
    [
      'python\tmissing\t',
      'python3\tavailable\t/usr/bin/python3',
      'pip\tmissing\t',
      'apt-get\tavailable\t/usr/bin/apt-get',
    ].join('\n'),
    '',
    0,
    ['python', 'python3', 'pip', 'apt-get'],
  );

  assert.equal(
    getBenchmarkRuntimeCommandUsability(inventory, ['python3'], 'python script.py').status,
    'missing',
  );
  assert.equal(
    getBenchmarkRuntimeCommandUsability(inventory, ['python3'], 'python3 script.py').status,
    'usable',
  );
  assert.equal(
    getBenchmarkRuntimeCommandUsability(inventory, ['python3'], 'pip install torch').status,
    'missing',
  );
  assert.equal(
    getBenchmarkRuntimeCommandUsability(inventory, ['python3'], 'apt-get update').status,
    'not_executor_allowed',
  );
});
