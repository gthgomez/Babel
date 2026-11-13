import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DaemonQueue } from './queue.js';
import { createAgentJob, getAgentJob } from '../services/agentJobs.js';
import type { AgentJobPipelineRun } from '../services/agentJobPipeline.js';
import { diagnoseRun } from '../services/haltDiagnosis.js';

const testRoot = mkdtempSync(join(tmpdir(), 'babel-daemon-exec-'));

test.before(() => {
  process.env['BABEL_RUNS_DIR'] = testRoot;
  process.env['BABEL_JOBS_REGISTRY_PATH'] = join(testRoot, 'jobs', 'registry.json');
  process.env['BABEL_LITE_OFFLINE'] = '1';
});

test.after(() => {
  delete process.env['BABEL_LITE_OFFLINE'];
  rmSync(testRoot, { recursive: true, force: true });
});

test('executeJob uses runJobPipeline hook with resolved job model when qualified', async () => {
  let capturedModel: string | undefined;
  const job = createAgentJob({
    id: `exec-${Date.now()}`,
    task: 'noop qualified',
    mode: 'chat',
    model: 'explicit-legacy-route',
  });

  const mockRun = async (j: typeof job): Promise<AgentJobPipelineRun> => {
    capturedModel = j.model ?? undefined;
    return {
      result: {
        status: 'COMPLETE',
        runDir: join(testRoot, 'runs', 'mock'),
        manifest: {} as AgentJobPipelineRun['result']['manifest'],
        plan: null,
      },
      resolvedModel: 'explicit-legacy-route',
      status: 'complete',
      completionVerification: null,
      diagnosis: diagnoseRun({ pipelineStatus: 'COMPLETE' }),
      error: null,
    };
  };

  const queue = new DaemonQueue(1, 30, 5000, {
    isPipelineQualified: () => true,
    runJobPipeline: mockRun,
  });
  await queue.tick();

  const updated = getAgentJob(job.id);
  assert.ok(updated);
  assert.equal(updated.status, 'complete');
  assert.equal(capturedModel, 'explicit-legacy-route');
  assert.equal(queue.getStatus().totalCompleted, 1);
});

test('processNext respects priority when execution is qualified', async () => {
  const high = createAgentJob({ id: `p0-${Date.now()}`, task: 'high', priority: 0 });
  const low = createAgentJob({ id: `p9-${Date.now() + 1}`, task: 'low', priority: 9 });
  const order: string[] = [];

  const queue = new DaemonQueue(1, 60, 5000, {
    isPipelineQualified: () => true,
    runJobPipeline: async (j) => {
      order.push(j.id);
      return {
        result: {
          status: 'FAILED',
          runDir: join(testRoot, 'runs', j.id),
          manifest: {} as AgentJobPipelineRun['result']['manifest'],
          plan: null,
        },
        resolvedModel: undefined,
        status: 'failed',
        completionVerification: null,
        diagnosis: diagnoseRun({ pipelineStatus: 'FAILED' }),
        error: 'fail',
      };
    },
  });

  await queue.tick();
  assert.ok(order.length >= 1);
  assert.equal(order[0], high.id);
  assert.notEqual(order[0], low.id);
});
