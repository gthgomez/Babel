import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type LaneName = 'backend' | 'frontend';
type VariantName = 'default' | 'minimal';
type QaVerdict = 'PASS' | 'REJECT';
type PipelineStatus = 'COMPLETE' | 'QA_REJECTED_MAX_LOOPS';

interface FixtureExpectation {
  qa_verdict: QaVerdict;
  qa_failure_tags: string[];
}

interface FixtureRecord {
  id: string;
  task: string;
  variant_expectations: Record<VariantName, FixtureExpectation>;
}

interface RuntimeTelemetryRecord {
  orchestrator_version: '8.0' | '9.0';
  domain_id: string;
  skill_ids: string[];
  model_adapter_id: string;
  selected_entry_ids: string[];
  token_budget_total: number | null;
  token_budget_missing_count: number;
  budget_warning_severity: 'info' | 'warn' | 'severe' | null;
  budget_policy_enabled: boolean;
  pipeline_mode: 'direct' | 'verified' | 'autonomous' | 'manual';
  qa_verdict: QaVerdict | null;
  qa_failure_tags: string[];
  final_outcome: string | null;
}

interface RunResultRecord {
  fixture_id: string;
  variant: VariantName;
  run_dir: string;
  status: PipelineStatus;
  selected_entry_ids: string[];
  skill_ids: string[];
  token_budget_total: number | null;
  qa_verdict: QaVerdict | null;
  qa_failure_tags: string[];
  final_outcome: string | null;
}

interface VariantSummary {
  variant: VariantName;
  average_token_budget: number | null;
  qa_pass_rate: number;
  final_success_rate: number;
  budgets: number[];
  failure_tag_frequency: Record<string, number>;
}

interface LaneConfig {
  lane: LaneName;
  taskCategory: 'Backend' | 'Frontend';
  domainId: 'domain_swe_backend' | 'domain_swe_frontend';
  defaultSkillIds: string[];
}

const LANE_CONFIGS: LaneConfig[] = [
  {
    lane: 'backend',
    taskCategory: 'Backend',
    domainId: 'domain_swe_backend',
    defaultSkillIds: ['skill_ts_zod', 'skill_supabase_pg'],
  },
  {
    lane: 'frontend',
    taskCategory: 'Frontend',
    domainId: 'domain_swe_frontend',
    defaultSkillIds: ['skill_react_nextjs', 'skill_a11y_design'],
  },
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BABEL_ROOT = resolve(__dirname, '..', '..');
const OUTPUT_ROOT = join(BABEL_ROOT, 'artifacts', 'bundle-comparisons');
const COMPARISON_RUNS_DIR = join(OUTPUT_ROOT, 'runs');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function readFixtureFile(filename: string): FixtureRecord[] {
  const fullPath = join(__dirname, 'fixtures', filename);
  return JSON.parse(readFileSync(fullPath, 'utf-8')) as FixtureRecord[];
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function frequency(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function variantStatusForExpectation(expectation: FixtureExpectation): PipelineStatus {
  return expectation.qa_verdict === 'PASS' ? 'COMPLETE' : 'QA_REJECTED_MAX_LOOPS';
}

function buildTaskPrompt(
  lane: LaneName,
  variant: VariantName,
  fixture: FixtureRecord,
): string {
  return [
    `bundle-compare lane:${lane} variant:${variant} fixture:${fixture.id}`,
    fixture.task,
  ].join(' | ');
}

function writeStubFiles(
  root: string,
  backendFixtures: FixtureRecord[],
  frontendFixtures: FixtureRecord[],
): {
  claudeCmd: string;
  codexCmd: string;
} {
  const fakeLlmPath = join(root, 'fake-llm-bundle-compare.mjs');
  const allFixtures = Object.fromEntries(
    [...backendFixtures, ...frontendFixtures].map(fixture => [fixture.id, fixture]),
  );
  const fixturesJson = JSON.stringify(allFixtures);

  const fakeLlmSource = `
import { readFileSync } from 'node:fs';

const fixtures = ${fixturesJson};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseMarker(prompt, label) {
  const match = prompt.match(new RegExp(label + ':([a-zA-Z0-9_-]+)'));
  return match ? match[1] : null;
}

function detectScenario(prompt) {
  const fixtureId = parseMarker(prompt, 'fixture');
  const variant = parseMarker(prompt, 'variant');
  const lane = parseMarker(prompt, 'lane') ?? (fixtureId && fixtureId.startsWith('frontend_') ? 'frontend' : 'backend');

  if (!fixtureId || !fixtures[fixtureId]) {
    throw new Error('Could not detect bundle comparison fixture from prompt.');
  }
  if (variant !== 'default' && variant !== 'minimal') {
    throw new Error('Could not detect bundle comparison variant from prompt.');
  }

  return {
    lane,
    variant,
    fixtureId,
    fixture: fixtures[fixtureId],
  };
}

function buildOrchestratorManifest(scenario) {
  const isFrontend = scenario.lane === 'frontend';
  const useDefaultSkills = scenario.variant === 'default';

  return {
    orchestrator_version: '9.0',
    target_project: 'global',
    analysis: {
      task_summary: isFrontend
        ? 'Bundle comparison fixture: frontend verified lane.'
        : 'Bundle comparison fixture: backend verified lane.',
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
      rationale: useDefaultSkills
        ? 'Bundle comparison fixture selects the default v9 verified bundle.'
        : 'Bundle comparison fixture selects the trimmed v9 verified bundle.',
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
      apply_domain_default_skills: useDefaultSkills,
      expand_skill_dependencies: true,
      strict_conflict_mode: 'error',
    },
    prompt_manifest: [],
    handoff_payload: {
      user_request:
        'bundle-compare lane:' + scenario.lane +
        ' variant:' + scenario.variant +
        ' fixture:' + scenario.fixtureId +
        ' | ' + scenario.fixture.task,
      system_directive: 'Resolve instruction_stack against prompt_catalog.yaml, expand dependencies, compile prompt_manifest, then load the compiled files in order.',
    },
  };
}

function buildSwePlan(scenario) {
  return {
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    task_summary:
      'OBJECTIVE: Compare the ' + scenario.variant + ' ' + scenario.lane +
      ' verified bundle. [lane:' + scenario.lane +
      ' variant:' + scenario.variant +
      ' fixture:' + scenario.fixtureId + ']',
    known_facts: [
      'The orchestrator emitted a typed v9 manifest in uncompiled form.',
      'The compiler must resolve the selected stack before the SWE and QA stages execute.',
      'Fixture markers: lane=' + scenario.lane + ', variant=' + scenario.variant + ', fixture=' + scenario.fixtureId + '.',
    ],
    assumptions: [
      'This fixture is intentionally scoped to bundle comparison coverage.',
    ],
    risks: [
      {
        risk: 'The trimmed bundle may lose necessary guidance and fail QA.',
        likelihood: 'medium',
        mitigation: 'Capture QA outcome and compare it against the default bundle before proposing pruning.',
      },
    ],
    minimal_action_set: [
      {
        step: 1,
        description: 'Inspect the compiled manifest and runtime telemetry for the bundle comparison fixture.',
        tool: 'file_read',
        target: 'runs/latest/01_manifest.json',
        rationale: 'Confirms the active bundle compiled before the worker/QA path.',
        reversible: true,
        verification: 'The manifest is compiled and the runtime telemetry file exists.',
      },
    ],
    root_cause: 'N/A — bundle comparison fixture',
    out_of_scope: [
      'Executing CLI tools',
      'Modifying repository files',
    ],
  };
}

function buildQaVerdict(scenario) {
  const expectation = scenario.fixture.variant_expectations[scenario.variant];
  if (expectation.qa_verdict === 'PASS') {
    return {
      verdict: 'PASS',
      overall_confidence: 5,
      notes: 'Bundle comparison fixture passes QA for this variant.',
    };
  }

  return {
    verdict: 'REJECT',
    failure_count: expectation.qa_failure_tags.length,
    failures: expectation.qa_failure_tags.map((tag, index) => ({
      tag,
      condition: 'Bundle comparison fixture rejection for ' + scenario.variant + ' due to missing targeted guidance [' + (index + 1) + '].',
      confidence: 4,
    })),
    overall_confidence: 4,
    proposed_fix_strategy: 'Restore the domain-default skill bundle before changing any defaults.',
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

  const scenario = detectScenario(prompt);
  let payload;
  if (prompt.includes('OLS-v9-Orchestrator.md') || prompt.includes('"compilation_state": "uncompiled"')) {
    payload = buildOrchestratorManifest(scenario);
  } else if (prompt.includes('Analyze the task below and produce the SWE Plan')) {
    payload = buildSwePlan(scenario);
  } else if (prompt.includes('Review the SWE Plan below and produce a QA verdict')) {
    payload = buildQaVerdict(scenario);
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

function summarizeVariant(
  variant: VariantName,
  results: RunResultRecord[],
): VariantSummary {
  const budgets = results
    .map(result => result.token_budget_total)
    .filter((value): value is number => typeof value === 'number');
  const passRuns = results.filter(result => result.qa_verdict === 'PASS').length;
  const completeRuns = results.filter(result => result.final_outcome === 'COMPLETE').length;
  const failureTags = results.flatMap(result => result.qa_failure_tags);

  return {
    variant,
    average_token_budget: average(budgets),
    qa_pass_rate: results.length === 0 ? 0 : passRuns / results.length,
    final_success_rate: results.length === 0 ? 0 : completeRuns / results.length,
    budgets,
    failure_tag_frequency: frequency(failureTags),
  };
}

async function main(): Promise<void> {
  const backendFixtures = readFixtureFile('backend_verified_tasks.json');
  const frontendFixtures = readFixtureFile('frontend_verified_tasks.json');
  const fixturesByLane: Record<LaneName, FixtureRecord[]> = {
    backend: backendFixtures,
    frontend: frontendFixtures,
  };

  mkdirSync(OUTPUT_ROOT, { recursive: true });
  mkdirSync(COMPARISON_RUNS_DIR, { recursive: true });

  const tempDir = mkdtempSync(join(tmpdir(), 'babel-compare-v9-bundles-'));
  const { claudeCmd, codexCmd } = writeStubFiles(tempDir, backendFixtures, frontendFixtures);

  const comparisons: Record<LaneName, unknown> = {
    backend: null,
    frontend: null,
  };
  const pruningProposals: unknown[] = [];

  try {
    await withPatchedEnv(
      {
        BABEL_CLAUDE_CMD: claudeCmd,
        BABEL_CLAUDE_ARGS: '',
        BABEL_CODEX_CMD: codexCmd,
        BABEL_CODEX_ARGS: '',
        BABEL_RUNS_DIR: COMPARISON_RUNS_DIR,
        GROQ_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      async () => {
        const { runBabelPipeline } = await import('../src/pipeline.js');

        for (const laneConfig of LANE_CONFIGS) {
          const fixtures = fixturesByLane[laneConfig.lane];
          const runResults: RunResultRecord[] = [];

          for (const fixture of fixtures) {
            for (const variant of ['default', 'minimal'] as const) {
              const expectation = fixture.variant_expectations[variant];
              const task = buildTaskPrompt(laneConfig.lane, variant, fixture);
              const result = await runBabelPipeline(task, {
                orchestratorVersion: 'v9',
                mode: 'verified',
              });

              const runtimeTelemetryPath = join(result.runDir, '06_runtime_telemetry.json');
              assert(existsSync(runtimeTelemetryPath), `${fixture.id}/${variant}: expected runtime telemetry file`);
              const runtimeTelemetry = JSON.parse(
                readFileSync(runtimeTelemetryPath, 'utf-8'),
              ) as RuntimeTelemetryRecord;

              const expectedStatus = variantStatusForExpectation(expectation);
              const expectedSkillIds = variant === 'default' ? laneConfig.defaultSkillIds : [];

              assert(result.manifest.orchestrator_version === '9.0', `${fixture.id}/${variant}: expected v9 manifest`);
              assert(result.manifest.compilation_state === 'compiled', `${fixture.id}/${variant}: expected compiled v9 manifest`);
              assert(result.status === expectedStatus, `${fixture.id}/${variant}: expected status ${expectedStatus}, got ${result.status}`);
              assert(runtimeTelemetry.domain_id === laneConfig.domainId, `${fixture.id}/${variant}: expected domain ${laneConfig.domainId}, got ${runtimeTelemetry.domain_id}`);
              assert(
                JSON.stringify(runtimeTelemetry.skill_ids) === JSON.stringify(expectedSkillIds),
                `${fixture.id}/${variant}: expected skills ${JSON.stringify(expectedSkillIds)}, got ${JSON.stringify(runtimeTelemetry.skill_ids)}`,
              );
              assert(runtimeTelemetry.qa_verdict === expectation.qa_verdict, `${fixture.id}/${variant}: expected QA ${expectation.qa_verdict}, got ${runtimeTelemetry.qa_verdict}`);
              assert(
                JSON.stringify(runtimeTelemetry.qa_failure_tags) === JSON.stringify(expectation.qa_failure_tags),
                `${fixture.id}/${variant}: expected QA tags ${JSON.stringify(expectation.qa_failure_tags)}, got ${JSON.stringify(runtimeTelemetry.qa_failure_tags)}`,
              );

              runResults.push({
                fixture_id: fixture.id,
                variant,
                run_dir: result.runDir,
                status: result.status as PipelineStatus,
                selected_entry_ids: runtimeTelemetry.selected_entry_ids,
                skill_ids: runtimeTelemetry.skill_ids,
                token_budget_total: runtimeTelemetry.token_budget_total,
                qa_verdict: runtimeTelemetry.qa_verdict,
                qa_failure_tags: runtimeTelemetry.qa_failure_tags,
                final_outcome: runtimeTelemetry.final_outcome,
              });
            }
          }

          const defaultResults = runResults.filter(result => result.variant === 'default');
          const minimalResults = runResults.filter(result => result.variant === 'minimal');
          const defaultSummary = summarizeVariant('default', defaultResults);
          const minimalSummary = summarizeVariant('minimal', minimalResults);
          const budgetSavings = (defaultSummary.average_token_budget ?? 0) - (minimalSummary.average_token_budget ?? 0);
          const passRateDelta = defaultSummary.qa_pass_rate - minimalSummary.qa_pass_rate;
          const introducedFailureTags = unique(
            minimalResults
              .flatMap(result => result.qa_failure_tags)
              .filter(tag => !defaultResults.flatMap(result => result.qa_failure_tags).includes(tag)),
          );
          const recommendation = budgetSavings >= 250 && passRateDelta <= 0
            ? 'prune_candidate'
            : 'keep_default';

          const comparisonArtifact = {
            generated_at: new Date().toISOString(),
            lane: laneConfig.lane,
            domain_id: laneConfig.domainId,
            bundle_comparison: {
              current_default_skill_ids: laneConfig.defaultSkillIds,
              candidate_trimmed_skill_ids: [],
              average_budget_delta: budgetSavings,
              qa_pass_rate_delta: passRateDelta,
              introduced_failure_tags: introducedFailureTags,
              recommendation,
            },
            fixtures: fixtures.map(fixture => ({
              id: fixture.id,
              task: fixture.task,
              variant_expectations: fixture.variant_expectations,
            })),
            variant_summaries: {
              default: defaultSummary,
              minimal: minimalSummary,
            },
            run_results: runResults,
          };

          comparisons[laneConfig.lane] = comparisonArtifact;
          pruningProposals.push({
            domain_id: laneConfig.domainId,
            current_bundle: laneConfig.defaultSkillIds,
            proposed_trimmed_bundle: [],
            expected_budget_savings: budgetSavings,
            qa_risk: passRateDelta > 0 || introducedFailureTags.length > 0 ? 'high' : 'low',
            evidence_count: fixtures.length,
            introduced_failure_tags: introducedFailureTags,
            recommendation,
            approval_status: 'proposed',
          });

          writeFileSync(
            join(OUTPUT_ROOT, `${laneConfig.lane}-default-vs-minimal.json`),
            `${JSON.stringify(comparisonArtifact, null, 2)}\n`,
            'utf-8',
          );
        }

        const pruningArtifact = {
          generated_at: new Date().toISOString(),
          proposals: pruningProposals,
        };
        writeFileSync(
          join(OUTPUT_ROOT, 'pruning-proposals.json'),
          `${JSON.stringify(pruningArtifact, null, 2)}\n`,
          'utf-8',
        );

        process.stdout.write(
          `${JSON.stringify(
            {
              generated_at: new Date().toISOString(),
              output_root: OUTPUT_ROOT,
              generated_files: [
                'backend-default-vs-minimal.json',
                'frontend-default-vs-minimal.json',
                'pruning-proposals.json',
              ],
              comparisons,
            },
            null,
            2,
          )}\n`,
        );
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
