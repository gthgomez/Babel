import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';

export interface CliSmokeBenchmarkOptions {
  live?: boolean;
  modes?: string[];
  model?: string;
  modelTier?: string;
  timeoutMs?: number;
  outputDir?: string;
  now?: Date;
}

export interface CliSmokeBenchmarkCase {
  id: string;
  mode: string;
  surface: 'babel' | 'bl' | 'do';
  scenario_id: string;
  command: string[];
  expected_statuses: string[];
  required_fields: string[];
  missing_fields: string[];
  status: 'passed' | 'failed' | 'skipped';
  exit_code: number | null;
  duration_ms: number | null;
  reported_status: string | null;
  total_tokens: number | null;
  schema_retries: number | null;
  selected_lane: string | null;
  changed_files: string[];
  checks: string[];
  run_dir: string | null;
  recovery: Record<string, unknown> | null;
  resume: Record<string, unknown> | null;
  stdout_path: string | null;
  stderr_path: string | null;
  notes: string[];
}

export interface CliSmokeBenchmarkReport {
  schema_version: 1;
  report_type: 'babel_cli_smoke_benchmark';
  generated_at: string;
  live: boolean;
  benchmark_root: string;
  artifact_path: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    total_tokens: number;
    schema_retries: number;
  };
  cases: CliSmokeBenchmarkCase[];
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function prepareNodeFixture(root: string, source: string, testFile: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    scripts: { test: 'node --test' },
    type: 'module',
  }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(root, 'src', 'math.js'), source, 'utf-8');
  writeFileSync(join(root, 'src', 'math.test.js'), testFile, 'utf-8');
}

function prepareFixFixture(root: string): void {
  prepareNodeFixture(
    root,
    'export function add(a, b) {\n  return a - b;\n}\n',
    [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { add } from './math.js';",
    '',
    "test('add sums two numbers', () => {",
    '  assert.equal(add(2, 3), 5);',
    '});',
    '',
    ].join('\n'),
  );
}

function prepareReadOnlyRepoFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Smoke Fixture\n\nUse this repo for read-only CLI questions.\n', 'utf-8');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(root, 'src', 'index.js'), 'export const answer = 42;\n', 'utf-8');
}

function prepareSmallRefactorFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    scripts: { test: 'node --test' },
    type: 'module',
  }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(root, 'src', 'messages.js'), [
    'export function greeting(name) {',
    "  const cleaned = String(name || '').trim();",
    "  return 'Hello, ' + cleaned + '!';",
    '}',
    '',
  ].join('\n'), 'utf-8');
  writeFileSync(join(root, 'src', 'messages.test.js'), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { greeting } from './messages.js';",
    '',
    "test('greeting trims names', () => {",
    "  assert.equal(greeting(' Ada '), 'Hello, Ada!');",
    '});',
    '',
  ].join('\n'), 'utf-8');
}

function prepareProviderSchemaRecoveryRun(root: string, projectRoot: string): string {
  const runDir = join(root, 'fixtures', 'provider-schema-run');
  mkdirSync(runDir, { recursive: true });
  const capsulePath = join(runDir, '12_pre_execution_failure_capsule.json');
  writeFileSync(join(runDir, 'terminal_status_summary.json'), `${JSON.stringify({
    schema_version: 1,
    artifact_type: 'babel_terminal_status_summary',
    status: 'FATAL_ERROR',
    reason_category: 'fatal_error',
    failed_command: null,
    changed_files: [],
    change_disposition: 'none',
    rollback_mode: 'none',
    failure_capsule_path: capsulePath,
    next_recommended_operator_action: 'Inspect schema failure and retry.',
    parseable_json_stdout_required: true,
    attempt_safety_summary_path: null,
    repair_attempt_timeline_path: null,
    condition_summary: 'PROVIDER_SCHEMA_INVALID: Zod validation failed',
    verifier_contract: null,
  }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), `${JSON.stringify({
    status: 'EXECUTION_HALTED',
    pipeline_error: { condition: 'PROVIDER_SCHEMA_INVALID: Zod validation failed' },
    tool_call_log: [],
  }, null, 2)}\n`, 'utf-8');
  writeFileSync(capsulePath, `${JSON.stringify({
    category: 'provider_schema_invalid',
    failure_code: 'PROVIDER_SCHEMA_INVALID',
    task: 'In one sentence, summarize this repo.',
    project_root: projectRoot,
    retryable: true,
  }, null, 2)}\n`, 'utf-8');
  return runDir;
}

function prepareVerifierFailureResumeRun(root: string): string {
  const projectRoot = join(root, 'fixtures', 'verifier-resume-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), `${JSON.stringify({
    type: 'module',
    scripts: { test: 'node check.js' },
  }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(projectRoot, 'check.js'), 'process.exit(0);\n', 'utf-8');
  const runDir = join(root, 'fixtures', 'verifier-failure-run');
  mkdirSync(runDir, { recursive: true });
  const capsulePath = join(runDir, 'small_fix_failure_capsule.json');
  writeFileSync(join(runDir, 'terminal_status_summary.json'), `${JSON.stringify({
    schema_version: 1,
    artifact_type: 'babel_terminal_status_summary',
    status: 'SMALL_FIX_FAILED',
    reason_category: 'small_fix_failed',
    failed_command: 'npm test',
    changed_files: ['src/math.js'],
    failure_capsule_path: capsulePath,
    condition_summary: 'npm test failed',
  }, null, 2)}\n`, 'utf-8');
  writeFileSync(join(runDir, '04_execution_report.json'), `${JSON.stringify({
    status: 'EXECUTION_HALTED',
    small_fix: {
      target_file: 'src/math.js',
      verifier_command: 'npm test',
      project_root: projectRoot,
    },
    tool_call_log: [{ tool: 'test_run', target: 'npm test', exit_code: 1 }],
  }, null, 2)}\n`, 'utf-8');
  writeFileSync(capsulePath, `${JSON.stringify({
    failure_code: 'verifier_failed',
    failed_command: 'npm test',
    project_root: projectRoot,
    retryable: true,
  }, null, 2)}\n`, 'utf-8');
  return runDir;
}

function buildCases(input: {
  modes: string[];
  benchmarkRoot: string;
  model?: string;
  modelTier?: string;
}): Array<{
  id: string;
  mode: string;
  surface: 'babel' | 'bl' | 'do';
  scenario_id: string;
  command: string[];
  expected_statuses: string[];
  required_fields: string[];
}> {
  const cliRoot = join(BABEL_ROOT, 'babel-cli');
  const distIndex = join(cliRoot, 'dist', 'index.js');
  const liteBin = join(cliRoot, 'bin', 'babel-lite.js');
  const modelArgs = [
    ...(input.model ? ['--model', input.model] : []),
    ...(input.modelTier ? ['--model-tier', input.modelTier] : []),
  ];
  const cases: Array<{
    id: string;
    mode: string;
    surface: 'babel' | 'bl' | 'do';
    scenario_id: string;
    command: string[];
    expected_statuses: string[];
    required_fields: string[];
  }> = [];
  const readOnlyRoot = join(input.benchmarkRoot, 'fixtures', 'read-only');
  prepareReadOnlyRepoFixture(readOnlyRoot);
  const schemaRun = prepareProviderSchemaRecoveryRun(input.benchmarkRoot, readOnlyRoot);
  const verifierRun = prepareVerifierFailureResumeRun(input.benchmarkRoot);
  const answerFields = ['status', 'task', 'run_dir', 'changed_files', 'checks', 'usage.totalTokens', 'schema_retries', 'support_path'];
  const fixFields = ['status', 'run_dir', 'changed_files', 'checks', 'usage.totalTokens', 'schema_retries', 'support_path'];
  const doFields = [...fixFields, 'selected_lane'];
  const resumeFields = ['status', 'run_dir', 'classification', 'changed_files', 'checks', 'recovery.available_artifacts', 'recovery.missing_artifacts'];
  if (input.modes.includes('babel')) {
    const fixRoot = join(input.benchmarkRoot, 'fixtures', 'babel-fix');
    const refactorRoot = join(input.benchmarkRoot, 'fixtures', 'babel-refactor');
    const repairRoot = join(input.benchmarkRoot, 'fixtures', 'babel-repair');
    prepareFixFixture(fixRoot);
    prepareSmallRefactorFixture(refactorRoot);
    prepareFixFixture(repairRoot);
    cases.push({
      id: 'babel_read_only_repo_question',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'read_only_repo_question',
      command: [process.execPath, distIndex, 'ask', 'In one sentence, summarize this repo.', '--project-root', readOnlyRoot, ...modelArgs, '--json'],
      expected_statuses: ['ANSWER_READY', 'NEEDS_MORE_CONTEXT'],
      required_fields: answerFields,
    });
    cases.push({
      id: 'babel_bare_read_only_repo_question',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'read_only_repo_question',
      command: [process.execPath, distIndex, 'Explain this repo without editing.', '--project-root', readOnlyRoot, ...modelArgs, '--json'],
      expected_statuses: ['ANSWER_READY', 'NEEDS_MORE_CONTEXT'],
      required_fields: [...answerFields, 'selected_lane'],
    });
    const inferredRoot = join(input.benchmarkRoot, 'fixtures', 'babel-inferred-fix');
    prepareFixFixture(inferredRoot);
    cases.push({
      id: 'babel_bare_inferred_one_file_bug_fix',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'inferred_one_file_bug_fix',
      command: [process.execPath, distIndex, 'fix the failing math test', '--project-root', inferredRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['DO_COMPLETE'],
      required_fields: doFields,
    });
    cases.push({
      id: 'babel_one_file_bug_fix',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'one_file_bug_fix',
      command: [
        process.execPath,
        distIndex,
        'fix',
        'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        '--project-root',
        fixRoot,
        '--execution-profile',
        'dev_local',
        ...modelArgs,
        '--json',
      ],
      expected_statuses: ['FIX_COMPLETE'],
      required_fields: fixFields,
    });
    cases.push({
      id: 'babel_small_refactor',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'small_refactor',
      command: [process.execPath, distIndex, 'fix', 'Refactor the greeting implementation for readability. Only edit src/messages.js. Run npm test before completing.', '--project-root', refactorRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['FIX_COMPLETE'],
      required_fields: fixFields,
    });
    cases.push({
      id: 'babel_failing_test_repair',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'failing_test_repair',
      command: [process.execPath, distIndex, 'fix', 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.', '--project-root', repairRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['FIX_COMPLETE'],
      required_fields: fixFields,
    });
    cases.push({
      id: 'babel_provider_schema_recovery',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'provider_schema_recovery',
      command: [process.execPath, distIndex, 'resume', schemaRun, ...modelArgs, '--json'],
      expected_statuses: ['RESUME_COMPLETE', 'RESUME_NOT_RESUMABLE'],
      required_fields: resumeFields,
    });
    cases.push({
      id: 'babel_verifier_failure_resume',
      mode: 'babel',
      surface: 'babel',
      scenario_id: 'verifier_failure_resume',
      command: [process.execPath, distIndex, 'resume', verifierRun, '--json'],
      expected_statuses: ['RESUME_COMPLETE'],
      required_fields: resumeFields,
    });
  }
  if (input.modes.includes('bl')) {
    const fixRoot = join(input.benchmarkRoot, 'fixtures', 'bl-fix');
    const doFixRoot = join(input.benchmarkRoot, 'fixtures', 'bl-do-fix');
    const refactorRoot = join(input.benchmarkRoot, 'fixtures', 'bl-refactor');
    const repairRoot = join(input.benchmarkRoot, 'fixtures', 'bl-repair');
    prepareFixFixture(fixRoot);
    prepareFixFixture(doFixRoot);
    prepareSmallRefactorFixture(refactorRoot);
    prepareFixFixture(repairRoot);
    cases.push({
      id: 'bl_read_only_repo_question',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'read_only_repo_question',
      command: [process.execPath, liteBin, 'ask', 'In one sentence, summarize this repo.', '--project-root', readOnlyRoot, ...modelArgs, '--json'],
      expected_statuses: ['ANSWER_READY', 'NEEDS_MORE_CONTEXT'],
      required_fields: answerFields,
    });
    cases.push({
      id: 'bl_do_read_only_repo_question',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'bl_do_read_only_repo_question',
      command: [process.execPath, liteBin, 'do', 'Explain this repo without editing.', '--project-root', readOnlyRoot, ...modelArgs, '--json'],
      expected_statuses: ['ANSWER_READY', 'NEEDS_MORE_CONTEXT'],
      required_fields: [...answerFields, 'selected_lane'],
    });
    cases.push({
      id: 'bl_one_file_bug_fix',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'one_file_bug_fix',
      command: [
        process.execPath,
        liteBin,
        'fix',
        'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        '--project-root',
        fixRoot,
        '--execution-profile',
        'dev_local',
        ...modelArgs,
        '--json',
      ],
      expected_statuses: ['FIX_COMPLETE'],
      required_fields: fixFields,
    });
    cases.push({
      id: 'bl_do_one_file_bug_fix',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'bl_do_one_file_bug_fix',
      command: [
        process.execPath,
        liteBin,
        'do',
        'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        '--project-root',
        doFixRoot,
        '--execution-profile',
        'dev_local',
        ...modelArgs,
        '--json',
      ],
      expected_statuses: ['DO_COMPLETE'],
      required_fields: doFields,
    });
    cases.push({
      id: 'bl_small_refactor',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'small_refactor',
      command: [process.execPath, liteBin, 'fix', 'Refactor the greeting implementation for readability. Only edit src/messages.js. Run npm test before completing.', '--project-root', refactorRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['FIX_COMPLETE'],
      required_fields: fixFields,
    });
    cases.push({
      id: 'bl_failing_test_repair',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'failing_test_repair',
      command: [process.execPath, liteBin, 'fix', 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.', '--project-root', repairRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['FIX_COMPLETE'],
      required_fields: fixFields,
    });
    cases.push({
      id: 'bl_provider_schema_recovery',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'provider_schema_recovery',
      command: [process.execPath, liteBin, 'resume', schemaRun, ...modelArgs, '--json'],
      expected_statuses: ['RESUME_COMPLETE', 'RESUME_NOT_RESUMABLE'],
      required_fields: resumeFields,
    });
    cases.push({
      id: 'bl_verifier_failure_resume',
      mode: 'bl',
      surface: 'bl',
      scenario_id: 'verifier_failure_resume',
      command: [process.execPath, liteBin, 'resume', verifierRun, '--json'],
      expected_statuses: ['RESUME_COMPLETE'],
      required_fields: resumeFields,
    });
  }
  if (input.modes.includes('do')) {
    const fixRoot = join(input.benchmarkRoot, 'fixtures', 'do-fix');
    const refactorRoot = join(input.benchmarkRoot, 'fixtures', 'do-refactor');
    const repairRoot = join(input.benchmarkRoot, 'fixtures', 'do-repair');
    prepareFixFixture(fixRoot);
    prepareSmallRefactorFixture(refactorRoot);
    prepareFixFixture(repairRoot);
    cases.push({
      id: 'do_read_only_repo_question',
      mode: 'do',
      surface: 'do',
      scenario_id: 'read_only_repo_question',
      command: [process.execPath, distIndex, 'do', 'Explain this repo without editing.', '--project-root', readOnlyRoot, ...modelArgs, '--json'],
      expected_statuses: ['ANSWER_READY', 'NEEDS_MORE_CONTEXT'],
      required_fields: [...answerFields, 'selected_lane'],
    });
    cases.push({
      id: 'do_one_file_bug_fix',
      mode: 'do',
      surface: 'do',
      scenario_id: 'one_file_bug_fix',
      command: [process.execPath, distIndex, 'do', 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.', '--project-root', fixRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['DO_COMPLETE'],
      required_fields: doFields,
    });
    cases.push({
      id: 'do_small_refactor',
      mode: 'do',
      surface: 'do',
      scenario_id: 'small_refactor',
      command: [process.execPath, distIndex, 'do', 'Refactor the greeting implementation for readability. Only edit src/messages.js. Run npm test before completing.', '--project-root', refactorRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['DO_COMPLETE'],
      required_fields: doFields,
    });
    cases.push({
      id: 'do_failing_test_repair',
      mode: 'do',
      surface: 'do',
      scenario_id: 'failing_test_repair',
      command: [process.execPath, distIndex, 'do', 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.', '--project-root', repairRoot, '--execution-profile', 'dev_local', ...modelArgs, '--json'],
      expected_statuses: ['DO_COMPLETE'],
      required_fields: doFields,
    });
    cases.push({
      id: 'do_provider_schema_recovery',
      mode: 'do',
      surface: 'do',
      scenario_id: 'provider_schema_recovery',
      command: [process.execPath, distIndex, 'resume', schemaRun, ...modelArgs, '--json'],
      expected_statuses: ['RESUME_COMPLETE', 'RESUME_NOT_RESUMABLE'],
      required_fields: resumeFields,
    });
    cases.push({
      id: 'do_verifier_failure_resume',
      mode: 'do',
      surface: 'do',
      scenario_id: 'verifier_failure_resume',
      command: [process.execPath, distIndex, 'resume', verifierRun, '--json'],
      expected_statuses: ['RESUME_COMPLETE'],
      required_fields: resumeFields,
    });
  }
  return cases;
}

function hasField(value: Record<string, unknown> | null, path: string): boolean {
  if (!value) {
    return false;
  }
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !(part in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined && current !== null;
}

export function runCliSmokeBenchmark(options: CliSmokeBenchmarkOptions = {}): CliSmokeBenchmarkReport {
  const now = options.now ?? new Date();
  const benchmarkRoot = resolve(options.outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks', `cli-smoke-${formatTimestamp(now)}`));
  mkdirSync(benchmarkRoot, { recursive: true });
  const modes = (options.modes && options.modes.length > 0 ? options.modes : ['babel', 'bl', 'do'])
    .map(mode => mode.trim().toLowerCase())
    .filter(mode => mode === 'babel' || mode === 'bl' || mode === 'do');
  const prepared = buildCases({
    modes: modes.length > 0 ? modes : ['babel', 'bl', 'do'],
    benchmarkRoot,
    ...(options.model ? { model: options.model } : {}),
    ...(options.modelTier ? { modelTier: options.modelTier } : {}),
  });

  const cases: CliSmokeBenchmarkCase[] = prepared.map(testCase => {
    if (options.live !== true) {
      return {
        ...testCase,
        missing_fields: [],
        status: 'skipped',
        exit_code: null,
        duration_ms: null,
        reported_status: null,
        total_tokens: null,
        schema_retries: null,
        selected_lane: null,
        changed_files: [],
        checks: [],
        run_dir: null,
        recovery: null,
        resume: null,
        stdout_path: null,
        stderr_path: null,
        notes: ['Dry run only. Add --live to call the configured provider.'],
      };
    }

    const started = Date.now();
    const result = spawnSync(testCase.command[0]!, testCase.command.slice(1), {
      cwd: BABEL_ROOT,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 420_000,
    });
    const duration = Date.now() - started;
    const stdoutPath = join(benchmarkRoot, `${testCase.id}.stdout.log`);
    const stderrPath = join(benchmarkRoot, `${testCase.id}.stderr.log`);
    writeFileSync(stdoutPath, result.stdout ?? '', 'utf-8');
    writeFileSync(stderrPath, result.stderr ?? '', 'utf-8');
    const parsed = parseJsonObject(result.stdout ?? '');
    const usage = parsed?.['usage'];
    const totalTokens = usage !== null && typeof usage === 'object' && !Array.isArray(usage) && typeof (usage as { totalTokens?: unknown }).totalTokens === 'number'
      ? (usage as { totalTokens: number }).totalTokens
      : null;
    const schemaRetries = typeof parsed?.['schema_retries'] === 'number' ? parsed['schema_retries'] : null;
    const reportedStatus = typeof parsed?.['status'] === 'string' ? parsed['status'] : null;
    const selectedLane = typeof parsed?.['selected_lane'] === 'string' ? parsed['selected_lane'] : null;
    const missingFields = testCase.required_fields.filter(field => !hasField(parsed, field));
    const expectedOk = reportedStatus !== null && testCase.expected_statuses.includes(reportedStatus);
    const pass = result.status === 0 && expectedOk && missingFields.length === 0;
    return {
      ...testCase,
      status: pass ? 'passed' : 'failed',
      exit_code: result.status,
      duration_ms: duration,
      reported_status: reportedStatus,
      missing_fields: missingFields,
      total_tokens: totalTokens,
      schema_retries: schemaRetries,
      selected_lane: selectedLane,
      changed_files: stringArray(parsed?.['changed_files']),
      checks: stringArray(parsed?.['checks']),
      run_dir: typeof parsed?.['run_dir'] === 'string' ? parsed['run_dir'] : null,
      recovery: parsed?.['recovery'] !== null && typeof parsed?.['recovery'] === 'object' && !Array.isArray(parsed?.['recovery'])
        ? parsed['recovery'] as Record<string, unknown>
        : null,
      resume: reportedStatus?.startsWith('RESUME') === true ? parsed : null,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      notes: [
        result.error ? String(result.error.message) : '',
        expectedOk ? 'reported expected status' : `unexpected status=${reportedStatus ?? '(none)'}`,
        missingFields.length > 0 ? `missing fields: ${missingFields.join(', ')}` : '',
      ].filter(Boolean),
    };
  });

  const report: CliSmokeBenchmarkReport = {
    schema_version: 1,
    report_type: 'babel_cli_smoke_benchmark',
    generated_at: now.toISOString(),
    live: options.live === true,
    benchmark_root: benchmarkRoot,
    artifact_path: join(benchmarkRoot, 'report.json'),
    summary: {
      total: cases.length,
      passed: cases.filter(testCase => testCase.status === 'passed').length,
      failed: cases.filter(testCase => testCase.status === 'failed').length,
      skipped: cases.filter(testCase => testCase.status === 'skipped').length,
      total_tokens: cases.reduce((sum, testCase) => sum + (testCase.total_tokens ?? 0), 0),
      schema_retries: cases.reduce((sum, testCase) => sum + (testCase.schema_retries ?? 0), 0),
    },
    cases,
  };
  writeFileSync(report.artifact_path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return report;
}

export function formatCliSmokeBenchmarkHuman(report: CliSmokeBenchmarkReport): string {
  const lines = [
    'Babel CLI Smoke Benchmark',
    `Live: ${report.live ? 'yes' : 'no'}`,
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
    `Provider usage: ${report.summary.total_tokens > 0 ? `${report.summary.total_tokens} tokens` : 'not reported'}`,
    `Provider formatting retries: ${report.summary.schema_retries}`,
    '',
  ];
  for (const testCase of report.cases) {
    const path = testCase.selected_lane ? ` path=${testCase.selected_lane}` : '';
    const tokens = testCase.total_tokens !== null ? ` tokens=${testCase.total_tokens}` : '';
    lines.push(`- ${testCase.id}: ${testCase.status} status=${testCase.reported_status ?? '(none)'}${path}${tokens}`);
  }
  lines.push('');
  lines.push(`Report: ${report.artifact_path}`);
  return lines.join('\n');
}
