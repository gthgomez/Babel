import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBabelCliEnv } from '../src/config/envBootstrap.js';
import { enableInMemoryTelemetryForTests, resetTelemetryForTests } from '../src/telemetry/tracing.js';

loadBabelCliEnv();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

interface Scenario {
  name: 'backend' | 'frontend';
  task: string;
  taskCategory: 'Backend' | 'Frontend';
  domainId: 'domain_swe_backend' | 'domain_swe_frontend';
  expectedSelectedIds: string[];
  expectedTokenBudgetTotal: number;
  expectedBudgetWarningSeverity: 'info' | 'warn' | 'severe';
}

const SCENARIOS: Scenario[] = [
  {
    name: 'backend',
    task: 'Regression backend verified lane: prove v9 uncompiled compiles before worker and QA.',
    taskCategory: 'Backend',
    domainId: 'domain_swe_backend',
    expectedSelectedIds: [
      'behavioral_core_v11',
      'domain_swe_backend',
      'skill_supabase_pg',
      'skill_ts_zod',
      'skill_evidence_gathering',
      'skill_bcdp_contracts',
      'adapter_codex_balanced',
      'pipeline_qa_reviewer',
      'pipeline_cli_executor',
    ],
    expectedTokenBudgetTotal: 3090,
    expectedBudgetWarningSeverity: 'severe',
  },
  {
    name: 'frontend',
    task: 'Regression frontend verified lane: prove v9 uncompiled compiles before worker and QA.',
    taskCategory: 'Frontend',
    domainId: 'domain_swe_frontend',
    expectedSelectedIds: [
      'behavioral_core_v11',
      'domain_swe_frontend',
      'skill_evidence_gathering',
      'skill_bcdp_contracts',
      'adapter_codex_balanced',
      'pipeline_qa_reviewer',
      'pipeline_cli_executor',
    ],
    expectedTokenBudgetTotal: 2440,
    expectedBudgetWarningSeverity: 'severe',
  },
];

const liveMode = process.argv.includes('--live');
const useLegacyCliStub = process.env['BABEL_PIPELINE_V9_USE_CLI_STUB'] === '1';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deepSeekLiveModelPolicyPath = join(
  packageRoot,
  'src',
  'fixtures',
  'live-governance',
  'deepseek-model-policy.json',
);

function hasLiveGovernanceProviderKey(): boolean {
  return Boolean(process.env['DEEPSEEK_API_KEY'] || process.env['DEEPINFRA_API_KEY']);
}

function liveGovernanceEnvPatch(): Record<string, string | undefined> {
  if (process.env['DEEPSEEK_API_KEY']) {
    return {
      BABEL_LIVE_GOVERNANCE_PROVIDER: 'deepseek',
      BABEL_MODEL_POLICY_PATH: process.env['BABEL_MODEL_POLICY_PATH'] ?? deepSeekLiveModelPolicyPath,
    };
  }
  if (process.env['DEEPINFRA_API_KEY']) {
    return {
      BABEL_LIVE_GOVERNANCE_PROVIDER: 'deepinfra',
    };
  }
  return {};
}

function isDirectDeepSeekLiveGovernance(): boolean {
  return process.env['BABEL_LIVE_GOVERNANCE_PROVIDER'] === 'deepseek';
}

function isAcceptableDirectDeepSeekStatus(status: string): boolean {
  return (
    status === 'COMPLETE' ||
    status === 'QA_REJECTED_MAX_LOOPS' ||
    status === 'SHELL_COMMAND_FAILED' ||
    status === 'SHELL_COMMAND_DENIED' ||
    status === 'EXECUTOR_HALTED'
  );
}

function isAcceptableDirectDeepSeekFinalOutcome(finalOutcome: string | null | undefined): boolean {
  return finalOutcome === 'COMPLETE' || finalOutcome === 'QA_REJECTED_MAX_LOOPS' || finalOutcome === 'EXECUTOR_HALTED';
}

function hasModelAdapter(selectedIds: string[]): boolean {
  return selectedIds.some(selectedId => selectedId.startsWith('adapter_'));
}

function writeStubFiles(root: string): {
  claudeCmd: string;
  codexCmd: string;
} {
  const fakeLlmPath = join(root, 'fake-llm.mjs');
  const fakeLlmSource = `
import { readFileSync } from 'node:fs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function detectLane(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes('regression frontend verified lane')) {
    return 'frontend';
  }
  if (lower.includes('regression backend verified lane')) {
    return 'backend';
  }
  if (lower.includes('clean_swe_frontend') || lower.includes('react-nextjs')) {
    return 'frontend';
  }
  return 'backend';
}

function buildOrchestratorManifest(lane) {
  const isFrontend = lane === 'frontend';
  return {
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: isFrontend
        ? 'Pipeline regression: typed v9 frontend verified lane.'
        : 'Pipeline regression: typed v9 backend verified lane.',
      task_category: isFrontend ? 'Frontend' : 'Backend',
      secondary_category: null,
      complexity_estimate: 'Medium',
      pipeline_mode: 'deep',
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
      rationale: isFrontend
        ? 'Regression fixture selects qwen3 for the frontend verified lane.'
        : 'Regression fixture selects qwen3 for the backend verified lane.',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v11'],
      domain_id: isFrontend ? 'domain_swe_frontend' : 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: [],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: isFrontend
        ? 'Pipeline regression for the v9 frontend verified lane.'
        : 'Pipeline regression for the v9 backend verified lane.',
      system_directive: 'Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order.',
    },
  };
}

function buildSwePlan(lane) {
  const label = lane === 'frontend' ? 'frontend' : 'backend';
  return {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary: \`OBJECTIVE: Validate the v9 compiled \${label} verified lane.\`,
    known_facts: [
      'The orchestrator emitted a typed v9 manifest in uncompiled form.',
      'The compiler must populate prompt_manifest before the SWE stage runs.',
    ],
    assumptions: [
      'This regression fixture only needs to verify routing and QA coherence.',
    ],
    risks: [
      {
        risk: 'The typed stack could fail to compile before the worker runs.',
        likelihood: 'low',
        mitigation: 'Assert the written manifest is compiled before checking SWE and QA artifacts.',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: \`Inspect the compiled manifest artifact for the resolved \${label} stack.\`,
        tool: 'file_read',
        target: 'runs/latest/01_manifest.json',
        rationale: 'Confirms Stage 1 produced a compiled manifest before execution planning proceeds.',
        reversible: true,
        verification: 'The manifest shows compilation_state = compiled and a populated prompt_manifest.',
      },
    ],
    root_cause: 'N/A — regression coverage task',
    out_of_scope: [
      'Executing CLI tools',
      'Modifying repository files',
    ],
  };
}

function buildQaPass(lane) {
  return {
    verdict: 'PASS',
    overall_confidence: 5,
    notes: lane === 'frontend'
      ? 'Regression fixture plan is sufficient for the verified frontend worker/QA path.'
      : 'Regression fixture plan is sufficient for the verified backend worker/QA path.',
  };
}

async function main() {
  const runnerKind = process.argv[2];
  let prompt = '';

  if (runnerKind === 'codex') {
    const promptPath = process.argv[process.argv.length - 1];
    if (!promptPath) {
      throw new Error('codex stub expected a prompt file path');
    }
    prompt = readFileSync(promptPath, 'utf-8');
  } else {
    prompt = await readStdin();
  }

  const lane = detectLane(prompt);
  let payload;
  if (prompt.includes('OLS-v9-Orchestrator.md') || prompt.includes('"compilation_state": "uncompiled"')) {
    payload = buildOrchestratorManifest(lane);
  } else if (prompt.includes('Analyze the task below and produce the SWE Plan')) {
    payload = buildSwePlan(lane);
  } else if (prompt.includes('Review the SWE Plan below and produce a QA verdict')) {
    payload = buildQaPass(lane);
  } else {
    throw new Error('Unrecognized Babel stage prompt in fake LLM runner.');
  }

  process.stdout.write(JSON.stringify(payload));
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
`.trimStart();

  writeFileSync(fakeLlmPath, fakeLlmSource, 'utf-8');

  const claudeCmd = join(root, 'claude.cmd');
  const codexCmd = join(root, 'codex.cmd');

  writeFileSync(
    claudeCmd,
    `@echo off\r\nnode "${fakeLlmPath}" claude\r\n`,
    'utf-8',
  );
  writeFileSync(
    codexCmd,
    [
      '@echo off',
      'set "last="',
      ':next',
      'if "%~1"=="" goto run',
      'set "last=%~1"',
      'shift',
      'goto next',
      ':run',
      `node "${fakeLlmPath}" codex "%last%"`,
      '',
    ].join('\r\n'),
    'utf-8',
  );

  return { claudeCmd, codexCmd };
}

function withPatchedEnv(
  envPatch: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envPatch)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function assertScenarioArtifacts(
  scenario: Scenario,
  result: Awaited<ReturnType<typeof import('../src/pipeline.js').runBabelPipeline>>,
): void {
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      isAcceptableDirectDeepSeekStatus(result.status),
      `${scenario.name}: expected live DeepSeek COMPLETE, QA_REJECTED_MAX_LOOPS, or governed executor halt status, got ${result.status}`,
    );
  } else {
    assert(result.status === 'COMPLETE', `${scenario.name}: expected COMPLETE status, got ${result.status}`);
  }
  assert(result.manifest.orchestrator_version === '9.0', `${scenario.name}: expected v9 orchestrator manifest`);
  assert(result.manifest.compilation_state === 'compiled', `${scenario.name}: expected compiled manifest`);
  assert(result.manifest.compiled_artifacts !== undefined, `${scenario.name}: expected compiled_artifacts`);
  assert(result.manifest.prompt_manifest.length > 0, `${scenario.name}: expected compiled root prompt_manifest`);

  const selectedIds = result.manifest.compiled_artifacts.selected_entry_ids;
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      selectedIds.some(selectedId => selectedId.startsWith('domain_')),
      `${scenario.name}: expected live DeepSeek selected IDs to include a domain, got ${JSON.stringify(selectedIds)}`,
    );
    assert(
      hasModelAdapter(selectedIds),
      `${scenario.name}: expected live DeepSeek selected IDs to include a model adapter, got ${JSON.stringify(selectedIds)}`,
    );
    assert(
      selectedIds.includes('pipeline_qa_reviewer'),
      `${scenario.name}: expected live DeepSeek selected IDs to include pipeline_qa_reviewer, got ${JSON.stringify(selectedIds)}`,
    );
  } else {
    assert(
      JSON.stringify(selectedIds) === JSON.stringify(scenario.expectedSelectedIds),
      `${scenario.name}: expected selected IDs ${JSON.stringify(scenario.expectedSelectedIds)}, got ${JSON.stringify(selectedIds)}`,
    );
  }

  const manifestPath = join(result.runDir, '01_manifest.json');
  const swePlanPath = join(result.runDir, '02_swe_plan_v1.json');
  const qaVerdictPath = join(result.runDir, '03_qa_verdict_v1.json');
  const runtimeTelemetryPath = join(result.runDir, '06_runtime_telemetry.json');
  const traceContextPath = join(result.runDir, '07_trace_context.json');
  const terminalStatusPath = join(result.runDir, 'terminal_status_summary.json');

  assert(existsSync(manifestPath), `${scenario.name}: expected 01_manifest.json to be written`);
  assert(existsSync(swePlanPath), `${scenario.name}: expected 02_swe_plan_v1.json to be written`);
  assert(existsSync(qaVerdictPath), `${scenario.name}: expected 03_qa_verdict_v1.json to be written`);
  assert(existsSync(runtimeTelemetryPath), `${scenario.name}: expected 06_runtime_telemetry.json to be written`);
  assert(existsSync(traceContextPath), `${scenario.name}: expected 07_trace_context.json to be written when tracing is enabled`);

  const writtenManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    compilation_state?: string;
    compiled_artifacts?: {
      selected_entry_ids?: string[];
      token_budget_total?: number;
      token_budget_missing?: string[];
      warnings?: string[];
    };
    runtime_telemetry?: {
      domain_id?: string;
      token_budget_total?: number;
    };
  };
  const writtenQaVerdict = JSON.parse(readFileSync(qaVerdictPath, 'utf-8')) as {
    verdict?: string;
  };
  const writtenRuntimeTelemetry = JSON.parse(readFileSync(runtimeTelemetryPath, 'utf-8')) as {
    domain_id?: string;
    token_budget_total?: number;
    token_budget_missing_count?: number;
    budget_warning_severity?: string | null;
    budget_policy_enabled?: boolean;
    qa_verdict?: string | null;
    qa_failure_tags?: string[];
    final_outcome?: string | null;
  };
  const writtenTraceContext = JSON.parse(readFileSync(traceContextPath, 'utf-8')) as {
    enabled?: boolean;
    schema_version?: string;
    trace_id?: string;
    root_span_id?: string;
    baggage?: Record<string, string>;
  };
  const writtenTerminalStatus = existsSync(terminalStatusPath)
    ? JSON.parse(readFileSync(terminalStatusPath, 'utf-8')) as {
        status?: string;
        reason_category?: string;
        condition_summary?: string;
      }
    : null;

  assert(writtenManifest.compilation_state === 'compiled', `${scenario.name}: expected written manifest to be compiled`);
  if (isDirectDeepSeekLiveGovernance()) {
    const writtenSelectedIds = writtenManifest.compiled_artifacts?.selected_entry_ids ?? [];
    assert(
      writtenSelectedIds.some(selectedId => selectedId.startsWith('domain_')),
      `${scenario.name}: expected written live DeepSeek selected IDs to include a domain`,
    );
    assert(
      hasModelAdapter(writtenSelectedIds),
      `${scenario.name}: expected written live DeepSeek selected IDs to include a model adapter`,
    );
    assert(
      writtenSelectedIds.includes('pipeline_qa_reviewer'),
      `${scenario.name}: expected written live DeepSeek selected IDs to include pipeline_qa_reviewer`,
    );
    assert(
      typeof writtenManifest.compiled_artifacts?.token_budget_total === 'number' &&
      writtenManifest.compiled_artifacts.token_budget_total > 0,
      `${scenario.name}: expected live DeepSeek token_budget_total to be positive`,
    );
  } else {
    assert(
      JSON.stringify(writtenManifest.compiled_artifacts?.selected_entry_ids ?? []) === JSON.stringify(scenario.expectedSelectedIds),
      `${scenario.name}: expected written manifest selected IDs to match`,
    );
    assert(
      writtenManifest.compiled_artifacts?.token_budget_total === scenario.expectedTokenBudgetTotal,
      `${scenario.name}: expected token_budget_total ${scenario.expectedTokenBudgetTotal}, got ${writtenManifest.compiled_artifacts?.token_budget_total}`,
    );
  }
  assert(
    Array.isArray(writtenManifest.compiled_artifacts?.token_budget_missing) &&
    writtenManifest.compiled_artifacts?.token_budget_missing.length === 0,
    `${scenario.name}: expected no missing token budgets in active verified lane`,
  );
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      Array.isArray(writtenManifest.compiled_artifacts?.warnings) &&
      writtenManifest.compiled_artifacts.warnings.some(warning => /Total token budget:/i.test(warning)),
      `${scenario.name}: expected live DeepSeek total token budget warning to be recorded`,
    );
  } else {
    assert(
      Array.isArray(writtenManifest.compiled_artifacts?.warnings) &&
      writtenManifest.compiled_artifacts?.warnings.includes(`Total token budget: ${scenario.expectedTokenBudgetTotal}`),
      `${scenario.name}: expected total token budget warning to be recorded`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      typeof writtenManifest.runtime_telemetry?.domain_id === 'string' &&
      writtenManifest.runtime_telemetry.domain_id.startsWith('domain_'),
      `${scenario.name}: expected live DeepSeek runtime telemetry domain_id to be populated`,
    );
  } else {
    assert(
      writtenManifest.runtime_telemetry?.domain_id === scenario.domainId,
      `${scenario.name}: expected runtime telemetry domain_id ${scenario.domainId}, got ${writtenManifest.runtime_telemetry?.domain_id}`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      typeof writtenManifest.runtime_telemetry?.token_budget_total === 'number' &&
      writtenManifest.runtime_telemetry.token_budget_total > 0,
      `${scenario.name}: expected live DeepSeek runtime telemetry token_budget_total to be positive`,
    );
  } else {
    assert(
      writtenManifest.runtime_telemetry?.token_budget_total === scenario.expectedTokenBudgetTotal,
      `${scenario.name}: expected runtime telemetry token_budget_total ${scenario.expectedTokenBudgetTotal}, got ${writtenManifest.runtime_telemetry?.token_budget_total}`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      typeof writtenRuntimeTelemetry.domain_id === 'string' &&
      writtenRuntimeTelemetry.domain_id.startsWith('domain_'),
      `${scenario.name}: expected live DeepSeek runtime telemetry file domain_id to be populated`,
    );
  } else {
    assert(
      writtenRuntimeTelemetry.domain_id === scenario.domainId,
      `${scenario.name}: expected runtime telemetry file domain_id ${scenario.domainId}, got ${writtenRuntimeTelemetry.domain_id}`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      typeof writtenRuntimeTelemetry.token_budget_total === 'number' &&
      writtenRuntimeTelemetry.token_budget_total > 0,
      `${scenario.name}: expected live DeepSeek runtime telemetry file token_budget_total to be positive`,
    );
  } else {
    assert(
      writtenRuntimeTelemetry.token_budget_total === scenario.expectedTokenBudgetTotal,
      `${scenario.name}: expected runtime telemetry file token_budget_total ${scenario.expectedTokenBudgetTotal}, got ${writtenRuntimeTelemetry.token_budget_total}`,
    );
  }
  assert(
    writtenRuntimeTelemetry.token_budget_missing_count === 0,
    `${scenario.name}: expected runtime telemetry file token_budget_missing_count 0, got ${writtenRuntimeTelemetry.token_budget_missing_count}`,
  );
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      ['info', 'warn', 'severe'].includes(String(writtenRuntimeTelemetry.budget_warning_severity)),
      `${scenario.name}: expected live DeepSeek budget_warning_severity to be populated, got ${writtenRuntimeTelemetry.budget_warning_severity}`,
    );
  } else {
    assert(
      writtenRuntimeTelemetry.budget_warning_severity === scenario.expectedBudgetWarningSeverity,
      `${scenario.name}: expected runtime telemetry file budget_warning_severity ${scenario.expectedBudgetWarningSeverity}, got ${writtenRuntimeTelemetry.budget_warning_severity}`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      typeof writtenRuntimeTelemetry.budget_policy_enabled === 'boolean',
      `${scenario.name}: expected live DeepSeek budget_policy_enabled boolean, got ${writtenRuntimeTelemetry.budget_policy_enabled}`,
    );
  } else {
    assert(
      writtenRuntimeTelemetry.budget_policy_enabled === true,
      `${scenario.name}: expected runtime telemetry file budget_policy_enabled true, got ${writtenRuntimeTelemetry.budget_policy_enabled}`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      writtenRuntimeTelemetry.qa_verdict === 'PASS' || writtenRuntimeTelemetry.qa_verdict === 'REJECT',
      `${scenario.name}: expected live DeepSeek qa_verdict PASS or REJECT, got ${writtenRuntimeTelemetry.qa_verdict}`,
    );
    if (writtenRuntimeTelemetry.qa_verdict === 'REJECT') {
      assert(
        Array.isArray(writtenRuntimeTelemetry.qa_failure_tags) &&
        writtenRuntimeTelemetry.qa_failure_tags.length > 0,
        `${scenario.name}: expected live DeepSeek QA rejection to record failure tags`,
      );
    }
  } else {
    assert(
      writtenRuntimeTelemetry.qa_verdict === 'PASS',
      `${scenario.name}: expected runtime telemetry file qa_verdict PASS, got ${writtenRuntimeTelemetry.qa_verdict}`,
    );
    assert(
      Array.isArray(writtenRuntimeTelemetry.qa_failure_tags) &&
      writtenRuntimeTelemetry.qa_failure_tags.length === 0,
      `${scenario.name}: expected runtime telemetry file qa_failure_tags to be empty`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      isAcceptableDirectDeepSeekFinalOutcome(writtenRuntimeTelemetry.final_outcome),
      `${scenario.name}: expected live DeepSeek final_outcome COMPLETE, QA_REJECTED_MAX_LOOPS, or EXECUTOR_HALTED, got ${writtenRuntimeTelemetry.final_outcome}`,
    );
    if (writtenRuntimeTelemetry.final_outcome === 'EXECUTOR_HALTED') {
      assert(
        (writtenTerminalStatus?.status === 'SHELL_COMMAND_DENIED' ||
          writtenTerminalStatus?.status === 'SHELL_COMMAND_FAILED' ||
          writtenTerminalStatus?.status === 'EXECUTOR_HALTED') &&
        (writtenTerminalStatus.reason_category === 'shell_command_denied' ||
          writtenTerminalStatus.reason_category === 'shell_command_failed' ||
          writtenTerminalStatus.reason_category === 'executor_halted') &&
        typeof writtenTerminalStatus.condition_summary === 'string' &&
        writtenTerminalStatus.condition_summary.length > 0,
        `${scenario.name}: expected live DeepSeek executor halt to have terminal evidence`,
      );
    }
  } else {
    assert(
      writtenRuntimeTelemetry.final_outcome === 'COMPLETE',
      `${scenario.name}: expected runtime telemetry file final_outcome COMPLETE, got ${writtenRuntimeTelemetry.final_outcome}`,
    );
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      typeof writtenTraceContext.enabled === 'boolean',
      `${scenario.name}: expected live DeepSeek trace context to record enabled state`,
    );
  } else {
    assert(writtenTraceContext.enabled === true, `${scenario.name}: expected trace context to be enabled`);
  }
  assert(writtenTraceContext.schema_version === '1', `${scenario.name}: expected trace schema version 1`);
  if (!isDirectDeepSeekLiveGovernance() || writtenTraceContext.enabled === true) {
    assert(typeof writtenTraceContext.trace_id === 'string' && writtenTraceContext.trace_id.length > 0, `${scenario.name}: expected trace_id`);
    assert(typeof writtenTraceContext.root_span_id === 'string' && writtenTraceContext.root_span_id.length > 0, `${scenario.name}: expected root_span_id`);
    assert(writtenTraceContext.baggage?.['babel.lane.id'] === '9.0:deep', `${scenario.name}: expected babel.lane.id baggage to match deep v9 lane`);
  }
  if (isDirectDeepSeekLiveGovernance()) {
    assert(
      writtenQaVerdict.verdict === 'PASS' || writtenQaVerdict.verdict === 'REJECT',
      `${scenario.name}: expected live DeepSeek QA PASS or REJECT, got ${writtenQaVerdict.verdict}`,
    );
  } else {
    assert(writtenQaVerdict.verdict === 'PASS', `${scenario.name}: expected QA PASS, got ${writtenQaVerdict.verdict}`);
  }
}

function buildPrecomputedManifest(scenario: Scenario) {
  const isFrontend = scenario.name === 'frontend';
  return {
    orchestrator_version: '9.0',
    target_project: 'global',
    target_project_path: process.cwd(),
    analysis: {
      task_summary: isFrontend
        ? 'Pipeline regression: typed v9 frontend verified lane.'
        : 'Pipeline regression: typed v9 backend verified lane.',
      task_category: scenario.taskCategory,
      secondary_category: null,
      task_overlay_ids: [],
      complexity_estimate: 'Medium',
      pipeline_mode: 'deep',
      purpose_mode: 'execution',
      purpose_source: 'fallback_default',
      purpose_confidence: 0.7,
      ambiguity_note: null,
      routing_confidence: 0.95,
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
      rationale: isFrontend
        ? 'Regression fixture selects qwen3 for the frontend verified lane.'
        : 'Regression fixture selects qwen3 for the backend verified lane.',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v11'],
      domain_id: scenario.domainId,
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: [],
    },
    resolution_policy: {
      apply_domain_default_skills: true,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
      task_shape_profile: 'full',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request: isFrontend
        ? 'Pipeline regression for the v9 frontend verified lane.'
        : 'Pipeline regression for the v9 backend verified lane.',
      system_directive: 'Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order.',
    },
  };
}

async function runOfflineRegression(): Promise<void> {
  const tempRunsDir = mkdtempSync(join(tmpdir(), 'babel-pipeline-v9-runs-'));
  try {
    await withPatchedEnv(
      {
        BABEL_PIPELINE_V9_OFFLINE: '1',
        BABEL_OTEL_ENABLED: 'true',
        BABEL_OTEL_SERVICE_NAME: 'babel-cli-tests',
        DEEPSEEK_API_KEY: undefined,
        DEEPINFRA_API_KEY: undefined,
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      async () => {
        await enableInMemoryTelemetryForTests();
        const { _runBabelPipelineInternal } = await import('../src/pipeline.js');
        const { EvidenceBundle } = await import('../src/evidence.js');
        const { OrchestratorManifestSchema } = await import('../src/schemas/agentContracts.js');
        const runsRoot = tempRunsDir;

        for (const scenario of SCENARIOS) {
          const evidence = new EvidenceBundle(scenario.task, runsRoot);
          const result = await _runBabelPipelineInternal(
            scenario.task,
            {
              orchestratorVersion: 'v9',
              mode: 'deep',
            },
            evidence,
            OrchestratorManifestSchema.parse(buildPrecomputedManifest(scenario)),
          );
          assertScenarioArtifacts(scenario, result);
        }
      },
    );

    console.log('[test:pipeline-v9] offline regression passed');
  } finally {
    await resetTelemetryForTests();
    try {
      rmSync(tempRunsDir, { recursive: true, force: true });
    } catch {}
  }
}

async function runLiveRegression(): Promise<void> {
  if (!hasLiveGovernanceProviderKey()) {
    console.log('[test:pipeline-v9:live] SKIPPED — DEEPSEEK_API_KEY/DEEPINFRA_API_KEY not set');
    return;
  }

  const tempDir = useLegacyCliStub ? mkdtempSync(join(tmpdir(), 'babel-pipeline-v9-test-')) : null;
  const stubFiles = tempDir ? writeStubFiles(tempDir) : null;

  try {
    await enableInMemoryTelemetryForTests();
    const envPatch: Record<string, string | undefined> = {
      ...liveGovernanceEnvPatch(),
      BABEL_OTEL_ENABLED: 'true',
      BABEL_OTEL_SERVICE_NAME: 'babel-cli-tests',
      GROQ_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    };
    if (stubFiles) {
      envPatch.BABEL_CLAUDE_CMD = stubFiles.claudeCmd;
      envPatch.BABEL_CLAUDE_ARGS = '';
      envPatch.BABEL_CODEX_CMD = stubFiles.codexCmd;
      envPatch.BABEL_CODEX_ARGS = '';
    }

    await withPatchedEnv(envPatch, async () => {
      const { runBabelPipeline } = await import('../src/pipeline.js');

      for (const scenario of SCENARIOS) {
        const result = await runBabelPipeline(scenario.task, {
          orchestratorVersion: 'v9',
          mode: 'deep',
        });
        assertScenarioArtifacts(scenario, result);
      }
    });

    console.log('[test:pipeline-v9:live] live regression passed');
  } finally {
    await resetTelemetryForTests();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  if (liveMode) {
    await runLiveRegression();
    return;
  }

  await runOfflineRegression();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
