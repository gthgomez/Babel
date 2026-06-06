import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildParityFixtureFromResults,
  readParityCorpusManifest,
  readParityCorpusTask,
  resolveParityCorpusTaskPath,
  runParityBabelCell,
} from './parityCorpus.js';

test('parity corpus manifest lists tasks 1-2', () => {
  const manifest = readParityCorpusManifest();
  assert.deepEqual(manifest.tasks, ['small_bug_fix', 'failing_test_repair']);
  assert.ok(existsTask('small_bug_fix'));
  assert.ok(existsTask('failing_test_repair'));
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
});

for (const taskId of ['small_bug_fix', 'failing_test_repair'] as const) {
  test(`parity babel fix cell records offline_demo evidence for ${taskId}`, async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-parity-corpus-test-'));
    const result = await runParityBabelCell(taskId, {
      mode: 'fix',
      evidenceDir,
    });

    assert.equal(result.tool, 'babel');
    assert.equal(result.task_id, taskId);
    assert.equal(result.status, 'success');
    assert.equal(result.verifier, 'pass');
    assert.equal(result.false_complete, false);
    assert.ok(result.evidence_path);
    assert.ok(result.latency_ms !== null && result.latency_ms >= 0);

    const evidence = JSON.parse(readFileSync(result.evidence_path!, 'utf8')) as {
      fixture_type?: string;
      mode?: string;
    };
    assert.equal(evidence.fixture_type, 'babel_parity_babel_cell');
    assert.equal(evidence.mode, 'fix');

    const fixture = buildParityFixtureFromResults([result]);
    assert.equal(fixture.results.length, 1);
    assert.equal(fixture.results[0]?.tool, 'babel');
  });
}

test('parity corpus task paths resolve under fixtures', () => {
  const path = resolveParityCorpusTaskPath('small_bug_fix');
  assert.match(path, /parity-corpus[\\/]small_bug_fix\.json$/);
});
