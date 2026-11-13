import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentJob } from './agentJobs.js';
import { evaluateCompletionVerification } from './completionVerification.js';

test('evaluateCompletionVerification fails when workspace manager verification fails', () => {
  const gate = evaluateCompletionVerification({
    pipelineStatus: 'COMPLETE',
    executionProfile: 'workspace_manager',
    projectRoot: '/tmp',
    verification: {
      status: 'fail',
      project_root: '/tmp',
      execution_profile: 'workspace_manager',
      onboarding: {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        project_root: '/tmp',
        project_name: 'tmp',
        markers: [],
        detected_stacks: [],
        recommended_execution_profile: 'workspace_manager',
        recommended_commands: { install: [], build: [], test: ['npm test'], lint: [] },
        context_draft: '',
        notes: [],
      },
      selected_commands: ['npm test'],
      command_results: [],
      approved_roots: ['/tmp'],
    },
  });
  assert.equal(gate.status, 'fail');
});

function minimalJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    schema_version: 1,
    id: 'job-1',
    task: 'noop',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'queued',
    mode: 'chat',
    execution_profile: 'verified',
    project_root: null,
    approved_roots: [],
    model: 'explicit-legacy-route',
    model_tier: null,
    verify_commands: [],
    approval_ids: [],
    run_dir: null,
    pipeline_status: null,
    completion_verification: null,
    diagnosis: null,
    escalation: { should_escalate: false, recommended_tier: null, signals: [] },
    report_path: null,
    error: null,
    ...overrides,
  };
}

test('resolveAgentJobModel honors explicit job model when offline', async () => {
  const previous = process.env['BABEL_LITE_OFFLINE'];
  process.env['BABEL_LITE_OFFLINE'] = '1';
  try {
    const { resolveAgentJobModel } = await import('./agentJobs.js');
    assert.equal(resolveAgentJobModel(minimalJob()), 'explicit-legacy-route');
  } finally {
    if (previous === undefined) delete process.env['BABEL_LITE_OFFLINE'];
    else process.env['BABEL_LITE_OFFLINE'] = previous;
  }
});
