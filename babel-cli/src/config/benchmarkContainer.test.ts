import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildBenchmarkContainerCommand,
  formatBenchmarkRuntimeInventoryPromptLines,
  getBenchmarkRuntimeCommandUsability,
  isBenchmarkProjectExecutableCommand,
  parseBenchmarkRuntimeInventoryOutput,
  shouldUseBenchmarkContainerExecution,
} from './benchmarkContainer.js';

test('benchmark container execution is gated by profile and docker image', () => {
  assert.equal(shouldUseBenchmarkContainerExecution('benchmark_container', 'image:tag'), true);
  assert.equal(shouldUseBenchmarkContainerExecution('safe_repo', 'image:tag'), false);
  assert.equal(shouldUseBenchmarkContainerExecution('benchmark_container', ''), false);
});

test('benchmark docker command mounts project at /app and preserves project executable', () => {
  const command = buildBenchmarkContainerCommand({
    dockerImage: 'example/task:latest',
    projectRoot: '/workspace-root/tmp/app',
    cwd: '/workspace-root/tmp/app',
    command: './cli_tool weights.json image.png',
  });

  assert.equal(command.executable, 'docker');
  assert.deepEqual(command.args.slice(0, 7), [
    'run',
    '--rm',
    '-v',
    `${resolve('/workspace-root/tmp/app').replace(/\\/g, '/')}:/app`,
    '-w',
    '/app',
    'example/task:latest',
  ]);
  assert.deepEqual(command.args.slice(7), ['./cli_tool', 'weights.json', 'image.png']);
});

test('benchmark docker command runs shell syntax inside the container shell', () => {
  const command = buildBenchmarkContainerCommand({
    dockerImage: 'example/task:latest',
    projectRoot: '/workspace-root/tmp/app',
    cwd: '/workspace-root/tmp/app',
    command: 'cat data.comp | /project/decomp > decompressed.txt && diff data.txt decompressed.txt',
  });

  assert.equal(command.executable, 'docker');
  assert.deepEqual(command.args.slice(7), [
    '/bin/sh',
    '-lc',
    'cat data.comp | /app/decomp > decompressed.txt && diff data.txt decompressed.txt',
  ]);
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
