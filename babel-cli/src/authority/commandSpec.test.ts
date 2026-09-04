import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyExecutionRisk,
  COMMAND_SPECS,
  normalizeExecutionBase,
} from './commandSpec.js';
import { ALLOWED_COMMANDS } from '../sandbox.js';
import { EXECUTION_PROFILE_NAMES, getExecutionProfileCommandAdditions } from '../config/executionProfiles.js';
import { parseGitCommand } from './gitCommand.js';
import { decideActionRequest } from './pdp.js';
import { parseLeaseJson } from './lease.js';
import { decideWithLease } from './wire.js';
import { executeActionWithPolicy, createToolExecutor } from '../agent/toolExecutor.js';
import { establishAuthoritySession } from './sessionContext.js';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { validateDockerIsolationArgs } from '../config/dockerIsolationArgs.js';
import { SafeExecutor, validateExecutorShellCommand } from '../sandbox.js';
import { hardenGitHostEnvironment } from './unprivilegedChildEnv.js';

if (!process.env['BABEL_ALLOW_HOST_FALLBACK'] && process.env['BABEL_DOCKER_DISABLE'] !== 'true') {
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
}

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test('completeness: every allowlisted and profile-added base is registered', () => {
  const bases = new Set<string>();
  for (const cmd of ALLOWED_COMMANDS) bases.add(normalizeExecutionBase(cmd));
  for (const profile of EXECUTION_PROFILE_NAMES) {
    for (const cmd of getExecutionProfileCommandAdditions(profile)) {
      bases.add(normalizeExecutionBase(cmd));
    }
  }
  const missing = [...bases].filter((b) => COMMAND_SPECS[b] === undefined);
  assert.deepEqual(missing, [], `unregistered command bases: ${missing.join(', ')}`);
  assert.ok(COMMAND_SPECS.sed);
});

test('normalizeExecutionBase strips path and windows suffixes', () => {
  assert.equal(normalizeExecutionBase('C:\\\\repo\\\\gradlew.bat'), 'gradlew');
  assert.equal(normalizeExecutionBase('./gradlew'), 'gradlew');
  assert.equal(normalizeExecutionBase('adb.exe'), 'adb');
});

test('project-relative executables are project_code', () => {
  assert.equal(classifyExecutionRisk('./cli_tool').executionRisk, 'project_code');
  assert.equal(classifyExecutionRisk('/app/bin/tool').executionRisk, 'project_code');
  assert.equal(classifyExecutionRisk('/project/bin/tool').executionRisk, 'project_code');
});

test('jvm and language run/build carriers require isolation', () => {
  for (const command of [
    'gradlew test',
    './gradlew assembleDebug',
    'java Attack.java',
    'cargo run',
    'go run main.go',
    'dotnet run',
    'mvn test',
    'cmake --build .',
  ]) {
    const p = parseGitCommand(command);
    assert.equal(p.requiresIsolation, true, command);
  }
});

test('host-safe inspection does not require isolation', () => {
  assert.equal(parseGitCommand('git status').requiresIsolation, undefined);
  assert.equal(parseGitCommand('rg foo').capability, 'run_local_command');
  assert.equal(parseGitCommand('rg foo').requiresIsolation, undefined);
});

test('git global options that change execution fail closed', () => {
  assert.equal(parseGitCommand('git -c protocol.ext.allow=always fetch ext::calc').capability, 'unknown');
  assert.equal(parseGitCommand('git --git-dir /tmp/other fetch').capability, 'unknown');
  assert.equal(parseGitCommand('git --work-tree /tmp status').capability, 'unknown');
  assert.equal(parseGitCommand('git --config-env foo=BAR status').capability, 'unknown');
});

test('git -C is forbidden even inside the repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-c-'));
  roots.push(root);
  const p = parseGitCommand(`git -C ${root} status`, { repoRoot: root });
  assert.equal(p.capability, 'unknown');
  assert.equal(classifyExecutionRisk(`git -C ${root} status`, { repoRoot: root }).executionRisk, 'forbidden');
});

test('git fetch/pull/stash are not inspect_repository', () => {
  assert.notEqual(parseGitCommand('git fetch').capability, 'inspect_repository');
  assert.equal(parseGitCommand('git pull').requiresIsolation, true);
  assert.notEqual(parseGitCommand('git stash push').capability, 'inspect_repository');
});

test('git commit -S is unknown', () => {
  assert.equal(parseGitCommand('git commit -S -m x').capability, 'unknown');
});

test('git program-launch forms fail closed', () => {
  const forbidden = [
    'git rebase -x ./attack.sh HEAD~1',
    'git rebase --exec ./attack.sh HEAD~1',
    'git rebase --exec=./attack.sh HEAD~1',
    'git rebase -i HEAD~1',
    'git rebase --interactive HEAD~1',
    'git rebase --gpg-sign HEAD~1',
    'git merge -S main',
    'git merge --gpg-sign main',
    'git merge --edit feature',
    'git tag -s v1.0.0',
    'git tag -u KEY v1.0.0',
    'git tag --sign v1.0.0',
    'git tag -a v1.0.0',
    'git tag --annotate v1.0.0',
    'git tag -e -a v1.0.0 -m release',
    'git push --signed origin HEAD',
    'git commit',
    'git commit --amend',
    'git commit -e -m x',
    'git branch --edit-description',
    'git branch --edit-description feat/x',
    'git config -e',
    'git config --edit',
    'git config core.editor ./attack',
    'git config --local sequence.editor ./attack',
    'git config core.sshCommand ./attack',
    'git config credential.helper ./attack',
    'git config gpg.program ./attack',
    'git config commit.gpgSign true',
    'git config tag.gpgSign true',
    'git config core.hooksPath .githooks',
    'git config alias.x !./attack',
    'git config --add alias.foo !calc',
    'git config filter.lfs.smudge ./attack',
    'git fetch --upload-pack=./attack origin',
    'git fetch --upload-pack ./attack origin',
    'git push --receive-pack=./attack origin feat/x',
    'git push --receive-pack ./attack origin feat/x',
    'git pull --upload-pack=./attack origin',
  ];
  for (const command of forbidden) {
    const p = parseGitCommand(command);
    assert.equal(p.capability, 'unknown', command);
    assert.equal(classifyExecutionRisk(command).executionRisk, 'forbidden', command);
  }
  assert.equal(parseGitCommand('git commit -m x').capability, 'commit_ship_set');
  assert.equal(parseGitCommand('git rebase HEAD~1').capability, 'shared_history_rewrite');
  assert.equal(parseGitCommand('git tag -a v1.0.0 -m release').capability, 'release');
  assert.equal(parseGitCommand('git tag --annotate v1 --message=release').capability, 'release');
  assert.equal(parseGitCommand('git tag v1.0.0').capability, 'release');
  assert.equal(parseGitCommand('git branch feat/x').capability, 'create_task_branch');
  assert.equal(parseGitCommand('git config user.email babel@example.com').capability, 'repo_admin');
  assert.equal(parseGitCommand('git config --get core.editor').capability, 'repo_admin');
  assert.equal(parseGitCommand('git merge --no-edit feature').capability, 'merge');
  assert.equal(parseGitCommand('git merge feature').capability, 'unknown');
});

test('package-manager install commands require isolation', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'pkg-iso',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['run_local_command'],
    }),
  );
  assert.ok(parsed.ok);
  for (const command of ['pip install .', 'uv pip install .', 'cargo install --path .', 'go install ./...']) {
    const p = parseGitCommand(command);
    assert.equal(p.requiresIsolation, true, command);
    assert.equal(classifyExecutionRisk(command).executionRisk, 'project_code', command);
    const denied = decideActionRequest(
      { capability: p.capability, requiresIsolation: true },
      parsed.lease,
    );
    assert.equal(denied.outcome, 'deny', command);
    assert.ok(denied.rulesTriggered.includes('pdp.project_code_requires_isolation'), command);
  }
});

test('heterogeneous effectful chains fail closed', () => {
  const p = parseGitCommand('npm test && git commit -m x');
  assert.equal(p.capability, 'unknown');
  assert.equal(p.ambiguous, true);
});

test('winget/adb verb split', () => {
  assert.equal(parseGitCommand('winget list').capability, 'inspect_host_environment');
  assert.equal(parseGitCommand('winget install Git.Git').capability, 'unknown');
  assert.equal(parseGitCommand('adb devices').capability, 'inspect_external_device');
  assert.equal(parseGitCommand('adb logcat').capability, 'unknown');
  assert.equal(parseGitCommand('adb install app.apk').capability, 'unknown');
});

test('PDP: merge+eval without isolation denies even when merge is leased', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'merge-iso',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['merge', 'run_arbitrary_code'],
      constraints: { allowedPullRequests: [88] },
    }),
  );
  assert.ok(parsed.ok);
  const decoded = parseGitCommand('node -e "/* gh pr merge 88 */ console.log(1)"');
  assert.equal(decoded.capability, 'merge');
  const denied = decideActionRequest(
    { capability: 'merge', target: '88', requiresIsolation: true },
    parsed.lease,
  );
  assert.equal(denied.outcome, 'deny');
  assert.ok(denied.rulesTriggered.includes('pdp.project_code_requires_isolation'));
});

test('PDP: missing merge membership wins over isolation', () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'no-merge',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['run_tests'],
      constraints: { allowedPullRequests: [88] },
    }),
  );
  assert.ok(parsed.ok);
  const missing = decideActionRequest(
    { capability: 'merge', target: '88', requiresIsolation: true, isolationAvailable: true },
    parsed.lease,
  );
  assert.equal(missing.outcome, 'deny');
  assert.equal(missing.reasonCode, 'DENY_MISSING_AUTHORITY');
});

test('wire+executor: merge+eval without isolation never invokes executeTool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-merge-iso-'));
  roots.push(root);
  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(dirname(persistPath), { recursive: true });
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'merge-iso-e2e',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['merge', 'run_arbitrary_code'],
      constraints: { allowedPullRequests: [88] },
    }),
  );
  assert.ok(parsed.ok);
  const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
  let executed = false;
  const executor = createToolExecutor({
    executeTool: async () => {
      executed = true;
      return { exit_code: 0, stdout: 'nope', stderr: '' };
    },
  });
  const run = await executeActionWithPolicy(
    { type: 'run_command', command: 'node -e "/* gh pr merge 88 */ console.log(1)"' },
    'workspace_write',
    { agentId: 'iso', runId: 'iso-1', babelRoot: root },
    { authoritySession: session, executor },
  );
  assert.equal(run.policyBlocked, true);
  assert.equal(executed, false);
  const wire = decideWithLease(
    { type: 'run_command', command: 'node -e "/* gh pr merge 88 */ console.log(1)"' },
    'workspace_write',
    { lease: parsed.lease, baseline: { repoRoot: root, manifest: { schemaVersion: 1, entries: [], capturedAt: '' } } },
  );
  assert.equal(wire.decision, 'deny');
});

test('authorized git commit -m cannot execute hooksPath or default hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-hook-'));
  roots.push(root);
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf-8', windowsHide: true });
  assert.equal(git(['init']).status, 0);
  assert.equal(git(['config', 'user.email', 'babel-test@example.com']).status, 0);
  assert.equal(git(['config', 'user.name', 'Babel Test']).status, 0);
  assert.equal(git(['config', 'core.hooksPath', '.githooks']).status, 0);
  mkdirSync(join(root, '.githooks'), { recursive: true });
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  const hookBody = '#!/bin/sh\necho ran > HOOK_RAN\nexit 1\n';
  writeFileSync(join(root, '.githooks', 'pre-commit'), hookBody);
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), hookBody);
  if (process.platform !== 'win32') {
    chmodSync(join(root, '.githooks', 'pre-commit'), 0o755);
    chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  }
  writeFileSync(join(root, 'tracked.txt'), 'content\n');
  assert.equal(git(['add', 'tracked.txt']).status, 0);

  const hardened = hardenGitHostEnvironment({ PATH: process.env['PATH'], HOME: process.env['HOME'] });
  assert.equal(hardened.GIT_CONFIG_KEY_0, 'core.hooksPath');
  assert.ok(hardened.GIT_CONFIG_VALUE_0);

  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(dirname(persistPath), { recursive: true });
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'commit-hooks',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['commit_ship_set', 'run_local_command'],
    }),
  );
  assert.ok(parsed.ok);
  const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
  const se = new SafeExecutor(root);
  const executor = createToolExecutor({
    executeTool: async (req) => {
      if (req.tool === 'shell_exec' || req.tool === 'test_run') {
        return se.shellExecAsync(req.command, root, 15_000);
      }
      return { exit_code: 1, stdout: '', stderr: `unexpected tool ${req.tool}` };
    },
  });
  const run = await executeActionWithPolicy(
    { type: 'run_command', command: 'git commit -m test' },
    'workspace_write',
    { agentId: 'hooks', runId: 'hooks-1', babelRoot: root },
    { authoritySession: session, executor },
  );
  assert.equal(run.policyBlocked, false, run.results[0]?.stderr);
  assert.equal(run.results[0]?.exit_code, 0, run.results[0]?.stderr);
  assert.equal(existsSync(join(root, 'HOOK_RAN')), false);
  const log = git(['log', '-1', '--pretty=%s']);
  assert.equal(log.status, 0);
  assert.match(log.stdout, /test/);

  writeFileSync(join(root, 'second.txt'), 'more\n');
  assert.equal(git(['add', 'second.txt']).status, 0);
  const seResult = se.shellExec('git commit -m second', root, 15_000);
  assert.equal(seResult.exit_code, 0, seResult.stderr);
  assert.equal(existsSync(join(root, 'HOOK_RAN')), false);
});

test('raw git merge feature is forbidden before spawn; --no-edit still needs a PR target', async () => {
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'merge-no-target',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['merge'],
      constraints: { allowedPullRequests: [88], repositoryAdmin: true },
    }),
  );
  assert.ok(parsed.ok);
  const raw = parseGitCommand('git merge feature');
  assert.equal(raw.capability, 'unknown');
  assert.equal(classifyExecutionRisk('git merge feature').reason, 'git_editor_denied');
  const noEdit = parseGitCommand('git merge --no-edit feature');
  assert.equal(noEdit.capability, 'merge');
  assert.equal(noEdit.target, undefined);
  const denied = decideActionRequest(
    { capability: noEdit.capability, ...(noEdit.target !== undefined ? { target: noEdit.target } : {}) },
    parsed.lease,
  );
  assert.equal(denied.outcome, 'deny');
  assert.ok(denied.rulesTriggered.includes('pdp.missing_pr_target'));

  const root = mkdtempSync(join(tmpdir(), 'babel-merge-deny-'));
  roots.push(root);
  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(dirname(persistPath), { recursive: true });
  const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
  let executed = false;
  const executor = createToolExecutor({
    executeTool: async () => {
      executed = true;
      return { exit_code: 0, stdout: 'nope', stderr: '' };
    },
  });
  const run = await executeActionWithPolicy(
    { type: 'run_command', command: 'git merge feature' },
    'workspace_write',
    { agentId: 'merge', runId: 'merge-1', babelRoot: root },
    { authoritySession: session, executor },
  );
  assert.equal(run.policyBlocked, true);
  assert.equal(executed, false);
});

test('repo_admin cannot write execution-bearing Git config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-cfg-'));
  roots.push(root);
  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(dirname(persistPath), { recursive: true });
  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'repo-admin-poison',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['repo_admin', 'commit_ship_set'],
      constraints: { repositoryAdmin: true },
    }),
  );
  assert.ok(parsed.ok);
  const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
  let executed = false;
  const executor = createToolExecutor({
    executeTool: async () => {
      executed = true;
      return { exit_code: 0, stdout: 'nope', stderr: '' };
    },
  });
  const run = await executeActionWithPolicy(
    { type: 'run_command', command: 'git config core.editor ./attack-editor' },
    'workspace_write',
    { agentId: 'cfg', runId: 'cfg-1', babelRoot: root },
    { authoritySession: session, executor },
  );
  assert.equal(run.policyBlocked, true, run.results[0]?.stderr);
  assert.equal(executed, false);

  executed = false;
  const includeRun = await executeActionWithPolicy(
    { type: 'run_command', command: 'git config include.path ./evil.gitconfig' },
    'workspace_write',
    { agentId: 'cfg', runId: 'cfg-2', babelRoot: root },
    { authoritySession: session, executor },
  );
  assert.equal(includeRun.policyBlocked, true, includeRun.results[0]?.stderr);
  assert.equal(executed, false);
});

test('authorized git commit -m does not run a configured signer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-git-sign-'));
  roots.push(root);
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf-8', windowsHide: true });
  assert.equal(git(['init']).status, 0);
  assert.equal(git(['config', 'user.email', 'babel-test@example.com']).status, 0);
  assert.equal(git(['config', 'user.name', 'Babel Test']).status, 0);
  const signer = join(root, process.platform === 'win32' ? 'fake-gpg.cmd' : 'fake-gpg.sh');
  const sentinel = join(root, 'SIGNER_RAN');
  if (process.platform === 'win32') {
    writeFileSync(signer, `@echo off\r\necho ran>"${sentinel}"\r\nexit /b 0\r\n`);
  } else {
    writeFileSync(signer, `#!/bin/sh\necho ran > "${sentinel}"\nexit 0\n`);
    chmodSync(signer, 0o755);
  }
  assert.equal(git(['config', 'commit.gpgSign', 'true']).status, 0);
  assert.equal(git(['config', 'gpg.program', signer]).status, 0);
  writeFileSync(join(root, 'signed.txt'), 'content\n');
  assert.equal(git(['add', 'signed.txt']).status, 0);

  const hardened = hardenGitHostEnvironment({ PATH: process.env['PATH'], HOME: process.env['HOME'] });
  assert.equal(hardened.GIT_CONFIG_KEY_1, 'commit.gpgSign');
  assert.equal(hardened.GIT_CONFIG_VALUE_1, 'false');

  if (!process.env['BABEL_ALLOW_HOST_FALLBACK'] && process.env['BABEL_DOCKER_DISABLE'] !== 'true') {
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  }
  const se = new SafeExecutor(root);
  const result = se.shellExec('git commit -m signed', root, 15_000);
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(existsSync(sentinel), false);
});

test('Git auxiliary-program surface is closed or deterministically suppressed', () => {
  const mustForbid = [
    'git branch --edit-description',
    'git config --edit',
    'git config -e',
    'git config core.editor vim',
    'git config alias.x !true',
    'git config include.path ./evil',
    'git config includeIf.gitdir:/tmp.path ./evil',
    'git config credential.https://github.com.helper !x',
    'git config protocol.ext.allow always',
    'git config core.gitProxy ./attack',
    'git config --global user.email babel@example.com',
    'git merge feature',
    'git tag -a v1',
    'git tag --annotate v1',
    'git tag -e -a v1 -m x',
    'git rebase --exec true',
    'git rebase -i HEAD',
    'git commit',
    'git commit -S -m x',
    'env GIT_SSH_COMMAND=./attack git push origin feat/x',
    'env -i git commit -m x',
    'git fetch --upload-pack=./attack origin',
    'git fetch --upload-pack ./attack origin',
    'git push --receive-pack=./attack origin feat/x',
    'git push --receive-pack ./attack origin feat/x',
    'git pull --upload-pack=./attack origin',
  ];
  for (const command of mustForbid) {
    assert.equal(classifyExecutionRisk(command).executionRisk, 'forbidden', command);
  }
  const mustAllowDeterministic = [
    ['git commit -m x', 'commit_ship_set'],
    ['git commit --amend --no-edit', 'shared_history_rewrite'],
    ['git tag -a v1 -m release', 'release'],
    ['git branch feat/x', 'create_task_branch'],
    ['git status', 'inspect_repository'],
    ['git config user.email babel@example.com', 'repo_admin'],
    ['git config --get core.editor', 'repo_admin'],
    ['git config core.editor', 'repo_admin'],
    ['git merge --no-edit feature', 'merge'],
    ['env git status', 'inspect_repository'],
  ] as const;
  for (const [command, capability] of mustAllowDeterministic) {
    assert.equal(parseGitCommand(command).capability, capability, command);
    assert.notEqual(classifyExecutionRisk(command).executionRisk, 'forbidden', command);
  }
});

test('git fetch --upload-pack and git push --receive-pack fail closed before spawn', async () => {
  const commands = [
    'git fetch --upload-pack=./attack origin',
    'git fetch --upload-pack ./attack origin',
    'git push --receive-pack=./attack origin feat/x',
    'git push --receive-pack ./attack origin feat/x',
    'git pull --upload-pack=./attack origin',
  ];
  for (const command of commands) {
    assert.equal(classifyExecutionRisk(command).executionRisk, 'forbidden', command);
    assert.equal(classifyExecutionRisk(command).reason, 'git_exec_denied', command);
    assert.equal(parseGitCommand(command).capability, 'unknown', command);
    assert.ok(validateExecutorShellCommand(command, process.platform, 'dev_local'), command);
  }

  const parsed = parseLeaseJson(
    JSON.stringify({
      version: 2,
      leaseId: 'upload-pack-deny',
      scope: { repository: 'babel', remote: 'origin' },
      allowedCapabilities: ['run_local_command', 'push_feature_branch', 'commit_ship_set'],
    }),
  );
  assert.ok(parsed.ok);
  for (const command of commands) {
    const p = parseGitCommand(command);
    const denied = decideActionRequest({ capability: p.capability }, parsed.lease);
    assert.equal(denied.outcome, 'deny', command);
    assert.equal(denied.reasonCode, 'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT', command);
  }

  const root = mkdtempSync(join(tmpdir(), 'babel-upload-pack-'));
  roots.push(root);
  const persistPath = join(root, 'runs/s1/authority-session.json');
  mkdirSync(dirname(persistPath), { recursive: true });
  const session = establishAuthoritySession({ repoRoot: root, lease: parsed.lease, persistPath });
  let executed = false;
  const executor = createToolExecutor({
    executeTool: async () => {
      executed = true;
      return { exit_code: 0, stdout: 'nope', stderr: '' };
    },
  });
  for (const command of commands) {
    executed = false;
    const run = await executeActionWithPolicy(
      { type: 'run_command', command },
      'workspace_write',
      { agentId: 'upack', runId: 'upack-1', babelRoot: root },
      { authoritySession: session, executor },
    );
    assert.equal(run.policyBlocked, true, command);
    assert.equal(executed, false, command);
  }

  const sentinel = join(root, 'HELPER_RAN');
  const helper = join(root, process.platform === 'win32' ? 'attack.cmd' : 'attack.sh');
  if (process.platform === 'win32') {
    writeFileSync(helper, `@echo off\r\necho ran>"${sentinel}"\r\nexit /b 0\r\n`);
  } else {
    writeFileSync(helper, `#!/bin/sh\necho ran > "${sentinel}"\nexit 0\n`);
    chmodSync(helper, 0o755);
  }
  if (!process.env['BABEL_ALLOW_HOST_FALLBACK'] && process.env['BABEL_DOCKER_DISABLE'] !== 'true') {
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  }
  const se = new SafeExecutor(root);
  const fetchCmd = `git fetch --upload-pack=${helper} origin`;
  const fetchResult = se.shellExec(fetchCmd, root, 15_000);
  assert.notEqual(fetchResult.exit_code, 0, fetchResult.stderr);
  assert.equal(existsSync(sentinel), false);
  const pushCmd = `git push --receive-pack=${helper} origin feat/x`;
  const pushResult = se.shellExec(pushCmd, root, 15_000);
  assert.notEqual(pushResult.exit_code, 0, pushResult.stderr);
  assert.equal(existsSync(sentinel), false);
});

test('SafeExecutor denies gradlew test on host profile without authority stack', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-se-gradle-'));
  roots.push(root);
  const prev = process.env['BABEL_EXECUTION_PROFILE'];
  const prevHostFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  // This test proves the no-escalation denial path, so an explicit host
  // fallback inherited from another test's environment must not leak in.
  delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
  try {
    const se = new SafeExecutor(root);
    const result = se.shellExec('gradlew test', root, 5_000);
    assert.notEqual(result.exit_code, 0);
    assert.match(result.stderr, /isolation_required|project or container-only/i);
  } finally {
    if (prev === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = prev;
    if (prevHostFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = prevHostFallback;
  }
});

test('validateExecutorShellCommand denies git -c execution config', () => {
  const issue = validateExecutorShellCommand(
    'git -c protocol.ext.allow=always fetch ext::echo',
    process.platform,
    'dev_local',
  );
  assert.ok(issue);
});

test('docker extra args fail closed for host networking forms', () => {
  assert.equal(validateDockerIsolationArgs('--network host').ok, false);
  assert.equal(validateDockerIsolationArgs('--network=host').ok, false);
  assert.equal(validateDockerIsolationArgs('--cap-add SYS_ADMIN').ok, false);
  assert.equal(validateDockerIsolationArgs('--cap-add=SYS_ADMIN').ok, false);
  assert.equal(validateDockerIsolationArgs('--read-only --user 1000:1000').ok, true);
});

test('docker extra args fail closed for equals and space security-opt unconfined', () => {
  assert.equal(validateDockerIsolationArgs('--security-opt seccomp=unconfined').ok, false);
  assert.equal(validateDockerIsolationArgs('--security-opt=seccomp=unconfined').ok, false);
  assert.equal(validateDockerIsolationArgs('--security-opt apparmor=unconfined').ok, false);
  assert.equal(validateDockerIsolationArgs('--security-opt=apparmor=unconfined').ok, false);
  assert.equal(validateDockerIsolationArgs('--security-opt=no-new-privileges').ok, true);
});

describe('hostProcessSurface', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = resolveSrcRoot(here);

  test('direct child-process call sites match the checked manifest', () => {
    const found = collectSpawnFiles(srcRoot).sort();
    const missing = found.filter((f) => !HOST_PROCESS_SURFACE.has(f));
    const extra = [...HOST_PROCESS_SURFACE].filter((f) => !found.includes(f));
    assert.deepEqual(missing, [], `unregistered spawn sites: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `stale manifest entries: ${extra.join(', ')}`);
  });
});

function resolveSrcRoot(fromAuthority: string): string {
  return join(fromAuthority, '..');
}

const SPAWN_RE = /\b(spawn|spawnSync|execFile|execFileSync)\s*\(/;

function collectSpawnFiles(srcRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (ent === 'node_modules' || ent === 'dist') continue;
        walk(full);
        continue;
      }
      if (!ent.endsWith('.ts') && !ent.endsWith('.js')) continue;
      if (ent.endsWith('.test.ts') || ent.endsWith('.test.js')) continue;
      const text = readFileSync(full, 'utf8');
      if (SPAWN_RE.test(text)) out.push(relative(srcRoot, full).replace(/\\/g, '/'));
    }
  };
  walk(srcRoot);
  return out;
}

/** Production (non-test) files that spawn child processes. Update when adding a site. */
const HOST_PROCESS_SURFACE = new Set([
  'agent/backgroundShell.ts',
  'agent/breakerContract.ts',
  'bridge/workspaceChanges.ts',
  'eval/canary/liveCell.ts',
  'eval/cleanRoomGrade.ts',
  'agent/capabilityBroker.ts',
  'agent/chatEngineSupport.ts',
  'agent/diffCritic.ts',
  'agent/implementWorktreeAgent.ts',
  'bridge/sessionRunner.ts',
  'cli/helpers.ts',
  'config/benchmarkContainer.ts',
  'daemon/client.ts',
  'doctor.ts',
  'evidence/independentVerifier.ts',
  'evidence/revisionBoundReceipt.ts',
  'interactive/openEditor.ts',
  'localTools.ts',
  'pipeline/bootstrapLanes.ts',
  'pipeline/liveSessionParity.ts',
  'runners/cliBase.ts',
  'runners/transportConformance.fixture.ts',
  'sandbox.ts',
  'services/agentBenchmark.ts',
  'services/agentBenchmarkHarness.ts',
  'services/agentTeams.ts',
  'services/benchmarkImprovementLoop.ts',
  'services/benchmarkRepairLoop.ts',
  'services/causalCampaignContract.ts',
  'services/checkpoints.ts',
  'services/cliSmokeBenchmark.ts',
  'services/contextInjection.ts',
  'services/dogfoodSandbox.ts',
  'services/evidenceProduct.ts',
  'stages/runtimePreflight.ts',
  'stages/runtimeVerificationRunner.ts',
  'utils/gitExec.ts',
  'agent/agentRunCoordinator.ts',
  'services/gitMutations.ts',
  'services/governanceBenchmark.ts',
  'services/knowledgeGraphIndexer.ts',
  'services/learning.ts',
  'services/liteParallelReview.ts',
  'services/liteTrustDemo.ts',
  'services/liteWorkerLoop.ts',
  'services/liveCliReliabilityMatrix.ts',
  'services/lsp/client.ts',
  'services/maintenanceAudit.ts',
  'services/parityCorpus.ts',
  'services/productBenchmark.ts',
  'services/realTaskPilot.ts',
  'services/releaseReadinessBenchmark.ts',
  'services/shadowDiff.ts',
  'services/ship.ts',
  'services/smallFix.ts',
  'services/swebenchProCampaign.ts',
  'services/verifierOverlay.ts',
  'services/workspaceDepPreflight.ts',
  'services/worktreeIsolation.ts',
  'services/worktreeSafety.ts',
  'tools/auditUiTool.ts',
  'tools/mcpTransport.ts',
  'tools/ripgrep.ts',
]);
