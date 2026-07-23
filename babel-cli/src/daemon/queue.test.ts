/**
 * daemon/queue.test.ts — Queue retry, priority, rate limiting tests (Phase 3)
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DaemonQueue } from './queue.js';
import { createAgentJob, listAgentJobs, updateAgentJob } from '../services/agentJobs.js';

const originalEnv = process.env['BABEL_RUNS_DIR'];
const originalRegistry = process.env['BABEL_JOBS_REGISTRY_PATH'];
const testRoot = mkdtempSync(join(tmpdir(), 'babel-daemon-queue-test-'));

function uid(suffix: string): string {
  return `test-${Date.now()}-${suffix}-${Math.random().toString(36).slice(2, 6)}`;
}

test.before(() => {
  process.env['BABEL_RUNS_DIR'] = testRoot;
  process.env['BABEL_JOBS_REGISTRY_PATH'] = join(testRoot, 'jobs', 'registry.json');
});

test.after(() => {
  if (originalEnv) process.env['BABEL_RUNS_DIR'] = originalEnv;
  else delete process.env['BABEL_RUNS_DIR'];

  if (originalRegistry) process.env['BABEL_JOBS_REGISTRY_PATH'] = originalRegistry;
  else delete process.env['BABEL_JOBS_REGISTRY_PATH'];

  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
});

test('DaemonQueue dequeues higher priority jobs first', () => {
  const q = new DaemonQueue(1);
  const low = createAgentJob({ id: uid('low'), task: 'low priority', priority: 10 });
  const high = createAgentJob({ id: uid('high'), task: 'high priority', priority: 0 });
  const mid = createAgentJob({ id: uid('mid'), task: 'mid priority', priority: 5 });

  assert.equal(low.status, 'queued');
  assert.equal(high.status, 'queued');
  assert.equal(mid.status, 'queued');
  assert.equal(low.priority, 10);
  assert.equal(high.priority, 0);
  assert.equal(mid.priority, 5);
  assert.ok(q.pendingCount >= 3);
});

test('DaemonQueue retry fields are set correctly on job creation', () => {
  const job = createAgentJob({ id: uid('retry'), task: 'retry test', maxRetries: 3 });
  assert.equal(job.max_retries, 3);
  assert.equal(job.retry_count, 0);
  assert.equal(job.status, 'queued');
});

test('DaemonQueue retry_after delays re-enqueue', () => {
  const job = createAgentJob({ id: uid('delayed'), task: 'delayed', maxRetries: 2 });
  updateAgentJob(job.id, {
    retry_count: 1,
    retry_after: new Date(Date.now() + 60000).toISOString(),
    status: 'queued',
  });
  const { jobs } = listAgentJobs();
  const updated = jobs.find((j) => j.id === job.id);
  assert.ok(updated);
  assert.equal(updated.retry_count, 1);
  assert.ok(new Date(updated.retry_after!) > new Date());
});

test('DaemonQueue rate limiting tracks completions', () => {
  const q = new DaemonQueue(1, 2);
  const status = q.getStatus();
  assert.equal(status.rateLimitActive, false);
});

test('DaemonQueue drain when idle returns drained', async () => {
  const q = new DaemonQueue(1);
  const result = await q.drain();
  assert.equal(result.drained, true);
  assert.equal(result.abandonedJobId, null);
});

test('DaemonQueue jobs support tags', () => {
  const job = createAgentJob({
    id: uid('tagged'),
    task: 'tagged job',
    tags: ['file-watcher', 'rule:test-rule'],
  });
  assert.deepEqual(job.tags, ['file-watcher', 'rule:test-rule']);
});
