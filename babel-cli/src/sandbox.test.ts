import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SafeExecutor, validateExecutorShellCommand } from './sandbox.js';
import {
  approveApproval,
  requestDependencyInstallApproval,
} from './services/approvalQueue.js';

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
  symlinkSync(join(projectRoot, 'real-target'), insideLink, process.platform === 'win32' ? 'junction' : 'dir');
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
    assert.equal(readFileSync(join(fixture.projectRoot, 'nested', 'output.txt'), 'utf-8'), 'created\n');
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
    expectPolicyDenial(executor.fileRead(join(fixture.outsideRoot, 'outside.txt')), 'path_jail_rejected');
  } finally {
    fixture.cleanup();
  }
});

test('absolute outside fileWrite is rejected', () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(executor.fileWrite(join(fixture.outsideRoot, 'created.txt'), 'blocked\n'), 'path_jail_rejected');
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
    assert.equal(readFileSync(join(fixture.projectRoot, 'real-target', 'new.txt'), 'utf-8'), 'through-link\n');
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
    expectPolicyDenial(executor.fileWrite('outside-link/created.txt', 'blocked\n'), 'symlink_escape_rejected');
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
    expectPolicyDenial(executor.fileWrite('outside-link/more/nested.txt', 'blocked\n'), 'symlink_escape_rejected');
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
    assert.equal(readFileSync(join(fixture.projectRoot, 'nested', 'benchmark-output.txt'), 'utf-8'), 'mapped\n');
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

test('final write target symlink to outside file is rejected', { skip: process.platform === 'win32' }, () => {
  const fixture = makeFixture();
  try {
    const symlinkPath = join(fixture.projectRoot, 'linked-file.txt');
    const outsideFile = join(fixture.outsideRoot, 'outside.txt');
    symlinkSync(outsideFile, symlinkPath, 'file');

    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(executor.fileWrite('linked-file.txt', 'blocked\n'), 'symlink_escape_rejected');
    assert.equal(readFileSync(outsideFile, 'utf-8'), 'outside\n');
  } finally {
    fixture.cleanup();
  }
});

test('final write target symlink to in-root file is rejected to avoid TOCTOU swaps', { skip: process.platform === 'win32' }, () => {
  const fixture = makeFixture();
  try {
    const symlinkPath = join(fixture.projectRoot, 'linked-inside-file.txt');
    const insideFile = join(fixture.projectRoot, 'safe.txt');
    symlinkSync(insideFile, symlinkPath, 'file');

    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(executor.fileWrite('linked-inside-file.txt', 'blocked\n'), 'symlink_escape_rejected');
    assert.equal(readFileSync(insideFile, 'utf-8'), 'safe-root\n');
  } finally {
    fixture.cleanup();
  }
});

const allowedCommands = [
  'npm test',
  'npx tsx script.ts',
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
  'ls -la',
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
  assert.equal(validateExecutorShellCommand('chmod +x cli_tool', 'win32', 'benchmark_container'), null);
  assert.equal(validateExecutorShellCommand('diff expected.txt actual.txt', 'win32', 'benchmark_container'), null);
  assert.equal(validateExecutorShellCommand('gzip data.txt', 'win32', 'benchmark_container'), null);
  assert.equal(validateExecutorShellCommand('which git', 'win32', 'benchmark_container'), null);
  assert.equal(validateExecutorShellCommand('env', 'win32', 'benchmark_container'), null);
  assert.equal(validateExecutorShellCommand('./cli_tool weights.json image.png', 'win32', 'benchmark_container'), null);
});

test('benchmark-only inspection commands stay rejected in safe_repo', () => {
  assert.equal(validateExecutorShellCommand('which git', 'win32', 'safe_repo')?.reason_code, 'command_allowlist_rejected');
  assert.equal(validateExecutorShellCommand('env', 'win32', 'safe_repo')?.reason_code, 'command_allowlist_rejected');
});

test('benchmark_container allows shell syntax only when docker-backed execution is active', () => {
  const command = 'cat data.comp | ./decomp > decompressed.txt && diff data.txt decompressed.txt';

  assert.equal(
    validateExecutorShellCommand(command, 'win32', 'benchmark_container', 'example/task:latest'),
    null,
  );
  assert.equal(
    validateExecutorShellCommand(command, 'win32', 'benchmark_container', '')?.reason_code,
    'shell_operator_rejected',
  );
});

test('safe_repo execution profile keeps expanded local build tools rejected', () => {
  const issue = validateExecutorShellCommand('pnpm test', process.platform, 'safe_repo');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

test('read_only_audit execution profile rejects writes and command execution', () => {
  const fixture = makeFixture();
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  try {
    process.env['BABEL_EXECUTION_PROFILE'] = 'read_only_audit';
    const executor = new SafeExecutor(fixture.projectRoot);
    expectPolicyDenial(executor.fileWrite('nested/output.txt', 'blocked\n'), 'execution_profile_tool_rejected');
    expectPolicyDenial(executor.shellExec('node -v', '.', 5_000), 'execution_profile_tool_rejected');
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
  const installIssue = validateExecutorShellCommand('npm install', process.platform, 'workspace_manager');
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
        validateExecutorShellCommand(
          'npm install',
          process.platform,
          'workspace_manager',
          undefined,
          { projectRoot: fixture.projectRoot },
        ),
        null,
      );
      assert.equal(
        validateExecutorShellCommand(
          'pip install pytest',
          process.platform,
          'workspace_manager',
          undefined,
          { projectRoot: fixture.projectRoot },
        )?.reason_code,
        'dependency_install_requires_approval',
      );
    } finally {
      fixture.cleanup();
    }
  });
});

test('windows env-prefix syntax is rejected on Windows', { skip: process.platform !== 'win32' }, () => {
  const issue = validateExecutorShellCommand('FOO=bar npm test', 'win32');
  assert.equal(issue?.reason_code, 'windows_env_prefix_unsupported');
});

test('mkdir is explicitly rejected on Windows', { skip: process.platform !== 'win32' }, () => {
  const issue = validateExecutorShellCommand('mkdir dist', 'win32');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

test('chmod is explicitly rejected on Windows', { skip: process.platform !== 'win32' }, () => {
  const issue = validateExecutorShellCommand('chmod +x script.sh', 'win32');
  assert.equal(issue?.reason_code, 'command_allowlist_rejected');
});

test('backslash absolute outside path is rejected on Windows', { skip: process.platform !== 'win32' }, () => {
  const fixture = makeFixture();
  try {
    const executor = new SafeExecutor(fixture.projectRoot);
    const outsidePath = resolve(fixture.outsideRoot, 'outside.txt').replace(/\//g, '\\');
    expectPolicyDenial(executor.fileRead(outsidePath), 'path_jail_rejected');
  } finally {
    fixture.cleanup();
  }
});
