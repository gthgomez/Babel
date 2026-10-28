import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  SafeExecutor,
  awaitPendingProcessTerminations,
  spawnCommandAsync,
  isTransientSpawnError,
  normalizeSupervisorTerminatedShellOutput,
  validateExecutorShellCommand,
} from './sandbox.js';
import { isProcessAlive, waitForProcessExit } from './processTree.js';
import { ProcessWitness } from './diagnostics/bdns/processWitness.js';
import {
  setDockerAvailableForTest,
  resetDockerAvailabilityCache,
} from './config/benchmarkContainer.js';
import { approveApproval, requestDependencyInstallApproval } from './services/approvalQueue.js';

// H13: unit sandbox tests exercise host path policy without a Docker image.
// Explicit escalation keeps fail-closed isolation from blocking fixtures.
if (!process.env['BABEL_ALLOW_HOST_FALLBACK'] && process.env['BABEL_DOCKER_DISABLE'] !== 'true') {
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
}

function makeFixture() {
  const rootParent = mkdtempSync(join(tmpdir(), 'babel-sandbox-root-'));
  const outsideParent = mkdtempSync(join(tmpdir(), 'babel-sandbox-outside-'));
  const projectRoot = join(rootParent, 'project');
  const outsideRoot = join(outsideParent, 'outside');

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, 'nested'), { recursive: true });
  mkdirSync(join(projectRoot, 'real-target'), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });

  writeFileSync(join(projectRoot, 'safe.txt'), 'safe-root\n', 'utf-8');
  writeFileSync(join(projectRoot, 'nested', 'inside.txt'), 'inside\n', 'utf-8');
  writeFileSync(join(projectRoot, 'real-target', 'linked.txt'), 'linked-inside\n', 'utf-8');
  writeFileSync(join(outsideRoot, 'outside.txt'), 'outside\n', 'utf-8');

  const insideLink = join(projectRoot, 'inside-link');
  const outsideLink = join(projectRoot, 'outside-link');
  symlinkSync(
    join(projectRoot, 'real-target'),
    insideLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  symlinkSync(outsideRoot, outsideLink, process.platform === 'win32' ? 'junction' : 'dir');

  return {
    projectRoot,
    outsideRoot,
    cleanup() {
      rmSync(rootParent, { recursive: true, force: true });
      rmSync(outsideParent, { recursive: true, force: true });
    },
  };
}

function expectPolicyDenial(
  result: { exit_code: number; stderr: string; denial?: { reason_code: string } },
  expectedReason: string,
): void {
  assert.equal(result.exit_code, 1);
  assert.equal(result.denial?.reason_code, expectedReason);
}

function withApprovalQueue<T>(run: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'babel-sandbox-approvals-'));
  const previous = process.env['BABEL_APPROVAL_QUEUE_PATH'];
  process.env['BABEL_APPROVAL_QUEUE_PATH'] = join(root, 'approval-queue.json');
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_APPROVAL_QUEUE_PATH'];
    } else {
      process.env['BABEL_APPROVAL_QUEUE_PATH'] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('sandbox file operations stay usable for in-root paths', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);

    assert.match(executor.fileRead('safe.txt').stdout, /safe-root/);
    assert.match(executor.fileRead('/project/safe.txt').stdout, /safe-root/);
    assert.match(executor.fileRead('nested\\inside.txt').stdout, /inside/);
    assert.match(executor.listDirectory('.').stdout, /safe\.txt/);
    assert.match(executor.listDirectory('/project/nested').stdout, /inside\.txt/);

    const writeResult = executor.fileWrite('nested/output.txt', 'created\n');
    assert.equal(writeResult.exit_code, 0);
    assert.equal(
      readFileSync(join(fixture.projectRoot, 'nested', 'output.txt'), 'utf-8'),
      'created\n',
    );
  } finally {
    fixture.cleanup();
  }
});

const traversalCases = [
  '../outside.txt',
  '..\\outside.txt',
  '../../escape.txt',
  'nested/../../outside.txt',
  'nested\\..\\..\\outside.txt',
  '/project/../outside.txt',
  '/project/..\\outside.txt',
  '/project/nested/../../../outside.txt',
];

for (const inputPath of traversalCases) {
  test(`fileRead rejects traversal path: ${inputPath}`, () => {
    const fixture = makeFixture();
    try {
      const executor = new SafeExecutor(fixture.projectRoot);
      expectPolicyDenial(executor.fileRead(inputPath), 'path_jail_rejected');
    } finally {
      fixture.cleanup();
    }
  });

  test(`fileWrite rejects traversal path: ${inputPath}`, () => {
    const fixture = makeFixture();
    try {
      const executor = new SafeExecutor(fixture.projectRoot);
      expectPolicyDenial(executor.fileWrite(inputPath, 'nope\n'), 'path_jail_rejected');
    } finally {
      fixture.cleanup();
    }
  });

  test(`directory_list rejects traversal path: ${inputPath}`, () => {
    const fixture = makeFixture();
    try {
      const executor = new SafeExecutor(fixture.projectRoot);
      expectPolicyDenial(executor.listDirectory(inputPath), 'path_jail_rejected');
    } finally {
      fixture.cleanup();
    }
  });
}

test('absolute outside fileRead is rejected', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(
      executor.fileRead(join(fixture.outsideRoot, 'outside.txt')),
      'path_jail_rejected',
    );
  } finally {
    fixture.cleanup();
  }
});

test('absolute outside fileWrite is rejected', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(
      executor.fileWrite(join(fixture.outsideRoot, 'created.txt'), 'blocked\n'),
      'path_jail_rejected',
    );
  } finally {
    fixture.cleanup();
  }
});

test('internal symlink reads stay inside the project root', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = executor.fileRead('inside-link/linked.txt');
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /linked-inside/);
  } finally {
    fixture.cleanup();
  }
});

test('internal symlink writes land on the real in-root target', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = executor.fileWrite('inside-link/new.txt', 'through-link\n');
    assert.equal(result.exit_code, 0);
    assert.equal(
      readFileSync(join(fixture.projectRoot, 'real-target', 'new.txt'), 'utf-8'),
      'through-link\n',
    );
  } finally {
    fixture.cleanup();
  }
});

test('internal symlink directory listing stays allowed', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = executor.listDirectory('inside-link');
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /linked\.txt/);
  } finally {
    fixture.cleanup();
  }
});

test('outside symlink fileRead is rejected', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(executor.fileRead('outside-link/outside.txt'), 'symlink_escape_rejected');
  } finally {
    fixture.cleanup();
  }
});

test('outside symlink fileWrite is rejected', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(
      executor.fileWrite('outside-link/created.txt', 'blocked\n'),
      'symlink_escape_rejected',
    );
  } finally {
    fixture.cleanup();
  }
});

test('outside symlink directory_list is rejected', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(executor.listDirectory('outside-link'), 'symlink_escape_rejected');
  } finally {
    fixture.cleanup();
  }
});

test('outside symlink with missing descendant is rejected before write', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(
      executor.fileWrite('outside-link/more/nested.txt', 'blocked\n'),
      'symlink_escape_rejected',
    );
  } finally {
    fixture.cleanup();
  }
});

test('plan mode rejects mutating file writes', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot, null, 'plan');
    expectPolicyDenial(executor.fileWrite('nested/output.txt', 'blocked\n'), 'planning_restricted');
  } finally {
    fixture.cleanup();
  }
});

test('plan mode rejects shell execution', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot, null, 'plan');
    expectPolicyDenial(executor.shellExec('node -v', '.', 5_000), 'planning_restricted');
  } finally {
    fixture.cleanup();
  }
});

test('shellExec rejects working directories outside the project root', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = executor.shellExec('node -v', fixture.outsideRoot, 5_000);
    expectPolicyDenial(result, 'path_jail_rejected');
  } finally {
    fixture.cleanup();
  }
});

test('safe_repo Docker cwd support does not add virtual file-write aliases', (t) => {
  const fixture = makeFixture();
  const names = ['BABEL_EXECUTION_PROFILE', 'BABEL_BENCHMARK_DOCKER_IMAGE', 'BABEL_DOCKER_DISABLE', 'BABEL_ALLOW_HOST_FALLBACK'] as const;
  const previous = names.map(name => [name, process.env[name]] as const);
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[]) => {
    calls++;
    assert.equal(command, 'docker');
    assert.equal(args[args.indexOf('-w') + 1], '/app');
    return { pid: 1, output: ['', 'cwd probe', ''], stdout: 'cwd probe', stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'synthetic/sandbox:unit';
    delete process.env['BABEL_DOCKER_DISABLE'];
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    setDockerAvailableForTest(true);
    const executor = new SafeExecutor(fixture.projectRoot);
    writeFileSync(join(fixture.projectRoot, 'AGENTS.md'), 'protected sentinel');
    const blocked = executor.fileWrite('/app/AGENTS.md', 'changed');
    assert.notEqual(blocked.exit_code, 0, 'virtual file targets must not bypass upstream policy/transaction paths');
    assert.equal(readFileSync(join(fixture.projectRoot, 'AGENTS.md'), 'utf8'), 'protected sentinel');
    assert.throws(() => executor.resolveSafe('/app'));
    assert.throws(() => executor.resolveSafe('/app/../outside.txt'));
    const cwdProbe = executor.shellExec('echo cwd', '/app', 5_000);
    assert.equal(cwdProbe.exit_code, 0, cwdProbe.stderr);
    assert.equal(calls, 1);
    const traversal = executor.shellExec('echo cwd', '/app/../outside.txt', 5_000);
    assert.notEqual(traversal.exit_code, 0);
    assert.equal(calls, 1, 'cwd traversal must not spawn');
    setDockerAvailableForTest(false);
    assert.throws(() => executor.resolveSafe('/app'));
    assert.notEqual(executor.shellExec('echo cwd', '/app', 5_000).exit_code, 0);
    assert.equal(calls, 1, 'absent Docker must not map cwd or spawn');
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    resetDockerAvailabilityCache();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fixture.cleanup();
  }
});

test('benchmark_container maps /app file paths to the project root mirror', () => {
  const fixture = makeFixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  try {
    process.env['BABEL_EXECUTION_PROFILE'] = 'benchmark_container';
    const executor = new SafeExecutor(fixture.projectRoot);

    assert.match(executor.fileRead('/app/safe.txt').stdout, /safe-root/);
    const writeResult = executor.fileWrite('/app/nested/benchmark-output.txt', 'mapped\n');

    assert.equal(writeResult.exit_code, 0);
    assert.equal(
      readFileSync(join(fixture.projectRoot, 'nested', 'benchmark-output.txt'), 'utf-8'),
      'mapped\n',
    );
  } finally {
    if (previousProfile === undefined) {
      delete process.env['BABEL_EXECUTION_PROFILE'];
    } else {
      process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    }
    fixture.cleanup();
  }
});

test('benchmark_container maps /app shell working directory to the project root mirror', () => {
  const fixture = makeFixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  try {
    process.env['BABEL_EXECUTION_PROFILE'] = 'benchmark_container';
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = executor.shellExec('echo v1.0', '/app', 5_000);

    assert.equal(result.exit_code, 0, result.stderr);
    assert.match(result.stdout, /v1\.0/);
  } finally {
    if (previousProfile === undefined) {
      delete process.env['BABEL_EXECUTION_PROFILE'];
    } else {
      process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    }
    fixture.cleanup();
  }
});

test(
  'final write target symlink to outside file is rejected',
  { skip: process.platform === 'win32' ? 'POSIX file symlink fixture; Windows directory junction covered separately' : false },
  () => {
    const fixture = makeFixture();
    try {
      const symlinkPath = join(fixture.projectRoot, 'linked-file.txt');
      const outsideFile = join(fixture.outsideRoot, 'outside.txt');
      symlinkSync(outsideFile, symlinkPath, 'file');

      const executor = new SafeExecutor(fixture.projectRoot);
      expectPolicyDenial(
        executor.fileWrite('linked-file.txt', 'blocked\n'),
        'symlink_escape_rejected',
      );
      assert.equal(readFileSync(outsideFile, 'utf-8'), 'outside\n');
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  'final write target symlink to in-root file is rejected to avoid TOCTOU swaps',
  { skip: process.platform === 'win32' ? 'POSIX file symlink fixture; Windows directory junction covered separately' : false },
  () => {
    const fixture = makeFixture();
    try {
      const symlinkPath = join(fixture.projectRoot, 'linked-inside-file.txt');
      const insideFile = join(fixture.projectRoot, 'safe.txt');
      symlinkSync(insideFile, symlinkPath, 'file');

      const executor = new SafeExecutor(fixture.projectRoot);
      expectPolicyDenial(
        executor.fileWrite('linked-inside-file.txt', 'blocked\n'),
        'symlink_escape_rejected',
      );
      assert.equal(readFileSync(insideFile, 'utf-8'), 'safe-root\n');
    } finally {
      fixture.cleanup();
    }
  },
);

test('fileWrite rejects a final in-root directory alias before resolving it', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(executor.fileWrite('inside-link', 'blocked\n'), 'symlink_escape_rejected');
    assert.equal(readFileSync(join(fixture.projectRoot, 'real-target', 'linked.txt'), 'utf8'), 'linked-inside\n');
  } finally {
    fixture.cleanup();
  }
});

const allowedCommands = [
  'npm test',
  'node app.js',
  'git status',
  'java -version',
  'winget list',
  'gradle test',
  'gradlew.bat test',
  'sdkmanager --list',
  'adb devices',
  'python -m pytest',
  'python3 -V',
  'py -3',
  'pytest -q',
  'pip list',
  'pip3 list',
  'deno test',
];

for (const command of allowedCommands) {
  test(`allowlist accepts command: ${command}`, () => {
    assert.equal(validateExecutorShellCommand(command, process.platform), null);
  });
}

const rejectedOperatorCommands = [
  'npm test; echo pwned',
  'npm test && echo pwned',
  'npm | cat',
  'npm > out.txt',
  'npm < in.txt',
  'npm $(whoami)',
  'npm `whoami`',
  'npm test\nwhoami',
];

for (const command of rejectedOperatorCommands) {
  test(`shell operator validation rejects: ${command.replace(/\n/g, '\\n')}`, () => {
    const issue = validateExecutorShellCommand(command, process.platform);
    assert.equal(issue?.reason_code, 'shell_operator_rejected');
  });
}

const rejectedAllowlistCommands = [
  'powershell -c dir',
  'bash script.sh',
  'curl https://example.com',
  'ruby script.rb',
  'npx tsx script.ts',
];

for (const command of rejectedAllowlistCommands) {
  test(`allowlist rejects non-approved command: ${command}`, () => {
    const issue = validateExecutorShellCommand(command, process.platform);
    assert.equal(issue?.reason_code, 'command_allowlist_rejected');
  });
}

test('empty command is rejected', () => {
  const issue = validateExecutorShellCommand('   ', process.platform);
  assert.equal(issue?.reason_code, 'empty_command_rejected');
});

test('argv validation accepts quoted arguments with spaces', () => {
  assert.equal(
    validateExecutorShellCommand('node app.js "path with spaces.txt"', process.platform, 'dev_local'),
    null,
  );
});

test('argv validation reports malformed quoting', () => {
  assert.equal(
    validateExecutorShellCommand('node "unterminated', process.platform, 'dev_local')?.reason_code,
    'command_argv_parse_error',
  );
});

test('dev_local execution profile allows common local build tools', () => {
  assert.equal(validateExecutorShellCommand('pnpm test', process.platform, 'dev_local'), null);
  assert.equal(validateExecutorShellCommand('cargo test', process.platform, 'dev_local'), null);
  assert.equal(validateExecutorShellCommand('go test ./...', process.platform, 'dev_local'), null);
});

test('benchmark_container profile allows Linux container commands and explicit project executables', () => {
  assert.equal(
    validateExecutorShellCommand('chmod +x cli_tool', 'win32', 'benchmark_container'),
    null,
  );
  assert.equal(
    validateExecutorShellCommand('diff expected.txt actual.txt', 'win32', 'benchmark_container'),
    null,
  );
  assert.equal(validateExecutorShellCommand('gzip data.txt', 'win32', 'benchmark_container'), null);
  assert.equal(validateExecutorShellCommand('which git', 'win32', 'benchmark_container'), null);
  assert.equal(validateExecutorShellCommand('env', 'win32', 'benchmark_container'), null);
  assert.equal(
    validateExecutorShellCommand(
      './cli_tool weights.json image.png',
      'win32',
      'benchmark_container',
    ),
    null,
  );
});

test('benchmark-only inspection commands stay rejected in safe_repo', () => {
  assert.equal(
    validateExecutorShellCommand('which git', 'win32', 'safe_repo')?.reason_code,
    'command_allowlist_rejected',
  );
  assert.equal(
    validateExecutorShellCommand('env', 'win32', 'safe_repo')?.reason_code,
    'command_allowlist_rejected',
  );
});

test('benchmark_container allows shell syntax only when docker-backed execution is active', () => {
  setDockerAvailableForTest(true);
  const command = 'cat data.comp | ./decomp > decompressed.txt && diff data.txt decompressed.txt';

  // With image set: shell syntax should be allowed
  process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'example/task:latest';
  try {
    assert.equal(validateExecutorShellCommand(command, 'win32', 'benchmark_container'), null);
  } finally {
    delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  }

  // Without image: shell syntax should be rejected
  assert.equal(
    validateExecutorShellCommand(command, 'win32', 'benchmark_container')?.reason_code,
    'shell_operator_rejected',
  );
  resetDockerAvailabilityCache();
});

test('safe_repo execution profile keeps expanded local build tools rejected', () => {
  const issue = validateExecutorShellCommand('pnpm test', process.platform, 'safe_repo');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

// ── interpreter eval-flag blocking ──────────────────────────────────────────

const interpreterEvalRejectedCommands = [
  { command: 'node -e 1', flag: '-e' },
  { command: 'node --eval 1', flag: '--eval' },
  { command: 'node -p process.version', flag: '-p' },
  { command: 'node --print process.version', flag: '--print' },
  { command: 'python -c pass', flag: '-c' },
  { command: 'python3 -c None', flag: '-c' },
  { command: 'py -c 1', flag: '-c' },
  { command: 'deno eval 1', flag: 'eval' },
];

for (const { command, flag } of interpreterEvalRejectedCommands) {
  test(`interpreter eval-flag blocking rejects: ${command}`, () => {
    const issue = validateExecutorShellCommand(command, process.platform);
    assert.equal(issue?.reason_code, 'interpreter_eval_rejected');
    assert.ok(
      issue?.message.includes(flag),
      `message should mention blocked flag "${flag}": ${issue?.message}`,
    );
  });
}

const interpreterScriptFileAllowed = [
  'node build.js',
  'node ./scripts/deploy.js',
  'python test.py',
  'python3 manage.py runserver',
  'py setup.py build',
  'pytest -q',
  'pip list',
  'pip3 install -r requirements.txt',
  'deno test',
  'npm test',
  'npm run build',
];

for (const command of interpreterScriptFileAllowed) {
  test(`interpreter eval-flag blocking allows script-file: ${command}`, () => {
    assert.equal(validateExecutorShellCommand(command, process.platform), null);
  });
}

test('interpreter_eval_rejected includes evidence with command and blocked arg', () => {
  const issue = validateExecutorShellCommand('python -c pass', process.platform);
  assert.equal(issue?.reason_code, 'interpreter_eval_rejected');
  assert.ok(issue?.evidence?.includes('python -c pass'));
  assert.ok(issue?.evidence?.some((e) => e.startsWith('-c')));
});

// ── BABEL_ALLOW_INTERPRETER_EVAL override ──────────────────────────────────

test('BABEL_ALLOW_INTERPRETER_EVAL=1 allows python -c', () => {
  const previous = process.env['BABEL_ALLOW_INTERPRETER_EVAL'];
  try {
    process.env['BABEL_ALLOW_INTERPRETER_EVAL'] = '1';
    const issue = validateExecutorShellCommand('python -c pass', process.platform);
    assert.equal(issue, null);
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_ALLOW_INTERPRETER_EVAL'];
    } else {
      process.env['BABEL_ALLOW_INTERPRETER_EVAL'] = previous;
    }
  }
});

test('BABEL_ALLOW_INTERPRETER_EVAL=true allows node -e', () => {
  const previous = process.env['BABEL_ALLOW_INTERPRETER_EVAL'];
  try {
    process.env['BABEL_ALLOW_INTERPRETER_EVAL'] = 'true';
    const issue = validateExecutorShellCommand('node -e 1', process.platform);
    assert.equal(issue, null);
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_ALLOW_INTERPRETER_EVAL'];
    } else {
      process.env['BABEL_ALLOW_INTERPRETER_EVAL'] = previous;
    }
  }
});

test('BABEL_ALLOW_INTERPRETER_EVAL=0 still blocks python -c', () => {
  const previous = process.env['BABEL_ALLOW_INTERPRETER_EVAL'];
  try {
    process.env['BABEL_ALLOW_INTERPRETER_EVAL'] = '0';
    const issue = validateExecutorShellCommand('python -c pass', process.platform);
    assert.equal(issue?.reason_code, 'interpreter_eval_rejected');
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_ALLOW_INTERPRETER_EVAL'];
    } else {
      process.env['BABEL_ALLOW_INTERPRETER_EVAL'] = previous;
    }
  }
});

test('read_only_audit execution profile rejects writes and command execution', () => {
  const fixture = makeFixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  try {
    process.env['BABEL_EXECUTION_PROFILE'] = 'read_only_audit';
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(
      executor.fileWrite('nested/output.txt', 'blocked\n'),
      'execution_profile_tool_rejected',
    );
    expectPolicyDenial(
      executor.shellExec('node -v', '.', 5_000),
      'execution_profile_tool_rejected',
    );
  } finally {
    if (previousProfile === undefined) {
      delete process.env['BABEL_EXECUTION_PROFILE'];
    } else {
      process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    }
    fixture.cleanup();
  }
});

test('workspace_manager rejects dependency installs until explicitly approved', () => {
  const installIssue = validateExecutorShellCommand(
    'npm install',
    process.platform,
    'workspace_manager',
  );
  assert.equal(installIssue?.reason_code, 'dependency_install_requires_approval');

  const testIssue = validateExecutorShellCommand('npm test', process.platform, 'workspace_manager');
  assert.equal(testIssue, null);
});

test('workspace_manager allows exact dependency install after approval queue grant', () => {
  withApprovalQueue(() => {
    const fixture = makeFixture();
    try {
      const request = requestDependencyInstallApproval({
        command: 'npm install',
        projectRoot: fixture.projectRoot,
        executionProfile: 'workspace_manager',
      });
      approveApproval(request.record.id, { ttlHours: 1 });

      assert.equal(
        validateExecutorShellCommand('npm install', process.platform, 'workspace_manager', {
          projectRoot: fixture.projectRoot,
        }),
        null,
      );
      assert.equal(
        validateExecutorShellCommand('pip install pytest', process.platform, 'workspace_manager', {
          projectRoot: fixture.projectRoot,
        })?.reason_code,
        'dependency_install_requires_approval',
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test(
  'windows env-prefix syntax is rejected on Windows',
  { skip: process.platform !== 'win32' ? 'Windows-specific fixture' : false },
  () => {
    const issue = validateExecutorShellCommand('FOO=bar npm test', 'win32');
    assert.equal(issue?.reason_code, 'windows_env_prefix_unsupported');
  },
);

test('mkdir is explicitly rejected on Windows', { skip: process.platform !== 'win32' ? 'Windows-specific fixture' : false }, () => {
  const issue = validateExecutorShellCommand('mkdir dist', 'win32');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

test('chmod is explicitly rejected on Windows', { skip: process.platform !== 'win32' ? 'Windows-specific fixture' : false }, () => {
  const issue = validateExecutorShellCommand('chmod +x script.sh', 'win32');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

test(
  'backslash absolute outside path is rejected on Windows',
  { skip: process.platform !== 'win32' ? 'Windows-specific fixture' : false },
  () => {
    const fixture = makeFixture();
    try {
      const executor = new SafeExecutor(fixture.projectRoot);
      const outsidePath = resolve(fixture.outsideRoot, 'outside.txt').replace(/\//g, '\\');
      expectPolicyDenial(executor.fileRead(outsidePath), 'path_jail_rejected');
    } finally {
      fixture.cleanup();
    }
  },
);

// ── residual sandbox cases ──────────────────────────────────────

test(
  'cd path && allowed-cmd is not allowlist-rejected',
  { skip: process.platform !== 'win32' ? 'Windows-specific fixture' : false },
  () => {
    const samples = [
      String.raw`cd /tmp/foo && python -m pytest --version 2>&1`,
      String.raw`cd C:\tmp\ws && npm test`,
      String.raw`cd /d C:\tmp\ws && python -m pytest tests\foo.py -q 2>&1`,
      String.raw`chdir C:\tmp\ws && git status`,
    ];
    for (const command of samples) {
      const issue = validateExecutorShellCommand(command, 'win32', 'safe_repo');
      assert.equal(
        issue,
        null,
        `expected allow: ${command} — got ${issue?.reason_code}: ${issue?.message}`,
      );
    }
  },
);

test(
  'bare redirect and lone & still rejected',
  { skip: process.platform !== 'win32' ? 'Windows-specific fixture' : false },
  () => {
    const dangerous = ['npm test > out.txt', 'ls >', 'echo hello & echo world', 'python test.py &'];
    for (const command of dangerous) {
      const issue = validateExecutorShellCommand(command, 'win32', 'safe_repo');
      assert.equal(issue?.reason_code, 'shell_operator_rejected', `expected reject: ${command}`);
    }
  },
);

test(
  'P2.1: 2>&1 on allowed commands passes without interpreter-eval env',
  { skip: process.platform !== 'win32' ? 'Windows-specific fixture' : false },
  () => {
    assert.equal(
      validateExecutorShellCommand('python -m pytest --version 2>&1', 'win32', 'safe_repo'),
      null,
    );
    assert.equal(
      validateExecutorShellCommand('pip install numpy --quiet 2>&1', 'win32', 'safe_repo'),
      null,
    );
  },
);

// ── Transient spawn error pattern matching ────────────────────────────────

test('isTransientSpawnError matches ENOENT errors', () => {
  assert.ok(isTransientSpawnError('spawn node ENOENT'));
  assert.ok(isTransientSpawnError("ENOENT: no such file or directory, stat '/usr/bin/node'"));
  assert.ok(isTransientSpawnError('spawn npm ENOENT'));
});

test('isTransientSpawnError matches EPIPE errors', () => {
  assert.ok(isTransientSpawnError('EPIPE: broken pipe'));
  assert.ok(isTransientSpawnError('write EPIPE: stdout maxBuffer exceeded'));
});

test('isTransientSpawnError matches ECONNRESET errors', () => {
  assert.ok(isTransientSpawnError('ECONNRESET: socket hang up'));
  assert.ok(isTransientSpawnError('read ECONNRESET'));
});

test('isTransientSpawnError matches ECONNREFUSED errors', () => {
  assert.ok(isTransientSpawnError('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8080'));
});

test('isTransientSpawnError matches ETIMEDOUT errors', () => {
  assert.ok(isTransientSpawnError('ETIMEDOUT: connect ETIMEDOUT 10.0.0.1:443'));
  assert.ok(isTransientSpawnError('socket hang up'));
});

test('isTransientSpawnError matches Docker daemon errors', () => {
  assert.ok(
    isTransientSpawnError(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    ),
  );
  assert.ok(isTransientSpawnError('Error response from daemon: No such container'));
  assert.ok(isTransientSpawnError('Container abc123def is not running'));
  assert.ok(isTransientSpawnError('Is the docker daemon running?'));
  assert.ok(isTransientSpawnError('Connection refused -- docker daemon not available'));
});

test('isTransientSpawnError rejects non-transient errors', () => {
  assert.ok(!isTransientSpawnError('EACCES: permission denied'));
  assert.ok(!isTransientSpawnError('EISDIR: illegal operation on a directory'));
  assert.ok(!isTransientSpawnError('ENOTDIR: not a directory'));
  assert.ok(!isTransientSpawnError('EEXIST: file already exists'));
  assert.ok(!isTransientSpawnError(''));
});

// ── Transient spawn retry behavior ────────────────────────────────────────
// Note: An end-to-end test for spawn retry exhausting on a transient ENOENT
// is not feasible cross-platform because:
//  - On Windows, all commands go through cmd.exe, which always spawns
//    successfully (ENOENT at the child process level is reported via stderr
//    and non-zero exit code, never via result.error).
//  - On POSIX, triggering ENOENT requires a command binary that is in the
//    allowed list but not installed, which is environment-dependent.
// The pattern-matching tests above comprehensively verify that
// isTransientSpawnError correctly identifies ENOENT and other transient
// patterns. The retry loop itself (backoff, retry count, marker prefix) is
// a simple synchronous construct verified by code review.

test('spawn with non-zero exit code does not receive transient spawn error marker', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    // node -e "process.exit(1)" runs successfully from the spawn perspective
    // (no ENOENT, no connection error) but exits with code 1. The retry
    // logic only fires on result.error, not on non-zero exit codes.
    const result = executor.shellExec('git status --definitely-not-a-flag', '.', 5_000);
    assert.notEqual(result.exit_code, 0);
    assert.ok(
      !result.stderr.startsWith('[sandbox] Transient spawn error (retries exhausted):'),
      `Transient marker should not appear for non-zero exit codes, got: ${result.stderr}`,
    );
    assert.ok(
      !result.stderr.startsWith('[sandbox] Spawn error:'),
      `Spawn error marker should not appear for non-zero exit codes, got: ${result.stderr}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('shellExecAsync correlates process witness observations with toolCallId', async () => {
  const fixture = makeFixture();
  const witness = new ProcessWitness();
  try {
    const kinds: string[] = [];
    const ids: Array<string | undefined> = [];
    witness.subscribe((observation) => {
      kinds.push(observation.kind);
      ids.push(observation.correlation.toolCallId);
    }, { id: 'sandbox-toolcall' });
    const executor = new SafeExecutor(fixture.projectRoot, null, 'act', witness);
    const result = await executor.shellExecAsync(
      'echo ok',
      '.',
      5_000,
      'shell_exec',
      undefined,
      { sessionId: 'session-shell', toolCallId: 'tool-shell-1' },
    );
    assert.equal(result.exit_code, 0);
    await witness.bus.flush();
    assert.ok(kinds.includes('process_requested'));
    assert.ok(kinds.includes('process_exited'));
    assert.ok(ids.includes('tool-shell-1'));
  } finally {
    await witness.close();
    fixture.cleanup();
  }
});

test('shellExecAsync preserves shellExec result shape for a successful command', async () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    const syncResult = executor.shellExec('echo ok', '.', 5_000);
    const asyncResult = await executor.shellExecAsync('echo ok', '.', 5_000);
    assert.deepEqual(asyncResult, syncResult);
  } finally {
    fixture.cleanup();
  }
});

const SUPERVISOR_LAUNCHED_MARKER = 'BABEL_SUPERVISOR_LAUNCHED';
const SYNC_SUPERVISOR_PID_FILE = '.supervisor-sync-test.pid';
/** Matches production Windows tree kill bound in processTree.terminateChildTree. */
const FIXTURE_TASKKILL_TIMEOUT_MS = 1_500;

/**
 * Pre-existing production limitation (NOT repaired by this test helper):
 * shellExec uses spawnSync with timeout only (sandbox.ts ~1956–2012) and does not call
 * registerPendingProcessTermination. On Windows, prepareShellExecution routes through
 * cmd.exe (sandbox.ts ~1820–1823), so the wrapper can return after supervisor timeout
 * while a descendant node process keeps the cwd. This helper only tears down fixture-
 * recorded PIDs for test isolation; it does not change executor behavior.
 */
async function teardownFixtureSupervisorPids(
  projectRoot: string,
  pidFileName: string,
  options: { requireReceipt: boolean },
): Promise<void> {
  const pidPath = join(projectRoot, pidFileName);
  if (!existsSync(pidPath)) {
    assert.equal(
      options.requireReceipt,
      false,
      'fixture PID receipt file missing after sync supervisor child was expected to launch',
    );
    return;
  }
  const pids = [
    ...new Set(
      readFileSync(pidPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0),
    ),
  ];
  unlinkSync(pidPath);
  if (options.requireReceipt) {
    assert.ok(pids.length > 0, 'fixture PID receipt file contained no recorded child PIDs');
  }
  for (const pid of pids) {
    if (!isProcessAlive(pid)) {
      continue;
    }
    if (process.platform === 'win32') {
      const windowsRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
      const killResult = childProcess.spawnSync(
        join(windowsRoot, 'System32', 'taskkill.exe'),
        ['/F', '/T', '/PID', String(pid)],
        { stdio: 'ignore', windowsHide: true, timeout: FIXTURE_TASKKILL_TIMEOUT_MS },
      );
      if (killResult.error) {
        assert.fail(
          `taskkill must complete within ${FIXTURE_TASKKILL_TIMEOUT_MS}ms for fixture pid ${pid}: ${killResult.error.message}`,
        );
      }
      assert.equal(
        killResult.status,
        0,
        `taskkill must terminate fixture supervisor child pid ${pid} (status ${killResult.status})`,
      );
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          throw error;
        }
      }
    }
    const exited = await waitForProcessExit(pid, 5_000);
    assert.equal(exited, true, `fixture supervisor child pid ${pid} must be dead before cleanup`);
  }
}

function assertSupervisorTerminatedNotLaunchFailure(
  result: { exit_code: number; stdout: string; stderr: string; launch_failure?: unknown; denial?: unknown },
  label: string,
): void {
  assert.equal(result.denial, undefined, `${label}: must not be a policy denial`);
  assert.equal(result.launch_failure, undefined, `${label}: must not be a host launch failure`);
  assert.match(result.stdout, new RegExp(SUPERVISOR_LAUNCHED_MARKER), `${label}: must prove the child launched`);
  assert.notEqual(result.exit_code, 0, `${label}: supervisor termination must not report success`);
}

test('shellExecAsync supervisor timeout is not a host launch failure', async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'timeout-async.mjs'),
      `process.stdout.write('${SUPERVISOR_LAUNCHED_MARKER}\\n');
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => {}, 60_000);
`,
      'utf-8',
    );
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = await executor.shellExecAsync('node timeout-async.mjs', '.', 250);
    assertSupervisorTerminatedNotLaunchFailure(
      result,
      'async supervisor timeout (SIGTERM exit 0)',
    );
  } finally {
    fixture.cleanup();
  }
});

test('shellExec supervisor timeout is not a host launch failure', async () => {
  const fixture = makeFixture();
  let requirePidReceipt = false;
  try {
    writeFileSync(
      join(fixture.projectRoot, 'timeout-sync.mjs'),
      `import { appendFileSync } from 'node:fs';
appendFileSync('${SYNC_SUPERVISOR_PID_FILE}', String(process.pid) + '\\n', 'utf8');
process.stdout.write('${SUPERVISOR_LAUNCHED_MARKER}\\n');
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => {}, 60_000);
`,
      'utf-8',
    );
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = executor.shellExec('node timeout-sync.mjs', '.', 250);
    requirePidReceipt = result.stdout.includes(SUPERVISOR_LAUNCHED_MARKER);
    assertSupervisorTerminatedNotLaunchFailure(
      result,
      'sync supervisor timeout (SIGTERM exit 0)',
    );
  } finally {
    await teardownFixtureSupervisorPids(fixture.projectRoot, SYNC_SUPERVISOR_PID_FILE, {
      requireReceipt: requirePidReceipt,
    });
    fixture.cleanup();
  }
});

test('shellExec never retries a launched supervisor timeout', (t) => {
  const fixture = makeFixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', () => {
    calls++;
    return { pid: 1, output: ['', SUPERVISOR_LAUNCHED_MARKER, ''], stdout: SUPERVISOR_LAUNCHED_MARKER, stderr: '', status: null, signal: null,
      error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
  });
  syncBuiltinESMExports();
  try {
    const result = new SafeExecutor(fixture.projectRoot).shellExec('node timeout.mjs', '.', 1);
    assertSupervisorTerminatedNotLaunchFailure(result, 'launched sync timeout');
    assert.equal(calls, 1, 'a runtime timeout must not replay potentially mutating project code');
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); fixture.cleanup();
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
  }
});

test('shellExecAsync never retries a launched supervisor timeout', async (t) => {
  const fixture = makeFixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  let calls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  t.mock.method(childProcess, 'spawn', () => {
    calls++;
    const child = new childProcess.ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    t.mock.method(child, 'kill', () => { queueMicrotask(() => child.emit('close', 0)); return true; });
    queueMicrotask(() => { child.emit('spawn'); child.stdout?.emit('data', SUPERVISOR_LAUNCHED_MARKER); });
    return child;
  });
  syncBuiltinESMExports();
  try {
    const result = await new SafeExecutor(fixture.projectRoot).shellExecAsync('node timeout.mjs', '.', 1);
    assertSupervisorTerminatedNotLaunchFailure(result, 'launched async timeout');
    assert.equal(calls, 1, 'a runtime timeout must not replay potentially mutating project code');
  } finally {
    clearInterval(keepAlive); t.mock.restoreAll(); syncBuiltinESMExports(); fixture.cleanup();
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
  }
});

test('shellExec retains retry for a confirmed launch failure before any child starts', (t) => {
  const fixture = makeFixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', () => {
    calls++;
    return calls === 1
      ? { pid: 0, output: ['', '', ''], stdout: '', stderr: '', status: null, signal: null, error: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) }
      : { pid: 1, output: ['', 'started once', ''], stdout: 'started once', stderr: '', status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    const result = new SafeExecutor(fixture.projectRoot).shellExec('node launch.mjs', '.', 5000);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'started once');
    assert.equal(calls, 2);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); fixture.cleanup();
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE']; else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
  }
});

test('shellExec spawnSync ENOBUFS overflow is not a host launch failure', () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'overflow-sync.mjs'),
      `process.stdout.write('${SUPERVISOR_LAUNCHED_MARKER}\\n');
const chunk = 'x'.repeat(64 * 1024);
for (let i = 0; i < 96; i++) process.stdout.write(chunk);
`,
      'utf-8',
    );
    const executor = new SafeExecutor(fixture.projectRoot);
    const result = executor.shellExec('node overflow-sync.mjs', '.', 60_000);
    assertSupervisorTerminatedNotLaunchFailure(result, 'spawnSync ENOBUFS overflow');
  } finally {
    fixture.cleanup();
  }
});

test('spawnCommandAsync supervisor timeout coerces SIGTERM exit 0 to non-zero', async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'timeout-spawn-async.mjs'),
      `process.stdout.write('${SUPERVISOR_LAUNCHED_MARKER}\\n');
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => {}, 60_000);
`,
      'utf-8',
    );
    const raw = await spawnCommandAsync(process.execPath, [join(fixture.projectRoot, 'timeout-spawn-async.mjs')], {
      cwd: fixture.projectRoot,
      timeoutMs: 250,
      env: { SystemRoot: process.env['SystemRoot'] },
    });
    assert.equal(raw.processStarted, true);
    assert.equal(raw.timedOut, true);
    assert.ok(raw.error);
    const result = normalizeSupervisorTerminatedShellOutput(
      raw.status,
      raw.stdout,
      raw.stderr,
      raw.stdoutTruncated,
      raw.stderrTruncated,
    );
    assertSupervisorTerminatedNotLaunchFailure(result, 'spawnCommandAsync timeout path');
  } finally {
    fixture.cleanup();
  }
});

// The product shell policy denies project interpreters on an unisolated host.
// Exercise its real process supervisor with fixed, owned fixture scripts.
function superviseFixtureScript(fixture: ReturnType<typeof makeFixture>, name: string, timeoutMs: number, signal?: AbortSignal) {
  return spawnCommandAsync(process.execPath, [join(fixture.projectRoot, name)], {
    cwd: fixture.projectRoot, timeoutMs, ...(signal ? { signal } : {}),
    env: { SystemRoot: process.env['SystemRoot'] },
    processContext: { sessionId: fixture.projectRoot },
  });
}

test('process supervisor leaves the event loop responsive while an owned fixture runs', async () => {
  const fixture = makeFixture();
  const controller = new AbortController();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'slow-command.mjs'),
      "await new Promise((resolve) => setTimeout(resolve, 800));\nconsole.log('finished');\n",
      'utf-8',
    );
    const startedAt = Date.now();
    const timerFired = new Promise<number>((resolveTimer) => {
      setTimeout(() => resolveTimer(Date.now() - startedAt), 25);
    });
    const commandResult = superviseFixtureScript(fixture, 'slow-command.mjs', 5_000, controller.signal);
    // Allow up to 5s on Windows CI; the product bar (250ms p95) targets Linux/macOS dev machines.
    const timerMs = await timerFired;
    assert.ok(timerMs < 5000, `event-loop timer should remain responsive, took ${timerMs}ms`);
    const result = await commandResult;
    assert.equal(result.status, 0, result.stderr);
  } finally {
    controller.abort();
    await awaitPendingProcessTerminations(fixture.projectRoot);
    fixture.cleanup();
  }
});

test('process supervisor cancels an owned fixture without blocking the event loop', async () => {
  const fixture = makeFixture();
  const controller = new AbortController();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'cancel-command.mjs'),
      "await new Promise((resolve) => setTimeout(resolve, 10_000));\nconsole.log('unexpected');\n",
      'utf-8',
    );
    const startedAt = Date.now();
    const pending = superviseFixtureScript(fixture, 'cancel-command.mjs', 15_000, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.status, 1);
    assert.equal(result.aborted, true);
    // W0.1 gate: cancel p95 under 250ms is the product bar.
    // Local/dev slack 500ms; CI self-hosted Windows under load needs more headroom (5s).
    const cancelBudgetMs = process.env['CI'] ? 5_000 : 500;
    assert.ok(
      Date.now() - startedAt < cancelBudgetMs,
      `cancellation should settle quickly, took ${Date.now() - startedAt}ms (budget ${cancelBudgetMs}ms)`,
    );
    await awaitPendingProcessTerminations(fixture.projectRoot);
  } finally {
    controller.abort();
    await awaitPendingProcessTerminations(fixture.projectRoot);
    fixture.cleanup();
  }
});

test('shellExecAsync pre-aborted signal returns immediately without spawning long work', async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'should-not-run.mjs'),
      "console.log('should-not-run');\n",
      'utf-8',
    );
    const executor = new SafeExecutor(fixture.projectRoot);
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    const result = await executor.shellExecAsync(
      'echo should-not-run',
      '.',
      15_000,
      'shell_exec',
      controller.signal,
    );
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /aborted/i);
    assert.ok(Date.now() - startedAt < 250, 'pre-aborted path must be near-instant');
    assert.doesNotMatch(result.stdout, /should-not-run/);
  } finally {
    fixture.cleanup();
  }
});

test('process supervisor abort terminates the owned fixture descendant tree', async () => {
  const fixture = makeFixture();
  const controller = new AbortController();
  try {
    const childPidFile = join(fixture.projectRoot, 'grandchild.pid').replace(/\\/g, '/');
    // Embed absolute pid path — sandbox getSafeEnv may not forward arbitrary env.
    writeFileSync(
      join(fixture.projectRoot, 'tree-parent.mjs'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid), 'utf8');
await new Promise((resolve) => setTimeout(resolve, 60_000));
`,
      'utf-8',
    );
    const pending = superviseFixtureScript(fixture, 'tree-parent.mjs', 30_000, controller.signal);
    const waitPid = async () => {
      const { existsSync, readFileSync } = await import('node:fs');
      for (let i = 0; i < 80; i++) {
        if (existsSync(childPidFile)) {
          const pid = Number(readFileSync(childPidFile, 'utf8').trim());
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    };
    const grandchildPid = await waitPid();
    assert.ok(grandchildPid, 'grandchild pid should be recorded');
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 1);
    assert.equal(result.aborted, true);
    await awaitPendingProcessTerminations(fixture.projectRoot);
    const descendantExited = await waitForProcessExit(grandchildPid!, 5_000);
    assert.equal(descendantExited, true, 'descendant process should be dead after tree kill');
  } finally {
    controller.abort();
    await awaitPendingProcessTerminations(fixture.projectRoot);
    fixture.cleanup();
  }
});

test('sandbox denies credential-class files and requires explicit external read roots', () => {
  const fixture = makeFixture();
  const previousRoots = process.env['BABEL_OPENCLAW_APPROVED_ROOTS'];
  try {
    mkdirSync(join(fixture.projectRoot, '.aws'));
    writeFileSync(join(fixture.projectRoot, '.env'), 'SYNTHETIC=only\n', 'utf-8');
    writeFileSync(join(fixture.projectRoot, '.env.example'), 'SYNTHETIC=\n', 'utf-8');
    writeFileSync(join(fixture.projectRoot, 'id_rsa'), 'synthetic\n', 'utf-8');
    writeFileSync(join(fixture.projectRoot, '.aws', 'credentials'), 'synthetic\n', 'utf-8');
    writeFileSync(join(fixture.outsideRoot, '.env'), 'synthetic\n', 'utf-8');

    const defaultExecutor = new SafeExecutor(fixture.projectRoot);
    for (const path of ['.env', 'id_rsa', '.aws/credentials']) {
      expectPolicyDenial(defaultExecutor.fileRead(path), 'credential_read_denied');
    }
    assert.match(defaultExecutor.fileRead('.env.example').stdout, /SYNTHETIC=/);
    expectPolicyDenial(
      defaultExecutor.fileRead(join(fixture.outsideRoot, 'outside.txt')),
      'path_jail_rejected',
    );

    process.env['BABEL_OPENCLAW_APPROVED_ROOTS'] = fixture.outsideRoot;
    const approvedExecutor = new SafeExecutor(fixture.projectRoot);
    assert.match(approvedExecutor.fileRead(join(fixture.outsideRoot, 'outside.txt')).stdout, /outside/);
    expectPolicyDenial(
      approvedExecutor.fileRead(join(fixture.outsideRoot, '.env')),
      'credential_read_denied',
    );
  } finally {
    if (previousRoots === undefined) {
      delete process.env['BABEL_OPENCLAW_APPROVED_ROOTS'];
    } else {
      process.env['BABEL_OPENCLAW_APPROVED_ROOTS'] = previousRoots;
    }
    fixture.cleanup();
  }
});
test('sandbox rejects credential-class shadow targets', { skip: process.platform === 'win32' ? 'POSIX file symlink fixture; Windows directory junction covered separately' : false }, () => {
  const fixture = makeFixture();
  const shadowRoot = mkdtempSync(join(tmpdir(), 'babel-sandbox-shadow-'));
  try {
    writeFileSync(join(fixture.projectRoot, 'config.json'), '{}\n', 'utf-8');
    writeFileSync(join(shadowRoot, '.env'), 'SYNTHETIC=only\n', 'utf-8');
    symlinkSync(
      join(shadowRoot, '.env'),
      join(shadowRoot, 'config.json'),
      process.platform === 'win32' ? 'file' : 'file',
    );

    const executor = new SafeExecutor(fixture.projectRoot, shadowRoot);
    expectPolicyDenial(executor.fileRead('config.json'), 'credential_read_denied');
  } finally {
    rmSync(shadowRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});
test('sandbox rejects credential-class shadow directories', { skip: process.platform === 'win32' ? 'POSIX file symlink fixture; Windows directory junction covered separately' : false }, () => {
  const fixture = makeFixture();
  const shadowRoot = mkdtempSync(join(tmpdir(), 'babel-sandbox-shadow-dir-'));
  const secretRoot = mkdtempSync(join(tmpdir(), 'babel-sandbox-secret-dir-'));
  try {
    mkdirSync(join(fixture.projectRoot, 'config'));
    mkdirSync(join(secretRoot, '.ssh'));
    writeFileSync(join(secretRoot, '.ssh', 'id_rsa'), 'synthetic\n', 'utf-8');
    symlinkSync(join(secretRoot, '.ssh'), join(shadowRoot, 'config'));

    const executor = new SafeExecutor(fixture.projectRoot, shadowRoot);
    expectPolicyDenial(executor.listDirectory('config'), 'credential_read_denied');
  } finally {
    rmSync(shadowRoot, { recursive: true, force: true });
    rmSync(secretRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test('shell results distinguish a started process from denial and pre-abort', async () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    writeFileSync(join(fixture.projectRoot, 'verify.test.cjs'), "require('node:test').test('red control',()=>{throw Error('intentional red')})\n");
    const failed = await executor.testRunAsync('node --test verify.test.cjs', '.', 15000);
    assert.equal(failed.exit_code, 1);
    assert.equal(failed.process_started, true);
    writeFileSync(join(fixture.projectRoot, 'verify.test.cjs'), "require('node:test').test('green control',()=>{})\n");
    const passed = await executor.testRunAsync('node --test verify.test.cjs', '.', 15000);
    assert.equal(passed.exit_code, 0);
    assert.equal(passed.process_started, true);
    writeFileSync(join(fixture.projectRoot, 'verify.test.cjs'), "require('node:test').test('timeout control',async()=>{console.log('timeout-test-started');await new Promise(r=>setTimeout(r,10000))})\n");
    const timedOut = await executor.testRunAsync('node --test --test-isolation=none verify.test.cjs', '.', 500);
    assert.notEqual(timedOut.exit_code, 0);
    assert.match(timedOut.stdout, /timeout-test-started/);
    assert.equal(timedOut.process_started, true);
    const controller = new AbortController(); controller.abort();
    const aborted = await executor.testRunAsync('node --test verify.test.cjs', '.', 15000, controller.signal);
    assert.notEqual(aborted.process_started, true);
    const denied = await executor.testRunAsync('node --test ../outside.test.cjs', '..', 15000);
    assert.notEqual(denied.process_started, true);
  } finally { fixture.cleanup(); }
});
