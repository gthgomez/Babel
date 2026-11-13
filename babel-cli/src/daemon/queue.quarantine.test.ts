import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DaemonQueue, DAEMON_PIPELINE_QUARANTINE_MESSAGE } from './queue.js';
import { createAgentJob, getAgentJob } from '../services/agentJobs.js';

const testRoot = mkdtempSync(join(tmpdir(), 'babel-daemon-quarantine-'));
const originalRuns = process.env['BABEL_RUNS_DIR'];
const originalRegistry = process.env['BABEL_JOBS_REGISTRY_PATH'];
const previousFetch = globalThis.fetch;

test.before(() => {
  process.env['BABEL_RUNS_DIR'] = testRoot;
  process.env['BABEL_JOBS_REGISTRY_PATH'] = join(testRoot, 'jobs', 'registry.json');
  globalThis.fetch = async () => {
    throw new Error('Unexpected provider request during quarantined queue execution');
  };
});

test.after(() => {
  globalThis.fetch = previousFetch;
  if (originalRuns) process.env['BABEL_RUNS_DIR'] = originalRuns;
  else delete process.env['BABEL_RUNS_DIR'];
  if (originalRegistry) process.env['BABEL_JOBS_REGISTRY_PATH'] = originalRegistry;
  else delete process.env['BABEL_JOBS_REGISTRY_PATH'];
  rmSync(testRoot, { recursive: true, force: true });
});

test('queued jobs fail closed while daemon pipeline qualification is off', async () => {
  const job = createAgentJob({
    id: `quarantine-${Date.now()}`,
    task: 'offline noop task',
    mode: 'chat',
    maxRetries: 2,
  });
  const queue = new DaemonQueue(1);
  await queue.tick();

  const updated = getAgentJob(job.id);
  assert.ok(updated);
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, DAEMON_PIPELINE_QUARANTINE_MESSAGE);
  assert.equal(queue.getStatus().totalFailed, 1);
});
