import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildParityFixtureFromResults,
  parityCorpusSeedExpectsFailingVerifier,
  readParityCorpusManifest,
  readParityCorpusTask,
  resolveParityCorpusRepoKind,
  resolveParityCorpusRunMode,
  resolveParityCorpusTaskPath,
  runParityBabelCell,
  runParityCorpusVerifier,
  writeParityCorpusRepo,
} from './parityCorpus.js';
import { skipIfNoApiKeys } from '../test-helpers/apiKeyCheck.js';

const ALL_TASK_IDS = [
  'small_bug_fix',
  'failing_test_repair',
  'multi_file_refactor',
  'docs_grounded_dependency_update',
  'issue_pr_context_implementation',
  'ui_browser_inspection',
  'checkpoint_restore_recovery',
  'read_only_subagent_review',
] as const;

test('parity corpus manifest lists tasks 1-8', () => {
  const manifest = readParityCorpusManifest();
  assert.deepEqual(manifest.tasks, [...ALL_TASK_IDS]);
  for (const taskId of ALL_TASK_IDS) {
    assert.ok(existsTask(taskId));
  }
});

function existsTask(taskId: string): boolean {
  try {
    readParityCorpusTask(taskId);
    return true;
  } catch {
    return false;
  }
}

test('parity corpus task fixtures expose verifier metadata', () => {
  const repair = readParityCorpusTask('failing_test_repair');
  assert.equal(repair.parity_task_id, 'failing_test_repair');
  assert.match(repair.broken_implementation, /multiply/);
  assert.match(repair.fixed_implementation, /\*/);

  const multi = readParityCorpusTask('multi_file_refactor');
  assert.equal(resolveParityCorpusRepoKind(multi), 'multi_file_fix');
  assert.ok(multi.files?.['src/format.js']);
});

test('parity corpus run modes resolve per repo_kind', () => {
  assert.equal(resolveParityCorpusRunMode(readParityCorpusTask('small_bug_fix')), 'fix');
  assert.equal(
    resolveParityCorpusRunMode(readParityCorpusTask('read_only_subagent_review')),
    'ask',
  );
  assert.equal(resolveParityCorpusRunMode(readParityCorpusTask('ui_browser_inspection')), 'ask');
});

for (const taskId of ALL_TASK_IDS) {
  test(`parity babel cell records offline_demo evidence for ${taskId}`, { skip: skipIfNoApiKeys }, async () => {
    const task = readParityCorpusTask(taskId);
    const expectedMode = resolveParityCorpusRunMode(task);
    const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-parity-corpus-test-'));
    const result = await runParityBabelCell(taskId, { evidenceDir });

    assert.equal(result.tool, 'babel');
    assert.equal(result.task_id, taskId);
    assert.equal(result.status, 'success');
    assert.equal(result.false_complete, false);
    assert.ok(result.evidence_path);
    assert.ok(result.latency_ms !== null && result.latency_ms >= 0);

    if (expectedMode === 'ask') {
      const repoKind = resolveParityCorpusRepoKind(task);
      assert.equal(result.verifier, repoKind === 'static_ui_report' ? 'fail' : 'pass');
    } else {
      assert.equal(result.verifier, 'pass');
    }

    const evidence = JSON.parse(readFileSync(result.evidence_path!, 'utf8')) as {
      fixture_type?: string;
      mode?: string;
    };
    assert.equal(evidence.fixture_type, 'babel_parity_babel_cell');
    assert.equal(evidence.mode, expectedMode);

    const fixture = buildParityFixtureFromResults([result]);
    assert.equal(fixture.results.length, 1);
    assert.equal(fixture.results[0]?.tool, 'babel');
  });
}

for (const taskId of ALL_TASK_IDS) {
  test(`parity corpus repo writer seeds verifier state for ${taskId}`, () => {
    const task = readParityCorpusTask(taskId);
    const root = mkdtempSync(join(tmpdir(), 'babel-parity-corpus-seed-'));
    try {
      writeParityCorpusRepo(root, task);
      const exitCode = runParityCorpusVerifier(root, task.verifier_command);
      if (parityCorpusSeedExpectsFailingVerifier(task)) {
        assert.notEqual(exitCode, 0, `expected failing verifier seed for ${taskId}`);
      } else {
        assert.equal(exitCode, 0, `expected passing verifier seed for ${taskId}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('parity corpus task paths resolve under fixtures', () => {
  const path = resolveParityCorpusTaskPath('small_bug_fix');
  assert.match(path, /parity-corpus[\\/]small_bug_fix\.json$/);
});
