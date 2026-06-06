import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { shouldHaltAutonomousWithoutApprovedPlan } from '../pipeline.js';
import {
  ExecutorReportSchema,
  ExecutorTurnSchema,
  QaVerdictSchema,
  SwePlanSchema,
  ToolCallLogSchema,
  type ExecutorReport,
  type ToolCallLog,
} from '../schemas/agentContracts.js';
import {
  buildVerifierContractArtifacts,
  type VerifierContractSummary,
} from './requiredVerifierContract.js';
import {
  buildTerminalStatusSummary,
  type TerminalStatus,
} from './terminalStatus.js';
import { createWorktreeSafetyController } from './worktreeSafety.js';

interface RecordedScenario {
  id: string;
  required_scenario: string;
  task: string;
  compiled_stack: {
    id: string;
    content: string;
  };
  provider: {
    mode: 'recorded';
    fixture_id: string;
    planner_model: string;
    qa_model: string;
    executor_model: string;
  };
  repo_files?: Array<{ path: string; content: string }>;
  dirty_file?: { path: string; content: string };
  planner_output: unknown;
  qa_output: unknown | null;
  executor_output: unknown | null;
  tool_call_log?: ToolCallLog[];
  expected_terminal_status: TerminalStatus;
  expected_no_files?: string[];
}

interface RecordedFixtureSet {
  schema_version: 1;
  fixture_set_id: string;
  provider_mode: string;
  live_provider_unavailable_artifact: string;
  scenarios: RecordedScenario[];
}

const thisFile = fileURLToPath(import.meta.url);
const babelCliRoot = resolve(dirname(thisFile), '..', '..');
const babelRoot = resolve(babelCliRoot, '..');
const fixturePath = join(dirname(thisFile), '..', 'fixtures', 'live-governance', 'recorded-provider-scenarios.json');
const proofRoot = process.env['BABEL_LIVE_GOVERNANCE_PROOF_ROOT'] ??
  join(babelRoot, 'runs', 'reports', 'babel-live-governance-proof-artifacts');

function liveProviderKeyState(): {
  provider: 'deepseek' | 'deepinfra' | null;
  keyPresent: boolean;
  modeWithKey: string;
} {
  if (process.env['DEEPSEEK_API_KEY']) {
    return {
      provider: 'deepseek',
      keyPresent: true,
      modeWithKey: 'recorded_replay_with_deepseek_key_available',
    };
  }
  if (process.env['DEEPINFRA_API_KEY']) {
    return {
      provider: 'deepinfra',
      keyPresent: true,
      modeWithKey: 'recorded_replay_with_deepinfra_key_available',
    };
  }
  return {
    provider: null,
    keyPresent: false,
    modeWithKey: 'recorded_replay_live_provider_unavailable',
  };
}

function loadFixtures(): RecordedFixtureSet {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as RecordedFixtureSet;
}

function parseSchemaScenarioFilter(): string[] {
  const rawFilter = process.env['BABEL_SCHEMA_FAILURE_SCENARIOS'];
  if (!rawFilter) {
    return [];
  }
  return rawFilter
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function selectScenarios(fixtures: RecordedFixtureSet, scenarioIds: string[]): RecordedScenario[] {
  if (scenarioIds.length === 0) {
    return fixtures.scenarios;
  }

  const normalized = new Set(scenarioIds.map((id) => id.toLowerCase()));
  const selected = fixtures.scenarios.filter((scenario) => normalized.has(scenario.id.toLowerCase()));
  if (selected.length === 0) {
    throw new Error(
      `No scenario matched BABEL_SCHEMA_FAILURE_SCENARIOS=[${scenarioIds.join(', ')}]. ` +
      `Available scenarios: ${fixtures.scenarios.map((scenario) => scenario.id).join(', ')}`,
    );
  }
  return selected;
}

function sha256(input: unknown): string {
  return createHash('sha256').update(
    typeof input === 'string' ? input : JSON.stringify(input),
  ).digest('hex');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeRepoFiles(root: string, files: readonly { path: string; content: string }[] = []): void {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');
  }
}

function runGit(root: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
  );
}

function runGitStatus(root: string): string[] {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(
    result.status,
    0,
    `git status failed: ${result.stderr || result.stdout}`,
  );
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function makeProjectRoot(scenario: RecordedScenario): string {
  const root = mkdtempSync(join(tmpdir(), `babel-live-governance-${scenario.id}-`));
  writeRepoFiles(root, scenario.repo_files);
  if (scenario.dirty_file) {
    runGit(root, ['init']);
    runGit(root, ['config', 'user.email', 'babel-proof@example.test']);
    runGit(root, ['config', 'user.name', 'Babel Proof']);
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', 'baseline']);
    const target = join(root, scenario.dirty_file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, scenario.dirty_file.content, 'utf8');
  }
  return root;
}

function commandsAttempted(toolLog: readonly ToolCallLog[]): string[] {
  return toolLog
    .filter(entry => entry.tool === 'shell_exec' || entry.tool === 'test_run')
    .map(entry => entry.target);
}

function touchedFiles(toolLog: readonly ToolCallLog[]): string[] {
  return toolLog
    .filter(entry => entry.tool === 'file_write' && entry.exit_code === 0)
    .map(entry => entry.target)
    .sort();
}

function parseToolLog(raw: unknown): ToolCallLog[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => ToolCallLogSchema.parse(entry));
}

function makeExecutionReport(input: {
  scenario: RecordedScenario;
  status: TerminalStatus;
  runDir: string;
  toolLog: ToolCallLog[];
  condition: string;
  lastToolOutput?: ToolCallLog | null;
}): ExecutorReport {
  if (input.status === 'QA_REJECTED_MAX_LOOPS') {
    return ExecutorReportSchema.parse({
      status: 'ACTIVATION_REFUSED',
      reason: `QA rejected recorded provider plan: ${input.condition}`,
      gate: 'ACTIVATION_GATE_FAIL',
    });
  }

  if (input.status === 'COMPLETE') {
    return ExecutorReportSchema.parse({
      status: 'EXECUTION_COMPLETE',
      stage_status: 'TOOL_EXECUTION_COMPLETE',
      steps_executed: input.toolLog.length,
      tool_call_log: input.toolLog,
      diff_path: join(input.runDir, 'recorded-provider-diff.patch'),
      execution_log_path: join(input.runDir, '04_execution_report.json'),
      warnings: input.scenario.expected_terminal_status === 'COMPLETE' && input.toolLog.length === 0
        ? ['No tool calls were recorded despite COMPLETE terminal status.']
        : [],
    });
  }

  const haltTag = input.status === 'REQUIRED_VERIFIER_FAILED' ||
    input.status === 'REQUIRED_VERIFIER_MISSING' ||
    input.status === 'REQUIRED_VERIFIER_SKIPPED'
    ? 'STEP_VERIFICATION_FAIL'
    : 'ACTIVATION_GATE_FAIL';

  return ExecutorReportSchema.parse({
    status: 'EXECUTION_HALTED',
    stage_status: input.status === 'REQUIRED_VERIFIER_FAILED' ? 'VERIFIER_FAILED' : 'EXECUTION_ATTEMPTED',
    steps_executed: input.toolLog.length,
    tool_call_log: input.toolLog,
    pipeline_error: {
      halt_tag: haltTag,
      halted_at_step: Math.max(1, input.toolLog.length),
      condition: input.condition,
      ...(input.lastToolOutput ? { last_tool_output: input.lastToolOutput } : {}),
    },
  });
}

function verifierArtifactsFor(
  scenario: RecordedScenario,
  toolLog: readonly ToolCallLog[],
  runDir: string,
): {
  plan: ReturnType<typeof buildVerifierContractArtifacts>['plan'];
  summary: VerifierContractSummary;
} {
  const artifacts = buildVerifierContractArtifacts({
    task: scenario.task,
    toolCallLog: toolLog,
    runDir,
  });
  writeJson(artifacts.artifactPaths.verifier_plan, artifacts.plan);
  writeJson(artifacts.artifactPaths.verifier_execution_summary, artifacts.summary);
  return {
    plan: artifacts.plan,
    summary: artifacts.summary,
  };
}

function runScenario(
  fixtureSet: RecordedFixtureSet,
  scenario: RecordedScenario,
): void {
  const scenarioArtifactRoot = join(proofRoot, scenario.id);
  const runDir = join(scenarioArtifactRoot, 'run');
  const projectRoot = makeProjectRoot(scenario);
  mkdirSync(runDir, { recursive: true });

  try {
    const promptStack = {
      id: scenario.compiled_stack.id,
      sha256: sha256(scenario.compiled_stack.content),
      content_preview: scenario.compiled_stack.content,
    };

    const plannerParse = SwePlanSchema.safeParse(scenario.planner_output);
    const qaParse = scenario.qa_output === null
      ? null
      : QaVerdictSchema.safeParse(scenario.qa_output);
    const executorParse = scenario.executor_output === null
      ? null
      : ExecutorTurnSchema.safeParse(scenario.executor_output);

    let toolLog = parseToolLog(scenario.tool_call_log);
    let condition = '';
    let verifierSummary: VerifierContractSummary | null = null;
    let rollbackMode: 'none' | 'rollback_skipped_user_dirty_target' = 'none';
    let targetDirtyConflicts: string[] = [];

    assert.equal(
      scenario.provider.mode,
      'recorded',
      'Phase 1 recorded-provider scenarios must explicitly identify recorded mode.',
    );

    if (!plannerParse.success) {
      condition = `Planner output failed SwePlanSchema validation: ${plannerParse.error.issues.map(issue => issue.message).join('; ')}`;
      assert.equal(shouldHaltAutonomousWithoutApprovedPlan('autonomous', null), true);
    } else if (qaParse && qaParse.success && qaParse.data.verdict === 'REJECT') {
      condition = qaParse.data.failures.map(failure => failure.condition).join('; ');
      assert.equal(shouldHaltAutonomousWithoutApprovedPlan('autonomous', null), true);
      for (const file of scenario.expected_no_files ?? []) {
        assert.equal(existsSync(join(projectRoot, file)), false, `${file} must not be created after QA rejection`);
      }
    } else {
      assert.equal(plannerParse.success, true);
      assert.equal(qaParse?.success, true);
      assert.equal(qaParse?.data.verdict, 'PASS');
      if (executorParse !== null) {
        assert.equal(executorParse.success, true);
      }

      if (scenario.dirty_file) {
        const safety = createWorktreeSafetyController({
          projectRoot,
          runDir,
        });
        const attemptedPath = scenario.dirty_file.path;
        const snapshot = safety.snapshotBeforeWrite(attemptedPath, 1);
        assert.equal(snapshot.ok, false);
        assert.equal(snapshot.status, 'WORKTREE_DIRTY_UNSAFE');
        assert.equal(readFileSync(join(projectRoot, attemptedPath), 'utf8'), scenario.dirty_file.content);

        const rollback = safety.rollbackTouchedFiles('recorded provider attempted to write dirty target');
        const safetySummary = safety.buildSummary();
        writeJson(join(runDir, 'rollback_summary.json'), rollback);
        writeJson(join(runDir, 'worktree_safety_summary.json'), safetySummary);

        rollbackMode = 'rollback_skipped_user_dirty_target';
        targetDirtyConflicts = safetySummary.target_dirty_conflicts;
        const statusAfter = runGitStatus(projectRoot);
        toolLog = [
          ToolCallLogSchema.parse({
            step: 1,
            tool: 'file_write',
            target: attemptedPath,
            exit_code: 126,
            stdout: '',
            stderr: snapshot.reason ?? 'Dirty target refused.',
            verified: false,
            denial: {
              category: 'executor_policy',
              reason_code: 'WORKTREE_DIRTY_UNSAFE',
              message: snapshot.reason ?? 'Dirty target refused.',
              tool: 'file_write',
              active_mode: 'autonomous',
              required_mode: null,
              evidence: targetDirtyConflicts,
            },
          }),
        ];
        condition = snapshot.reason ?? 'Dirty target refused.';
        assert.equal(statusAfter.length, 1);
        assert.equal(statusAfter[0], `M ${attemptedPath}`);
        assert.equal(readFileSync(join(projectRoot, attemptedPath), 'utf8'), scenario.dirty_file.content);
      } else {
        const verifier = verifierArtifactsFor(scenario, toolLog, runDir);
        verifierSummary = verifier.summary;
        condition = verifierSummary.completionBlockingStatus
          ? `Required verifier contract blocked completion: ${verifierSummary.completionBlockingStatus}`
          : 'Required verifier contract was satisfied and no completion block was recorded.';
      }
    }

    if (!verifierSummary) {
      const verifier = verifierArtifactsFor(scenario, toolLog, runDir);
      verifierSummary = verifier.summary;
    }

    const terminalStatus = buildTerminalStatusSummary({
      status: scenario.expected_terminal_status,
      condition,
      toolCallLog: toolLog,
      changedFiles: touchedFiles(toolLog),
      rollbackMode,
      targetDirtyConflicts,
      verifierContractSummary: verifierSummary,
    });

    assert.equal(terminalStatus.status, scenario.expected_terminal_status);
    if (scenario.expected_terminal_status === 'COMPLETE') {
      assert.equal(verifierSummary?.completionBlockingStatus, null);
    } else {
      assert.notEqual(terminalStatus.status, 'COMPLETE');
    }

    const executionReport = makeExecutionReport({
      scenario,
      runDir,
      status: terminalStatus.status,
      toolLog,
      condition,
      lastToolOutput: [...toolLog].reverse().find(entry => entry.exit_code !== 0) ?? null,
    });

    const proofArtifact = {
      schema_version: 1,
      artifact_type: 'babel_live_governance_recorded_provider_proof',
      fixture_set_id: fixtureSet.fixture_set_id,
      live_provider_state: liveProviderKeyState().keyPresent
        ? 'live_provider_key_present_recorded_replay_still_used_for_deterministic_regression'
        : fixtureSet.live_provider_unavailable_artifact,
      scenario_id: scenario.id,
      required_scenario: scenario.required_scenario,
      prompt_stack: promptStack,
      provider: scenario.provider,
      provider_output_hashes: {
        planner_output_sha256: sha256(scenario.planner_output),
        qa_output_sha256: sha256(scenario.qa_output),
        executor_output_sha256: sha256(scenario.executor_output),
      },
      planner_output: scenario.planner_output,
      planner_parse: plannerParse.success
        ? { status: 'pass' }
        : { status: 'fail', issues: plannerParse.error.issues.map(issue => issue.message) },
      qa_output: scenario.qa_output,
      qa_parse: qaParse === null
        ? { status: 'not_run' }
        : qaParse.success
          ? { status: 'pass', verdict: qaParse.data.verdict }
          : { status: 'fail', issues: qaParse.error.issues.map(issue => issue.message) },
      executor_output: scenario.executor_output,
      executor_parse: executorParse === null
        ? { status: 'not_invoked' }
        : executorParse.success
          ? { status: 'pass', output_type: executorParse.data.type }
          : { status: 'fail', issues: executorParse.error.issues.map(issue => issue.message) },
      commands_attempted: commandsAttempted(toolLog),
      verifier_declaration: scenario.task.match(/\bVerifier commands?\s*:.+$/im)?.[0] ?? null,
      verifier_output: verifierSummary,
      files_touched: touchedFiles(toolLog),
      target_dirty_conflicts: targetDirtyConflicts,
      terminal_status: terminalStatus,
      final_execution_report: executionReport,
    };

    writeJson(join(scenarioArtifactRoot, 'recorded-provider-proof.json'), proofArtifact);
    writeJson(join(scenarioArtifactRoot, 'terminal_status_summary.json'), terminalStatus);
    writeJson(join(scenarioArtifactRoot, '04_execution_report.json'), executionReport);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('recorded-provider governance proof scenarios', async (t) => {
  const fixtures = loadFixtures();
  const scenarioFilter = parseSchemaScenarioFilter();
  const selectedScenarios = selectScenarios(fixtures, scenarioFilter);
  const liveProvider = liveProviderKeyState();
  rmSync(proofRoot, { recursive: true, force: true });
  mkdirSync(proofRoot, { recursive: true });

  writeJson(join(proofRoot, 'provider-mode.json'), {
    schema_version: 1,
    artifact_type: 'babel_live_governance_provider_mode',
    fixture_set_id: fixtures.fixture_set_id,
    requested_live_provider: true,
    preferred_provider: 'deepseek',
    selected_live_provider: liveProvider.provider,
    deepseek_api_key_present: Boolean(process.env['DEEPSEEK_API_KEY']),
    deepinfra_api_key_present: Boolean(process.env['DEEPINFRA_API_KEY']),
    mode_used: liveProvider.keyPresent ? liveProvider.modeWithKey : 'recorded_replay_live_provider_unavailable',
    note: liveProvider.keyPresent
      ? 'A live provider key is present, but this deterministic regression suite still uses recorded provider outputs.'
      : fixtures.live_provider_unavailable_artifact,
  });

  for (const scenario of selectedScenarios) {
    await t.test(scenario.id, () => {
      runScenario(fixtures, scenario);
    });
  }

  writeJson(join(proofRoot, 'proof-summary.json'), {
    schema_version: 1,
    artifact_type: 'babel_live_governance_proof_summary',
    fixture_set_id: fixtures.fixture_set_id,
    scenario_count: selectedScenarios.length,
    scenario_ids: selectedScenarios.map(scenario => scenario.id),
    selected_scenario_filter: scenarioFilter,
    provider_mode: liveProvider.keyPresent
      ? liveProvider.modeWithKey
      : 'recorded_replay_live_provider_unavailable',
    live_provider_unavailable: !liveProvider.keyPresent,
    artifact_root: proofRoot,
  });
});
