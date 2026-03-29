import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enableInMemoryTelemetryForTests, resetTelemetryForTests } from '../src/telemetry/tracing.js';

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
}

const SCENARIOS: Scenario[] = [
  {
    name: 'backend',
    task: 'Regression backend verified lane: prove v9 uncompiled compiles before worker and QA.',
    taskCategory: 'Backend',
    domainId: 'domain_swe_backend',
    expectedSelectedIds: [
      'behavioral_core_v7',
      'behavioral_guard_v7',
      'domain_swe_backend',
      'skill_ts_zod',
      'skill_supabase_pg',
      'adapter_codex_balanced',
      'pipeline_qa_reviewer',
    ],
    expectedTokenBudgetTotal: 2375,
  },
  {
    name: 'frontend',
    task: 'Regression frontend verified lane: prove v9 uncompiled compiles before worker and QA.',
    taskCategory: 'Frontend',
    domainId: 'domain_swe_frontend',
    expectedSelectedIds: [
      'behavioral_core_v7',
      'behavioral_guard_v7',
      'domain_swe_frontend',
      'skill_react_nextjs',
      'skill_a11y_design',
      'adapter_codex_balanced',
      'pipeline_qa_reviewer',
    ],
    expectedTokenBudgetTotal: 2350,
  },
];

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
      pipeline_mode: 'verified',
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
      assigned_model: 'Codex',
      rationale: isFrontend
        ? 'Regression fixture selects Codex for the frontend verified lane.'
        : 'Regression fixture selects Codex for the backend verified lane.',
    },
    compilation_state: 'uncompiled',
    instruction_stack: {
      behavioral_ids: ['behavioral_core_v7', 'behavioral_guard_v7'],
      domain_id: isFrontend ? 'domain_swe_frontend' : 'domain_swe_backend',
      skill_ids: [],
      model_adapter_id: 'adapter_codex_balanced',
      project_overlay_id: null,
      task_overlay_ids: [],
      pipeline_stage_ids: ['pipeline_qa_reviewer'],
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
  assert(result.status === 'COMPLETE', `${scenario.name}: expected COMPLETE status, got ${result.status}`);
  assert(result.manifest.orchestrator_version === '9.0', `${scenario.name}: expected v9 orchestrator manifest`);
  assert(result.manifest.compilation_state === 'compiled', `${scenario.name}: expected compiled manifest`);
  assert(result.manifest.compiled_artifacts !== undefined, `${scenario.name}: expected compiled_artifacts`);
  assert(result.manifest.prompt_manifest.length > 0, `${scenario.name}: expected compiled root prompt_manifest`);

  const selectedIds = result.manifest.compiled_artifacts.selected_entry_ids;
  assert(
    JSON.stringify(selectedIds) === JSON.stringify(scenario.expectedSelectedIds),
    `${scenario.name}: expected selected IDs ${JSON.stringify(scenario.expectedSelectedIds)}, got ${JSON.stringify(selectedIds)}`,
  );

  const manifestPath = join(result.runDir, '01_manifest.json');
  const swePlanPath = join(result.runDir, '02_swe_plan_v1.json');
  const qaVerdictPath = join(result.runDir, '03_qa_verdict_v1.json');
  const runtimeTelemetryPath = join(result.runDir, '06_runtime_telemetry.json');
  const traceContextPath = join(result.runDir, '07_trace_context.json');

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

  assert(writtenManifest.compilation_state === 'compiled', `${scenario.name}: expected written manifest to be compiled`);
  assert(
    JSON.stringify(writtenManifest.compiled_artifacts?.selected_entry_ids ?? []) === JSON.stringify(scenario.expectedSelectedIds),
    `${scenario.name}: expected written manifest selected IDs to match`,
  );
  assert(
    writtenManifest.compiled_artifacts?.token_budget_total === scenario.expectedTokenBudgetTotal,
    `${scenario.name}: expected token_budget_total ${scenario.expectedTokenBudgetTotal}, got ${writtenManifest.compiled_artifacts?.token_budget_total}`,
  );
  assert(
    Array.isArray(writtenManifest.compiled_artifacts?.token_budget_missing) &&
    writtenManifest.compiled_artifacts?.token_budget_missing.length === 0,
    `${scenario.name}: expected no missing token budgets in active verified lane`,
  );
  assert(
    Array.isArray(writtenManifest.compiled_artifacts?.warnings) &&
    writtenManifest.compiled_artifacts?.warnings.includes(`Total token budget: ${scenario.expectedTokenBudgetTotal}`),
    `${scenario.name}: expected total token budget warning to be recorded`,
  );
  assert(
    writtenManifest.runtime_telemetry?.domain_id === scenario.domainId,
    `${scenario.name}: expected runtime telemetry domain_id ${scenario.domainId}, got ${writtenManifest.runtime_telemetry?.domain_id}`,
  );
  assert(
    writtenManifest.runtime_telemetry?.token_budget_total === scenario.expectedTokenBudgetTotal,
    `${scenario.name}: expected runtime telemetry token_budget_total ${scenario.expectedTokenBudgetTotal}, got ${writtenManifest.runtime_telemetry?.token_budget_total}`,
  );
  assert(
    writtenRuntimeTelemetry.domain_id === scenario.domainId,
    `${scenario.name}: expected runtime telemetry file domain_id ${scenario.domainId}, got ${writtenRuntimeTelemetry.domain_id}`,
  );
  assert(
    writtenRuntimeTelemetry.token_budget_total === scenario.expectedTokenBudgetTotal,
    `${scenario.name}: expected runtime telemetry file token_budget_total ${scenario.expectedTokenBudgetTotal}, got ${writtenRuntimeTelemetry.token_budget_total}`,
  );
  assert(
    writtenRuntimeTelemetry.token_budget_missing_count === 0,
    `${scenario.name}: expected runtime telemetry file token_budget_missing_count 0, got ${writtenRuntimeTelemetry.token_budget_missing_count}`,
  );
  assert(
    writtenRuntimeTelemetry.budget_warning_severity === 'info',
    `${scenario.name}: expected runtime telemetry file budget_warning_severity info, got ${writtenRuntimeTelemetry.budget_warning_severity}`,
  );
  assert(
    writtenRuntimeTelemetry.budget_policy_enabled === true,
    `${scenario.name}: expected runtime telemetry file budget_policy_enabled true, got ${writtenRuntimeTelemetry.budget_policy_enabled}`,
  );
  assert(
    writtenRuntimeTelemetry.qa_verdict === 'PASS',
    `${scenario.name}: expected runtime telemetry file qa_verdict PASS, got ${writtenRuntimeTelemetry.qa_verdict}`,
  );
  assert(
    Array.isArray(writtenRuntimeTelemetry.qa_failure_tags) &&
    writtenRuntimeTelemetry.qa_failure_tags.length === 0,
    `${scenario.name}: expected runtime telemetry file qa_failure_tags to be empty`,
  );
  assert(
    writtenRuntimeTelemetry.final_outcome === 'COMPLETE',
    `${scenario.name}: expected runtime telemetry file final_outcome COMPLETE, got ${writtenRuntimeTelemetry.final_outcome}`,
  );
  assert(writtenTraceContext.enabled === true, `${scenario.name}: expected trace context to be enabled`);
  assert(writtenTraceContext.schema_version === '1', `${scenario.name}: expected trace schema version 1`);
  assert(typeof writtenTraceContext.trace_id === 'string' && writtenTraceContext.trace_id.length > 0, `${scenario.name}: expected trace_id`);
  assert(typeof writtenTraceContext.root_span_id === 'string' && writtenTraceContext.root_span_id.length > 0, `${scenario.name}: expected root_span_id`);
  assert(writtenTraceContext.baggage?.['babel.lane.id'] === '9.0:verified', `${scenario.name}: expected babel.lane.id baggage to match verified v9 lane`);
  assert(writtenQaVerdict.verdict === 'PASS', `${scenario.name}: expected QA PASS, got ${writtenQaVerdict.verdict}`);
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-pipeline-v9-test-'));
  const { claudeCmd, codexCmd } = writeStubFiles(tempDir);

  try {
    await enableInMemoryTelemetryForTests();
    await withPatchedEnv(
      {
        BABEL_CLAUDE_CMD: claudeCmd,
        BABEL_CLAUDE_ARGS: '',
        BABEL_CODEX_CMD: codexCmd,
        BABEL_CODEX_ARGS: '',
        BABEL_OTEL_ENABLED: 'true',
        BABEL_OTEL_SERVICE_NAME: 'babel-cli-tests',
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      async () => {
        const { runBabelPipeline } = await import('../src/pipeline.js');

        for (const scenario of SCENARIOS) {
          const result = await runBabelPipeline(scenario.task, {
            orchestratorVersion: 'v9',
            mode: 'verified',
          });
          assertScenarioArtifacts(scenario, result);
        }
      },
    );

    console.log('v9 pipeline regression tests passed');
  } finally {
    await resetTelemetryForTests();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
