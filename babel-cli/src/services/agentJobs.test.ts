import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  approveAgentJob,
  createAgentJob,
  getAgentJobApprovalState,
  listAgentJobs,
  pauseAgentJob,
  resumeAgentJob,
  writeAgentJobReport,
} from './agentJobs.js';

function withJobState<T>(run: (state: { workspace: string; scratch: string; registryPath: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'babel-jobs-'));
  const workspace = join(root, 'workspace');
  const scratch = join(workspace, 'scratch');
  mkdirSync(scratch, { recursive: true });

  const previousWorkspace = process.env['BABEL_WORKSPACE_ROOT'];
  const previousRoots = process.env['BABEL_example_autonomous_agent_APPROVED_ROOTS'];
  const previousApprovals = process.env['BABEL_APPROVAL_QUEUE_PATH'];
  const previousJobs = process.env['BABEL_JOBS_REGISTRY_PATH'];
  process.env['BABEL_WORKSPACE_ROOT'] = workspace;
  process.env['BABEL_example_autonomous_agent_APPROVED_ROOTS'] = scratch;
  process.env['BABEL_APPROVAL_QUEUE_PATH'] = join(root, 'approvals.json');
  process.env['BABEL_JOBS_REGISTRY_PATH'] = join(root, 'jobs.json');

  try {
    return run({
      workspace,
      scratch,
      registryPath: join(root, 'jobs.json'),
    });
  } finally {
    if (previousWorkspace === undefined) delete process.env['BABEL_WORKSPACE_ROOT'];
    else process.env['BABEL_WORKSPACE_ROOT'] = previousWorkspace;
    if (previousRoots === undefined) delete process.env['BABEL_example_autonomous_agent_APPROVED_ROOTS'];
    else process.env['BABEL_example_autonomous_agent_APPROVED_ROOTS'] = previousRoots;
    if (previousApprovals === undefined) delete process.env['BABEL_APPROVAL_QUEUE_PATH'];
    else process.env['BABEL_APPROVAL_QUEUE_PATH'] = previousApprovals;
    if (previousJobs === undefined) delete process.env['BABEL_JOBS_REGISTRY_PATH'];
    else process.env['BABEL_JOBS_REGISTRY_PATH'] = previousJobs;
    rmSync(root, { recursive: true, force: true });
  }
}

test('agent jobs create queued records for simple manager tasks', () => {
  withJobState(({ scratch }) => {
    const job = createAgentJob({
      id: 'simple-job',
      task: 'Update README title',
      projectRoot: scratch,
      verifyCommands: ['npm test'],
    });

    assert.equal(job.status, 'queued');
    assert.equal(job.project_root, resolve(scratch));
    assert.deepEqual(job.verify_commands, ['npm test']);
    assert.equal(listAgentJobs().jobs.length, 1);
  });
});

test('agent jobs create exact escalation approvals for hard tasks', () => {
  withJobState(({ scratch }) => {
    const job = createAgentJob({
      id: 'hard-job',
      task: 'Optimize largest-eigenval benchmark timeout',
      projectRoot: scratch,
    });

    assert.equal(job.status, 'waiting_approval');
    assert.equal(job.model_tier, 'escalation');
    assert.equal(job.approval_ids.length, 1);
    assert.deepEqual(getAgentJobApprovalState(job).pending, job.approval_ids);

    const approved = approveAgentJob(job.id, { ttlHours: 1 }).job;
    assert.equal(approved.status, 'queued');
    assert.deepEqual(getAgentJobApprovalState(approved).approved, job.approval_ids);
  });
});

test('agent jobs can pause, resume, and write report artifacts', () => {
  withJobState(({ scratch }) => {
    const job = createAgentJob({
      id: 'report-job',
      task: 'Update README title',
      projectRoot: scratch,
    });

    assert.equal(pauseAgentJob(job.id).status, 'paused');
    const resumed = resumeAgentJob(job.id);
    assert.equal(resumed.status, 'queued');
    const reported = writeAgentJobReport(resumed);
    assert.match(reported.report_path ?? '', /report-job\.json$/);
  });
});
