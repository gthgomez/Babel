import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateCompletionVerification } from './completionVerification.js';
import { validateEvidenceBundleRun } from './evidenceValidation.js';
import type { WorkspaceVerifyReport } from './workspaceManager.js';

function report(status: WorkspaceVerifyReport['status']): WorkspaceVerifyReport {
  return {
    status,
    project_root: 'C:\\Workspace\\scratch\\demo',
    execution_profile: 'opencalw_manager',
    onboarding: {
      schema_version: 1,
      generated_at: '2026-04-28T00:00:00.000Z',
      project_root: 'C:\\Workspace\\scratch\\demo',
      project_name: 'demo',
      markers: [],
      detected_stacks: [],
      recommended_execution_profile: 'dev_local',
      recommended_commands: { install: [], build: [], test: [], lint: [] },
      notes: [],
      context_draft: '',
    },
    selected_commands: [],
    command_results: [],
    approved_roots: ['C:\\Workspace\\scratch'],
  };
}

test('completion verification is required for completed example_autonomous_agent manager jobs', () => {
  const gate = evaluateCompletionVerification({
    pipelineStatus: 'COMPLETE',
    executionProfile: 'opencalw_manager',
    projectRoot: 'C:\\Workspace\\scratch\\demo',
    verification: report('pass'),
  });

  assert.equal(gate.required, true);
  assert.equal(gate.status, 'pass');
});

test('completion verification fails when no commands are available', () => {
  const gate = evaluateCompletionVerification({
    pipelineStatus: 'COMPLETE',
    executionProfile: 'opencalw_manager',
    projectRoot: 'C:\\Workspace\\scratch\\demo',
    verification: report('no_commands'),
  });

  assert.equal(gate.status, 'fail');
  assert.match(gate.reason, /requires at least one/);
});

test('completion verification is not required for non-manager incomplete runs', () => {
  const gate = evaluateCompletionVerification({
    pipelineStatus: 'EXECUTOR_HALTED',
    executionProfile: 'safe_repo',
  });

  assert.equal(gate.required, false);
  assert.equal(gate.status, 'not_required');
});

function writeJson(runDir: string, name: string, value: unknown): void {
  writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

test('evidence validation accepts complete autonomous evidence bundles', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-evidence-complete-'));
  writeJson(runDir, '01_manifest.json', {
    analysis: { pipeline_mode: 'autonomous' },
  });
  writeJson(runDir, '02_swe_plan_v1.json', { plan_version: '1.0' });
  writeJson(runDir, '03_qa_verdict_v1.json', { verdict: 'PASS' });
  writeJson(runDir, '04_execution_report.json', {
    status: 'EXECUTION_COMPLETE',
    tool_call_log: [
      { step: 1, tool: 'file_write', target: 'out.txt', exit_code: 0, stdout: '', stderr: '', verified: true },
    ],
  });
  writeJson(runDir, '06_runtime_telemetry.json', {
    final_outcome: 'COMPLETE',
  });

  const result = validateEvidenceBundleRun(runDir);

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.issues, []);
});

test('evidence validation rejects missing QA verdict for completed verified/autonomous runs', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-evidence-missing-qa-'));
  writeJson(runDir, '01_manifest.json', {
    analysis: { pipeline_mode: 'autonomous' },
  });
  writeJson(runDir, '02_swe_plan_v1.json', { plan_version: '1.0' });
  writeJson(runDir, '04_execution_report.json', {
    status: 'EXECUTION_COMPLETE',
    tool_call_log: [
      { step: 1, tool: 'file_write', target: 'out.txt', exit_code: 0, stdout: '', stderr: '', verified: true },
    ],
  });

  const result = validateEvidenceBundleRun(runDir);

  assert.equal(result.status, 'fail');
  assert.match(result.issues.map(issue => issue.code).join('\n'), /qa_verdict_missing_for_completion/);
});

test('evidence validation rejects conflicting completion and halted execution statuses', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-evidence-conflict-'));
  writeJson(runDir, '01_manifest.json', {
    analysis: { pipeline_mode: 'autonomous' },
  });
  writeJson(runDir, '02_swe_plan_v1.json', { plan_version: '1.0' });
  writeJson(runDir, '03_qa_verdict_v1.json', { verdict: 'PASS' });
  writeJson(runDir, '04_execution_report.json', {
    status: 'EXECUTION_HALTED',
    pipeline_error: { halt_tag: 'VERIFICATION_FAILED', halted_at_step: 1, condition: 'failed' },
  });
  writeJson(runDir, '06_runtime_telemetry.json', {
    final_outcome: 'COMPLETE',
  });

  const result = validateEvidenceBundleRun(runDir);

  assert.equal(result.status, 'fail');
  assert.match(result.issues.map(issue => issue.code).join('\n'), /terminal_status_conflict/);
});
