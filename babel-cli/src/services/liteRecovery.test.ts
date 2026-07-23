import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildLiteContinueAssessment,
  readWorkerChainManifest,
  writeWorkerChainManifest,
  type WorkerChainManifest,
} from './liteRecovery.js';

test('buildLiteContinueAssessment resumes linked worker chain from manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-recovery-'));
  try {
    const sessionRunDir = join(root, 'runs', 'babel-lite', '20260605T120000Z-do-demo');
    mkdirSync(sessionRunDir, { recursive: true });
    const manifest: WorkerChainManifest = {
      schema_version: 1,
      artifact_type: 'babel_lite_worker_chain',
      session_run_id: '20260605T120000Z-do-demo',
      session_run_dir: sessionRunDir,
      task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
      project: null,
      project_root: root,
      provider: 'mock',
      chain_status: 'failed',
      steps: [
        {
          verb: 'plan',
          status: 'PLAN_READY',
          exit_code: 0,
          run_dir: join(sessionRunDir, 'plan'),
        },
      ],
      next_verb: 'propose',
      failed_step: 'propose',
      updated_at: new Date().toISOString(),
    };
    writeWorkerChainManifest(sessionRunDir, manifest);

    const assessment = buildLiteContinueAssessment({ projectRoot: root });
    assert.equal(assessment.source, 'worker_chain');
    assert.equal(assessment.status, 'CONTINUE_READY');
    assert.equal(assessment.next_verb, 'propose');
    assert.equal(assessment.session_run_dir, sessionRunDir);
    assert.ok(readWorkerChainManifest(sessionRunDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildLiteContinueAssessment reports complete worker chains', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-recovery-complete-'));
  try {
    const sessionRunDir = join(root, 'runs', 'babel-lite', '20260605T130000Z-do-complete');
    mkdirSync(sessionRunDir, { recursive: true });
    writeWorkerChainManifest(sessionRunDir, {
      schema_version: 1,
      artifact_type: 'babel_lite_worker_chain',
      session_run_id: '20260605T130000Z-do-complete',
      session_run_dir: sessionRunDir,
      task: 'done',
      project: null,
      project_root: root,
      chain_status: 'complete',
      steps: [],
      next_verb: null,
      updated_at: new Date().toISOString(),
    });

    const assessment = buildLiteContinueAssessment({ projectRoot: root });
    assert.equal(assessment.status, 'CHAIN_COMPLETE');
    assert.equal(assessment.next_verb, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildLiteContinueAssessment falls back to babel run recovery without manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-recovery-fallback-'));
  try {
    const assessment = buildLiteContinueAssessment({
      projectRoot: root,
      run: join(root, 'missing-run'),
    });
    assert.equal(assessment.source, 'babel_run');
    assert.equal(assessment.status, 'RUN_NOT_FOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
