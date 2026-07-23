import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  hasFinalEvidence,
  isStaleLatestPointer,
  listLatestPointerFiles,
  repairStaleLatestPointers,
} from './runEvidence.js';

function writePointer(runsDir: string, name: string, payload: Record<string, unknown>): void {
  writeFileSync(join(runsDir, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('hasFinalEvidence accepts terminal_status_summary.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-run-evidence-'));
  const runDir = join(root, 'complete-run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'terminal_status_summary.json'), '{}\n', 'utf8');
  assert.equal(hasFinalEvidence(runDir), true);
});

test('repairStaleLatestPointers removes pointers to incomplete and missing runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-run-evidence-'));
  const runsDir = join(root, 'runs');
  const completeRun = join(runsDir, 'complete-run');
  const incompleteRun = join(runsDir, 'incomplete-run');
  mkdirSync(completeRun, { recursive: true });
  mkdirSync(incompleteRun, { recursive: true });
  writeFileSync(join(completeRun, 'manifest.json'), '{}\n', 'utf8');
  writeFileSync(join(incompleteRun, '01_manifest.json'), '{}\n', 'utf8');

  writePointer(runsDir, '.latest.complete.json', {
    run_dir: completeRun,
    project: 'complete',
  });
  writePointer(runsDir, '.latest.incomplete.json', {
    run_dir: incompleteRun,
    project: 'incomplete',
  });
  writePointer(runsDir, '.latest.missing.json', {
    run_dir: join(runsDir, 'missing-run'),
    project: 'missing',
  });
  writePointer(runsDir, '.latest.false-flag.json', {
    run_dir: completeRun,
    project: 'complete',
    evidence_complete: false,
  });

  const report = repairStaleLatestPointers(runsDir);
  assert.equal(report.repaired.length, 3);
  assert.equal(existsSync(join(runsDir, '.latest.complete.json')), true);
  assert.equal(existsSync(join(runsDir, '.latest.incomplete.json')), false);
  assert.equal(existsSync(join(runsDir, '.latest.missing.json')), false);
  assert.equal(existsSync(join(runsDir, '.latest.false-flag.json')), false);
});

test('listLatestPointerFiles matches .latest and .latest.project.json', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'babel-run-evidence-'));
  writePointer(runsDir, '.latest.json', { run_dir: '/tmp/a', project: 'global' });
  writePointer(runsDir, '.latest.demo.json', { run_dir: '/tmp/b', project: 'demo' });
  writeFileSync(join(runsDir, 'not-a-pointer.json'), '{}\n', 'utf8');

  const files = listLatestPointerFiles(runsDir).map((file) => file.split(/[/\\]/).pop());
  assert.deepEqual(files.sort(), ['.latest.demo.json', '.latest.json']);
});

test('isStaleLatestPointer treats evidence_complete false as stale even with final artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-run-evidence-'));
  const runDir = join(root, 'run');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), '{}\n', 'utf8');
  assert.equal(isStaleLatestPointer({ evidence_complete: false }, runDir), true);
});
