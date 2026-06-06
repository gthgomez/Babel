import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildIdeBridgeContract,
  buildIdeBridgeSnapshot,
  readIdeBridgeEvidenceText,
} from './ideBridge.js';

test('IDE bridge contract is read-only and view-complete', () => {
  const contract = buildIdeBridgeContract();

  assert.equal(contract.contract_id, 'babel.ide_bridge.read_only');
  assert.equal(contract.read_only, true);
  assert.equal(contract.approval_actions, 'not_supported');
  assert.equal(contract.mutation_policy.mutates_workspace, false);
  assert.equal(contract.mutation_policy.mutates_git, false);
  assert.equal(contract.mutation_policy.remote_side_effects, false);
  assert.deepEqual(contract.views, [
    'run_timeline',
    'plan_review',
    'diffs',
    'checkpoint_list',
    'evidence_browser',
  ]);
});

test('IDE bridge snapshot indexes run evidence and checkpoints without mutation actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ide-bridge-'));
  try {
    writeFileSync(join(root, '01_manifest.json'), '{}\n', 'utf-8');
    writeFileSync(join(root, '02_swe_plan.json'), '{}\n', 'utf-8');
    mkdirSync(join(root, 'checkpoints'));
    writeFileSync(join(root, 'checkpoints', 'before.patch'), 'diff\n', 'utf-8');

    const snapshot = buildIdeBridgeSnapshot(root);

    assert.equal(snapshot.run_timeline.find(item => item.file === '01_manifest.json')?.present, true);
    assert.equal(snapshot.run_timeline.find(item => item.file === '03_qa_verdict.json')?.present, false);
    assert.equal(snapshot.plan_review.plan_path, join(root, '02_swe_plan.json'));
    assert.equal(snapshot.diffs.restore_available, true);
    assert.deepEqual(snapshot.checkpoint_list.map(item => item.name), ['before.patch']);
    assert.ok(snapshot.evidence_browser.some(item => item.name === '01_manifest.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('IDE bridge evidence reader truncates large text files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-ide-bridge-'));
  try {
    const file = join(root, 'large.txt');
    writeFileSync(file, 'a'.repeat(20), 'utf-8');
    assert.match(readIdeBridgeEvidenceText(file, 8), /truncated at 8 bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
