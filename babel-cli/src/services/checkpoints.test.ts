import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  createPreMutationCheckpoint,
  finalizeCheckpointAfterToolCall,
  formatCheckpointInspect,
  listCheckpoints,
  restoreCheckpoint,
} from './checkpoints.js';

function makeFixture(): {
  base: string;
  projectRoot: string;
  runDir: string;
  context: { runId: string; runDir: string; babelRoot: string };
} {
  const base = mkdtempSync(join(tmpdir(), 'babel-checkpoints-'));
  const projectRoot = join(base, 'project');
  const babelRoot = join(base, 'babel-repo');
  const runDir = join(babelRoot, 'runs', '20260424_120000_checkpoint-fixture');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return {
    base,
    projectRoot,
    runDir,
    context: {
      runId: '20260424_120000_checkpoint-fixture',
      runDir,
      babelRoot,
    },
  };
}

test('file_write checkpoint restores prior file content', () => {
  const fixture = makeFixture();
  try {
    const target = join(fixture.projectRoot, 'src', 'example.txt');
    writeFileSync(target, 'before\n', 'utf-8');

    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'file_write',
        path: 'src/example.txt',
        content: 'after\n',
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);
    writeFileSync(target, 'after\n', 'utf-8');
    finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);

    const result = restoreCheckpoint(checkpoint);
    assert.equal(result.status, 'restored');
    assert.equal(readFileSync(target, 'utf-8'), 'before\n');

    const index = listCheckpoints(fixture.runDir);
    assert.equal(index.checkpoints.length, 1);
    assert.equal(index.checkpoints[0]?.id, checkpoint.id);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('file_write checkpoint refuses to overwrite later user edits without force', () => {
  const fixture = makeFixture();
  try {
    const target = join(fixture.projectRoot, 'src', 'example.txt');
    writeFileSync(target, 'before\n', 'utf-8');

    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'file_write',
        path: 'src/example.txt',
        content: 'after\n',
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);
    writeFileSync(target, 'after\n', 'utf-8');
    const finalized = finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);
    assert.ok(finalized);

    writeFileSync(target, 'user edit\n', 'utf-8');
    const refused = restoreCheckpoint(finalized);
    assert.equal(refused.status, 'refused');
    assert.equal(readFileSync(target, 'utf-8'), 'user edit\n');

    const forced = restoreCheckpoint(finalized, { force: true });
    assert.equal(forced.status, 'restored');
    assert.equal(readFileSync(target, 'utf-8'), 'before\n');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('new-file checkpoint removes a file Babel created', () => {
  const fixture = makeFixture();
  try {
    const target = join(fixture.projectRoot, 'src', 'created.txt');
    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'file_write',
        path: 'src/created.txt',
        content: 'created\n',
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);
    writeFileSync(target, 'created\n', 'utf-8');
    const finalized = finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);
    assert.ok(finalized);

    const restored = restoreCheckpoint(finalized);
    assert.equal(restored.status, 'restored');
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('shell_exec checkpoint restores modified files from filesystem diff', () => {
  const fixture = makeFixture();
  try {
    const target = join(fixture.projectRoot, 'src', 'example.txt');
    writeFileSync(target, 'before\n', 'utf-8');

    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'shell_exec',
        command: 'node mutate.js',
        working_directory: fixture.projectRoot,
        timeout_seconds: 30,
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);
    assert.equal(checkpoint.restore_status, 'metadata_only');

    writeFileSync(target, 'after\n', 'utf-8');
    const finalized = finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);
    assert.ok(finalized);
    assert.equal(finalized.restore_status, 'available');
    assert.equal(finalized.files.length, 1);
    assert.equal(finalized.files[0]?.project_relative_path, 'src/example.txt');
    assert.equal(finalized.filesystem_diff?.modified_files, 1);

    const result = restoreCheckpoint(finalized);
    assert.equal(result.status, 'restored');
    assert.equal(readFileSync(target, 'utf-8'), 'before\n');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('checkpoint inspect output includes restore command and coverage warnings', () => {
  const fixture = makeFixture();
  try {
    const target = join(fixture.projectRoot, 'src', 'example.txt');
    writeFileSync(target, 'before\n', 'utf-8');

    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'shell_exec',
        command: 'node mutate.js',
        working_directory: fixture.projectRoot,
        timeout_seconds: 30,
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);

    writeFileSync(target, 'after\n', 'utf-8');
    const finalized = finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);
    assert.ok(finalized);

    const output = formatCheckpointInspect(finalized);
    assert.match(output, new RegExp(`babel checkpoint restore ${finalized.id} --run "`));
    assert.match(output, /Safety:/);
    assert.match(output, /Restore refuses to clobber later user edits/);
    assert.match(output, /Snapshot coverage:/);
    assert.match(output, /Restore coverage:/);
    assert.match(output, /Modified: 1/);
    assert.match(output, /Restorable files: 1/);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('shell_exec checkpoint removes files created by command diff', () => {
  const fixture = makeFixture();
  try {
    const target = join(fixture.projectRoot, 'src', 'created-by-command.txt');
    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'shell_exec',
        command: 'node mutate.js',
        working_directory: fixture.projectRoot,
        timeout_seconds: 30,
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);

    writeFileSync(target, 'created\n', 'utf-8');
    const finalized = finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);
    assert.ok(finalized);
    assert.equal(finalized.restore_status, 'available');
    assert.equal(finalized.filesystem_diff?.created_files, 1);

    const result = restoreCheckpoint(finalized);
    assert.equal(result.status, 'restored');
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('test_run checkpoint restores deleted files from filesystem diff', () => {
  const fixture = makeFixture();
  try {
    const target = join(fixture.projectRoot, 'src', 'deleted-by-test.txt');
    writeFileSync(target, 'before\n', 'utf-8');

    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'test_run',
        command: 'npm test',
        working_directory: fixture.projectRoot,
        timeout_seconds: 30,
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);

    unlinkSync(target);
    const finalized = finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);
    assert.ok(finalized);
    assert.equal(finalized.restore_status, 'available');
    assert.equal(finalized.filesystem_diff?.deleted_files, 1);

    const result = restoreCheckpoint(finalized);
    assert.equal(result.status, 'restored');
    assert.equal(readFileSync(target, 'utf-8'), 'before\n');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('transactional restore aborts completely if any target file is locked or read-only', () => {
  const fixture = makeFixture();
  const target = join(fixture.projectRoot, 'src', 'locked-file.txt');
  try {
    writeFileSync(target, 'before\n', 'utf-8');

    const checkpoint = createPreMutationCheckpoint(
      {
        tool: 'file_write',
        path: 'src/locked-file.txt',
        content: 'after\n',
      },
      fixture.context,
      {
        dryRun: false,
        projectRoot: fixture.projectRoot,
      },
    );
    assert.ok(checkpoint);

    writeFileSync(target, 'after\n', 'utf-8');
    const finalized = finalizeCheckpointAfterToolCall(checkpoint.id, fixture.context);
    assert.ok(finalized);

    // Make the file read-only to simulate a lock/permission error
    chmodSync(target, 0o400);

    const result = restoreCheckpoint(finalized);
    assert.equal(result.status, 'refused');
    assert.ok(
      result.refused_files.some(
        (f) => f.path === target && f.reason.includes('locked or unwritable'),
      ),
    );

    // Make it writable again to inspect and cleanup
    chmodSync(target, 0o666);
    assert.equal(readFileSync(target, 'utf-8'), 'after\n'); // should NOT have been rolled back
  } finally {
    try {
      chmodSync(target, 0o666);
    } catch {
      /* intentional: chmod may fail but we still want rmSync */
    }
    rmSync(fixture.base, { recursive: true, force: true });
  }
});
