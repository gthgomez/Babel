import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotGovernanceBytes } from './governanceReconcile.js';
import { buildBaseline, checkBaseline } from './integrity.js';

function fixture(): { root: string; worktree: string; common: string } {
  const root = mkdtempSync(join(tmpdir(), 'babel-worktree-governance-'));
  const common = join(root, 'main', '.git');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', 'main');
  git('-C', 'main', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  git('-C', 'main', 'worktree', 'add', '--detach', join(root, 'linked'));
  return { root, worktree: join(root, 'linked'), common };
}

test('actual linked worktree snapshots shared Git governance and detects config drift', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline(f.worktree, f.common);
    const snapshots = snapshotGovernanceBytes(f.worktree, [], undefined, f.common);
    assert.ok(snapshots.some((s) => s.abs === join(f.common, 'config') && s.kind === 'file'));
    writeFileSync(join(f.common, 'config'), '[core]\n bare = false\n');
    assert.equal(checkBaseline(f.worktree, baseline).ok, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('linked worktree repair does not grant missing test authority', async () => {
  const f = fixture();
  const previous = process.env['BABEL_ALLOW_HOST_FALLBACK'];
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  try {
    const { establishAuthoritySession } = await import('./sessionContext.js');
    const { executeActionWithPolicy } = await import('../agent/toolExecutor.js');
    const session = establishAuthoritySession({ repoRoot: f.worktree, trustedGitCommonDir: f.common, lease: null });
    const context = { agentId: 'fixture', runId: 'worktree-native', babelRoot: f.worktree, projectRoot: f.worktree };
    const deps = { authoritySession: session, hostFallbackAllowed: true };
    const edit = await executeActionWithPolicy({ type: 'write_file', path: 'proof.cjs', content: "require('node:assert/strict').equal(2 + 2, 4); console.log('worktree-test-executed');\n" }, 'workspace_write', context, deps);
    assert.equal(edit.policyBlocked, false);
    assert.equal(edit.results[0]?.exit_code, 0);
    const testRun = await executeActionWithPolicy({ type: 'test_run', command: 'node proof.cjs', cwd: f.worktree }, 'workspace_write', context, deps);
    assert.equal(testRun.policyBlocked, true);
    assert.equal(testRun.reasonCode, 'DENY_MISSING_AUTHORITY');
    assert.doesNotMatch(testRun.results[0]?.stdout ?? '', /worktree-test-executed/);
    assert.equal(session.invalidated, false);
  } finally {
    if (previous === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK']; else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previous;
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const target of ['config', 'config.worktree', 'info/attributes', 'hooks/pre-commit', 'hooks/new-hook']) {
  test(`shared ${target} changes restore without granting authority`, async () => {
    const f = fixture();
    try {
      const { existsSync, mkdirSync, readFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const { reconcileGovernanceAfterEffect } = await import('./governanceReconcile.js');
      const { establishAuthoritySession } = await import('./sessionContext.js');
      const path = join(f.common, target);
      mkdirSync(dirname(path), { recursive: true });
      const newlyCreated = target === 'hooks/new-hook';
      if (!newlyCreated) writeFileSync(path, 'original');
      const session = establishAuthoritySession({ repoRoot: f.worktree, trustedGitCommonDir: f.common, lease: null });
      const before = snapshotGovernanceBytes(f.worktree, [], undefined, f.common);
      writeFileSync(path, 'modified');
      const result = reconcileGovernanceAfterEffect({ repoRoot: f.worktree, before, session });
      assert.equal(result.mutated, true);
      assert.deepEqual(result.failed, []);
      if (newlyCreated) assert.equal(existsSync(path), false);
      else assert.equal(readFileSync(path, 'utf8'), 'original');
      assert.equal(session.invalidated, true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const target of ['.git', 'commondir', 'gitdir']) {
  test(`redirected ${target} fails closed and does not retarget snapshots`, async () => {
    const f = fixture();
    try {
      const { readFileSync } = await import('node:fs');
      const { reconcileGovernanceAfterEffect } = await import('./governanceReconcile.js');
      const before = snapshotGovernanceBytes(f.worktree, [], undefined, f.common);
      const baseline = buildBaseline(f.worktree, f.common);
      const path = target === '.git' ? join(f.worktree, target) : join(f.common, 'worktrees', 'linked', target);
      const original = readFileSync(path, 'utf8');
      writeFileSync(path, target === '.git' ? 'gitdir: ../unrelated\n' : '../unrelated\n');
      assert.equal(checkBaseline(f.worktree, baseline).ok, false);
      assert.throws(() => snapshotGovernanceBytes(f.worktree, [], undefined, f.common), /governance inspect failed/);
      assert.equal(reconcileGovernanceAfterEffect({ repoRoot: f.worktree, before }).mutated, true);
      assert.equal(readFileSync(path, 'utf8'), original);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('ordinary worktree index and HEAD updates do not change governance', () => {
  const f = fixture();
  try {
    const baseline = buildBaseline(f.worktree, f.common);
    writeFileSync(join(f.worktree, 'source.txt'), 'source');
    execFileSync('git', ['add', 'source.txt'], { cwd: f.worktree });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'], { cwd: f.worktree, stdio: 'pipe' });
    assert.equal(checkBaseline(f.worktree, baseline).ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('swapped governance ancestor cannot redirect inspection or restoration', async () => {
  const f = fixture();
  try {
    const { mkdirSync, readFileSync, renameSync, symlinkSync } = await import('node:fs');
    const { restoreGovernanceBytes } = await import('./governanceReconcile.js');
    const hooks = join(f.common, 'hooks');
    writeFileSync(join(hooks, 'pre-commit'), 'original');
    const before = snapshotGovernanceBytes(f.worktree, [], undefined, f.common);
    const baseline = buildBaseline(f.worktree, f.common);
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'pre-commit'), 'untouched');
    renameSync(hooks, `${hooks}-saved`);
    symlinkSync(outside, hooks, 'junction');
    assert.equal(checkBaseline(f.worktree, baseline).ok, false);
    const restored = restoreGovernanceBytes(before);
    assert.deepEqual(restored.failed, []);
    assert.ok(restored.changed.length > 0);
    assert.equal(readFileSync(join(hooks, 'pre-commit'), 'utf8'), 'original');
    assert.equal(readFileSync(join(outside, 'pre-commit'), 'utf8'), 'untouched');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('resume requires the original explicit host common-directory binding', async () => {
  const f = fixture();
  try {
    const { establishAuthoritySession, restoreAuthoritySession } = await import('./sessionContext.js');
    const persistPath = join(f.root, 'authority-session.json');
    establishAuthoritySession({ repoRoot: f.worktree, trustedGitCommonDir: f.common, lease: null, persistPath });
    assert.equal(restoreAuthoritySession({ repoRoot: f.worktree, trustedGitCommonDir: f.common, lease: null, persistPath }).invalidated, false);
    assert.equal(restoreAuthoritySession({ repoRoot: f.worktree, lease: null, persistPath }).invalidated, true);
    assert.equal(restoreAuthoritySession({ repoRoot: f.worktree, trustedGitCommonDir: join(f.root, 'other'), lease: null, persistPath }).invalidated, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a bound Chat engine cannot carry Git governance authority into another project', async () => {
  const f = fixture();
  const prior = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = join(f.root, 'runs');
  try {
    const { ChatEngine } = await import('../agent/chatEngine.js');
    const { readFileSync } = await import('node:fs');
    const { chatSessionDir } = await import('../cli/runsLayout.js');
    const engine = new ChatEngine({ task: 'Inspect source files', projectRoot: f.worktree, trustedGitCommonDir: f.common });
    try {
      const state = join(chatSessionDir(engine.getEngineRunId()), 'authority-session.json');
      const original = readFileSync(state, 'utf8');
      assert.throws(() => engine.applyTurnPreparation({ task: 'Inspect another project', projectRoot: join(f.root, 'main') }), /SESSION_REBIND_REQUIRED/);
      assert.deepEqual(engine.getExecutionScope(), { kind: 'project', projectRoot: f.worktree });
      assert.equal(readFileSync(state, 'utf8'), original);
      engine.applyTurnPreparation({ task: 'Inspect source files again', projectRoot: f.worktree });
      assert.equal(readFileSync(state, 'utf8'), original);
    } finally { engine.closeAdmissionStore(); }
  } finally {
    if (prior === undefined) delete process.env['BABEL_RUNS_DIR']; else process.env['BABEL_RUNS_DIR'] = prior;
    rmSync(f.root, { recursive: true, force: true });
  }
});
