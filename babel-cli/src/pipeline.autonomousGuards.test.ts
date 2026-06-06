import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  collectExecutorSafetyViolations,
  getBenchmarkDependencyInstallPlanReject,
  getBenchmarkInstallRecoveryBlockReason,
  getBenchmarkProtectedWriteReason,
  getExternalRepairRerunLimit,
  getExternalBenchmarkDefaultLockedFiles,
  inferDeterministicDomainId,
  isEvidenceRequestPlanSatisfied,
  isBenchmarkDependencyInstallCommand,
  isExecutorToolShapePlaceholder,
  maybeApplyBenchmarkRoutingIsolation,
  maybeEnrichPipelineStageIds,
  repairExactOutputSchemaArtifacts,
  resolveCompletionStatusAfterExactInvariantCheck,
  shouldApplyHostWindowsExecutorNotes,
  shouldEnforceBoundedPlanActivationContract,
  shouldHaltExternalRepairRerun,
  shouldHaltAutonomousWithoutApprovedPlan,
  shouldRefuseDirectModeWriteRequest,
} from './pipeline.js';
import type { OrchestratorManifest, SwePlan } from './schemas/agentContracts.js';

test('autonomous mode without an approved plan must halt instead of completing', () => {
  assert.equal(shouldHaltAutonomousWithoutApprovedPlan('autonomous', null), true);
});

test('verified/autonomous completion status is demoted on exact instruction drift', () => {
  assert.equal(resolveCompletionStatusAfterExactInvariantCheck(null), 'COMPLETE');
  assert.equal(
    resolveCompletionStatusAfterExactInvariantCheck('[EXACT_INSTRUCTION_DRIFT] missing literal'),
    'EXACT_INSTRUCTION_DRIFT',
  );
  assert.equal(
    resolveCompletionStatusAfterExactInvariantCheck('[AMBIGUOUS_LITERAL_BINDING] multiple filenames and literals'),
    'AMBIGUOUS_LITERAL_BINDING',
  );
});

test('non-autonomous no-execution modes do not use the autonomous QA rejection halt', () => {
  assert.equal(shouldHaltAutonomousWithoutApprovedPlan('verified', null), false);
  assert.equal(shouldHaltAutonomousWithoutApprovedPlan('manual', null), false);
});

test('direct mode refuses write requests with an execution-mode status', () => {
  assert.equal(shouldRefuseDirectModeWriteRequest('direct', 1), true);
  assert.equal(shouldRefuseDirectModeWriteRequest('direct', 0), false);
  assert.equal(shouldRefuseDirectModeWriteRequest('autonomous', 1), false);
});

test('autonomous mode with an approved plan can continue to executor gating', () => {
  assert.equal(shouldHaltAutonomousWithoutApprovedPlan('autonomous', {
    plan_version: '1.0',
    thinking: 'test',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: test',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [],
    root_cause: 'N/A',
    out_of_scope: [],
  }), false);
});

test('exact output deterministic repair rewrites log summary CSV from visible logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-log-summary-'));
  try {
    const logs = join(root, 'logs');
    mkdirSync(logs);
    writeFileSync(join(logs, '2025-08-12_app.log'), '[ERROR] one\n[INFO] two\n', 'utf-8');
    writeFileSync(join(logs, '2025-08-11_db.log'), '[WARNING] three\n', 'utf-8');
    writeFileSync(join(logs, '2025-07-20_api.log'), '[INFO] four\n[ERROR] five\n', 'utf-8');
    writeFileSync(join(logs, '2025-07-03_auth.log'), '[WARNING] six\n', 'utf-8');

    const task = [
      'You are given multiple log files stored in logs.',
      'Each log file name follows the pattern YYYY-MM-DD_<source>.log.',
      'Write a CSV file summary.csv with the following structure (including the header):',
      'period,severity,count',
      'today,ERROR,<count>',
      'today,WARNING,<count>',
      'today,INFO,<count>',
      'last_7_days,ERROR,<count>',
      'last_7_days,WARNING,<count>',
      'last_7_days,INFO,<count>',
      'last_30_days,ERROR,<count>',
      'last_30_days,WARNING,<count>',
      'last_30_days,INFO,<count>',
      'month_to_date,ERROR,<count>',
      'month_to_date,WARNING,<count>',
      'month_to_date,INFO,<count>',
      'total,ERROR,<count>',
      'total,WARNING,<count>',
      'total,INFO,<count>',
      'The current date is 2025-08-12.',
    ].join('\n');

    const result = repairExactOutputSchemaArtifacts(task, root);

    assert.match(String(result), /EXACT_OUTPUT_SCHEMA_DETERMINISTIC_REPAIR/);
    assert.equal(readFileSync(join(root, 'summary.csv'), 'utf-8'), [
      'period,severity,count',
      'today,ERROR,1',
      'today,WARNING,0',
      'today,INFO,1',
      'last_7_days,ERROR,1',
      'last_7_days,WARNING,1',
      'last_7_days,INFO,1',
      'last_30_days,ERROR,2',
      'last_30_days,WARNING,1',
      'last_30_days,INFO,2',
      'month_to_date,ERROR,1',
      'month_to_date,WARNING,1',
      'month_to_date,INFO,1',
      'total,ERROR,2',
      'total,WARNING,2',
      'total,INFO,2',
      '',
    ].join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence request plans complete once their planned reads are satisfied', () => {
  const plan = {
    plan_version: '1.0',
    thinking: 'test',
    plan_type: 'EVIDENCE_REQUEST',
    task_summary: 'OBJECTIVE: inspect benchmark files',
    known_facts: ['Need file contents before implementation.'],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Read requests',
        tool: 'file_read',
        target: 'task_file/input_data/requests_bucket_1.jsonl',
        rationale: 'Need request shape.',
        reversible: true,
        verification: 'file_read succeeds',
      },
      {
        step: 2,
        description: 'Read cost model',
        tool: 'file_read',
        target: 'task_file/scripts/cost_model.py',
        rationale: 'Need scoring model.',
        reversible: true,
        verification: 'file_read succeeds',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  } satisfies SwePlan;

  assert.equal(isEvidenceRequestPlanSatisfied(plan, [
    {
      step: 1,
      tool: 'file_read',
      target: 'task_file/input_data/requests_bucket_1.jsonl',
      exit_code: 0,
      stdout: '{}',
      stderr: '',
      verified: true,
    },
  ]), false);

  assert.equal(isEvidenceRequestPlanSatisfied(plan, [
    {
      step: 1,
      tool: 'file_read',
      target: 'task_file/input_data/requests_bucket_1.jsonl',
      exit_code: 0,
      stdout: '{}',
      stderr: '',
      verified: true,
    },
    {
      step: 2,
      tool: 'file_read',
      target: 'task_file/scripts/cost_model.py',
      exit_code: 0,
      stdout: 'def cost(): pass',
      stderr: '',
      verified: true,
    },
  ]), true);
});

test('external benchmark tasks skip strict file_write-only bounded activation gate', () => {
  assert.equal(
    shouldEnforceBoundedPlanActivationContract('Terminal-Bench 2 task: write-compressor\nWrite me data.comp.'),
    false,
  );
  assert.equal(
    shouldEnforceBoundedPlanActivationContract('Create src/newFeature.ts with the helper implementation.'),
    true,
  );
});

test('external benchmark defaults lock visible verifier fixtures', () => {
  assert.deepEqual(
    getExternalBenchmarkDefaultLockedFiles('Terminal-Bench 2 task: break-filter-js-from-html'),
    ['test_outputs.py', 'filter.py'],
  );
  assert.deepEqual(
    getExternalBenchmarkDefaultLockedFiles('Implement a normal repo feature.'),
    [],
  );
  assert.match(
    String(getBenchmarkProtectedWriteReason(
      'Terminal-Bench 2 task: break-filter-js-from-html',
      './test_outputs.py',
    )),
    /BENCHMARK_PROTECTED_FIXTURE_WRITE/,
  );
  assert.equal(
    getBenchmarkProtectedWriteReason(
      'Terminal-Bench 2 task: break-filter-js-from-html',
      'out.html',
    ),
    null,
  );
});

test('benchmark dependency install detection catches expensive recovery commands', () => {
  assert.equal(isBenchmarkDependencyInstallCommand('pip install torch'), true);
  assert.equal(isBenchmarkDependencyInstallCommand('python3 -m pip install torch --no-cache-dir'), true);
  assert.equal(isBenchmarkDependencyInstallCommand('apt-get update && apt-get install -y build-essential'), true);
  assert.equal(isBenchmarkDependencyInstallCommand('uv pip install -r requirements.txt'), true);
  assert.equal(isBenchmarkDependencyInstallCommand('uv sync'), false);
  assert.equal(isBenchmarkDependencyInstallCommand('python model.py --export-weights weights.json'), false);
});

test('docker-backed benchmark containers do not inherit host Windows executor notes', () => {
  assert.equal(
    shouldApplyHostWindowsExecutorNotes('benchmark_container', 'example/task:latest'),
    false,
  );
  if (process.platform === 'win32') {
    assert.equal(shouldApplyHostWindowsExecutorNotes('safe_repo', ''), true);
  }
});

test('deterministic domain route keeps break-filter benchmarks out of game routing', () => {
  const route = inferDeterministicDomainId([
    'Terminal-Bench 2 task: break-filter-js-from-html',
    'Create out.html that triggers a JavaScript alert after filter.py processes it.',
  ].join('\n'));

  assert.equal(route?.domainId, 'domain_python_backend');
  assert.match(route?.reason ?? '', /sanitizer/);
});

test('benchmark routing isolation clears unrelated workspace project context', () => {
  const manifest = {
    orchestrator_version: '9.0',
    target_project: 'example_game_workspace',
    target_project_path: 'C:\\Workspace\\benchmarks\\runs\\terminal-bench-2\\job\\01-largest-eigenval\\app',
    analysis: {
      task_summary: 'largest-eigenval',
      task_category: 'Python Backend',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'High',
      pipeline_mode: 'autonomous',
      purpose_mode: 'execution',
      purpose_source: 'fallback_default',
      purpose_confidence: 0.7,
      ambiguity_note: null,
    },
    platform_profile: {
      profile_source: 'not_required_for_routing',
      client_surface: 'unspecified',
      container_model: null,
      ingestion_mode: 'none',
      repo_write_mode: null,
      output_surface: [],
      platform_modes: [],
      execution_trust: null,
      data_trust: null,
      freshness_trust: null,
      action_trust: null,
      approval_mode: 'none',
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'test',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v10'],
      domain_id: 'domain_python_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: 'example_game_workspace',
      task_overlay_ids: [],
      pipeline_stage_ids: [],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
      task_shape_profile: 'full',
    },
    prompt_manifest: ['x.md'],
    handoff_payload: {
      user_request: 'Terminal-Bench 2 task: largest-eigenval',
      system_directive: 'test',
    },
  } satisfies OrchestratorManifest;

  const result = maybeApplyBenchmarkRoutingIsolation(
    manifest,
    'Terminal-Bench 2 task: largest-eigenval',
  );

  assert.equal(result.applied, true);
  assert.equal(result.manifest.target_project, 'global');
  assert.equal(result.manifest.target_project_path, manifest.target_project_path);
  assert.equal(result.manifest.instruction_stack?.project_overlay_id, null);
});

test('executor tool-shape placeholders are recognized for plan target canonicalization', () => {
  assert.equal(isExecutorToolShapePlaceholder('<project-relative or /project/... path>'), true);
  assert.equal(isExecutorToolShapePlaceholder('<cmd-without-cmd-slash-c-or-cd>'), true);
  assert.equal(isExecutorToolShapePlaceholder('logs'), false);
  assert.equal(isExecutorToolShapePlaceholder('python summary_script.py'), false);
});

test('benchmark safety gate rejects writes to visible verifier fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-protected-fixture-'));
  const previousImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  try {
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'example/task:latest';
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const plan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: create out.html',
      known_facts: [],
      assumptions: [],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Read the visible sanitizer',
          tool: 'file_read',
          target: 'filter.py',
          rationale: 'Inspect benchmark fixture behavior.',
          reversible: true,
          verification: 'filter.py is read',
        },
        {
          step: 2,
          description: 'Rewrite the visible verifier',
          tool: 'file_write',
          target: 'test_outputs.py',
          rationale: 'Make local tests pass.',
          reversible: true,
          verification: 'pytest exits 0',
        },
        {
          step: 3,
          description: 'Run custom verifier',
          tool: 'shell_exec',
          target: 'python verify_bypass.py',
          rationale: 'Custom postcondition check exists in the approved plan.',
          reversible: false,
          verification: 'verifier exits 0',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: [],
    } satisfies SwePlan;

    const reject = collectExecutorSafetyViolations(
      plan,
      manifest as never,
      'Terminal-Bench 2 task: break-filter-js-from-html\nCreate out.html.',
      'benchmark_container',
    );

    assert.equal(reject?.verdict, 'REJECT');
    assert.match(reject?.failures[0]?.condition ?? '', /BENCHMARK_PROTECTED_FIXTURE_WRITE/);
  } finally {
    if (previousImage === undefined) {
      delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    } else {
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = previousImage;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('benchmark safety gate requires reading break-filter source before payload selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-break-filter-source-'));
  try {
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const guessingPlan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: create out.html',
      known_facts: [],
      assumptions: [],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Write guessed payload',
          tool: 'file_write',
          target: 'out.html',
          rationale: 'Try an event handler payload.',
          reversible: true,
          verification: 'out.html exists',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: [],
    } satisfies SwePlan;

    const rejected = collectExecutorSafetyViolations(
      guessingPlan,
      manifest as never,
      'Terminal-Bench 2 task: break-filter-js-from-html\nCreate out.html.',
      'benchmark_container',
    );

    assert.equal(rejected?.verdict, 'REJECT');
    assert.match(rejected?.failures[0]?.condition ?? '', /BENCHMARK_SOURCE_INSPECTION_REQUIRED/);

    const sourceGroundedPlan = {
      ...guessingPlan,
      minimal_action_set: [
        {
          step: 1,
          description: 'Read sanitizer',
          tool: 'file_read',
          target: 'filter.py',
          rationale: 'Inspect parser/removal behavior before payload selection.',
          reversible: true,
          verification: 'filter.py is read',
        },
        {
          step: 2,
          description: 'Write payload selected from sanitizer source behavior',
          tool: 'file_write',
          target: 'out.html',
          rationale: 'Use only a payload family left intact by the inspected filter.',
          reversible: true,
          verification: 'out.html exists',
        },
        {
          step: 3,
          description: 'Write custom verifier',
          tool: 'file_write',
          target: 'verify_bypass.py',
          rationale: 'Check filtered artifact postconditions without pytest.',
          reversible: true,
          verification: 'helper exists',
        },
        {
          step: 4,
          description: 'Run sanitizer',
          tool: 'shell_exec',
          target: 'python filter.py out.html',
          rationale: 'Apply filter.',
          reversible: false,
          verification: 'filter exits 0',
        },
        {
          step: 5,
          description: 'Run custom verifier',
          tool: 'shell_exec',
          target: 'python verify_bypass.py',
          rationale: 'Fail unless the filtered artifact satisfies the bypass postcondition.',
          reversible: false,
          verification: 'verifier exits 0',
        },
      ],
    } satisfies SwePlan;

    assert.equal(
      collectExecutorSafetyViolations(
        sourceGroundedPlan,
        manifest as never,
        'Terminal-Bench 2 task: break-filter-js-from-html\nCreate out.html.',
        'benchmark_container',
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('benchmark safety gate rejects weak break-filter verifier and stripped payload assumptions', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-break-filter-verifier-'));
  try {
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const weakPlan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: create out.html',
      known_facts: [],
      assumptions: ['HTML entity encoding can bypass filter.py detection.'],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Read sanitizer',
          tool: 'file_read',
          target: 'filter.py',
          rationale: 'Inspect parser/removal behavior before payload selection.',
          reversible: true,
          verification: 'filter.py is read',
        },
        {
          step: 2,
          description: 'Write an onerror event handler payload',
          tool: 'file_write',
          target: 'out.html',
          rationale: 'Try event handler obfuscation.',
          reversible: true,
          verification: 'out.html exists',
        },
        {
          step: 3,
          description: 'Run the sanitizer',
          tool: 'shell_exec',
          target: 'python filter.py out.html',
          rationale: 'Apply filter.',
          reversible: false,
          verification: 'filter exits 0',
        },
        {
          step: 4,
          description: 'Inspect output',
          tool: 'file_read',
          target: 'out.html',
          rationale: 'Look for alert.',
          reversible: true,
          verification: 'alert remains',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: [],
    } satisfies SwePlan;

    const rejected = collectExecutorSafetyViolations(
      weakPlan,
      manifest as never,
      'Terminal-Bench 2 task: break-filter-js-from-html\nCreate out.html.',
      'benchmark_container',
    );

    assert.equal(rejected?.verdict, 'REJECT');
    const conditions = rejected?.failures.map(failure => failure.condition).join('\n') ?? '';
    assert.match(conditions, /BENCHMARK_STRIPPED_PAYLOAD_ASSUMPTION/);
    assert.match(conditions, /BENCHMARK_CUSTOM_VERIFIER_REQUIRED/);
    assert.match(rejected?.proposed_fix_strategy ?? '', /custom executable verifier/);

    const manualVerifierPlan = {
      ...weakPlan,
      assumptions: [],
      minimal_action_set: [
        weakPlan.minimal_action_set[0]!,
        {
          step: 2,
          description: 'Write payload selected from sanitizer source behavior',
          tool: 'file_write',
          target: 'out.html',
          rationale: 'Use only a payload family left intact by the inspected filter.',
          reversible: true,
          verification: 'out.html exists',
        },
        {
          step: 3,
          description: 'Run the sanitizer',
          tool: 'shell_exec',
          target: 'python filter.py out.html',
          rationale: 'Apply filter.',
          reversible: false,
          verification: 'filter exits 0',
        },
        {
          step: 4,
          description: 'Print manual verification reminder',
          tool: 'shell_exec',
          target: 'python -c "print(\'Manual verification required\')"',
          rationale: 'Ask a person to check the browser.',
          reversible: false,
          verification: 'prints reminder',
        },
      ],
    } satisfies SwePlan;

    const manualRejected = collectExecutorSafetyViolations(
      manualVerifierPlan,
      manifest as never,
      'Terminal-Bench 2 task: break-filter-js-from-html\nCreate out.html.',
      'benchmark_container',
    );

    assert.equal(manualRejected?.verdict, 'REJECT');
    assert.match(
      manualRejected?.failures.map(failure => failure.condition).join('\n') ?? '',
      /BENCHMARK_CUSTOM_VERIFIER_REQUIRED/,
    );

    const strongerPlan = {
      ...weakPlan,
      assumptions: [],
      minimal_action_set: [
        weakPlan.minimal_action_set[0]!,
        {
          step: 2,
          description: 'Write payload chosen from observed sanitizer behavior',
          tool: 'file_write',
          target: 'out.html',
          rationale: 'Use only families not removed by the inspected filter source.',
          reversible: true,
          verification: 'out.html exists',
        },
        {
          step: 3,
          description: 'Write custom verifier',
          tool: 'file_write',
          target: 'verify_bypass.py',
          rationale: 'Check filtered artifact postconditions without pytest.',
          reversible: true,
          verification: 'helper exists',
        },
        {
          step: 4,
          description: 'Run the sanitizer',
          tool: 'shell_exec',
          target: 'python filter.py out.html',
          rationale: 'Apply filter.',
          reversible: false,
          verification: 'filter exits 0',
        },
        {
          step: 5,
          description: 'Run custom verifier',
          tool: 'shell_exec',
          target: 'python verify_bypass.py',
          rationale: 'Fail unless the filtered artifact satisfies the bypass postcondition.',
          reversible: false,
          verification: 'verifier exits 0',
        },
      ],
    } satisfies SwePlan;

    assert.equal(
      collectExecutorSafetyViolations(
        strongerPlan,
        manifest as never,
        'Terminal-Bench 2 task: break-filter-js-from-html\nCreate out.html.',
        'benchmark_container',
      ),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('external repair rerun guard bounds repeated benchmark postcondition loops', () => {
  assert.equal(getExternalRepairRerunLimit('Terminal-Bench 2 task: break-filter-js-from-html'), 3);
  assert.equal(shouldHaltExternalRepairRerun('Terminal-Bench 2 task: break-filter-js-from-html', 3), false);
  assert.equal(shouldHaltExternalRepairRerun('Terminal-Bench 2 task: break-filter-js-from-html', 4), true);
  assert.equal(shouldHaltExternalRepairRerun('Implement a normal repo change', 10), false);
});

test('benchmark install recovery blocks unplanned dependency installs', () => {
  const plan = {
    plan_version: '1.0',
    thinking: 'test',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: run model export',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Try the model export',
        tool: 'shell_exec',
        target: 'python model.py --export-weights weights.json',
        rationale: 'Use existing container runtime.',
        reversible: true,
        verification: 'weights file exists',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  } satisfies SwePlan;

  const block = getBenchmarkInstallRecoveryBlockReason(
    plan,
    'Terminal-Bench 2 task: pytorch-model-cli\nCreate the requested CLI artifacts.',
    'python3 -m pip install torch --no-cache-dir',
  );
  assert.match(String(block), /BENCHMARK_INSTALL_RECOVERY_BLOCKED/);

  assert.match(
    String(getBenchmarkInstallRecoveryBlockReason(
      plan,
      'Terminal-Bench 2 task: pytorch-model-cli\nCreate the requested CLI artifacts.',
      'pip install torch',
    )),
    /source-only/,
  );
});

test('benchmark install recovery allows exact approved or explicitly requested installs', () => {
  const plan = {
    plan_version: '1.0',
    thinking: 'test',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: 'OBJECTIVE: install dependencies',
    known_facts: [],
    assumptions: [],
    risks: [],
    minimal_action_set: [
      {
        step: 1,
        description: 'Install declared dependencies',
        tool: 'shell_exec',
        target: 'pip install -r requirements.txt',
        rationale: 'The task explicitly requires dependency installation.',
        reversible: true,
        verification: 'pip exits 0',
      },
    ],
    root_cause: 'N/A',
    out_of_scope: [],
  } satisfies SwePlan;

  assert.equal(
    getBenchmarkInstallRecoveryBlockReason(
      plan,
      'Terminal-Bench 2 task: dependency-bootstrap\nPrepare the project.',
      'pip install -r requirements.txt',
    ),
    null,
  );
  assert.equal(
    getBenchmarkInstallRecoveryBlockReason(
      { ...plan, minimal_action_set: [] },
      'Terminal-Bench 2 task: dependency-bootstrap\nInstall dependencies with pip install -r requirements.txt.',
      'pip install -r requirements.txt',
    ),
    null,
  );
});

test('benchmark safety gate rejects unrequested dependency install plan steps', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-install-'));
  const previousImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  try {
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'example/task:latest';
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const plan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: export model artifacts',
      known_facts: [],
      assumptions: [],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Install torch',
          tool: 'shell_exec',
          target: 'pip install torch',
          rationale: 'Try to repair missing torch.',
          reversible: true,
          verification: 'pip exits 0',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: [],
    } satisfies SwePlan;

    const reject = collectExecutorSafetyViolations(
      plan,
      manifest as never,
      'Terminal-Bench 2 task: pytorch-model-cli\nCreate the requested CLI artifacts.',
      'benchmark_container',
    );

    assert.equal(reject?.verdict, 'REJECT');
    assert.match(reject?.failures[0]?.condition ?? '', /BENCHMARK_DEPENDENCY_INSTALL_PLAN/);
    assert.match(
      String(getBenchmarkDependencyInstallPlanReject(
        'Terminal-Bench 2 task: pytorch-model-cli\nCreate the requested CLI artifacts.',
        'pip install torch',
      )),
      /Benchmark plans must not install dependencies/,
    );
  } finally {
    if (previousImage === undefined) {
      delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    } else {
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = previousImage;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('docker-backed benchmark plans may use POSIX shell syntax in shell_exec targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-shell-'));
  const previousImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  try {
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'example/task:latest';
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const plan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: verify compressed output',
      known_facts: [],
      assumptions: [],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Verify decompression output',
          tool: 'shell_exec',
          target: 'cat data.comp | ./decomp > decompressed.txt && diff data.txt decompressed.txt',
          rationale: 'Benchmark verifier uses POSIX shell semantics in the task container.',
          reversible: true,
          verification: 'diff exits 0',
        },
        {
          step: 2,
          description: 'Verify with stdin/stdout redirection',
          tool: 'shell_exec',
          target: './decomp < data.comp > decompressed.txt',
          rationale: 'Redirection is valid inside the isolated benchmark container.',
          reversible: true,
          verification: 'decompressed output exists',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: [],
    } satisfies SwePlan;

    assert.equal(
      collectExecutorSafetyViolations(
        plan,
        manifest as never,
        'Terminal-Bench 2 task: write-compressor\nWrite me data.comp.',
        'benchmark_container',
      ),
      null,
    );
  } finally {
    if (previousImage === undefined) {
      delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    } else {
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = previousImage;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('benchmark safety gate replaces generic git bundle inspection with capability command', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-bundle-'));
  const previousImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  try {
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'example/task:latest';
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const plan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: inspect bundle artifacts',
      known_facts: [],
      assumptions: [],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Inspect the generated bundle',
          tool: 'shell_exec',
          target: 'file bundle1.bundle',
          rationale: 'Check the artifact type.',
          reversible: true,
          verification: 'file exits 0',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: [],
    } satisfies SwePlan;

    const reject = collectExecutorSafetyViolations(
      plan,
      manifest as never,
      'Terminal-Bench 2 task: merge-diff-arc-agi-task\nCreate the required Git bundle.',
      'benchmark_container',
    );

    assert.equal(reject?.verdict, 'REJECT');
    assert.match(reject?.failures[0]?.condition ?? '', /TOOL_CAPABILITY_BROKER/);
    assert.match(reject?.failures[0]?.fix_hint ?? '', /git bundle verify bundle1\.bundle/);
  } finally {
    if (previousImage === undefined) {
      delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    } else {
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = previousImage;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('benchmark safety gate rejects treating git bundles as tar archives', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-bundle-archive-'));
  const previousImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  try {
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'example/task:latest';
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const plan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: merge bundle artifacts',
      known_facts: [],
      assumptions: [],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Extract the bundle as an archive',
          tool: 'shell_exec',
          target: 'tar -xf bundle1.bundle -C repo/branch1',
          rationale: 'Try to inspect bundle contents without git.',
          reversible: true,
          verification: 'files appear',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: [],
    } satisfies SwePlan;

    const reject = collectExecutorSafetyViolations(
      plan,
      manifest as never,
      'Terminal-Bench 2 task: merge-diff-arc-agi-task\nCreate the required Git bundle.',
      'benchmark_container',
    );

    assert.equal(reject?.verdict, 'REJECT');
    assert.match(reject?.failures[0]?.condition ?? '', /Git bundle as an archive|treats a Git bundle as an archive/);
    assert.match(reject?.failures[0]?.fix_hint ?? '', /not tar\/gzip archives/);
  } finally {
    if (previousImage === undefined) {
      delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    } else {
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = previousImage;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('benchmark safety gate rejects source-only substitute for required git bundle merge', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-benchmark-bundle-source-only-'));
  const previousImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
  try {
    process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'example/task:latest';
    const manifest = { target_project: 'benchmark', target_project_path: root };
    const plan = {
      plan_version: '1.0',
      thinking: 'test',
      plan_type: 'IMPLEMENTATION_PLAN',
      task_summary: 'OBJECTIVE: merge bundle artifacts',
      known_facts: [],
      assumptions: [],
      risks: [],
      minimal_action_set: [
        {
          step: 1,
          description: 'Create repo directory marker',
          tool: 'file_write',
          target: 'repo/.gitkeep',
          rationale: 'Create the required repo directory without git.',
          reversible: true,
          verification: 'directory exists',
        },
        {
          step: 2,
          description: 'Write algo.py directly',
          tool: 'file_write',
          target: 'repo/algo.py',
          rationale: 'Try to satisfy the visible file requirement without processing bundles.',
          reversible: true,
          verification: 'algo.py exists',
        },
      ],
      root_cause: 'N/A',
      out_of_scope: ['Git operations'],
    } satisfies SwePlan;

    const reject = collectExecutorSafetyViolations(
      plan,
      manifest as never,
      'Terminal-Bench 2 task: merge-diff-arc-agi-task\nCreate the required Git bundle merge.',
      'benchmark_container',
    );

    assert.equal(reject?.verdict, 'REJECT');
    assert.match(reject?.failures[0]?.condition ?? '', /BENCHMARK_REQUIRED_CAPABILITY_MISSING/);
    assert.match(reject?.failures[0]?.fix_hint ?? '', /Do not satisfy merge-diff/);
  } finally {
    if (previousImage === undefined) {
      delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    } else {
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = previousImage;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function makePipelineStageManifest(
  pipelineMode: 'direct' | 'verified' | 'autonomous' | 'manual',
  pipelineStageIds: string[] = [],
): OrchestratorManifest {
  return {
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: 'pipeline stage enrichment test',
      task_category: 'Backend',
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: pipelineMode,
      purpose_mode: 'execution',
      purpose_source: 'fallback_default',
      purpose_confidence: 0.7,
      ambiguity_note: null,
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v10'],
      domain_id: 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: pipelineStageIds,
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
      task_shape_profile: 'full',
    },
    worker_configuration: {
      assigned_model: 'qwen3',
      rationale: 'pipeline stage enrichment test',
    },
    platform_profile: {
      profile_source: 'not_required_for_routing',
      client_surface: 'unspecified',
      container_model: null,
      ingestion_mode: 'none',
      repo_write_mode: null,
      output_surface: [],
      platform_modes: [],
      execution_trust: null,
      data_trust: null,
      freshness_trust: null,
      action_trust: null,
      approval_mode: 'none',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: 'pipeline stage enrichment test',
      system_directive: 'test',
    },
  };
}

test('verified mode enriches empty pipeline_stage_ids with pipeline_qa_reviewer', () => {
  const manifest = makePipelineStageManifest('verified');
  const result = maybeEnrichPipelineStageIds(manifest);
  assert.equal(result.applied, true);
  assert.deepEqual(result.manifest.instruction_stack?.pipeline_stage_ids, ['pipeline_qa_reviewer']);
  assert.match(result.warnings[0] ?? '', /PIPELINE_STAGE_ENRICHMENT/);
});

test('autonomous mode enriches missing QA and CLI executor stages', () => {
  const manifest = makePipelineStageManifest('autonomous');
  const result = maybeEnrichPipelineStageIds(manifest);
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.manifest.instruction_stack?.pipeline_stage_ids,
    ['pipeline_qa_reviewer', 'pipeline_cli_executor'],
  );
});

test('direct and manual modes do not enrich pipeline stages', () => {
  for (const pipelineMode of ['direct', 'manual'] as const) {
    const manifest = makePipelineStageManifest(pipelineMode);
    const result = maybeEnrichPipelineStageIds(manifest);
    assert.equal(result.applied, false);
    assert.deepEqual(result.manifest.instruction_stack?.pipeline_stage_ids, []);
  }
});

test('pipeline stage enrichment is idempotent when QA stage is already present', () => {
  const manifest = makePipelineStageManifest('verified', ['pipeline_qa_reviewer']);
  const result = maybeEnrichPipelineStageIds(manifest);
  assert.equal(result.applied, false);
  assert.deepEqual(result.manifest.instruction_stack?.pipeline_stage_ids, ['pipeline_qa_reviewer']);
});

test('pipeline stage enrichment respects CLI mode override', () => {
  const manifest = makePipelineStageManifest('direct');
  const result = maybeEnrichPipelineStageIds(manifest, 'verified');
  assert.equal(result.applied, true);
  assert.deepEqual(result.manifest.instruction_stack?.pipeline_stage_ids, ['pipeline_qa_reviewer']);
});
