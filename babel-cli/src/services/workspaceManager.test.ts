import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getWorkspaceApprovedRoots,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveApprovedWorkspacePath,
  verifyWorkspaceProject,
} from './workspaceManager.js';

function withApprovedRoots<T>(roots: string[], run: () => T): T {
  const previous = process.env['BABEL_WORKSPACE_APPROVED_ROOTS'];
  process.env['BABEL_WORKSPACE_APPROVED_ROOTS'] = roots.join(';');
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_WORKSPACE_APPROVED_ROOTS'];
    } else {
      process.env['BABEL_WORKSPACE_APPROVED_ROOTS'] = previous;
    }
  }
}

function withWorkspaceRoot<T>(workspaceRoot: string, run: () => T): T {
  const previous = process.env['BABEL_WORKSPACE_ROOT'];
  process.env['BABEL_WORKSPACE_ROOT'] = workspaceRoot;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env['BABEL_WORKSPACE_ROOT'];
    } else {
      process.env['BABEL_WORKSPACE_ROOT'] = previous;
    }
  }
}

function withApprovalQueue<T>(run: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-approvals-'));
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

test('workspace manager roots can be overridden for tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-roots-'));
  try {
    withApprovedRoots([root], () => {
      const roots = getWorkspaceApprovedRoots();
      assert.equal(roots.length, 1);
      assert.equal(roots[0]?.path, resolve(root));
      assert.equal(roots[0]?.exists, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace manager roots default to the explicit project root', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-default-workspace-'));
  const repo = join(workspace, 'AnyRepo');
  const outside = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-default-outside-'));
  try {
    mkdirSync(repo);
    writeFileSync(join(repo, 'note.txt'), 'hello from any workspace repo\n', 'utf-8');
    writeFileSync(join(outside, 'secret.txt'), 'nope\n', 'utf-8');
    const roots = getWorkspaceApprovedRoots(repo);
    assert.equal(roots.length, 1);
    assert.equal(roots[0]?.path, resolve(repo));
    assert.notEqual(roots[0]?.path, resolve(workspace));
    assert.notEqual(roots[0]?.path, resolve(outside));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace manager roots expose sandbox mirror aliases', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-workspace-'));
  const scratch = join(workspace, 'scratch');
  try {
    mkdirSync(scratch);
    withWorkspaceRoot(workspace, () => {
      withApprovedRoots([scratch], () => {
        const roots = getWorkspaceApprovedRoots();
        assert.deepEqual(roots[0]?.aliases, [
          '/workspace/scratch',
          '/workspace/repos/scratch',
          'repos/scratch',
        ]);
      });
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('workspace file read accepts sandbox mirror aliases for approved roots', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-alias-'));
  const scratch = join(workspace, 'scratch');
  try {
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'note.txt'), 'hello through babel\n', 'utf-8');

    withWorkspaceRoot(workspace, () => {
      withApprovedRoots([scratch], () => {
        const resolved = resolveApprovedWorkspacePath('/workspace/scratch/note.txt');
        assert.equal(resolved.path, resolve(scratch, 'note.txt'));

        const read = readWorkspaceFile('repos/scratch/note.txt');
        assert.equal(read.content, 'hello through babel\n');
      });
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('workspace file list/read stay inside approved roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-files-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-outside-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.js'), 'export const ok = true;\n', 'utf-8');
    writeFileSync(join(outside, 'secret.txt'), 'nope\n', 'utf-8');

    withApprovedRoots([root], () => {
      const listed = listWorkspaceFiles(root, { recursive: true });
      assert.equal(listed.entries.some(entry => entry.relative_path === 'src/index.js'), true);

      const read = readWorkspaceFile(join(root, 'src', 'index.js'));
      assert.match(read.content, /ok = true/);

      assert.throws(
        () => resolveApprovedWorkspacePath(join(outside, 'secret.txt')),
        /outside approved workspace roots/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('workspace verify runs explicit commands through workspace_manager', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-verify-'));
  try {
    writeFileSync(
      join(root, 'sample.test.js'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('sample', () => assert.equal(1 + 1, 2));\n",
      'utf-8',
    );

    withApprovedRoots([root], () => {
      const report = verifyWorkspaceProject(root, {
        commands: ['node --test sample.test.js'],
        timeoutSeconds: 30,
      });
      assert.equal(report.status, 'pass');
      assert.equal(report.execution_profile, 'workspace_manager');
      assert.equal(report.command_results[0]?.exit_code, 0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace verify blocks dependency install commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-workspace-manager-install-'));
  try {
    withApprovedRoots([root], () => {
      withApprovalQueue(() => {
        const report = verifyWorkspaceProject(root, {
          commands: ['npm install'],
          timeoutSeconds: 30,
        });
        assert.equal(report.status, 'fail');
        assert.equal(report.command_results[0]?.exit_code, 1);
        assert.match(report.command_results[0]?.stderr ?? '', /dependency installation requires explicit approval/);
        assert.match(report.command_results[0]?.stderr ?? '', /babel approvals approve dep-/);
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
