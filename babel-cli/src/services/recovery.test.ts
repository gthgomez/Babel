import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildRecoveryAssessment,
  formatRecoveryAssessmentHuman,
} from './recovery.js';
import { resumeExecution } from './resumeExecution.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env['DEEPINFRA_API_KEY'];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env['DEEPINFRA_API_KEY'];
  } else {
    process.env['DEEPINFRA_API_KEY'] = originalApiKey;
  }
});

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'babel-recovery-'));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function makeRun(root: string, name: string): string {
  const runDir = join(root, name);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

test('recovery resolves latest and classifies verifier failures without missing paths', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_010101_verifier');
    const capsulePath = join(runDir, '12_repair_failure_capsule_attempt_1.json');
    writeJson(join(root, '.latest.json'), {
      run_dir: runDir,
      project: 'global',
      created_at: '2026-06-01T01:01:01.000Z',
    });
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'VERIFIER_FAILED',
      reason_category: 'verifier_failure',
      failed_command: 'npm test',
      changed_files: ['src/example.ts'],
      change_disposition: 'preserved_for_inspection',
      rollback_mode: 'none',
      failure_capsule_path: capsulePath,
      next_recommended_operator_action: 'Inspect verifier output.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: 'npm test failed',
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      tool_call_log: [
        { tool: 'test_run', target: 'npm test', exit_code: 1 },
      ],
    });
    writeJson(capsulePath, {
      schema_version: 1,
      attempt: 1,
      failure_code: 'TEST_FAILED',
      failed_command: 'npm test',
      concise_failure_summary: 'TEST_FAILED: one test failed',
      changed_files: ['src/example.ts'],
      exact_invariant_status: 'unknown',
      next_repair_hypothesis: 'Patch and rerun tests.',
      retryable: true,
    });

    const assessment = buildRecoveryAssessment({ run: 'latest', runsDir: root });

    assert.equal(assessment.run_dir, runDir);
    assert.equal(assessment.resolved_from, 'latest');
    assert.equal(assessment.classification, 'rerun_verifier');
    assert.equal(assessment.failure_code, 'TEST_FAILED');
    assert.equal(assessment.failed_command, 'npm test');
    assert.equal(assessment.missing_artifacts.length, 0);
    assert.equal(assessment.available_artifacts.every(artifact => artifact.path && artifact.path.length > 0), true);
    assert.equal(assessment.available_artifacts.every(artifact => !artifact.path.includes('does-not-exist')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume reruns a saved verifier failure when command and project root are present', async () => {
  const root = makeRoot();
  try {
    const projectRoot = makeRun(root, 'project');
    writeJson(join(projectRoot, 'package.json'), {
      type: 'module',
      scripts: { test: 'node check.js' },
    });
    writeFileSync(join(projectRoot, 'check.js'), 'process.exit(0);\n', 'utf-8');
    const runDir = makeRun(root, '20260601_010102_verifier');
    const capsulePath = join(runDir, 'small_fix_failure_capsule.json');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'SMALL_FIX_FAILED',
      reason_category: 'small_fix_failed',
      failed_command: 'npm test',
      changed_files: ['src/math.js'],
      failure_capsule_path: capsulePath,
      condition_summary: 'npm test failed',
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      small_fix: {
        target_file: 'src/math.js',
        verifier_command: 'npm test',
        project_root: projectRoot,
      },
      tool_call_log: [{ tool: 'test_run', target: 'npm test', exit_code: 1 }],
    });
    writeJson(capsulePath, {
      schema_version: 1,
      failure_code: 'verifier_failed',
      failed_command: 'npm test',
      project_root: projectRoot,
      retryable: true,
    });

    const result = await resumeExecution({ run: runDir });

    assert.equal(result.status, 'RESUME_COMPLETE');
    assert.equal(result.action, 'rerun_verifier');
    assert.deepEqual(result.checks, ['npm test: passed']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume returns parseable failure when a provider retry fails', async () => {
  const root = makeRoot();
  try {
    process.env['DEEPINFRA_API_KEY'] = 'test-key';
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    const projectRoot = makeRun(root, 'project');
    writeJson(join(projectRoot, 'package.json'), { type: 'module' });
    const runDir = makeRun(root, '20260601_010103_provider');
    const capsulePath = join(runDir, 'ask_failure_capsule.json');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      status: 'ASK_FAILED',
      reason_category: 'provider_request_failed',
      failed_command: 'ask',
      failure_capsule_path: capsulePath,
      condition_summary: 'fetch failed',
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      pipeline_error: { condition: 'fetch failed' },
    });
    writeJson(capsulePath, {
      failure_code: 'provider_request_failed',
      category: 'provider_request_failed',
      task: 'summarize this repo',
      project_root: projectRoot,
      retryable: true,
    });

    const result = await resumeExecution({ run: runDir, model: 'deepseek', modelTier: 'standard' });

    assert.equal(result.status, 'RESUME_FAILED');
    assert.equal(result.action, 'retry_ask');
    assert.equal(result.run_dir, runDir);
    assert.equal(result.recovery.available_artifacts.every(artifact => existsSync(artifact.path)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery classifies provider schema failures from the pre-execution capsule', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_020202_schema');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'FATAL_ERROR',
      reason_category: 'fatal_error',
      failed_command: null,
      changed_files: [],
      change_disposition: 'none',
      rollback_mode: 'none',
      failure_capsule_path: join(runDir, '12_pre_execution_failure_capsule.json'),
      next_recommended_operator_action: 'Inspect artifacts.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: '[PRE_EXECUTION_FAILURE] Zod validation failed',
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      pipeline_error: {
        condition: '[PRE_EXECUTION_FAILURE] Zod validation failed: missing minimal_action_set',
      },
      tool_call_log: [],
    });
    writeJson(join(runDir, '12_pre_execution_failure_capsule.json'), {
      schema_version: 1,
      attempt: 1,
      failure_code: 'PROVIDER_SCHEMA_INVALID',
      failed_command: null,
      concise_failure_summary: 'PROVIDER_SCHEMA_INVALID: Zod validation failed',
      changed_files: [],
      exact_invariant_status: 'unknown',
      next_repair_hypothesis: 'Retry with schema repair.',
      retryable: true,
    });

    const assessment = buildRecoveryAssessment({ runDir, runsDir: root });

    assert.equal(assessment.resolved_from, 'run_dir');
    assert.equal(assessment.classification, 'retry_with_schema_repair');
    assert.equal(assessment.failure_capsule?.failure_code, 'PROVIDER_SCHEMA_INVALID');
    assert.equal(assessment.missing_artifacts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery treats completed small-fix runs as complete with no missing failure capsule', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_030303_small_fix_complete');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'SMALL_FIX_COMPLETE',
      reason_category: 'small_fix_complete',
      failed_command: null,
      changed_files: ['src/math.js'],
      change_disposition: 'preserved_for_inspection',
      rollback_mode: 'none',
      failure_capsule_path: null,
      next_recommended_operator_action: 'Review the changed file and commit when ready.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: null,
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_COMPLETE',
      stage_status: 'SMALL_FIX_COMPLETE',
      tool_call_log: [],
    });

    const assessment = buildRecoveryAssessment({ run: runDir, runsDir: root });

    assert.equal(assessment.classification, null);
    assert.equal(assessment.retryable, false);
    assert.equal(assessment.missing_artifacts.some(artifact => artifact.key === 'failure_capsule'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery continues from plan when execution artifacts are absent but a plan exists', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_030303_plan');
    writeJson(join(root, '.latest.json'), {
      run_dir: runDir,
      project: 'global',
      created_at: '2026-06-01T03:03:03.000Z',
    });
    writeJson(join(runDir, '02_swe_plan.json'), {
      plan_version: '1.0',
      minimal_action_set: [],
    });

    const assessment = buildRecoveryAssessment({ run: 'latest', runsDir: root });

    assert.equal(assessment.classification, 'continue_from_plan');
    assert.deepEqual(
      assessment.missing_artifacts.map(artifact => artifact.filename).sort(),
      ['04_execution_report.json', 'terminal_status_summary.json'],
    );
    assert.equal(assessment.available_artifacts.some(artifact => artifact.filename === '02_swe_plan.json'), true);
    assert.equal(
      assessment.missing_artifacts.every(artifact => !Object.hasOwn(artifact, 'path')),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery reports referenced missing failure capsules without pointing to missing files', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_040404_missing-capsule');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'SHELL_COMMAND_FAILED',
      reason_category: 'shell_command_failed',
      failed_command: 'node ./scripts/check.js',
      changed_files: [],
      change_disposition: 'none',
      rollback_mode: 'none',
      failure_capsule_path: join(runDir, 'does-not-exist.json'),
      next_recommended_operator_action: 'Inspect shell output.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: 'command failed',
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      tool_call_log: [
        { tool: 'shell_exec', target: 'node ./scripts/check.js', exit_code: 1 },
      ],
    });

    const assessment = buildRecoveryAssessment({ runDir });
    const human = formatRecoveryAssessmentHuman(assessment);

    assert.equal(assessment.classification, 'retry_same_command');
    assert.equal(assessment.failure_capsule, null);
    assert.equal(assessment.terminal_status_summary?.failure_capsule_path, null);
    assert.equal(assessment.available_artifacts.some(artifact => artifact.path.endsWith('does-not-exist.json')), false);
    assert.equal(assessment.missing_artifacts.some(artifact => artifact.key === 'failure_capsule'), true);
    assert.match(human, /Missing artifacts:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery requires user decision for exact-contract ambiguity', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_050505_ambiguous');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'AMBIGUOUS_LITERAL_BINDING',
      reason_category: 'exact_contract_failure',
      failed_command: null,
      changed_files: [],
      change_disposition: 'none',
      rollback_mode: 'none',
      failure_capsule_path: null,
      next_recommended_operator_action: 'Ask the user to choose the literal mapping.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: 'ambiguous literal binding',
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      pipeline_error: {
        condition: 'AMBIGUOUS_LITERAL_BINDING',
      },
      tool_call_log: [],
    });

    const assessment = buildRecoveryAssessment({ run_dir: runDir });

    assert.equal(assessment.classification, 'requires_user_decision');
    assert.equal(assessment.next_action.includes('operator review'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery unwraps pipeline failure capsules for verifier failures', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_060606_wrapped');
    const capsulePath = join(runDir, '12_repair_failure_capsule_attempt_1.json');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'VERIFIER_FAILED',
      reason_category: 'verifier_failure',
      failed_command: 'npm test',
      changed_files: ['src/math.js'],
      change_disposition: 'preserved_for_inspection',
      rollback_mode: 'none',
      failure_capsule_path: capsulePath,
      next_recommended_operator_action: 'Inspect verifier output.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: 'npm test failed',
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      tool_call_log: [{ tool: 'test_run', target: 'npm test', exit_code: 1 }],
    });
    writeJson(capsulePath, {
      id: 'wrapped-capsule',
      source: 'pipeline',
      capsule: {
        failure_code: 'TEST_FAILED',
        failed_command: 'npm test',
        retryable: true,
      },
    });

    const assessment = buildRecoveryAssessment({ runDir });

    assert.equal(assessment.classification, 'rerun_verifier');
    assert.equal(assessment.failure_code, 'TEST_FAILED');
    assert.equal(assessment.failure_capsule?.failure_code, 'TEST_FAILED');
    assert.equal(assessment.failed_command, 'npm test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery classifies ambiguous plan before schema wording', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_070707_ambiguous-plan');
    const capsulePath = join(runDir, '12_pre_execution_failure_capsule.json');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'EXECUTOR_HALTED',
      reason_category: 'ambiguous_plan',
      failed_command: null,
      changed_files: [],
      change_disposition: 'none',
      rollback_mode: 'none',
      failure_capsule_path: capsulePath,
      next_recommended_operator_action: 'Ask for a clearer target.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: 'AMBIGUOUS_PLAN after Zod schema repair exhaustion',
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      pipeline_error: {
        halt_tag: 'AMBIGUOUS_PLAN',
        condition: 'AMBIGUOUS_PLAN after Zod schema repair exhaustion',
      },
      tool_call_log: [],
    });
    writeJson(capsulePath, {
      failure_code: 'AMBIGUOUS_PLAN',
      retryable: false,
    });

    const assessment = buildRecoveryAssessment({ runDir });

    assert.equal(assessment.classification, 'requires_user_decision');
    assert.equal(assessment.retryable, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery classifies approval-required execution failures', () => {
  const root = makeRoot();
  try {
    const runDir = makeRun(root, '20260601_080808_approval');
    const capsulePath = join(runDir, '12_pre_execution_failure_capsule.json');
    writeJson(join(runDir, 'terminal_status_summary.json'), {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status: 'SHELL_COMMAND_DENIED',
      reason_category: 'approval_required',
      failed_command: 'npm install',
      changed_files: [],
      change_disposition: 'none',
      rollback_mode: 'none',
      failure_capsule_path: capsulePath,
      next_recommended_operator_action: 'Approve dependency installation.',
      parseable_json_stdout_required: true,
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: null,
      condition_summary: 'dependency installation requires explicit approval',
      verifier_contract: null,
    });
    writeJson(join(runDir, '04_execution_report.json'), {
      status: 'EXECUTION_HALTED',
      pipeline_error: {
        condition: 'dependency installation requires explicit approval',
      },
      tool_call_log: [],
    });
    writeJson(capsulePath, {
      failure_code: 'APPROVAL_REQUIRED',
      approval_id: 'dep-123',
      retryable: false,
    });

    const assessment = buildRecoveryAssessment({ runDir });

    assert.equal(assessment.classification, 'requires_user_decision');
    assert.equal(assessment.next_command, 'babel approvals list --status pending');
    assert.equal(assessment.failure_code, 'APPROVAL_REQUIRED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
