import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildLiteContinueAssessment,
  readWorkerChainManifest,
  resumeLiteWorkerChain,
  writeWorkerChainManifest,
  type WorkerChainManifest,
} from './liteRecovery.js';
import { AgentSession } from '../agent/session.js';
import { handleContinue } from '../interactive/commands/service.js';
import type { ReplContext } from '../interactive/context.js';

test('failed worker-chain mutation is not replayed without settlement identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-resume-fence-'));
  const sessionRunDir = join(root, 'runs', 'babel-lite', '20260605T120000Z-do-demo');
  mkdirSync(sessionRunDir, { recursive: true });
  const originalRun = AgentSession.prototype.run;
  let calls = 0;
  try {
    const manifest: WorkerChainManifest = {
      schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: '20260605T120000Z-do-demo',
      session_run_dir: sessionRunDir, task: 'Only edit src/math.js. Run npm test before completing.', project: null,
      project_root: root, provider: 'mock', chain_status: 'failed', steps: [], next_verb: 'fix', failed_step: 'fix', updated_at: '2026-11-07T00:00:00.000Z',
    };
    const path = writeWorkerChainManifest(sessionRunDir, manifest);
    const before = readFileSync(path, 'utf8');
    assert.equal(buildLiteContinueAssessment({ projectRoot: root }).status, 'CONTINUE_BLOCKED');
    AgentSession.prototype.run = async () => { calls++; return { payload: { status: 'SMALL_FIX_COMPLETE' }, exitCode: 0, humanText: '' }; };
    const result = await resumeLiteWorkerChain({ projectRoot: root });
    assert.equal(calls, 0);
    assert.equal(result?.exitCode, 1);
    assert.equal(result?.payload['status'], 'CONTINUE_BLOCKED');
    assert.equal(result?.payload['run_dir'], sessionRunDir);
    assert.equal(buildLiteContinueAssessment({ projectRoot: root }).next_command, null);
    const ctx = { state: {}, lastRunDir: null, resolveCurrentTarget: () => ({ targetRoot: root }) } as unknown as ReplContext;
    const previousLog = console.log;
    try { console.log = () => {}; await handleContinue(ctx, []); } finally { console.log = previousLog; }
    assert.equal(ctx.lastRunDir, sessionRunDir);
    assert.equal(ctx.state.lastRunUserStatus, 'blocked');
    assert.equal(calls, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    AgentSession.prototype.run = originalRun;
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('a failed worker chain with no next step is not reported complete', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-incomplete-'));
  try {
    const run = join(root, 'runs', 'babel-lite', '20260605T130000Z-do-failed'); mkdirSync(run, { recursive: true });
    writeWorkerChainManifest(run, { schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: '20260605T130000Z-do-failed', session_run_dir: run, task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [], next_verb: null, updated_at: '2026-11-07T00:00:00.000Z' });
    const assessment = buildLiteContinueAssessment({ projectRoot: root });
    assert.equal(assessment.status, 'CONTINUE_BLOCKED');
    assert.equal(assessment.next_verb, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a manifest cannot claim completion while retaining a pending step', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-conflicting-status-'));
  try {
    writeFileSync(join(root, 'worker_chain_manifest.json'), JSON.stringify({ schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'demo', session_run_dir: root, task: 'fixture', project: null, project_root: root, chain_status: 'complete', steps: [], next_verb: 'fix', updated_at: '2026-11-07T00:00:00.000Z' }));
    assert.equal(readWorkerChainManifest(root), null);
    const assessment = buildLiteContinueAssessment({ run: root, projectRoot: root });
    assert.equal(assessment.status, 'CONTINUE_BLOCKED');
    assert.equal(assessment.run_dir, root);
    assert.match(assessment.reason, /unsafe|invalid/i);
    const child = join(root, 'child'); mkdirSync(child);
    const nested = buildLiteContinueAssessment({ run: child, projectRoot: root });
    assert.equal(nested.status, 'CONTINUE_BLOCKED');
    assert.equal(nested.run_dir, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('latest worker-chain inspection does not silently select an older valid manifest over a newer invalid one', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-latest-invalid-'));
  try {
    const oldRun = join(root, 'runs', 'babel-lite', '20260605T120000Z-do-old');
    const newRun = join(root, 'runs', 'babel-lite', '20260605T130000Z-do-new');
    mkdirSync(oldRun, { recursive: true }); mkdirSync(newRun, { recursive: true });
    writeWorkerChainManifest(oldRun, { schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'old', session_run_dir: oldRun, task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [], next_verb: 'fix', updated_at: '2026-11-07T00:00:00.000Z' });
    writeFileSync(join(newRun, 'worker_chain_manifest.json'), '{"schema_version":999}');
    utimesSync(oldRun, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    utimesSync(newRun, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
    const assessment = buildLiteContinueAssessment({ projectRoot: root });
    assert.equal(assessment.status, 'CONTINUE_BLOCKED');
    assert.equal(assessment.run_dir, newRun);
    assert.match(assessment.reason, /invalid|unsafe/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('latest worker-chain inspection blocks a newer junction instead of selecting older work', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-latest-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-worker-outside-'));
  try {
    const oldRun = join(root, 'runs', 'babel-lite', '20260605T120000Z-do-old');
    const linked = join(root, 'runs', 'babel-lite', '20260605T130000Z-do-link');
    mkdirSync(oldRun, { recursive: true });
    writeWorkerChainManifest(oldRun, { schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'old', session_run_dir: oldRun, task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [], next_verb: 'fix', updated_at: '2026-11-07T00:00:00.000Z' });
    utimesSync(oldRun, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const assessment = buildLiteContinueAssessment({ projectRoot: root });
    assert.equal(assessment.status, 'CONTINUE_BLOCKED');
    assert.equal(assessment.run_dir, linked);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('a worker manifest cannot redirect its claimed source directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-source-identity-'));
  try {
    const actual = join(root, 'actual'); const other = join(root, 'other');
    mkdirSync(actual); mkdirSync(other);
    writeWorkerChainManifest(actual, {
      schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'demo', session_run_dir: other,
      task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [], next_verb: 'fix', updated_at: '2026-11-07T00:00:00.000Z',
    });
    assert.equal(readWorkerChainManifest(actual), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a worker chain from another project is blocked without adopting its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-project-identity-'));
  try {
    const selected = join(root, 'selected'); const other = join(root, 'other'); const run = join(root, 'run');
    mkdirSync(selected); mkdirSync(other); mkdirSync(run);
    writeWorkerChainManifest(run, { schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'demo', session_run_dir: run, task: 'fixture', project: null, project_root: other, chain_status: 'failed', steps: [], next_verb: 'fix', failed_step: 'fix', updated_at: '2026-11-07T00:00:00.000Z' });
    const assessment = buildLiteContinueAssessment({ projectRoot: selected, run });
    assert.equal(assessment.status, 'CONTINUE_BLOCKED');
    assert.equal(assessment.run_dir, run);
    assert.match(assessment.reason, /project/i);
    assert.equal(assessment.manifest, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a worker manifest with an unsupported schema is not relabeled as version 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-schema-'));
  try {
    writeFileSync(join(root, 'worker_chain_manifest.json'), JSON.stringify({ schema_version: 999, artifact_type: 'babel_lite_worker_chain', session_run_id: 'demo', session_run_dir: root, task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [], next_verb: 'fix', updated_at: '2026-11-07T00:00:00.000Z' }));
    assert.equal(readWorkerChainManifest(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a malformed pending step cannot be silently classified as a complete chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-malformed-'));
  try {
    writeFileSync(join(root, 'worker_chain_manifest.json'), JSON.stringify({ schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'demo', session_run_dir: root, task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [], next_verb: 'unknown', failed_step: 'unknown', updated_at: '2026-11-07T00:00:00.000Z' }));
    assert.equal(readWorkerChainManifest(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed worker history is rejected rather than silently dropping a step', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-invalid-step-'));
  try {
    writeFileSync(join(root, 'worker_chain_manifest.json'), JSON.stringify({ schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'demo', session_run_dir: root, task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [{ verb: 'fix', status: 'FAILED' }, null], next_verb: 'fix', failed_step: 'fix', updated_at: '2026-11-07T00:00:00.000Z' }));
    assert.equal(readWorkerChainManifest(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a hard-linked worker manifest is rejected without changing its source', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-worker-hardlink-'));
  try {
    const actual = join(root, 'actual'); mkdirSync(actual);
    const outside = join(root, 'outside.json');
    const content = JSON.stringify({ schema_version: 1, artifact_type: 'babel_lite_worker_chain', session_run_id: 'demo', session_run_dir: actual, task: 'fixture', project: null, project_root: root, chain_status: 'failed', steps: [], next_verb: 'fix', updated_at: '2026-11-07T00:00:00.000Z' });
    writeFileSync(outside, content); linkSync(outside, join(actual, 'worker_chain_manifest.json'));
    assert.equal(readWorkerChainManifest(actual), null);
    assert.equal(readFileSync(outside, 'utf8'), content);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
