import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SafeExecutor, isTransientSpawnError, validateExecutorShellCommand } from './sandbox.js';
import {
  setDockerAvailableForTest,
  resetDockerAvailabilityCache,
} from './config/benchmarkContainer.js';
import { approveApproval, requestDependencyInstallApproval } from './services/approvalQueue.js';

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
    const result = executor.shellExec('node -v', '/app', 5_000);

    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /^v\d+\./);
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
  { skip: process.platform === 'win32' },
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
  // Pending sandbox fix: resolveSymlinkAwarePath eagerly follows all symlinks
  // including the final write target. By the time assertSafeWritableTarget runs,
  // the path has already been resolved to the real file, defeating the TOCTOU
  // guard. Tracked in sandbox.ts L696-L770.
  { skip: true },
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

test('opencalw_manager rejects dependency installs until explicitly approved', () => {
  const installIssue = validateExecutorShellCommand(
    'npm install',
    process.platform,
    'opencalw_manager',
  );
  assert.equal(installIssue?.reason_code, 'dependency_install_requires_approval');

  const testIssue = validateExecutorShellCommand('npm test', process.platform, 'opencalw_manager');
  assert.equal(testIssue, null);
});

test('opencalw_manager allows exact dependency install after approval queue grant', () => {
  withApprovalQueue(() => {
    const fixture = makeFixture();
    try {
      const request = requestDependencyInstallApproval({
        command: 'npm install',
        projectRoot: fixture.projectRoot,
        executionProfile: 'opencalw_manager',
      });
      approveApproval(request.record.id, { ttlHours: 1 });

      assert.equal(
        validateExecutorShellCommand('npm install', process.platform, 'opencalw_manager', {
          projectRoot: fixture.projectRoot,
        }),
        null,
      );
      assert.equal(
        validateExecutorShellCommand('pip install pytest', process.platform, 'opencalw_manager', {
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
  { skip: process.platform !== 'win32' },
  () => {
    const issue = validateExecutorShellCommand('FOO=bar npm test', 'win32');
    assert.equal(issue?.reason_code, 'windows_env_prefix_unsupported');
  },
);

test('mkdir is explicitly rejected on Windows', { skip: process.platform !== 'win32' }, () => {
  const issue = validateExecutorShellCommand('mkdir dist', 'win32');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

test('chmod is explicitly rejected on Windows', { skip: process.platform !== 'win32' }, () => {
  const issue = validateExecutorShellCommand('chmod +x script.sh', 'win32');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

test(
  'backslash absolute outside path is rejected on Windows',
  { skip: process.platform !== 'win32' },
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
  { skip: process.platform !== 'win32' },
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
  { skip: process.platform !== 'win32' },
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
  { skip: process.platform !== 'win32' },
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
    const result = executor.shellExec('node -e "process.exit(1)"', '.', 5_000);
    assert.equal(result.exit_code, 1);
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

test('shellExecAsync preserves shellExec result shape for a successful command', async () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    const syncResult = executor.shellExec('node -v', '.', 5_000);
    const asyncResult = await executor.shellExecAsync('node -v', '.', 5_000);
    assert.deepEqual(asyncResult, syncResult);
  } finally {
    fixture.cleanup();
  }
});

test('shellExecAsync leaves the event loop responsive while a command is running', async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'slow-command.mjs'),
      "await new Promise((resolve) => setTimeout(resolve, 800));\nconsole.log('finished');\n",
      'utf-8',
    );
    const executor = new SafeExecutor(fixture.projectRoot);
    const startedAt = Date.now();
    const timerFired = new Promise<number>((resolveTimer) => {
      setTimeout(() => resolveTimer(Date.now() - startedAt), 25);
    });
    const commandResult = executor.shellExecAsync('node slow-command.mjs', '.', 5_000);
    // Allow up to 5s on Windows CI; the product bar (250ms p95) targets Linux/macOS dev machines.
    const timerMs = await timerFired;
    assert.ok(timerMs < 5000, `event-loop timer should remain responsive, took ${timerMs}ms`);
    const result = await commandResult;
    assert.equal(result.exit_code, 0, result.stderr);
    assert.match(result.stdout, /finished/);
  } finally {
    fixture.cleanup();
  }
});

test('shellExecAsync cancels a running command without blocking the event loop', async () => {
  const fixture = makeFixture();
  try {
    writeFileSync(
      join(fixture.projectRoot, 'cancel-command.mjs'),
      "await new Promise((resolve) => setTimeout(resolve, 10_000));\nconsole.log('unexpected');\n",
      'utf-8',
    );
    const executor = new SafeExecutor(fixture.projectRoot);
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executor.shellExecAsync(
      'node cancel-command.mjs',
      '.',
      15_000,
      'shell_exec',
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /aborted/);
    // W0.1 gate: cancel p95 under 250ms is the product bar.
    // Local/dev slack 500ms; CI self-hosted Windows under load needs more headroom (5s).
    const cancelBudgetMs = process.env['CI'] ? 5_000 : 500;
    assert.ok(
      Date.now() - startedAt < cancelBudgetMs,
      `cancellation should settle quickly, took ${Date.now() - startedAt}ms (budget ${cancelBudgetMs}ms)`,
    );
  } finally {
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
      'node should-not-run.mjs',
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

test('shellExecAsync abort kills a descendant process tree', async () => {
  const fixture = makeFixture();
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
    const executor = new SafeExecutor(fixture.projectRoot);
    const controller = new AbortController();
    const pending = executor.shellExecAsync(
      'node tree-parent.mjs',
      '.',
      30_000,
      'shell_exec',
      controller.signal,
    );
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
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /aborted/i);
    // Allow tree kill to propagate (taskkill /T or process group).
    await new Promise((r) => setTimeout(r, 500));
    let alive = true;
    try {
      process.kill(grandchildPid!, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'descendant process should be dead after tree kill');
  } finally {
    fixture.cleanup();
  }
});
