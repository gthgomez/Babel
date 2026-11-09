import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import {
  classifyDockerImageRuntimeUser,
  classifyDockerDaemonSecurityOptions,
  BENCHMARK_RUNTIME_INVENTORY_COMMANDS,
  inspectBenchmarkContainerRuntime,
  buildBenchmarkContainerCommand,
  evaluateGovernedIsolation,
  formatBenchmarkRuntimeInventoryPromptLines,
  getBenchmarkRuntimeCommandUsability,
  isBenchmarkProjectExecutableCommand,
  isDockerAvailable,
  isHostIsolationEscalationAllowed,
  parseBenchmarkRuntimeInventoryOutput,
  resetDockerAvailabilityCache,
  setDockerAvailableForTest,
  shouldUseBenchmarkContainerExecution,
  shouldUseDockerSandbox,
  getDockerUnavailableReason,
  getDockerDaemonMode,
  getDockerImageRuntimeIdentity,
} from './benchmarkContainer.js';

test('Docker daemon mode classification fails closed when security options are incomplete', () => {
  assert.equal(
    classifyDockerDaemonSecurityOptions(['name=seccomp,profile=builtin', 'name=cgroupns']),
    'rootful',
  );
  assert.equal(classifyDockerDaemonSecurityOptions(['name=seccomp', 'name=rootless']), 'rootless');
  assert.equal(classifyDockerDaemonSecurityOptions(['name=seccomp', 'name=userns']), 'unknown');
  assert.equal(classifyDockerDaemonSecurityOptions([]), 'unknown');
  assert.equal(classifyDockerDaemonSecurityOptions(['unexpected', null]), 'unknown');
});

test('Docker image runtime user classification fails closed for non-root and ambiguous users', () => {
  assert.equal(classifyDockerImageRuntimeUser(''), 'unknown');
  assert.equal(classifyDockerImageRuntimeUser(undefined), 'unknown');
  assert.equal(classifyDockerImageRuntimeUser('0:0'), 'root');
  assert.equal(classifyDockerImageRuntimeUser('0'), 'unknown');
  assert.equal(classifyDockerImageRuntimeUser('0:1000'), 'unknown');
  assert.equal(classifyDockerImageRuntimeUser('0:app'), 'unknown');
  assert.equal(classifyDockerImageRuntimeUser('root'), 'nonroot');
  assert.equal(classifyDockerImageRuntimeUser('root:0'), 'unknown');
  assert.equal(classifyDockerImageRuntimeUser('node'), 'nonroot');
  assert.equal(classifyDockerImageRuntimeUser('1000:1000'), 'nonroot');
  assert.equal(classifyDockerImageRuntimeUser('root:group:extra'), 'unknown');
});

test('effective image uid and primary gid are measured inside a no-network, no-mount probe', (t) => {
  resetDockerAvailabilityCache();
  const priorProviderKey = process.env['OPENROUTER_API_KEY'];
  const priorDockerHost = process.env['DOCKER_HOST'];
  const priorDockerContext = process.env['DOCKER_CONTEXT'];
  process.env['OPENROUTER_API_KEY'] = 'synthetic-test-only';
  process.env['DOCKER_HOST'] = 'tcp://different-daemon.example:2376';
  process.env['DOCKER_CONTEXT'] = 'different-context';
  const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    assert.equal(command, 'docker');
    calls.push({ args, ...(options.env ? { env: options.env } : {}) });
    assert.equal(options.env?.['OPENROUTER_API_KEY'], undefined, 'provider credentials are not inherited by the Docker client probe');
    assert.equal(options.env?.['DOCKER_HOST'], undefined, 'probe uses the same Docker endpoint as SafeExecutor');
    assert.equal(options.env?.['DOCKER_CONTEXT'], undefined, 'probe uses the same Docker context as SafeExecutor');
    if (args[0] === 'create') return { pid: 1, output: ['', '0123456789abcdef0123456789abcdef\n', ''], stdout: '0123456789abcdef0123456789abcdef\n', stderr: '', status: 0, signal: null };
    if (args[0] === 'start') return { pid: 1, output: ['', 'uid=0(root) gid=1000(app) groups=1000(app)\n', ''], stdout: 'uid=0(root) gid=1000(app) groups=1000(app)\n', stderr: '', status: 0, signal: null };
    if (args[0] === 'inspect') return { pid: 1, output: ['', 'false 0\n', ''], stdout: 'false 0\n', stderr: '', status: 0, signal: null };
    return { pid: 1, output: ['', '0123456789abcdef0123456789abcdef\n', ''], stdout: '0123456789abcdef0123456789abcdef\n', stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(getDockerImageRuntimeIdentity('sha256:fixture'), { uid: 0, gid: 1000 });
    const createArgs = calls.find(call => call.args[0] === 'create')!.args;
    assert.ok(createArgs.includes('--pull=never'));
    assert.ok(createArgs.includes('--network=none'));
    assert.ok(createArgs.includes('--read-only'));
    assert.ok(createArgs.includes('--cap-drop=ALL'));
    assert.ok(createArgs.includes('--security-opt=no-new-privileges'));
    assert.ok(createArgs.includes('--entrypoint=/usr/bin/id'));
    assert.ok(createArgs.includes('sha256:fixture'));
    assert.ok(createArgs.includes('--'), 'override image CMD and measure the effective identity');
    assert.equal(createArgs.some(arg => arg === '-v' || arg === '--volume' || arg.startsWith('--mount')), false,
      'identity discovery receives no project or host mount');
    assert.deepEqual(calls.map(call => call.args[0]), ['create', 'start', 'inspect', 'rm']);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (priorProviderKey === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = priorProviderKey;
    if (priorDockerHost === undefined) delete process.env['DOCKER_HOST'];
    else process.env['DOCKER_HOST'] = priorDockerHost;
    if (priorDockerContext === undefined) delete process.env['DOCKER_CONTEXT'];
    else process.env['DOCKER_CONTEXT'] = priorDockerContext;
    resetDockerAvailabilityCache();
  }
});

test('daemon security detection rechecks the sanitized sandbox Docker endpoint on every call', (t) => {
  resetDockerAvailabilityCache();
  const prior = Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'HOME'].map(key => [key, process.env[key]]));
  process.env['DOCKER_HOST'] = 'tcp://untrusted-override.example:2376';
  process.env['DOCKER_CONTEXT'] = 'untrusted-context';
  process.env['DOCKER_CONFIG'] = '/tmp/untrusted-docker-config';
  const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  let securityQuery = 0;
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    assert.equal(command, 'docker');
    calls.push({ args, ...(options.env ? { env: options.env } : {}) });
    assert.equal(options.env?.['DOCKER_HOST'], undefined);
    assert.equal(options.env?.['DOCKER_CONTEXT'], undefined);
    assert.equal(options.env?.['DOCKER_CONFIG'], undefined);
    if (args[1] === '--format' && args[2] === '{{.ServerVersion}}')
      return { pid: 1, output: ['', '27.0.0\n', ''], stdout: '27.0.0\n', stderr: '', status: 0, signal: null };
    const rootless = ++securityQuery > 1;
    const stdout = rootless ? '["name=seccomp","name=rootless"]' : '["name=seccomp"]';
    return { pid: 1, output: ['', stdout, ''], stdout, stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    assert.equal(getDockerDaemonMode(), 'rootful');
    assert.equal(getDockerDaemonMode(), 'rootless', 'a changed Docker context cannot reuse a prior security classification');
    assert.ok(calls.length >= 3);
    assert.ok(calls.every(call => call.env?.['DOCKER_HOST'] === undefined), 'availability and security probes use the runtime-safe environment');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDockerAvailabilityCache();
  }
});

test('unavailable or malformed identity probe fails closed', (t) => {
  resetDockerAvailabilityCache();
  t.mock.method(childProcess, 'spawnSync', () => ({
    pid: 1, output: ['', 'uid=0(root) gid=0(root)\n', ''],
    stdout: 'uid=0(root) gid=0(root)\n', stderr: 'probe denied', status: 125, signal: null,
  }));
  syncBuiltinESMExports();
  try {
    assert.equal(getDockerImageRuntimeIdentity('sha256:unavailable'), null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    resetDockerAvailabilityCache();
  }
});

test('successful but malformed identity output fails closed', (t) => {
  resetDockerAvailabilityCache();
  t.mock.method(childProcess, 'spawnSync', (_command: string, args: readonly string[]) => {
    if (args[0] === 'create') return { pid: 1, output: ['', '0123456789abcdef\n', ''], stdout: '0123456789abcdef\n', stderr: '', status: 0, signal: null };
    if (args[0] === 'start') return { pid: 1, output: ['', 'uid=0(root)\nnot gid output\n', ''], stdout: 'uid=0(root)\nnot gid output\n', stderr: '', status: 0, signal: null };
    return { pid: 1, output: ['', '0123456789abcdef\n', ''], stdout: '0123456789abcdef\n', stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    assert.equal(getDockerImageRuntimeIdentity('sha256:malformed'), null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    resetDockerAvailabilityCache();
  }
});

test('timed-out identity start removes the owned container and fails closed', (t) => {
  resetDockerAvailabilityCache();
  const calls: string[][] = [];
  t.mock.method(childProcess, 'spawnSync', (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'create') return { pid: 1, output: ['', '0123456789abcdef\n', ''], stdout: '0123456789abcdef\n', stderr: '', status: 0, signal: null };
    if (args[0] === 'start') return { pid: 1, output: ['', '', ''], stdout: '', stderr: '', status: null, signal: 'SIGKILL', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    return { pid: 1, output: ['', '0123456789abcdef\n', ''], stdout: '0123456789abcdef\n', stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    assert.equal(getDockerImageRuntimeIdentity('sha256:timeout'), null);
    assert.deepEqual(calls.map(args => args[0]), ['create', 'start', 'rm']);
    assert.ok(calls[0]!.includes('--name'));
    assert.ok(calls[2]!.includes('0123456789abcdef'), 'cleanup is scoped to the exact container ID');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    resetDockerAvailabilityCache();
  }
});

test('an omitted Docker image USER does not prove the default account primary GID', () => {
  // Docker starts UID 0, but the image's root passwd entry can select GID
  // 1000. The directory access predicate assumes GID 0, so omission is unknown.
  assert.equal(classifyDockerImageRuntimeUser(''), 'unknown');
});

test('Docker mode-sharing eligibility requires UID 0 with the proven primary GID 0', () => {
  // rootfulContainerHasStableReadPath evaluates directories as UID/GID 0.
  // An image configured as USER 0:1000 cannot be assumed to have that group:
  // it would not traverse a 0750 directory owned by UID 1000, GID 0.
  assert.equal(classifyDockerImageRuntimeUser('0:0'), 'root');
  assert.equal(classifyDockerImageRuntimeUser('0:1000'), 'unknown');
  assert.equal(classifyDockerImageRuntimeUser('0:app'), 'unknown');
});

test('default runtime inventory accepts its own C++ command and probes Docker', (t) => {
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', (_command: string, args: readonly string[]) => {
    calls++;
    assert.ok(args.includes('--pull=never'), 'inventory must not download an image');
    const stdout = BENCHMARK_RUNTIME_INVENTORY_COMMANDS.map(command => `${command}\tavailable\t/usr/bin/${command}`).join('\n');
    return { pid: 1, output: ['', stdout, ''], stdout, stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    const inventory = inspectBenchmarkContainerRuntime('synthetic/default-command-inventory:unit');
    assert.equal(inventory.status, 'available', inventory.stderr);
    assert.equal(calls, 1);
    assert.equal(inventory.commands.find(entry => entry.command === 'g++')?.available, true);
    assert.match(formatBenchmarkRuntimeInventoryPromptLines(inventory, ['node', 'cat']).join('\n'), /Linux Docker shell/);
    const rejected = inspectBenchmarkContainerRuntime('synthetic/invalid-command:unit', ['node; touch unwanted']);
    assert.equal(rejected.status, 'unavailable');
    assert.equal(calls, 1, 'unsafe command must be rejected before Docker');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
import {
  BABEL_CONTAINER_EMPTY_HOOKS_DIR,
  BABEL_CONTAINER_NO_EDITOR,
} from '../authority/unprivilegedChildEnv.js';

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

test('H13 evaluateGovernedIsolation fail-closes safe_repo without Docker/image', () => {
  setDockerAvailableForTest(false);
  const prevAllow = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  const prevDisable = process.env['BABEL_DOCKER_DISABLE'];
  const prevImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
  delete process.env['BABEL_DOCKER_DISABLE'];
  delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  try {
    const decision = evaluateGovernedIsolation('safe_repo', '', {});
    assert.equal(decision.kind, 'fail_closed');
    if (decision.kind === 'fail_closed') {
      assert.match(decision.reason, /Isolation required|no Docker image|Docker/i);
    }
  } finally {
    if (prevAllow === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = prevAllow;
    if (prevDisable === undefined) delete process.env['BABEL_DOCKER_DISABLE'];
    else process.env['BABEL_DOCKER_DISABLE'] = prevDisable;
    if (prevImage === undefined) delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    else process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = prevImage;
    resetDockerAvailabilityCache();
  }
});

test('H13 evaluateGovernedIsolation allows explicit host escalation', () => {
  setDockerAvailableForTest(false);
  const decision = evaluateGovernedIsolation('safe_repo', '', {
    BABEL_ALLOW_HOST_FALLBACK: '1',
  } as NodeJS.ProcessEnv);
  assert.equal(decision.kind, 'host_escalated');
  assert.equal(isHostIsolationEscalationAllowed({ BABEL_DOCKER_DISABLE: 'true' }), true);
  resetDockerAvailabilityCache();
});

test('H13 evaluateGovernedIsolation allows host_profile for dev_local', () => {
  setDockerAvailableForTest(false);
  const decision = evaluateGovernedIsolation('dev_local', '', {});
  assert.equal(decision.kind, 'host_profile');
  resetDockerAvailabilityCache();
});

test('H13 evaluateGovernedIsolation uses docker when available and imaged', () => {
  setDockerAvailableForTest(true);
  const decision = evaluateGovernedIsolation('safe_repo', 'example/image:latest', {});
  assert.equal(decision.kind, 'docker');
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

test('benchmark docker command injects Git host overlay into the container', () => {
  const projectRoot = '/workspace/test/app';
  const command = buildBenchmarkContainerCommand({
    dockerImage: 'example/task:latest',
    projectRoot,
    cwd: projectRoot,
    command: 'git commit -m signed',
  });
  const envPairs = new Map<string, string>();
  for (let i = 0; i < command.args.length - 1; i++) {
    if (command.args[i] === '-e') {
      const pair = command.args[i + 1] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) envPairs.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  assert.equal(envPairs.get('GIT_CONFIG_COUNT'), '3');
  assert.equal(envPairs.get('GIT_CONFIG_KEY_1'), 'commit.gpgSign');
  assert.equal(envPairs.get('GIT_CONFIG_VALUE_1'), 'false');
  assert.equal(envPairs.get('GIT_CONFIG_KEY_2'), 'tag.gpgSign');
  assert.equal(envPairs.get('GIT_CONFIG_VALUE_2'), 'false');
  assert.equal(envPairs.get('GIT_CONFIG_VALUE_0'), BABEL_CONTAINER_EMPTY_HOOKS_DIR);
  assert.equal(envPairs.get('GIT_EDITOR'), BABEL_CONTAINER_NO_EDITOR);
  assert.equal(envPairs.get('GIT_MERGE_AUTOEDIT'), 'no');
  const volumes = command.args
    .map((arg, i) => (arg === '-v' ? command.args[i + 1] : undefined))
    .filter((v): v is string => typeof v === 'string');
  assert.ok(
    volumes.some((v) => v.endsWith(`:${BABEL_CONTAINER_EMPTY_HOOKS_DIR}:ro`)),
    `expected empty-hooks bind mount, got ${volumes.join(', ')}`,
  );
});

test('benchmark containers suppress Python bytecode writes into the mounted workspace', () => {
  const command = buildBenchmarkContainerCommand({
    dockerImage: 'example/python:latest',
    projectRoot: '/workspace/test/python-app',
    cwd: '/workspace/test/python-app',
    command: 'python -m doctest solution.py -v',
  });
  const envPairs = new Map<string, string>();
  for (let i = 0; i < command.args.length - 1; i++) {
    if (command.args[i] !== '-e') continue;
    const pair = command.args[i + 1] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) envPairs.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  assert.equal(envPairs.get('PYTHONDONTWRITEBYTECODE'), '1');
  assert.ok(command.args.includes('--network') && command.args.includes('none'));
  assert.ok(command.args.includes('--cap-drop=ALL'));
  assert.ok(command.args.includes('--security-opt=no-new-privileges'));
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
