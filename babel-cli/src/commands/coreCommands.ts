import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { Command } from 'commander';
import { z } from 'zod';

import { registerEvidenceProductSubcommands } from './evidenceProductCommands.js';
import { registerMaintenanceCommands } from './maintenanceCommands.js';
import { printJsonErrorAndExit, printJsonOrHuman } from './output.js';
import { registerShipCommand } from './shipCommands.js';
import { registerSkillCommands } from './skillCommands.js';
import { BabelEventBus, runBabelPipeline } from '../pipeline.js';
import { runBabelMcpServer } from '../mcp/server.js';
import { startInteractiveSession } from '../interactive.js';
import { getShadowDiff } from '../services/shadowDiff.js';
import { formatDoctorHuman, runDoctor, type DoctorScope } from '../doctor.js';
import { validateRuntimeEnv } from '../config/runtimeEnv.js';
import {
  buildInspectManifestView,
  buildInspectOutcomeView,
  buildInspectRunView,
  buildInspectStackView,
  buildInspectSummaryView,
  loadInspectBundle,
  resolveInspectRunDir,
} from '../inspect/loaders.js';
import {
  renderInspectManifest,
  renderInspectOutcome,
  renderInspectRun,
  renderInspectStack,
  renderInspectSummary,
} from '../ui/inspection.js';
import { renderProductBanner } from '../ui/renderers.js';
import { warning, muted } from '../ui/theme.js';
import { readRuntimeMode, writeRuntimeMode } from '../config/runtimeMode.js';
import { getExecutorToolRegistrySnapshot, getExecutorToolSnapshot } from '../localTools.js';
import {
  findCheckpoint,
  formatCheckpointInspect,
  formatCheckpointList,
  listCheckpoints,
  restoreCheckpoint,
} from '../services/checkpoints.js';
import type { ExecutorToolSnapshot } from '../tools/executorRegistry.js';
import { buildToolCatalog, formatToolCatalogHuman } from '../tools/toolCatalog.js';
import {
  APPROVAL_PROFILE_DEFINITIONS,
  APPROVAL_PROFILES,
  parseApprovalProfile,
  readApprovalProfileStatus,
  writeApprovalProfile,
  type ApprovalProfileStatus,
} from '../config/approvalProfiles.js';
import {
  getMcpServersConfigPath,
  readMcpServers,
  removeMcpServer,
  upsertMcpServer,
} from '../config/mcpServers.js';
import {
  BABEL_ROOT,
  BABEL_RUNS_DIR,
  VALID_MODES,
  resolveMode,
  type ValidMode,
} from '../cli/constants.js';
import { registerInternalTextProviderCommands } from './liteCommands.js';
import {
  printDryRunState,
  readDryRunState,
  readLatestRunPointer,
  resolveProjectRoot,
  writeDryRunState,
} from '../cli/helpers.js';
import { resolveModelByKey } from '../modelPolicy.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import {
  prepareContextInjection,
  summarizeContextInjection,
} from '../services/contextInjection.js';
import { runCiReview, formatCiReviewHuman } from '../services/ciReview.js';
import { runGitDraft, formatGitDraftHuman, type GitDraftKind } from '../services/gitDrafts.js';
import {
  createGitBranch,
  createGitCommit,
  createGitPullRequest,
  formatGitMutationHuman,
} from '../services/gitMutations.js';
import { buildEventStreamContract } from '../services/eventStream.js';
import {
  buildIdeBridgeContract,
  buildIdeBridgeSnapshot,
  formatIdeBridgeSnapshotHuman,
} from '../services/ideBridge.js';
import { buildRunStats, formatRunStatsHuman } from '../services/runStats.js';
import { formatProofStatusHuman, writeProofArtifacts } from '../services/proof.js';
import {
  formatLessonCandidateHuman,
  formatLessonEvalHuman,
  formatLearningFailureHuman,
  formatMutationPackageHuman,
  generateMutationPackage,
  promoteLessonToShadow,
  readLearningArtifact,
  testLessonCandidate,
  writeLessonCandidate,
  writeLearningFailureRecord,
} from '../services/learning.js';
import {
  createSchedule,
  deleteSchedule,
  formatScheduleListHuman,
  formatScheduleRunHuman,
  listSchedules,
  runScheduleNow,
  type ScheduleJobType,
} from '../services/schedules.js';
import {
  disablePlugin,
  enablePlugin,
  formatPluginDoctorHuman,
  formatPluginInspectHuman,
  formatPluginListHuman,
  loadPluginRegistry,
} from '../services/plugins.js';
import {
  buildSubagentIsolationContract,
  formatAgentListHuman,
  formatAgentMergeHuman,
  formatAgentMergeRestoreHuman,
  formatAgentRunHuman,
  inspectAgentRun,
  listAgentRuns,
  mergeAgentRun,
  restoreAgentMerge,
  runAgentTeamFromFile,
} from '../services/agentTeams.js';
import {
  detectContextFingerprintDrift,
  readExecutorSessionContext,
  summarizeExecutorSessionContext,
} from '../services/sessionContext.js';
import { formatProductBenchmarkHuman, runProductBenchmark } from '../services/productBenchmark.js';
import {
  formatProductionBenchmarkHuman,
  runProductionBenchmark,
} from '../services/productionBenchmark.js';
import { formatParityBenchmarkHuman, runParityBenchmark } from '../services/parityBenchmark.js';
import {
  formatCalibrationBenchmarkHuman,
  runCalibrationBenchmark,
  runCalibrationBenchmarkLive,
  renderCalibrationCurveAscii,
} from '../services/calibrationBenchmark.js';
import {
  formatInjectionBenchmarkHuman,
  runInjectionBenchmark,
  runInjectionBenchmarkLive,
} from '../services/injectionBenchmark.js';
import {
  buildLiteUsabilityReport,
  formatLiteUsabilityReportHuman,
} from '../services/liteUsability.js';
import {
  formatCliSmokeBenchmarkHuman,
  runCliSmokeBenchmark,
} from '../services/cliSmokeBenchmark.js';
import { buildRealTaskPilotReport, formatRealTaskPilotHuman } from '../services/realTaskPilot.js';
import { formatSkillDoctorHuman, runSkillDoctor } from '../services/skillForge.js';
import {
  buildBenchmarkImprovementLoopReport,
  formatBenchmarkImprovementLoopHuman,
} from '../services/benchmarkImprovementLoop.js';
import {
  formatLocalStackResolveHuman,
  resolveLocalStack,
  type LocalCodexAdapter,
  type LocalModel,
  type LocalPipelineMode,
  type LocalProject,
  type LocalTaskCategory,
} from '../control-plane/localStackResolver.js';
import {
  analyzeTerminalBenchRun,
  formatBenchmarkRunAnalysisHuman,
} from '../services/benchmarkAnalysis.js';
import {
  buildBenchmarkRepairReport,
  formatBenchmarkRepairHuman,
} from '../services/benchmarkRepair.js';
import {
  formatBenchmarkRepairLoopHuman,
  runBenchmarkRepairLoop,
} from '../services/benchmarkRepairLoop.js';
import {
  approveAgentJob,
  createAgentJob,
  formatAgentJobHuman,
  formatAgentJobListHuman,
  getAgentJob,
  getAgentJobApprovalState,
  listAgentJobs,
  pauseAgentJob,
  resumeAgentJob,
  updateAgentJob,
  writeAgentJobReport,
  type AgentJob,
} from '../services/agentJobs.js';
import {
  APPROVAL_STATUSES,
  approveApproval,
  denyApproval,
  formatApprovalHuman,
  formatApprovalListHuman,
  inspectApproval,
  listApprovals,
  requestDependencyInstallApproval,
  requestModelEscalationApproval,
  type ApprovalRecord,
  type ApprovalStatus,
} from '../services/approvalQueue.js';
import {
  evaluateCompletionVerification,
  type CompletionVerificationGate,
} from '../services/completionVerification.js';
import {
  diagnoseRun,
  formatHaltDiagnosisHuman,
  type HaltDiagnosis,
} from '../services/haltDiagnosis.js';
import {
  formatEscalationRecommendationHuman,
  recommendModelEscalation,
} from '../services/modelEscalationRules.js';
import { verifyWorkspaceProject } from '../services/workspaceManager.js';

const TOP_LEVEL_HELP_TEXT = `
Examples:
  $ babel                  # Launches interactive TUI session
  $ babel "Fix failing tests"
  $ babel plan "Split this safely"
  $ babel deep "Harden the migration path"
  $ babel doctor
  $ babel resume latest
  $ babel undo
  $ babel advanced

Command Guide:
  Interactive:  babel                  (or babel interactive / babel app)
  Default:      babel "<task...>"
  Plan:         babel plan "<task...>"
  Deep:         babel deep "<task...>"
  Recovery:     babel resume, babel undo
  Health:       babel doctor, babel inspect
  Advanced:     babel advanced

Notes:
  - Bare babel with no arguments launches the interactive TUI (REPL) session.
  - babel "<task...>" is the default one-shot action path — runs the task and exits.
  - babel plan prepares a plan, asks for approval in the terminal, then applies the approved task.
  - babel deep uses the heavier governed path when you want extra critique and execution rigor.
  - Daily work uses babel "<task>"; babel plan and babel deep cover planning and governed execution.
  - Shorthand is supported: babel <Project> "<task...>" maps to babel run --project <Project> "<task...>"
  - Use "babel advanced" for babel run, audit, benchmark, git, MCP, and inspection surfaces.
`;

export function applyProgramMetadata(program: Command): void {
  program
    .name('babel')
    .description('Babel Multi-Agent OS — local runtime harness for multi-repo workspaces')
    .version('1.0.0')
    .addHelpText('after', TOP_LEVEL_HELP_TEXT);
}

const DEFAULT_HELP_COMMANDS = new Set([
  'setup',
  'doctor',
  'dry',
  'permissions',
  'interactive',
  'plan',
  'deep',
  'undo',
  'resume',
  'inspect',
  'advanced',
]);

const ADVANCED_HELP_GROUPS: Array<[string, string[]]> = [
  ['Primary CLI', ['plan', 'deep', 'resume', 'undo', 'inspect', 'doctor']],
  ['Compatibility', ['do', 'fix', 'ask', 'propose', 'review', 'lite']],
  ['Advanced pipeline', ['run']],
  ['Readiness', ['setup', 'doctor', 'simplify', 'docs', 'dry', 'permissions', 'models']],
  [
    'Evidence',
    ['prove', 'learn', 'evidence', 'inspect', 'session', 'checkpoint', 'diagnose', 'stats'],
  ],
  ['Delivery', ['ship', 'git', 'ci', 'schedule', 'jobs']],
  ['Benchmarks', ['benchmark', 'smoke', 'test']],
  ['Project tools', ['files', 'verify', 'diff', 'repo-map', 'onboard-project', 'create']],
  ['Extensions', ['plugins', 'agents', 'skill', 'codex']],
  [
    'Internals',
    ['internals', 'mcp', 'mode', 'tools', 'events', 'context', 'escalation', 'shadow-diff'],
  ],
];

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find(
    (command) => command.name() === name || command.aliases().includes(name),
  );
}

function formatHelpGroups(
  program: Command,
  title: string,
  groups: Array<[string, string[]]>,
): string {
  const lines = [title, ''];
  for (const [group, names] of groups) {
    lines.push(`${group}:`);
    for (const name of names) {
      const command = findCommand(program, name);
      if (!command) {
        continue;
      }
      const aliases = command.aliases();
      const aliasText = aliases.length > 0 ? ` (${aliases.join(', ')})` : '';
      const description =
        command.name() === 'run'
          ? 'Advanced pipeline lane: explicit modes, audit, output, and tool/model controls'
          : command.name() === 'deep'
            ? 'Heavy governance path: critique, refine, implement, and verify'
            : command.description();
      lines.push(`  ${command.name()}${aliasText} - ${description}`);
    }
    lines.push('');
  }
  lines.push('Tip: run "babel <command> --help" for command-specific options.');
  return lines.join('\n');
}

export function applyUserFocusedHelpTiers(program: Command): void {
  for (const command of program.commands) {
    if (!DEFAULT_HELP_COMMANDS.has(command.name())) {
      (command as unknown as { _hidden: boolean })._hidden = true;
    }
  }

  program
    .command('advanced')
    .description('Show advanced Babel command groups')
    .addHelpText(
      'after',
      `
Notes:
  - Prefer babel "<task>", babel plan, and babel deep for daily work.
  - babel run is for explicit pipeline modes, audit flags, JSON event streams, and governed controls.
  - Prefer babel "<task>", babel plan, and babel deep before advanced run flags.
  - Internal pipeline mode names stay under "babel run --help".
`,
    )
    .action(() => {
      console.log(formatHelpGroups(program, 'Babel Advanced Commands', ADVANCED_HELP_GROUPS));
    });

  const internalsCommand = program
    .command('internals')
    .description('Show internal command groups')
    .action(() => {
      console.log(
        formatHelpGroups(program, 'Babel Internal Commands', [
          ['Control plane', ['mcp', 'mode', 'tools', 'events', 'context']],
          ['Runtime evidence', ['inspect', 'session', 'checkpoint', 'stats', 'diagnose']],
          ['Automation', ['agents', 'plugins', 'schedule', 'jobs', 'approvals', 'escalation']],
          ['Legacy compatibility', ['resume', 'apply', 'smoke', 'test', 'shadow-diff']],
          ['Text provider lane', ['text-provider']],
        ]),
      );
    });
  (internalsCommand as unknown as { _hidden: boolean })._hidden = true;

  registerInternalTextProviderCommands(program);
}

function exitWithRuntimeValidationFailure(message: string, jsonOutput: boolean): never {
  if (jsonOutput) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'fail',
          error: message,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    console.error(`Environment check failed:\n${message}`);
  }

  process.exit(1);
}

export function validateRuntimeEnvForCommand(options: { json?: boolean } = {}): void {
  try {
    validateRuntimeEnv();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithRuntimeValidationFailure(message, options.json === true);
  }
}

export function printBanner(): void {
  const runtimeMode = readRuntimeMode();
  const isDryRun = process.env['BABEL_DRY_RUN'] === 'true';

  const modeTag = runtimeMode === 'plan' ? warning(' [PLANNING]') : '';
  const dryTag = isDryRun ? muted(' [DRY RUN]') : '';

  process.stdout.write(
    renderProductBanner('Multi-Agent OS Runtime Harness', `${modeTag}${dryTag}`) + '\n',
  );
}

function handleDryMode(action: 'status' | 'on' | 'off', options: { json?: boolean }): void {
  try {
    const state =
      action === 'on'
        ? writeDryRunState(true)
        : action === 'off'
          ? writeDryRunState(false)
          : readDryRunState();
    printDryRunState(state, options.json === true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'fail',
            error: message,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(`Error updating dry-run mode: ${message}`);
    }
    process.exit(1);
  }
}

function describePermissionProfile(status: ApprovalProfileStatus): {
  action: string;
  scope: string[];
  cost: string;
  approval: string;
} {
  if (status.profile === 'suggest') {
    return {
      action: 'Babel will explain and plan, but file edits and commands stay simulated.',
      scope: ['read project files', 'draft plans', 'show proposed edits without writing them'],
      cost: 'No local mutation cost. Remote model calls may still use configured provider credits.',
      approval: 'You approve before any real edit or command run.',
    };
  }
  if (status.profile === 'full-auto') {
    return {
      action:
        'Babel may edit files and run checks inside the trusted workspace without repeated prompts.',
      scope: [
        'edit in-scope project files',
        'run local verifiers such as npm test',
        'keep sandbox and provider boundaries active',
      ],
      cost: 'Configured provider calls may use credits; expensive model tiers still require explicit opt-in.',
      approval:
        'Only outside-workspace, network, dependency, or high-cost boundaries should interrupt the flow.',
    };
  }
  return {
    action: 'Babel may edit files and run local checks inside the selected project.',
    scope: [
      'edit in-scope project files',
      'run local verifiers such as npm test',
      'write recovery evidence for failures',
    ],
    cost: 'Configured provider calls may use credits; expensive model tiers still require explicit opt-in.',
    approval: 'Trusted workspace work should not ask redundant approvals.',
  };
}

export function buildApprovalProfilePayload(
  status: ApprovalProfileStatus,
): Record<string, unknown> {
  const userTerms = describePermissionProfile(status);
  return {
    action: userTerms.action,
    scope: userTerms.scope,
    cost: userTerms.cost,
    approval: userTerms.approval,
    profile: status.profile,
    runtimeMode: status.runtimeMode,
    dryRun: status.dryRun,
    profilePath: status.profilePath,
  };
}

function printApprovalProfileStatus(status: ApprovalProfileStatus, json: boolean): void {
  const payload = buildApprovalProfilePayload(status);
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(`What will happen: ${payload['action']}`);
  console.log(`Scope: ${(payload['scope'] as string[]).join('; ')}`);
  console.log(`Cost: ${payload['cost']}`);
  console.log(`Approval: ${payload['approval']}`);
  console.log(`Profile: ${status.profile}`);
  console.log(`Config: ${status.profilePath}`);
  console.log('');
  if (status.profile === 'custom') {
    console.log('Current runtime controls do not exactly match a named approval profile.');
  } else {
    console.log(APPROVAL_PROFILE_DEFINITIONS[status.profile].description);
  }
}

function handlePermissionsCommand(
  profileArg: string | undefined,
  options: { json?: boolean },
): void {
  try {
    if (!profileArg || profileArg.trim().toLowerCase() === 'status') {
      printApprovalProfileStatus(readApprovalProfileStatus(), options.json === true);
      return;
    }

    const profile = parseApprovalProfile(profileArg);
    if (!profile) {
      throw new Error(
        `Invalid approval profile "${profileArg}". Valid values: ${APPROVAL_PROFILES.join(', ')}`,
      );
    }

    printApprovalProfileStatus(writeApprovalProfile(profile), options.json === true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'fail',
            error: message,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(`Error updating permissions: ${message}`);
    }
    process.exit(1);
  }
}

function parseApprovalStatus(value: string | undefined): ApprovalStatus | 'all' {
  const normalized = String(value ?? 'all')
    .trim()
    .toLowerCase();
  if (normalized === 'all' || APPROVAL_STATUSES.includes(normalized as ApprovalStatus)) {
    return normalized as ApprovalStatus | 'all';
  }
  throw new Error(
    `Invalid approval status "${value}". Valid values: all, ${APPROVAL_STATUSES.join(', ')}`,
  );
}

function printApprovalRequestRequired(status: string, record: ApprovalRecord, json: boolean): void {
  const payload = {
    status,
    approval: record,
    next: [`babel approvals approve ${record.id}`, 'Re-run the blocked command after approval.'],
  };
  printJsonOrHuman(
    payload,
    `${formatApprovalHuman(record)}\n\nNext: babel approvals approve ${record.id}`,
    json,
  );
}

function parseValidMode(value: string | undefined, fallback: ValidMode = 'chat'): ValidMode {
  const raw = String(value ?? fallback)
    .trim()
    .toLowerCase();
  const resolved = resolveMode(raw);
  if (resolved.deprecated && resolved.note) {
    process.stderr.write(`[DEPRECATED] ${resolved.note}\n`);
  }
  return resolved.mode;
}

function parseSemicolonCommands(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(';')
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

async function withJobEnv<T>(job: AgentJob, run: () => Promise<T>): Promise<T> {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  const previousAllowedRoots = process.env['BABEL_ALLOWED_ROOTS'];

  process.env['BABEL_EXECUTION_PROFILE'] = job.execution_profile;
  if (job.project_root) {
    process.env['BABEL_PROJECT_ROOT'] = job.project_root;
  }
  if (job.approved_roots.length > 0) {
    process.env['BABEL_ALLOWED_ROOTS'] = job.approved_roots.join(',');
  }

  try {
    return await run();
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    if (previousProjectRoot === undefined) delete process.env['BABEL_PROJECT_ROOT'];
    else process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
    if (previousAllowedRoots === undefined) delete process.env['BABEL_ALLOWED_ROOTS'];
    else process.env['BABEL_ALLOWED_ROOTS'] = previousAllowedRoots;
  }
}

function jobRequiresApproval(job: AgentJob): boolean {
  const approvalState = getAgentJobApprovalState(job);
  return approvalState.pending.length > 0 || approvalState.denied.length > 0;
}

async function runAgentJobNow(jobId: string): Promise<AgentJob> {
  const existing = getAgentJob(jobId);
  if (!existing) {
    throw new Error(`Job not found: ${jobId}`);
  }
  if (existing.status === 'paused') {
    throw new Error(`Job is paused: ${jobId}`);
  }
  if (jobRequiresApproval(existing)) {
    const diagnosis = diagnoseRun({
      approvalRequired: true,
      escalation: existing.escalation,
    });
    return updateAgentJob(existing.id, {
      status: 'waiting_approval',
      diagnosis,
      error: diagnosis.headline,
    });
  }

  const running = updateAgentJob(existing.id, {
    status: 'running',
    error: null,
  });

  try {
    const eventBus = new BabelEventBus();
    const result = await withJobEnv(running, () =>
      runBabelPipeline(running.task, {
        mode: running.mode,
        ...(running.model ? { modelOverride: running.model as never } : {}),
        ...(running.model_tier ? { modelTier: running.model_tier } : {}),
        ...(running.execution_profile
          ? { executionProfile: running.execution_profile as never }
          : {}),
        ...(running.model_tier === 'escalation' ? { allowExpensive: true } : {}),
        eventBus,
      }),
    );

    const verification =
      result.status === 'COMPLETE' && running.project_root
        ? verifyWorkspaceProject(running.project_root, {
            ...(running.verify_commands.length > 0 ? { commands: running.verify_commands } : {}),
          })
        : null;
    const completionGate: CompletionVerificationGate = evaluateCompletionVerification({
      pipelineStatus: result.status,
      executionProfile: running.execution_profile,
      projectRoot: running.project_root,
      verification,
    });
    const diagnosis: HaltDiagnosis = diagnoseRun({
      runDir: result.runDir,
      pipelineStatus: result.status,
      verification: completionGate,
      escalation: running.escalation,
    });
    const status =
      completionGate.status === 'fail'
        ? 'verification_failed'
        : result.status === 'COMPLETE'
          ? 'complete'
          : 'failed';
    const updated = updateAgentJob(running.id, {
      status,
      run_dir: result.runDir,
      pipeline_status: result.status,
      completion_verification: completionGate,
      diagnosis,
      error: status === 'failed' || status === 'verification_failed' ? diagnosis.headline : null,
    });
    return writeAgentJobReport(updated);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnosis = diagnoseRun({
      pipelineStatus: 'FAILED',
      escalation: running.escalation,
    });
    const updated = updateAgentJob(running.id, {
      status: 'failed',
      diagnosis,
      error: message,
    });
    return writeAgentJobReport(updated);
  }
}

async function handleModelsPing(options: {
  model?: string;
  json?: boolean;
  allowExpensive?: boolean;
}): Promise<void> {
  const startedAt = Date.now();
  const requestedModel = options.model?.trim() || 'qwen3-32b';

  try {
    const resolved = resolveModelByKey({
      key: requestedModel,
      allowExpensive: options.allowExpensive === true,
      babelRoot: BABEL_ROOT,
    });
    const runner = new DeepInfraApiRunner(resolved.providerModelId);
    const schema = z.object({ ok: z.literal(true) });
    await runner.execute('Return exactly this JSON object and nothing else: {"ok":true}', schema);
    const metadata = runner.getLastInvocationMetadata();
    const payload = {
      status: 'pass',
      requested_model: requestedModel,
      backend_key: resolved.resolvedBackendKey,
      provider: resolved.provider,
      provider_model_id: resolved.providerModelId,
      latency_ms: metadata?.latency_ms ?? Date.now() - startedAt,
      request_timeout_ms: Number(process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] ?? '120000'),
      request_max_retries: Number(process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] ?? '4'),
      stream_idle_timeout_ms: Number(
        process.env['BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS'] ?? '60000',
      ),
      stream_max_retries: Number(process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] ?? '1'),
    };

    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log(
        `Model ping passed: ${payload.backend_key} (${payload.provider_model_id}) in ${payload.latency_ms}ms`,
      );
    }
  } catch (err: unknown) {
    const payload = {
      status: 'fail',
      requested_model: requestedModel,
      latency_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.error(`Model check failed: ${payload.error}`);
    }
    process.exit(1);
  }
}

function printMcpServers(options: { json?: boolean; status?: boolean }): void {
  const servers = readMcpServers();
  const payload = {
    status: 'ok',
    config_path: getMcpServersConfigPath(),
    count: Object.keys(servers).length,
    servers,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(options.status ? 'MCP registry status:' : 'Configured MCP servers:');
  console.log(`Config: ${payload.config_path}`);
  for (const [name, server] of Object.entries(servers)) {
    console.log(`  ${name.padEnd(16)} ${server.command} ${server.args.join(' ')}`.trimEnd());
  }
}

function printEvidenceStatus(options: { json?: boolean; project?: string }): void {
  const latest = readLatestRunPointer(options.project);
  const payload = {
    status: latest ? 'ok' : 'no_latest_run',
    latest_run: latest,
    commands: [
      'babel doctor --scope all',
      'babel inspect run latest',
      'babel inspect summary --run latest',
    ],
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log('Evidence surfaces:');
  console.log('  doctor          workspace, repo, and export health checks');
  console.log('  inspect run     complete evidence bundle view');
  console.log('  inspect summary concise run summary');
  console.log('  evidence open   implementor run diagnose (W3)');
  console.log('  evidence export portable evidence bundle (W3)');
  console.log('  evidence scorecard  Grok-shadow prove + FP dashboard (W3.3)');
  if (latest) {
    console.log(`\nLatest run: ${latest.run_dir}`);
    console.log(`Project: ${latest.project}`);
  } else {
    console.log('\nNo latest run pointer found yet.');
  }
}

function parseToolList(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function printExecutorToolList(options: {
  json?: boolean;
  policy?: boolean;
  whyDisabled?: boolean;
  capabilities?: boolean;
  executionProfile?: string;
  allowedTools?: string;
  disallowedTools?: string;
}): void {
  const tools = getExecutorToolRegistrySnapshot();
  const showCatalog =
    options.policy === true || options.whyDisabled === true || options.capabilities === true;
  const catalog = showCatalog
    ? buildToolCatalog(tools, {
        executionProfile: options.executionProfile,
        allowedTools: parseToolList(options.allowedTools),
        disallowedTools: parseToolList(options.disallowedTools),
        includeCapabilities: options.capabilities === true,
      })
    : [];

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'ok',
          count: tools.length,
          tools,
          ...(showCatalog
            ? {
                execution_profile:
                  options.executionProfile ?? process.env['BABEL_EXECUTION_PROFILE'] ?? 'safe_repo',
                catalog,
              }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (showCatalog) {
    console.log(formatToolCatalogHuman(catalog));
    return;
  }

  console.log('Executor tool registry:');
  for (const tool of tools) {
    const safety = tool.mutating ? 'mutating' : 'read-only';
    console.log(
      `  ${tool.name.padEnd(16)} ${tool.category.padEnd(12)} ${safety.padEnd(9)} ${tool.description}`,
    );
  }
}

function printExecutorToolInspect(tool: ExecutorToolSnapshot, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: 'ok', tool }, null, 2)}\n`);
    return;
  }

  console.log(`Tool: ${tool.name}`);
  console.log(`  Category: ${tool.category}`);
  console.log(`  Mutating: ${tool.mutating ? 'yes' : 'no'}`);
  console.log(`  Dry run:  ${tool.dryRunBehavior}`);
  console.log(
    `  Required: ${tool.input.required.length > 0 ? tool.input.required.join(', ') : '(none)'}`,
  );
  console.log(
    `  Optional: ${tool.input.optional.length > 0 ? tool.input.optional.join(', ') : '(none)'}`,
  );
  console.log(`  Policy:   ${tool.policyTags.join(', ')}`);
  console.log(`  ${tool.description}`);
}

function handleExecutorToolInspect(
  name: string,
  options: { json?: boolean; policy?: boolean; executionProfile?: string },
): void {
  const tool = getExecutorToolSnapshot(name);
  if (!tool) {
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'not_found',
            tool: name,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      console.error(`Unknown tool "${name}". Run "babel tools list" to see available tools.`);
    }
    process.exit(1);
  }

  if (options.policy === true) {
    const catalogEntry = buildToolCatalog([tool], {
      executionProfile: options.executionProfile,
    })[0];
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ status: 'ok', tool, catalog_entry: catalogEntry }, null, 2)}\n`,
      );
      return;
    }
    console.log(formatToolCatalogHuman(catalogEntry ? [catalogEntry] : []));
    return;
  }

  printExecutorToolInspect(tool, options.json === true);
}

interface SessionSummary {
  run_dir: string;
  run_id: string;
  project: string | null;
  task: string | null;
  status: string | null;
  updated_at: string | null;
}

function safeReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getStringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSessionSummary(runDir: string): SessionSummary {
  const manifest = safeReadJson(join(runDir, '01_manifest.json'));
  const runtimeTelemetry = safeReadJson(join(runDir, '06_runtime_telemetry.json'));
  const executionReport = safeReadJson(join(runDir, '04_execution_report.json'));
  const stats = existsSync(runDir) ? statSync(runDir) : null;

  return {
    run_dir: runDir,
    run_id: basename(runDir),
    project: getStringField(manifest, 'target_project'),
    task: getStringField(manifest, 'task_summary') ?? getStringField(manifest, 'user_request'),
    status:
      getStringField(runtimeTelemetry, 'final_outcome') ??
      getStringField(executionReport, 'status'),
    updated_at: stats ? stats.mtime.toISOString() : null,
  };
}

function listSessionSummaries(options: { project?: string; limit?: number }): SessionSummary[] {
  if (!existsSync(BABEL_RUNS_DIR)) {
    return [];
  }

  return readdirSync(BABEL_RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(BABEL_RUNS_DIR, entry.name))
    .filter((runDir) => existsSync(join(runDir, '01_manifest.json')))
    .map(readSessionSummary)
    .sort((left, right) =>
      String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? '')),
    )
    .filter((summary) => !options.project || summary.project === options.project)
    .slice(0, options.limit ?? 10);
}

function printSessionSummary(summary: SessionSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: 'ok', session: summary }, null, 2)}\n`);
    return;
  }

  console.log('Latest Babel session:');
  console.log(`  Run:     ${summary.run_dir}`);
  console.log(`  Project: ${summary.project ?? '(unknown)'}`);
  console.log(`  Status:  ${summary.status ?? '(unknown)'}`);
  console.log(`  Task:    ${summary.task ?? '(unknown)'}`);
}

function printSessionList(sessions: SessionSummary[], json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: 'ok', count: sessions.length, sessions }, null, 2)}\n`,
    );
    return;
  }

  if (sessions.length === 0) {
    console.log('No Babel sessions found.');
    return;
  }

  console.log('Recent Babel sessions:');
  for (const session of sessions) {
    console.log(`  ${session.run_id}`);
    console.log(`    Project: ${session.project ?? '(unknown)'}`);
    console.log(`    Status:  ${session.status ?? '(unknown)'}`);
    console.log(`    Run:     ${session.run_dir}`);
  }
}

function addDryModeOptions(command: Command): Command {
  return command.option('--json', 'Emit structured JSON only');
}

function addInspectCommonOptions(command: Command): Command {
  return command
    .option('--run <run>', 'Run directory or latest')
    .option('--project <name>', 'Filter latest run pointer by project');
}

function renderInspectView(
  kind: 'run' | 'summary' | 'stack' | 'manifest' | 'outcome',
  runDir: string,
): string {
  const bundle = loadInspectBundle(runDir);
  switch (kind) {
    case 'run':
      return renderInspectRun(buildInspectRunView(bundle));
    case 'summary':
      return renderInspectSummary(buildInspectSummaryView(bundle));
    case 'stack':
      return renderInspectStack(buildInspectStackView(bundle));
    case 'manifest':
      return renderInspectManifest(buildInspectManifestView(bundle));
    case 'outcome':
      return renderInspectOutcome(buildInspectOutcomeView(bundle));
  }
}

function handleInspectMode(
  kind: 'run' | 'summary' | 'stack' | 'manifest' | 'outcome',
  runArg: string | undefined,
  options: { run?: string; project?: string },
): void {
  try {
    const resolvedRunDir = resolveInspectRunDir({
      run: options.run ?? runArg,
      project: options.project,
      babelRunsDir: BABEL_RUNS_DIR,
    });
    process.stdout.write(`${renderInspectView(kind, resolvedRunDir)}\n`);
  } catch (err: unknown) {
    console.error(`Error during inspection: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function resolveProofRunArg(
  runArg: string | undefined,
  options: { last?: boolean; run?: string },
): string {
  if (options.last === true) {
    return 'latest';
  }
  return options.run ?? runArg ?? 'latest';
}

function resolveProofRunDir(
  runArg: string | undefined,
  options: { last?: boolean; run?: string; project?: string },
): string {
  const requested = resolveProofRunArg(runArg, options);
  const resolved = resolveInspectRunDir({
    run: requested,
    project: options.project,
    babelRunsDir: BABEL_RUNS_DIR,
  });
  if (existsSync(resolved)) {
    return resolved;
  }
  if (!requested.includes('/') && !requested.includes('\\')) {
    const runIdCandidate = join(BABEL_RUNS_DIR, requested);
    if (existsSync(runIdCandidate)) {
      return runIdCandidate;
    }
  }
  return resolved;
}

function handleProofReport(
  runArg: string | undefined,
  options: { run?: string; project?: string; last?: boolean; json?: boolean },
): void {
  try {
    const resolvedRunDir = resolveProofRunDir(runArg, options);
    const artifacts = writeProofArtifacts(resolvedRunDir);
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'ok',
            proof_status_path: artifacts.proofStatusPath,
            report_path: artifacts.reportPath,
            proof: artifacts.proof,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(`${formatProofStatusHuman(artifacts.proof)}\n`);
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

function handleLearnFromRun(
  runArg: string | undefined,
  options: {
    run?: string;
    project?: string;
    last?: boolean;
    json?: boolean;
    learningRoot?: string;
  },
): void {
  try {
    const resolvedRunDir = resolveProofRunDir(runArg, options);
    const proofArtifacts = writeProofArtifacts(resolvedRunDir);
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, 'learning');
    const learningArtifacts = writeLearningFailureRecord({
      runDir: resolvedRunDir,
      learningRoot,
      proof: proofArtifacts.proof,
    });
    const payload = {
      status: 'ok',
      learning_root: learningRoot,
      failure_record_path: learningArtifacts.failureRecordPath,
      proof_status_path: proofArtifacts.proofStatusPath,
      report_path: proofArtifacts.reportPath,
      failure: learningArtifacts.record,
    };
    printJsonOrHuman(
      payload,
      formatLearningFailureHuman(learningArtifacts.record),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

function handleLearnInspect(
  artifactId: string,
  options: { json?: boolean; learningRoot?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, 'learning');
    const result = readLearningArtifact({
      id: artifactId,
      learningRoot,
    });
    const artifact = result.artifact;
    const payload =
      artifact.kind === 'failure'
        ? {
            status: 'ok',
            learning_root: learningRoot,
            artifact_type: 'failure',
            artifact_path: artifact.path,
            failure: artifact.record,
          }
        : artifact.kind === 'lesson'
          ? {
              status: 'ok',
              learning_root: learningRoot,
              artifact_type: 'lesson',
              artifact_path: artifact.path,
              lesson: artifact.record,
            }
          : artifact.kind === 'eval'
            ? {
                status: 'ok',
                learning_root: learningRoot,
                artifact_type: 'eval',
                artifact_path: artifact.path,
                eval: artifact.record,
              }
            : {
                status: 'ok',
                learning_root: learningRoot,
                artifact_type: 'mutation',
                artifact_path: artifact.path,
                mutation: artifact.record,
              };
    const human =
      artifact.kind === 'failure'
        ? formatLearningFailureHuman(artifact.record)
        : artifact.kind === 'lesson'
          ? formatLessonCandidateHuman(artifact.record)
          : artifact.kind === 'eval'
            ? formatLessonEvalHuman(artifact.record)
            : formatMutationPackageHuman(artifact.record);
    printJsonOrHuman(payload, human, options.json === true);
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

function handleLearnPropose(
  failureId: string,
  options: { json?: boolean; learningRoot?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, 'learning');
    const result = writeLessonCandidate({
      failureId,
      learningRoot,
    });
    const payload = {
      status: 'ok',
      learning_root: learningRoot,
      lesson_candidate_path: result.lessonCandidatePath,
      lesson: result.lesson,
    };
    printJsonOrHuman(payload, formatLessonCandidateHuman(result.lesson), options.json === true);
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

function handleLearnTest(
  lessonId: string,
  options: { json?: boolean; learningRoot?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, 'learning');
    const result = testLessonCandidate({
      lessonId,
      learningRoot,
    });
    const payload = {
      status: result.evalRecord.status,
      learning_root: learningRoot,
      eval_record_path: result.evalRecordPath,
      eval: result.evalRecord,
    };
    printJsonOrHuman(payload, formatLessonEvalHuman(result.evalRecord), options.json === true);
    if (result.evalRecord.status !== 'passed') {
      process.exit(1);
    }
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

function handleLearnPromote(
  lessonId: string,
  options: { json?: boolean; learningRoot?: string; shadow?: boolean },
): void {
  try {
    if (options.shadow !== true) {
      throw new Error('Only shadow promotion is supported. Re-run with --shadow.');
    }
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, 'learning');
    const result = promoteLessonToShadow({
      lessonId,
      learningRoot,
    });
    const payload = {
      status: 'ok',
      learning_root: learningRoot,
      active_lesson_path: result.activeLessonPath,
      lesson: result.lesson,
    };
    printJsonOrHuman(payload, formatLessonCandidateHuman(result.lesson), options.json === true);
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

function handleLearnPackage(
  lessonId: string,
  options: { json?: boolean; learningRoot?: string; target?: string },
): void {
  try {
    const learningRoot = options.learningRoot
      ? resolve(options.learningRoot)
      : join(BABEL_ROOT, 'learning');
    const target = options.target ?? 'project-verifier-contract';
    const result = generateMutationPackage({
      lessonId,
      learningRoot,
      target,
      repoRoot: BABEL_ROOT,
    });
    const payload = {
      status: 'ok',
      learning_root: learningRoot,
      mutation_package_dir: result.mutationPackageDir,
      mutation_package_path: result.mutationPackagePath,
      mutation: result.mutationPackage,
    };
    printJsonOrHuman(
      payload,
      formatMutationPackageHuman(result.mutationPackage),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

class ActionableCommandError extends Error {
  readonly payload: Record<string, unknown>;
  readonly human: string;

  constructor(message: string, payload: Record<string, unknown>, human: string) {
    super(message);
    this.name = 'ActionableCommandError';
    this.payload = payload;
    this.human = human;
  }
}

function printActionableErrorAndExit(error: ActionableCommandError, json: boolean): never {
  printJsonOrHuman(error.payload, error.human, json);
  process.exit(1);
}

function printCommandErrorAndExit(error: unknown, json: boolean): never {
  if (error instanceof ActionableCommandError) {
    printActionableErrorAndExit(error, json);
  }
  printJsonErrorAndExit(error instanceof Error ? error.message : String(error), json);
}

function resolveRunForReadOnlyCommand(
  run: string | undefined,
  project: string | undefined,
): string {
  return resolveInspectRunDir({
    run: run ?? 'latest',
    project,
    babelRunsDir: BABEL_RUNS_DIR,
  });
}

function printSetupChecklist(options: { json?: boolean }): void {
  const payload = {
    status: 'ok',
    kind: 'first_five_minutes',
    first_five_minutes: [
      {
        step: 'install_dependencies',
        command: 'npm --prefix .\\babel-cli ci',
      },
      {
        step: 'build_cli',
        command: 'npm --prefix .\\babel-cli run build',
      },
      {
        step: 'diagnose_workspace',
        command: 'node .\\babel-cli\\dist\\index.js doctor --json',
      },
      {
        step: 'safe_context_probe',
        command: 'node .\\babel-cli\\dist\\index.js context preview @file README.md --json',
      },
      {
        step: 'terminal_daily_profile',
        command: 'set BABEL_DAILY_PROFILE=terminal',
        note: 'Keeps daily CLI tasks on lite lanes unless you explicitly use babel deep or repo-wide risk applies.',
      },
    ],
    next_command: 'node .\\babel-cli\\dist\\index.js context preview @file README.md --json',
    mutates_workspace: false,
    remote_side_effects: false,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log('Babel first five minutes');
  for (const item of payload.first_five_minutes) {
    const note = 'note' in item && typeof item.note === 'string' ? ` — ${item.note}` : '';
    console.log(`  ${item.step}: ${item.command}${note}`);
  }
}

function printSessionResume(
  runArg: string | undefined,
  options: { project?: string; json?: boolean },
): void {
  try {
    const runDir = resolveRunForReadOnlyCommand(runArg, options.project);
    const sessionSummary = readSessionSummary(runDir);
    const context = readExecutorSessionContext(runDir);
    const payload = {
      status: 'ok',
      run_dir: runDir,
      session: sessionSummary,
      model_context: summarizeExecutorSessionContext(context),
      context_drift: context?.context_fingerprint
        ? detectContextFingerprintDrift(
            context.context_fingerprint,
            context.model_context.next_turn_prompt,
          )
        : null,
      recovery_commands: [
        `babel inspect run ${runDir}`,
        `babel checkpoint list --run ${runDir} --json`,
        `babel session resume ${runDir} --json`,
      ],
    };
    const humanLines = [
      'Babel Session Resume',
      `Run: ${runDir}`,
      `Status: ${sessionSummary.status ?? 'unknown'}`,
      `Model context: ${payload.model_context.available ? 'available' : 'not available'}`,
    ];
    if (payload.context_drift) {
      humanLines.push(`Context fingerprint: ${payload.context_drift.message}`);
    }
    printJsonOrHuman(
      payload,
      humanLines.join('\n'),
      options.json === true,
    );
  } catch (err: unknown) {
    printJsonErrorAndExit(err instanceof Error ? err.message : String(err), options.json === true);
  }
}

export function registerCoreCommands(program: Command): void {
  program.option('--experimental', 'Enable experimental features (daemon, goal loop)');

  program
    .command('resolve')
    .description(
      'Resolve a Babel Local Mode instruction stack using the canonical TypeScript resolver',
    )
    .option(
      '--task-category <category>',
      'Task category: frontend | backend | compliance | devops | research | mobile | game',
      'frontend',
    )
    .option('--project <project>', 'Project overlay target', 'global')
    .option('--project-path <path>', 'Concrete project path for repo-local context detection')
    .option('--model <model>', 'Model family: codex | claude | gemini', 'codex')
    .option('--client-surface <surface>', 'Client surface identifier')
    .option('--pipeline-mode <mode>', 'Pipeline mode: chat | chat-headless | plan | deep', 'chat')
    .option(
      '--codex-adapter <adapter>',
      'Codex adapter preference: auto | balanced | ultra',
      'auto',
    )
    .option('--task-overlay-id <id...>', 'Additional task overlay id or alias')
    .option('--task-prompt <prompt>', 'Task prompt used for purpose and skill inference')
    .option(
      '--purpose-mode <mode>',
      'Purpose mode: execution | verification | learning | exploration | audit',
    )
    .option('--disable-recommended-task-overlays', 'Disable automatic task overlay recommendations')
    .option('--load-all-skills', 'Emergency/debug override: load every active skill')
    .option('--local-learning-root <path>', 'Local learning root for active policies')
    .option('--babel-root <path>', 'Babel repository root', BABEL_ROOT)
    .option('--json', 'Emit structured JSON only')
    .action(
      (options: {
        taskCategory?: string;
        project?: string;
        projectPath?: string;
        model?: string;
        clientSurface?: string;
        pipelineMode?: string;
        codexAdapter?: string;
        taskOverlayId?: string[];
        taskPrompt?: string;
        purposeMode?: string;
        disableRecommendedTaskOverlays?: boolean;
        loadAllSkills?: boolean;
        localLearningRoot?: string;
        babelRoot?: string;
        json?: boolean;
      }) => {
        try {
          const result = resolveLocalStack({
            taskCategory: (options.taskCategory ?? 'frontend') as LocalTaskCategory,
            project: (options.project ?? 'global') as LocalProject,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
            model: (options.model ?? 'codex') as LocalModel,
            ...(options.clientSurface ? { clientSurface: options.clientSurface } : {}),
            pipelineMode: (options.pipelineMode ?? 'chat') as LocalPipelineMode,
            codexAdapter: (options.codexAdapter ?? 'auto') as LocalCodexAdapter,
            taskOverlayIds: options.taskOverlayId ?? [],
            ...(options.taskPrompt ? { taskPrompt: options.taskPrompt } : {}),
            ...(options.purposeMode ? { purposeMode: options.purposeMode as never } : {}),
            disableRecommendedTaskOverlays: options.disableRecommendedTaskOverlays === true,
            loadAllSkills: options.loadAllSkills === true,
            ...(options.localLearningRoot ? { localLearningRoot: options.localLearningRoot } : {}),
            babelRoot: resolve(options.babelRoot ?? BABEL_ROOT),
          });
          printJsonOrHuman(result, formatLocalStackResolveHuman(result), options.json === true);
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  program
    .command('setup')
    .description('Show the read-only first-five-minutes setup checklist')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      printSetupChecklist(options);
    });

  program
    .command('mode')
    .description('View or set the current runtime mode (plan or act)')
    .argument('[newMode]', 'Target mode: "plan" or "act"')
    .action((newMode) => {
      if (!newMode) {
        const current = readRuntimeMode();
        console.log(`Current runtime mode: ${current.toUpperCase()}`);
        return;
      }

      if (newMode !== 'plan' && newMode !== 'act') {
        console.error('Error: Mode must be "plan" or "act"');
        process.exit(1);
      }

      writeRuntimeMode(newMode);
      console.log(`Runtime mode updated to: ${newMode.toUpperCase()}`);
    });

  program
    .command('doctor')
    .description('Everyday diagnostic: run Babel workspace health and integrity checks')
    .option('--json', 'Emit structured JSON only')
    .option('--strict', 'Treat warnings as fatal in the overall result')
    .option('--strict-enterprise', 'Require explicit managed enterprise policy controls')
    .option('--verbose', 'Include additional diagnostic details')
    .option('--repair-pointers', 'Remove stale runs/.latest*.json pointers before evidence checks')
    .option(
      '--scope <scope>',
      'Check scope: all | env | workspace | repos | export | enterprise',
      'all',
    )
    .option('--skills', 'Run Skill Forge checks')
    .addHelpText(
      'after',
      `
Examples:
  $ babel doctor
  $ babel doctor --scope env --json --verbose
  $ babel doctor --scope repos
  $ babel doctor --scope enterprise --strict-enterprise
  $ babel doctor --scope export --strict
  $ babel doctor --json
`,
    )
    .action(
      async (options: {
        json?: boolean;
        strict?: boolean;
        strictEnterprise?: boolean;
        verbose?: boolean;
        repairPointers?: boolean;
        scope?: string;
        skills?: boolean;
      }) => {
        validateRuntimeEnvForCommand({ json: options.json === true });

        if (options.skills === true) {
          const report = runSkillDoctor(BABEL_ROOT);
          printJsonOrHuman(report, formatSkillDoctorHuman(report), options.json === true);
          if (report.status === 'fail') {
            process.exit(1);
          }
          return;
        }

        const scope = (options.scope ?? 'all') as DoctorScope;
        if (!['all', 'env', 'workspace', 'repos', 'export', 'enterprise'].includes(scope)) {
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  status: 'fail',
                  error: `[babel] Invalid doctor scope "${options.scope}". Valid values: all, env, workspace, repos, export, enterprise`,
                },
                null,
                2,
              )}\n`,
            );
          } else {
            console.error(
              `[babel] Invalid doctor scope "${options.scope}". Valid values: all, env, workspace, repos, export, enterprise`,
            );
          }
          process.exit(1);
        }

        try {
          const result = await runDoctor({
            babelRoot: BABEL_ROOT,
            strict: options.strict === true,
            strictEnterprise: options.strictEnterprise === true,
            verbose: options.verbose === true,
            repairPointers: options.repairPointers === true,
            scope,
          });

          if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            console.log(formatDoctorHuman(result, options.verbose === true));
          }

          if (result.status === 'fail') {
            process.exit(1);
          }
        } catch (err: unknown) {
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  status: 'fail',
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2,
              )}\n`,
            );
          } else {
            console.error(
              `Doctor check failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          process.exit(1);
        }
      },
    );

  registerMaintenanceCommands(program);

  registerSkillCommands(program);

  program
    .command('shadow-diff')
    .description('Compare the current dry-run shadow root with the live project')
    .option(
      '-p, --project <name>',
      'Target project (example_saas_backend | example_llm_router | AuditGuard | example_mobile_suite | example_game_suite | godot_td)',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ babel shadow-diff
  $ babel shadow-diff --project example_saas_backend

Notes:
  - Requires BABEL_SHADOW_ROOT to be set.
  - Uses "git diff --no-index" to compare the directories.
`,
    )
    .action(async (options: { project?: string }) => {
      let projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();

      if (options.project) {
        const resolved = resolveProjectRoot(options.project);
        if (resolved) {
          projectRoot = resolved;
        } else {
          console.warn(
            `Could not find project "${options.project}". Using the current directory instead.`,
          );
        }
      }

      const shadowRoot = process.env['BABEL_SHADOW_ROOT'];

      if (!shadowRoot) {
        console.error('Dry-run shadowing is not active. Run "babel dry on" to enable it.');
        process.exit(1);
      }

      const result = getShadowDiff(shadowRoot, projectRoot);
      if (result.status === 'error') {
        console.error(`Could not compare file differences: ${result.error}`);
        process.exit(1);
      }

      if (result.diff) {
        process.stdout.write(result.diff + '\n');
      }
    });

  const dryCommand = program
    .command('dry')
    .description('Everyday safety toggle: control persisted dry-run mode for the local CLI')
    .addHelpText(
      'after',
      `
Examples:
  $ babel dry status --json
  $ babel dry on
  $ babel dry off --json

Notes:
  - Dry mode ON keeps mutating tools in dry-run mode.
  - Dry mode OFF enables live mutating tools, but they still run through Babel sandbox protections.
`,
    )
    .action(async () => {
      handleDryMode('status', {});
    });

  addDryModeOptions(
    dryCommand
      .command('status')
      .description('Show current dry-run mode state')
      .action(async (options: { json?: boolean }) => {
        handleDryMode('status', options);
      }),
  );

  addDryModeOptions(
    dryCommand
      .command('on')
      .description('Persist dry-run mode as on')
      .action(async (options: { json?: boolean }) => {
        handleDryMode('on', options);
      }),
  );

  addDryModeOptions(
    dryCommand
      .command('off')
      .description('Persist dry-run mode as off')
      .action(async (options: { json?: boolean }) => {
        handleDryMode('off', options);
      }),
  );

  program
    .command('permissions')
    .description('View or set approval/autonomy profile (suggest | auto-edit | full-auto)')
    .argument('[profile]', 'Approval profile: status | suggest | auto-edit | full-auto')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel permissions
  $ babel permissions suggest
  $ babel permissions auto-edit --json

Notes:
  - suggest maps to plan mode plus dry-run.
  - auto-edit maps to act mode with live sandboxed edits.
  - full-auto keeps sandbox/policy gates but records the highest-autonomy intent.
`,
    )
    .action((profileArg: string | undefined, options: { json?: boolean }) => {
      handlePermissionsCommand(profileArg, options);
    });

  const approvalsCommand = program
    .command('approvals')
    .description(
      'Manage approval requests for installs, unattended jobs, and expensive model escalation',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ babel approvals list --json
  $ babel approvals approve dep-abc123 --json
  $ babel approvals deny model-abc123
  $ babel approvals request-install --command "npm install" --project-root /tmp/scratch\\hello-cli --json

Notes:
  - OpenClaw manager creates pending install approvals automatically when blocked.
  - Interactive model flags approve that one run; queued model approvals are for unattended or repeated escalation.
  - Approved requests expire by default after 24 hours.
`,
    )
    .action(() => {
      const records = listApprovals({ status: 'pending' });
      process.stdout.write(`${formatApprovalListHuman(records)}\n`);
    });

  approvalsCommand
    .command('list')
    .description('List approval requests')
    .option('--status <status>', `Filter: all | ${APPROVAL_STATUSES.join(' | ')}`, 'all')
    .option('--json', 'Emit structured JSON only')
    .action((options: { status?: string; json?: boolean }) => {
      try {
        const status = parseApprovalStatus(options.status);
        const records = listApprovals({ status });
        printJsonOrHuman(
          { status: 'ok', count: records.length, approvals: records },
          formatApprovalListHuman(records),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  approvalsCommand
    .command('inspect')
    .description('Inspect one approval request')
    .argument('<id>', 'Approval id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      const record = inspectApproval(id);
      if (!record) {
        printJsonErrorAndExit(`Approval request not found: ${id}`, options.json === true);
      }
      printJsonOrHuman(
        { status: 'ok', approval: record },
        formatApprovalHuman(record),
        options.json === true,
      );
    });

  approvalsCommand
    .command('approve')
    .description('Approve a pending request')
    .argument('<id>', 'Approval id')
    .option('--ttl-hours <hours>', 'Hours before the approval expires', '24')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { ttlHours?: string; json?: boolean }) => {
      try {
        const ttlHours = Number.parseInt(options.ttlHours ?? '24', 10);
        if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
          throw new Error('--ttl-hours must be a positive integer.');
        }
        const record = approveApproval(id, { ttlHours });
        printJsonOrHuman(
          { status: 'ok', approval: record },
          formatApprovalHuman(record),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  approvalsCommand
    .command('deny')
    .description('Deny a pending request')
    .argument('<id>', 'Approval id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      try {
        const record = denyApproval(id);
        printJsonOrHuman(
          { status: 'ok', approval: record },
          formatApprovalHuman(record),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  approvalsCommand
    .command('request-install')
    .description('Create or reuse a dependency-install approval request')
    .requiredOption(
      '--command <command>',
      'Exact install command to approve, such as "npm install"',
    )
    .option('--project-root <path>', 'Project root scope')
    .option('--execution-profile <profile>', 'Execution profile scope', 'opencalw_manager')
    .option('--json', 'Emit structured JSON only')
    .action(
      (options: {
        command?: string;
        projectRoot?: string;
        executionProfile?: string;
        json?: boolean;
      }) => {
        try {
          const request = requestDependencyInstallApproval({
            command: options.command ?? '',
            projectRoot: options.projectRoot ?? null,
            executionProfile: options.executionProfile ?? 'opencalw_manager',
          });
          printApprovalRequestRequired(
            request.created ? 'approval_requested' : 'approval_existing',
            request.record,
            options.json === true,
          );
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  approvalsCommand
    .command('request-escalation')
    .description('Create or reuse a model-escalation approval request')
    .requiredOption('--task <task>', 'Exact task text that will be re-run after approval')
    .option('--model <model>', 'Requested model family or backend')
    .option('--model-tier <tier>', 'Requested model tier', 'escalation')
    .option('--project-root <path>', 'Project root scope')
    .option('--json', 'Emit structured JSON only')
    .action(
      (options: {
        task?: string;
        model?: string;
        modelTier?: string;
        projectRoot?: string;
        json?: boolean;
      }) => {
        try {
          const request = requestModelEscalationApproval({
            task: options.task ?? '',
            model: options.model ?? null,
            modelTier: options.modelTier ?? 'escalation',
            projectRoot: options.projectRoot ?? null,
          });
          printApprovalRequestRequired(
            request.created ? 'approval_requested' : 'approval_existing',
            request.record,
            options.json === true,
          );
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  const jobsCommand = program
    .command('jobs')
    .description('Manage unattended OpenClaw/Babel workspace jobs')
    .addHelpText(
      'after',
      `
Examples:
  $ babel jobs create "Fix tests" --project-root /tmp/scratch\\hello-cli --json
  $ babel jobs list --json
  $ babel jobs status job-20260428T010000Z --json
  $ babel jobs approve job-20260428T010000Z --json
  $ babel jobs run job-20260428T010000Z --json
  $ babel jobs report job-20260428T010000Z

Notes:
  - Jobs default to execution profile opencalw_manager.
  - Hard-task escalation rules create exact approval requests before expensive model use.
  - Completed OpenClaw manager jobs must pass local verification before they are marked complete.
`,
    )
    .action(() => {
      const payload = listAgentJobs();
      process.stdout.write(`${formatAgentJobListHuman(payload)}\n`);
    });

  jobsCommand
    .command('create')
    .description('Create a resumable OpenClaw/Babel job')
    .argument('<task...>', 'Task prompt')
    .option('--id <id>', 'Stable job id')
    .option('--project-root <path>', 'Approved project root')
    .option('--execution-profile <profile>', 'Execution profile', 'opencalw_manager')
    .option('--mode <mode>', `Pipeline mode: ${VALID_MODES.join(' | ')}`, 'chat')
    .option('--model <model>', 'Optional model family override')
    .option('--model-tier <tier>', 'Optional model tier override')
    .option('--verify <commands>', 'Semicolon-separated verification commands')
    .option('--no-auto-escalate', 'Do not create escalation approvals from hard-task rules')
    .option('--json', 'Emit structured JSON only')
    .action(
      (
        taskParts: string[],
        options: {
          id?: string;
          projectRoot?: string;
          executionProfile?: string;
          mode?: string;
          model?: string;
          modelTier?: string;
          verify?: string;
          autoEscalate?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const job = createAgentJob({
            ...(options.id ? { id: options.id } : {}),
            task: taskParts.join(' '),
            mode: parseValidMode(options.mode),
            executionProfile: options.executionProfile ?? 'opencalw_manager',
            ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.modelTier ? { modelTier: options.modelTier } : {}),
            verifyCommands: parseSemicolonCommands(options.verify),
            autoEscalate: options.autoEscalate !== false,
          });
          printJsonOrHuman({ status: 'ok', job }, formatAgentJobHuman(job), options.json === true);
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  jobsCommand
    .command('list')
    .description('List jobs')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const payload = listAgentJobs();
      printJsonOrHuman(
        { status: 'ok', ...payload },
        formatAgentJobListHuman(payload),
        options.json === true,
      );
    });

  jobsCommand
    .command('status')
    .description('Inspect one job')
    .argument('<id>', 'Job id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      const job = getAgentJob(id);
      if (!job) {
        printJsonErrorAndExit(`Job not found: ${id}`, options.json === true);
      }
      printJsonOrHuman({ status: 'ok', job }, formatAgentJobHuman(job), options.json === true);
    });

  jobsCommand
    .command('approve')
    .description('Approve all pending approvals for a job')
    .argument('<id>', 'Job id')
    .option('--ttl-hours <hours>', 'Hours before approvals expire', '24')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { ttlHours?: string; json?: boolean }) => {
      try {
        const ttlHours = Number.parseInt(options.ttlHours ?? '24', 10);
        if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
          throw new Error('--ttl-hours must be a positive integer.');
        }
        const result = approveAgentJob(id, { ttlHours });
        printJsonOrHuman(
          { status: 'ok', job: result.job, approvals: result.approvals },
          `${formatAgentJobHuman(result.job)}\n\nApproved: ${result.approvals.map((record) => record.id).join(', ') || '(none)'}`,
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  jobsCommand
    .command('pause')
    .description('Pause a queued job')
    .argument('<id>', 'Job id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      try {
        const job = pauseAgentJob(id);
        printJsonOrHuman({ status: 'ok', job }, formatAgentJobHuman(job), options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  jobsCommand
    .command('resume')
    .description('Return a paused or approval-satisfied job to queued state')
    .argument('<id>', 'Job id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      try {
        const job = resumeAgentJob(id);
        printJsonOrHuman({ status: 'ok', job }, formatAgentJobHuman(job), options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  jobsCommand
    .command('run')
    .description('Run or resume one job now')
    .argument('<id>', 'Job id')
    .option('--json', 'Emit structured JSON only')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const job = await runAgentJobNow(id);
        printJsonOrHuman(
          { status: job.status, job },
          formatAgentJobHuman(job),
          options.json === true,
        );
        if (job.status !== 'complete') {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  jobsCommand
    .command('report')
    .description('Write and print a job report')
    .argument('<id>', 'Job id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      try {
        const job = getAgentJob(id);
        if (!job) {
          throw new Error(`Job not found: ${id}`);
        }
        const reported = writeAgentJobReport(job);
        printJsonOrHuman(
          { status: 'ok', job: reported },
          formatAgentJobHuman(reported),
          options.json === true,
        );
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  const escalationCommand = program
    .command('escalation')
    .description('Inspect model escalation routing recommendations')
    .action(() => {
      escalationCommand.help({ error: false });
    });

  escalationCommand
    .command('recommend')
    .description('Explain whether a task should use the escalation tier')
    .argument('<task...>', 'Task text')
    .option('--json', 'Emit structured JSON only')
    .action((taskParts: string[], options: { json?: boolean }) => {
      const task = taskParts.join(' ');
      const recommendation = recommendModelEscalation({ task });
      printJsonOrHuman(
        { status: 'ok', recommendation },
        formatEscalationRecommendationHuman(recommendation),
        options.json === true,
      );
    });

  const diagnoseCommand = program
    .command('diagnose')
    .description('Diagnose Babel run/job halts and next actions')
    .action(() => {
      diagnoseCommand.help({ error: false });
    });

  diagnoseCommand
    .command('run')
    .description('Diagnose a run directory')
    .argument('<run>', 'Run directory')
    .option('--json', 'Emit structured JSON only')
    .action((runDir: string, options: { json?: boolean }) => {
      const diagnosis = diagnoseRun({ runDir });
      printJsonOrHuman(
        { status: 'ok', diagnosis },
        formatHaltDiagnosisHuman(diagnosis),
        options.json === true,
      );
    });

  diagnoseCommand
    .command('job')
    .description('Diagnose a job')
    .argument('<id>', 'Job id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      const job = getAgentJob(id);
      if (!job) {
        printJsonErrorAndExit(`Job not found: ${id}`, options.json === true);
      }
      const diagnosis =
        job.diagnosis ??
        diagnoseRun({
          runDir: job.run_dir,
          pipelineStatus: job.pipeline_status,
          approvalRequired: job.status === 'waiting_approval',
          verification: job.completion_verification,
          escalation: job.escalation,
        });
      printJsonOrHuman(
        { status: 'ok', diagnosis },
        formatHaltDiagnosisHuman(diagnosis),
        options.json === true,
      );
    });

  const modelsCommand = program
    .command('models')
    .description('Inspect and ping configured model backends')
    .addHelpText(
      'after',
      `
Examples:
  $ babel models ping
  $ babel models ping --model qwen3-32b --json

Notes:
  - Ping validates the configured key, policy route, provider reachability, and JSON response parsing.
  - Disabled or policy-blocked models fail before making a provider request.
`,
    )
    .action(() => {
      modelsCommand.help();
    });

  modelsCommand
    .command('ping')
    .description('Ping one configured model backend with a tiny JSON request')
    .option('--model <key>', 'Model backend key to ping', 'qwen3-32b')
    .option('--allow-expensive', 'Approve an expensive or policy-blocked backend for this run')
    .option('--json', 'Emit structured JSON only')
    .action(async (options: { model?: string; json?: boolean; allowExpensive?: boolean }) => {
      validateRuntimeEnvForCommand({ json: options.json === true });
      await handleModelsPing(options);
    });

  program
    .command('prove')
    .description('Prove whether a Babel run earned its completion claim from evidence')
    .argument('[run]', 'Run directory or latest', 'latest')
    .option('--last', 'Use latest run pointer')
    .option('--run <run>', 'Run directory or latest')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel prove --last
  $ babel prove latest
  $ babel prove <run_dir> --json

Notes:
  - Writes proof_status.json and BABEL_RUN_REPORT.md into the run directory.
  - Defaults conservatively when required proof artifacts are missing.
`,
    )
    .action(
      (
        runArg: string | undefined,
        options: { last?: boolean; run?: string; project?: string; json?: boolean },
      ) => {
        handleProofReport(runArg, options);
      },
    );

  const learnCommand = program
    .command('learn')
    .description('Create reviewed learning artifacts from Babel run evidence')
    .addHelpText(
      'after',
      `
Examples:
  $ babel learn from-run --last
  $ babel learn from-run <run_dir> --json
  $ babel learn propose <failure-id> --json
  $ babel learn test <lesson-id> --json
  $ babel learn promote <lesson-id> --shadow --json
  $ babel learn package <lesson-id> --target project-verifier-contract --json
  $ babel learn inspect <artifact-id>

Notes:
  - P4-P7 propose, test, shadow-promote, and package review artifacts only.
  - P7 mutation packages are review-only and do not apply patches.
  - It does not mutate prompts, policies, verifier contracts, executor behavior, or tool permissions.
`,
    )
    .action(() => {
      learnCommand.help({ error: false });
    });

  learnCommand
    .command('from-run')
    .description('Create a structured learning failure record from a Babel run')
    .argument('[run]', 'Run directory, run id, or latest', 'latest')
    .option('--last', 'Use latest run pointer')
    .option('--run <run>', 'Run directory, run id, or latest')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--learning-root <path>', 'Directory for learning artifacts')
    .option('--json', 'Emit structured JSON only')
    .action(
      (
        runArg: string | undefined,
        options: {
          last?: boolean;
          run?: string;
          project?: string;
          learningRoot?: string;
          json?: boolean;
        },
      ) => {
        handleLearnFromRun(runArg, options);
      },
    );

  learnCommand
    .command('propose')
    .description('Create a scoped lesson candidate from a learning failure record')
    .argument('<failure-id>', 'Failure record id, run id, or direct .failure.json path')
    .option('--learning-root <path>', 'Directory for learning artifacts')
    .option('--json', 'Emit structured JSON only')
    .action((failureId: string, options: { learningRoot?: string; json?: boolean }) => {
      handleLearnPropose(failureId, options);
    });

  learnCommand
    .command('test')
    .description('Run the static stored-evidence eval gate for a lesson candidate')
    .argument('<lesson-id>', 'Lesson candidate id or direct candidate path')
    .option('--learning-root <path>', 'Directory for learning artifacts')
    .option('--json', 'Emit structured JSON only')
    .action((lessonId: string, options: { learningRoot?: string; json?: boolean }) => {
      handleLearnTest(lessonId, options);
    });

  learnCommand
    .command('promote')
    .description('Promote a passing lesson candidate to advisory shadow mode')
    .argument('<lesson-id>', 'Lesson candidate id or direct candidate path')
    .option('--shadow', 'Promote to advisory shadow mode')
    .option('--learning-root <path>', 'Directory for learning artifacts')
    .option('--json', 'Emit structured JSON only')
    .action(
      (lessonId: string, options: { shadow?: boolean; learningRoot?: string; json?: boolean }) => {
        handleLearnPromote(lessonId, options);
      },
    );

  learnCommand
    .command('package')
    .description('Generate a review-only mutation package from a passing project lesson')
    .argument('<lesson-id>', 'Lesson candidate id or direct candidate path')
    .requiredOption(
      '--target <target>',
      'Mutation target type: project-verifier-contract or project-overlay',
    )
    .option('--learning-root <path>', 'Directory for learning artifacts')
    .option('--json', 'Emit structured JSON only')
    .action(
      (lessonId: string, options: { target?: string; learningRoot?: string; json?: boolean }) => {
        handleLearnPackage(lessonId, options);
      },
    );

  learnCommand
    .command('inspect')
    .description(
      'Read a learning failure, lesson candidate, shadow lesson, eval record, or mutation package',
    )
    .argument(
      '<artifact-id>',
      'Failure id, lesson id, mutation id, or direct learning artifact path',
    )
    .option('--learning-root <path>', 'Directory for learning artifacts')
    .option('--json', 'Emit structured JSON only')
    .action((artifactId: string, options: { learningRoot?: string; json?: boolean }) => {
      handleLearnInspect(artifactId, options);
    });

  const evidenceCommand = program
    .command('evidence')
    .description('Show the evidence-first command surfaces and latest run pointer')
    .option('--json', 'Emit structured JSON only')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .addHelpText(
      'after',
      `
Examples:
  $ babel evidence
  $ babel evidence open
  $ babel evidence open --run <path>
  $ babel evidence export --run <path>
  $ babel evidence --project app_test_babel
  $ babel evidence --json
`,
    )
    .action((options: { json?: boolean; project?: string }) => {
      printEvidenceStatus(options);
    });

  registerEvidenceProductSubcommands(evidenceCommand);

  const toolsCommand = program
    .command('tools')
    .description('Inspect the executor tool registry')
    .addHelpText(
      'after',
      `
Examples:
  $ babel tools list
  $ babel tools list --json
  $ babel tools list --policy --capabilities
  $ babel tools list --policy --allowed-tools file_read,directory_list
  $ babel tools inspect file_read
  $ babel tools inspect shell_exec --policy --json

Notes:
  - This is an inspection surface for executor capabilities, not a tool execution surface.
  - Use babel run --allowed-tools / --disallowed-tools to scope tools for a run.
`,
    )
    .action(() => {
      printExecutorToolList({});
    });

  toolsCommand
    .command('list')
    .description('List registered executor tools')
    .option('--json', 'Emit structured JSON only')
    .option('--policy', 'Include current policy decision for each tool')
    .option('--why-disabled', 'Alias for --policy that emphasizes disabled reasons')
    .option(
      '--capabilities',
      'Include capability broker entries such as archive and bundle inspection',
    )
    .option(
      '--execution-profile <profile>',
      'Evaluate policy/capabilities for an execution profile',
    )
    .option('--allowed-tools <tools>', 'Comma-separated run-level allowed tool names to simulate')
    .option(
      '--disallowed-tools <tools>',
      'Comma-separated run-level disallowed tool names to simulate',
    )
    .action(
      (options: {
        json?: boolean;
        policy?: boolean;
        whyDisabled?: boolean;
        capabilities?: boolean;
        executionProfile?: string;
        allowedTools?: string;
        disallowedTools?: string;
      }) => {
        printExecutorToolList(options);
      },
    );

  toolsCommand
    .command('inspect')
    .description('Inspect one registered executor tool')
    .argument('<name>', 'Executor tool name')
    .option('--json', 'Emit structured JSON only')
    .option('--policy', 'Include current policy decision for this tool')
    .option('--execution-profile <profile>', 'Evaluate policy for an execution profile')
    .action(
      (name: string, options: { json?: boolean; policy?: boolean; executionProfile?: string }) => {
        handleExecutorToolInspect(name, options);
      },
    );

  const sessionCommand = program
    .command('session')
    .description('Read-only session views backed by Babel run evidence')
    .addHelpText(
      'after',
      `
Examples:
  $ babel session latest
  $ babel session latest --project example_saas_backend --json
  $ babel session list --limit 5
  $ babel session inspect latest

Notes:
  - Sessions are evidence-backed run directories, not separate chat logs.
  - "latest" uses the same project-scoped latest pointer as inspect/evidence.
`,
    )
    .action(() => {
      const latest = readLatestRunPointer();
      if (!latest) {
        console.error('[babel] No latest session pointer found.');
        process.exit(1);
      }
      printSessionSummary(readSessionSummary(latest.run_dir), false);
    });

  sessionCommand
    .command('latest')
    .description('Show the latest evidence-backed session')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--json', 'Emit structured JSON only')
    .action((options: { project?: string; json?: boolean }) => {
      const latest = readLatestRunPointer(options.project);
      if (!latest) {
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'no_latest_session',
                project: options.project ?? null,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          console.error(
            `[babel] No latest session pointer found${options.project ? ` for ${options.project}` : ''}.`,
          );
        }
        process.exit(1);
      }
      printSessionSummary(readSessionSummary(latest.run_dir), options.json === true);
    });

  sessionCommand
    .command('list')
    .description('List recent evidence-backed sessions')
    .option('--project <name>', 'Filter by manifest target project')
    .option('--limit <n>', 'Maximum sessions to show', '10')
    .option('--json', 'Emit structured JSON only')
    .action((options: { project?: string; limit?: string; json?: boolean }) => {
      const limit = Number.parseInt(options.limit ?? '10', 10);
      const sessions = listSessionSummaries({
        ...(options.project !== undefined ? { project: options.project } : {}),
        limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
      });
      printSessionList(sessions, options.json === true);
    });

  sessionCommand
    .command('resume')
    .description('Resolve a run id/latest pointer into recovery metadata')
    .argument('[run]', 'Run directory or latest', 'latest')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--json', 'Emit structured JSON only')
    .action((runArg: string | undefined, options: { project?: string; json?: boolean }) => {
      printSessionResume(runArg, options);
    });

  sessionCommand
    .command('inspect')
    .description('Inspect a session summary via existing evidence-bundle inspection')
    .argument('[run]', 'Run directory or latest')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .action((runArg: string | undefined, options: { project?: string }) => {
      handleInspectMode('summary', runArg ?? 'latest', options);
    });

  const inspectCommand = program
    .command('inspect')
    .description('Read-only run inspection surfaces for existing Babel evidence bundles')
    .option('--last', 'Use latest run pointer')
    .option('--report', 'Generate proof_status.json and BABEL_RUN_REPORT.md for a run')
    .option('--run <run>', 'Run directory or latest')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel inspect --last --report
  $ babel inspect report latest
  $ babel inspect run latest
  $ babel inspect summary --run latest
  $ babel inspect stack --run <run_dir>

Notes:
  - These views are read-only and operate on already-created evidence bundles.
  - --report writes proof_status.json and BABEL_RUN_REPORT.md into the run directory.
`,
    )
    .action(
      async (options: {
        last?: boolean;
        report?: boolean;
        run?: string;
        project?: string;
        json?: boolean;
      }) => {
        if (options.report === true) {
          handleProofReport(undefined, options);
          return;
        }
        inspectCommand.help({ error: false });
      },
    );

  addInspectCommonOptions(
    inspectCommand
      .command('report')
      .argument('[run]', 'Run directory or latest')
      .description('Generate proof_status.json and BABEL_RUN_REPORT.md for a Babel run')
      .option('--last', 'Use latest run pointer')
      .option('--json', 'Emit structured JSON only')
      .action(
        async (
          runArg: string | undefined,
          options: { run?: string; project?: string; last?: boolean; json?: boolean },
        ) => {
          handleProofReport(runArg, options);
        },
      ),
  );

  addInspectCommonOptions(
    inspectCommand
      .command('run')
      .argument('[run]', 'Run directory or latest')
      .description('Inspect a complete Babel run bundle')
      .action(async (runArg: string | undefined, options: { run?: string; project?: string }) => {
        handleInspectMode('run', runArg, options);
      }),
  );

  addInspectCommonOptions(
    inspectCommand
      .command('summary')
      .argument('[run]', 'Run directory or latest')
      .description('Inspect the summary artifact for a Babel run')
      .action(async (runArg: string | undefined, options: { run?: string; project?: string }) => {
        handleInspectMode('summary', runArg, options);
      }),
  );

  addInspectCommonOptions(
    inspectCommand
      .command('stack')
      .argument('[run]', 'Run directory or latest')
      .description('Inspect the resolved instruction stack for a Babel run')
      .action(async (runArg: string | undefined, options: { run?: string; project?: string }) => {
        handleInspectMode('stack', runArg, options);
      }),
  );

  addInspectCommonOptions(
    inspectCommand
      .command('manifest')
      .argument('[run]', 'Run directory or latest')
      .description('Inspect the artifact manifest for a Babel run')
      .action(async (runArg: string | undefined, options: { run?: string; project?: string }) => {
        handleInspectMode('manifest', runArg, options);
      }),
  );

  addInspectCommonOptions(
    inspectCommand
      .command('outcome')
      .argument('[run]', 'Run directory or latest')
      .description('Inspect the derived outcome for a Babel run')
      .action(async (runArg: string | undefined, options: { run?: string; project?: string }) => {
        handleInspectMode('outcome', runArg, options);
      }),
  );

  const checkpointCommand = program
    .command('checkpoint')
    .description('List, inspect, or restore pre-mutation checkpoints')
    .addHelpText(
      'after',
      `
Examples:
  $ babel checkpoint list --run latest
  $ babel checkpoint inspect <checkpoint_id> --run <run_dir>
  $ babel checkpoint restore <checkpoint_id> --run <run_dir> --json
`,
    );

  checkpointCommand
    .command('list')
    .description('List checkpoints for a run')
    .option('--run <run>', 'Run directory or latest', 'latest')
    .option('--project <project>', 'Project-scoped latest pointer')
    .option('--json', 'Emit structured JSON only')
    .action((options: { run?: string; project?: string; json?: boolean }) => {
      try {
        const runDir = resolveInspectRunDir({
          run: options.run,
          project: options.project,
          babelRunsDir: BABEL_RUNS_DIR,
        });
        const index = listCheckpoints(runDir);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatCheckpointList(index)}\n`);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  checkpointCommand
    .command('inspect')
    .argument('<checkpointId>', 'Checkpoint id')
    .description('Inspect a checkpoint record')
    .option('--run <run>', 'Run directory or latest')
    .option('--json', 'Emit structured JSON only')
    .action((checkpointId: string, options: { run?: string; json?: boolean }) => {
      try {
        const resolved = options.run
          ? findCheckpoint(checkpointId, { runDir: options.run })
          : findCheckpoint(checkpointId, { runsDir: BABEL_RUNS_DIR });
        if (options.json) {
          process.stdout.write(`${JSON.stringify(resolved.record, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatCheckpointInspect(resolved.record)}\n`);
        }
      } catch (err: unknown) {
        console.error(`Checkpoint error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  checkpointCommand
    .command('restore')
    .argument('<checkpointId>', 'Checkpoint id')
    .description('Restore files captured by a checkpoint')
    .option('--run <run>', 'Run directory or latest')
    .option('--force', 'Restore even if current files differ from the checkpoint post-write state')
    .option('--json', 'Emit structured JSON only')
    .action((checkpointId: string, options: { run?: string; force?: boolean; json?: boolean }) => {
      try {
        const runDir = options.run
          ? resolveInspectRunDir({ run: options.run, babelRunsDir: BABEL_RUNS_DIR })
          : undefined;
        const resolved = runDir
          ? findCheckpoint(checkpointId, { runDir })
          : findCheckpoint(checkpointId, { runsDir: BABEL_RUNS_DIR });
        const result = restoreCheckpoint(resolved.record, { force: options.force === true });
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        if (result.status !== 'restored') {
          process.exit(1);
        }
      } catch (err: unknown) {
        console.error(`Checkpoint error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  program
    .command('interactive')
    .alias('app')
    .description('Default: enter persistent interactive Babel session (REPL)')
    .option('-p, --project <name>', 'Default project for this session')
    .option('--mode <mode>', 'Default mode for this session', 'chat')
    .addHelpText(
      'after',
      `
Interactive slash command map:
  /checkpoint, /restore, /session
  /mcp, /plugins, /plugin, /agents
`,
    )
    .action(async (options: { project?: string; mode?: string }) => {
      try {
        await startInteractiveSession({
          ...(options.project !== undefined ? { project: options.project } : {}),
          mode: options.mode as never,
        });
      } catch (err: unknown) {
        console.error(
          `Interactive session error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

  const mcpCommand = program
    .command('mcp')
    .description('Manage MCP server registry or run the Babel MCP control-plane server over stdio')
    .addHelpText(
      'after',
      `
Examples:
  $ babel mcp list
  $ babel mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp
  $ babel mcp remove filesystem
  $ babel mcp serve

Notes:
  - Bare "babel mcp" is kept as a compatibility alias for "babel mcp serve".
`,
    )
    .action(async () => {
      try {
        await runBabelMcpServer();
      } catch (err: unknown) {
        console.error(`MCP error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  mcpCommand
    .command('doctor')
    .description('Diagnose MCP registry, transport, auth, timeout, and schema policy')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const servers = readMcpServers();
      const payload = {
        status: 'ok',
        config_path: getMcpServersConfigPath(),
        server_count: Object.keys(servers).length,
        servers,
        transport_policy: {
          supported: ['stdio'],
          http_oauth: 'not_enabled',
        },
        auth_policy: {
          env_passthrough: 'scrubbed',
          secret_redaction: true,
        },
        timeout_policy: {
          default_ms: Number(process.env['BABEL_MCP_TIMEOUT_MS'] ?? '10000'),
        },
        schema_policy: {
          lazy_loading: true,
          bounded_tool_search: true,
        },
        external_content_policy: {
          resources_are_untrusted: true,
          prompts_are_untrusted: true,
          tools_are_policy_gated: true,
        },
      };
      printJsonOrHuman(
        payload,
        [
          'Babel MCP Doctor',
          `Config: ${payload.config_path}`,
          `Servers: ${payload.server_count}`,
          'Schema policy: lazy loading, bounded tool search',
          'External content policy: MCP content is untrusted',
        ].join('\n'),
        options.json === true,
      );
    });

  mcpCommand
    .command('serve')
    .description('Run the read-only Babel MCP control-plane server over stdio')
    .action(async () => {
      try {
        await runBabelMcpServer();
      } catch (err: unknown) {
        console.error(`MCP error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });

  mcpCommand
    .command('list')
    .description('List configured MCP servers')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      printMcpServers(options);
    });

  mcpCommand
    .command('status')
    .description('Show MCP registry path and configured server count')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      printMcpServers({ ...options, status: true });
    });

  mcpCommand
    .command('add')
    .description('Add or update an MCP server registry entry')
    .argument('<name>', 'Logical server name used in mcp_request.server')
    .argument('<command>', 'Executable to spawn')
    .argument('[args...]', 'Arguments passed to the executable')
    .option('--json', 'Emit structured JSON only')
    .action(
      (
        name: string,
        commandValue: string,
        args: string[] | undefined,
        options: { json?: boolean },
      ) => {
        try {
          const servers = upsertMcpServer(name, { command: commandValue, args: args ?? [] });
          const payload = {
            status: 'ok',
            action: 'upsert',
            name,
            config_path: getMcpServersConfigPath(),
            server: servers[name],
          };
          if (options.json) {
            process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
          } else {
            console.log(`MCP server "${name}" saved to ${payload.config_path}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({ status: 'fail', error: message }, null, 2)}\n`,
            );
          } else {
            console.error(`MCP error: ${message}`);
          }
          process.exit(1);
        }
      },
    );

  mcpCommand
    .command('remove')
    .description('Remove an MCP server registry entry')
    .argument('<name>', 'Logical server name to remove')
    .option('--json', 'Emit structured JSON only')
    .action((name: string, options: { json?: boolean }) => {
      try {
        removeMcpServer(name);
        const payload = {
          status: 'ok',
          action: 'remove',
          name,
          config_path: getMcpServersConfigPath(),
        };
        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          console.log(`MCP server "${name}" removed from ${payload.config_path}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ status: 'fail', error: message }, null, 2)}\n`);
        } else {
          console.error(`MCP error: ${message}`);
        }
        process.exit(1);
      }
    });

  const contextCommand = program
    .command('context')
    .description('Preview bounded @file and @directory context attachments')
    .action(() => {
      contextCommand.help({ error: false });
    });

  contextCommand
    .command('preview')
    .description('Preview context attachments without starting a run')
    .argument('<refs...>', '@file/@directory references, for example: @file README.md')
    .option('--project-root <path>', 'Project root for attachment resolution', process.cwd())
    .option('--json', 'Emit structured JSON only')
    .action((refs: string[], options: { projectRoot?: string; json?: boolean }) => {
      try {
        const task = refs.join(' ');
        const result = prepareContextInjection(task, {
          projectRoot: options.projectRoot ?? process.cwd(),
        });
        printJsonOrHuman(result, summarizeContextInjection(result), options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  const eventsCommand = program
    .command('events')
    .description('Inspect structured JSON event stream contracts')
    .action(() => {
      eventsCommand.help({ error: false });
    });

  eventsCommand
    .command('schema')
    .description('Print the read-only JSONL event stream contract')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const contract = buildEventStreamContract();
      printJsonOrHuman(contract, JSON.stringify(contract, null, 2), options.json === true);
    });

  eventsCommand
    .command('ide-bridge')
    .description('Print a read-only IDE bridge snapshot for a run')
    .argument('[run]', 'Run directory or latest', 'latest')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--contract-only', 'Print only the read-only bridge contract')
    .option('--json', 'Emit structured JSON only')
    .action(
      (
        runArg: string | undefined,
        options: { project?: string; contractOnly?: boolean; json?: boolean },
      ) => {
        try {
          if (options.contractOnly === true) {
            const contract = buildIdeBridgeContract();
            printJsonOrHuman(contract, JSON.stringify(contract, null, 2), options.json === true);
            return;
          }
          const runDir = resolveRunForReadOnlyCommand(runArg, options.project);
          const snapshot = buildIdeBridgeSnapshot(runDir);
          printJsonOrHuman(snapshot, formatIdeBridgeSnapshotHuman(snapshot), options.json === true);
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  const statsCommand = program
    .command('stats')
    .description('Derive stats from existing evidence bundles')
    .action(() => {
      statsCommand.help({ error: false });
    });

  statsCommand
    .command('run')
    .description('Derive run stats from an evidence bundle')
    .argument('[run]', 'Run directory or latest', 'latest')
    .option('--project <name>', 'Use latest run pointer for a specific project')
    .option('--json', 'Emit structured JSON only')
    .action((runArg: string | undefined, options: { project?: string; json?: boolean }) => {
      try {
        const runDir = resolveRunForReadOnlyCommand(runArg, options.project);
        const stats = buildRunStats(runDir);
        printJsonOrHuman(stats, formatRunStatsHuman(stats), options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  const pluginsCommand = program
    .command('plugins')
    .description('Inspect and manage runtime plugins behind policy gates')
    .action(() => {
      const registry = loadPluginRegistry();
      process.stdout.write(`${formatPluginListHuman(registry)}\n`);
    });

  pluginsCommand
    .command('list')
    .description('List discovered runtime plugins')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const registry = loadPluginRegistry();
      printJsonOrHuman(registry, formatPluginListHuman(registry), options.json === true);
    });

  pluginsCommand
    .command('doctor')
    .description('Diagnose runtime plugin manifests and trust gates')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const registry = loadPluginRegistry();
      printJsonOrHuman(registry, formatPluginDoctorHuman(registry), options.json === true);
      if (registry.status === 'fail') {
        process.exit(1);
      }
    });

  pluginsCommand
    .command('inspect')
    .description('Inspect one plugin')
    .argument('<id>', 'Plugin id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      const registry = loadPluginRegistry();
      const plugin = registry.plugins.find((entry) => entry.manifest.id === id);
      if (!plugin) {
        printJsonErrorAndExit(`Plugin not found: ${id}`, options.json === true);
      }
      printJsonOrHuman(plugin, formatPluginInspectHuman(plugin), options.json === true);
    });

  pluginsCommand
    .command('enable')
    .description('Enable a plugin id in local plugin config')
    .argument('<id>', 'Plugin id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      try {
        const config = enablePlugin(id);
        printJsonOrHuman({ status: 'ok', config }, `Enabled plugin ${id}`, options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  pluginsCommand
    .command('disable')
    .description('Disable a plugin id in local plugin config')
    .argument('<id>', 'Plugin id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      try {
        const config = disablePlugin(id);
        printJsonOrHuman({ status: 'ok', config }, `Disabled plugin ${id}`, options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  const agentsCommand = program
    .command('agents')
    .description('Inspect and run spec-contract agent teams')
    .action(() => {
      const index = listAgentRuns();
      process.stdout.write(`${formatAgentListHuman(index)}\n`);
    });

  agentsCommand
    .command('list')
    .description('List prior agent-team runs')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const index = listAgentRuns();
      printJsonOrHuman(index, formatAgentListHuman(index), options.json === true);
    });

  agentsCommand
    .command('contract')
    .description('Print the live-subagent isolation contract')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const contract = buildSubagentIsolationContract();
      printJsonOrHuman(contract, JSON.stringify(contract, null, 2), options.json === true);
    });

  agentsCommand
    .command('run')
    .description('Run an agent-team spec file')
    .argument('<spec>', 'Path to agent-team spec JSON')
    .option('--json', 'Emit structured JSON only')
    .action((spec: string, options: { json?: boolean }) => {
      try {
        const run = runAgentTeamFromFile(spec);
        printJsonOrHuman(run, formatAgentRunHuman(run), options.json === true);
        if (run.status === 'failed') {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  agentsCommand
    .command('inspect')
    .description('Inspect an agent-team run')
    .argument('<idOrPath>', 'Agent-team run id or path')
    .option('--json', 'Emit structured JSON only')
    .action((idOrPath: string, options: { json?: boolean }) => {
      try {
        const run = inspectAgentRun(idOrPath);
        printJsonOrHuman(run, formatAgentRunHuman(run), options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  agentsCommand
    .command('merge')
    .description('Merge a ready agent-team run')
    .argument('<idOrPath>', 'Agent-team run id or path')
    .option('--json', 'Emit structured JSON only')
    .action((idOrPath: string, options: { json?: boolean }) => {
      try {
        const report = mergeAgentRun(idOrPath);
        printJsonOrHuman(report, formatAgentMergeHuman(report), options.json === true);
        if (report.status === 'failed') {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  agentsCommand
    .command('restore')
    .description('Restore files from an agent-team merge pre-merge snapshot')
    .argument('<idOrPath>', 'Agent-team run id or path')
    .option('--json', 'Emit structured JSON only')
    .action((idOrPath: string, options: { json?: boolean }) => {
      try {
        const report = restoreAgentMerge(idOrPath);
        printJsonOrHuman(report, formatAgentMergeRestoreHuman(report), options.json === true);
        if (report.status === 'failed') {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  const scheduleCommand = program
    .command('schedule')
    .description('Manage local schedules; mutating run-now jobs require explicit gates')
    .action(() => {
      const payload = listSchedules();
      process.stdout.write(`${formatScheduleListHuman(payload)}\n`);
    });

  scheduleCommand
    .command('list')
    .description('List local schedules')
    .option('--json', 'Emit structured JSON only')
    .action((options: { json?: boolean }) => {
      const payload = listSchedules();
      printJsonOrHuman(payload, formatScheduleListHuman(payload), options.json === true);
    });

  scheduleCommand
    .command('create')
    .description('Create a local schedule entry')
    .argument('<id>', 'Schedule id')
    .argument('<jobType>', 'Job type')
    .option('--project-root <path>', 'Project root used by the scheduled job')
    .option('--base-ref <ref>', 'Optional base ref for review/draft jobs')
    .option('--branch <name>', 'Branch name for git_branch_create')
    .option('--message <message>', 'Commit message for git_commit_create')
    .option('--pr-title <title>', 'PR title for git_pr_create')
    .option('--pr-body <body>', 'PR body for git_pr_create')
    .option('--json', 'Emit structured JSON only')
    .action(
      (
        id: string,
        jobType: string,
        options: {
          projectRoot?: string;
          baseRef?: string;
          branch?: string;
          message?: string;
          prTitle?: string;
          prBody?: string;
          json?: boolean;
        },
      ) => {
        try {
          const schedule = createSchedule({
            id,
            jobType: jobType as ScheduleJobType,
            ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
            ...(options.baseRef ? { baseRef: options.baseRef } : {}),
            ...(options.branch ? { branchName: options.branch } : {}),
            ...(options.message ? { commitMessage: options.message } : {}),
            ...(options.prTitle ? { prTitle: options.prTitle } : {}),
            ...(options.prBody ? { prBody: options.prBody } : {}),
          });
          printJsonOrHuman(
            { status: 'ok', schedule },
            `Created schedule ${schedule.id}`,
            options.json === true,
          );
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  scheduleCommand
    .command('run-now')
    .description(
      'Run a schedule immediately; mutating jobs require --allow-mutate and execute in an isolated project copy',
    )
    .argument('<id>', 'Schedule id')
    .option('--allow-mutate', 'Allow mutating scheduled jobs inside an isolated project copy')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Notes:
  - Mutating scheduled jobs require --allow-mutate.
  - Mutating jobs run inside an isolated project copy.
`,
    )
    .action((id: string, options: { allowMutate?: boolean; json?: boolean }) => {
      try {
        const record = runScheduleNow(id, { allowMutate: options.allowMutate === true });
        printJsonOrHuman(record, formatScheduleRunHuman(record), options.json === true);
        if (record.status === 'fail') {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  scheduleCommand
    .command('delete')
    .description('Delete a local schedule entry')
    .argument('<id>', 'Schedule id')
    .option('--json', 'Emit structured JSON only')
    .action((id: string, options: { json?: boolean }) => {
      const result = deleteSchedule(id);
      printJsonOrHuman(
        result,
        result.deleted ? `Deleted schedule ${id}` : `No schedule found for ${id}`,
        options.json === true,
      );
    });

  const ciCommand = program
    .command('ci')
    .description('Read-only CI and review evidence surfaces')
    .action(() => {
      ciCommand.help({ error: false });
    });

  ciCommand
    .command('review')
    .description('Write deterministic read-only CI review evidence')
    .option('--project-root <path>', 'Project root to review', process.cwd())
    .option('--base-ref <ref>', 'Optional base ref')
    .option('--json', 'Emit structured JSON only')
    .action((options: { projectRoot?: string; baseRef?: string; json?: boolean }) => {
      try {
        const report = runCiReview({
          projectRoot: options.projectRoot ?? process.cwd(),
          ...(options.baseRef ? { baseRef: options.baseRef } : {}),
        });
        printJsonOrHuman(report, formatCiReviewHuman(report), options.json === true);
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  const gitCommand = program
    .command('git')
    .description('Draft and governed Git delivery surfaces')
    .addHelpText(
      'after',
      `
Commands include:
  diff-summary, commit-draft, pr-draft
  branch-create, commit-create, pr-create --allow-remote
`,
    )
    .action(() => {
      gitCommand.help({ error: false });
    });

  const registerGitDraftCommand = (name: string, kind: GitDraftKind, description: string): void => {
    gitCommand
      .command(name)
      .description(description)
      .option('--project-root <path>', 'Project root to inspect', process.cwd())
      .option('--base-ref <ref>', 'Optional base ref')
      .option('--json', 'Emit structured JSON only')
      .action((options: { projectRoot?: string; baseRef?: string; json?: boolean }) => {
        try {
          const report = runGitDraft(kind, {
            projectRoot: options.projectRoot ?? process.cwd(),
            ...(options.baseRef ? { baseRef: options.baseRef } : {}),
          });
          printJsonOrHuman(report, formatGitDraftHuman(report), options.json === true);
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      });
  };

  registerGitDraftCommand(
    'diff-summary',
    'diff_summary',
    'Draft a diff summary without mutating Git',
  );
  registerGitDraftCommand(
    'commit-draft',
    'commit_draft',
    'Draft a commit message without committing',
  );
  registerGitDraftCommand('pr-draft', 'pr_draft', 'Draft PR metadata without opening a PR');

  gitCommand
    .command('branch-create')
    .description('Create a local branch and write evidence')
    .argument('<branch>', 'Branch name')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--from <ref>', 'Source ref', 'HEAD')
    .option('--json', 'Emit structured JSON only')
    .action((branch: string, options: { projectRoot?: string; from?: string; json?: boolean }) => {
      try {
        const report = createGitBranch({
          branchName: branch,
          projectRoot: options.projectRoot ?? process.cwd(),
          ...(options.from ? { fromRef: options.from } : {}),
        });
        printJsonOrHuman(report, formatGitMutationHuman(report), options.json === true);
        if (report.action.status === 'failed') {
          process.exit(1);
        }
      } catch (err: unknown) {
        printJsonErrorAndExit(
          err instanceof Error ? err.message : String(err),
          options.json === true,
        );
      }
    });

  gitCommand
    .command('commit-create')
    .description('Create a local commit and write evidence')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--message <message>', 'Commit message')
    .option('--stage <mode>', 'Stage mode: staged | tracked | all', 'staged')
    .option('--json', 'Emit structured JSON only')
    .action(
      (options: { projectRoot?: string; message?: string; stage?: string; json?: boolean }) => {
        try {
          const stage =
            options.stage === 'tracked' || options.stage === 'all' ? options.stage : 'staged';
          const report = createGitCommit({
            projectRoot: options.projectRoot ?? process.cwd(),
            stageMode: stage,
            ...(options.message ? { message: options.message } : {}),
          });
          printJsonOrHuman(report, formatGitMutationHuman(report), options.json === true);
          if (report.action.status === 'failed') {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  gitCommand
    .command('pr-create')
    .description('Plan PR creation by default; remote creation requires --allow-remote')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--title <title>', 'PR title')
    .option('--body <body>', 'PR body')
    .option('--allow-remote', 'Allow gh pr create remote side effect')
    .option('--json', 'Emit structured JSON only')
    .action(
      (options: {
        projectRoot?: string;
        title?: string;
        body?: string;
        allowRemote?: boolean;
        json?: boolean;
      }) => {
        try {
          const report = createGitPullRequest({
            projectRoot: options.projectRoot ?? process.cwd(),
            ...(options.title ? { title: options.title } : {}),
            ...(options.body ? { body: options.body } : {}),
            allowRemote: options.allowRemote === true,
          });
          printJsonOrHuman(report, formatGitMutationHuman(report), options.json === true);
          if (report.action.status === 'failed') {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  registerShipCommand(program);

  const benchmarkCommand = program
    .command('benchmark')
    .alias('bench')
    .description('Run local Babel benchmark suites')
    .action(() => {
      benchmarkCommand.help({ error: false });
    });

  benchmarkCommand
    .command('smoke')
    .description('Run a small Babel vs Babel Lite smoke benchmark')
    .option('--live', 'Call the configured provider and run the CLI cases')
    .option('--modes <modes>', 'Comma-separated modes: babel,bl', 'babel,bl')
    .option('--model <model>', 'Model family for live provider-backed cases')
    .option('--model-tier <tier>', 'Model tier for live provider-backed cases')
    .option('--timeout-ms <n>', 'Per-case timeout in milliseconds', '420000')
    .option('--output-dir <path>', 'Benchmark artifact output directory')
    .option('--json', 'Emit structured JSON only')
    .action(
      (options: {
        live?: boolean;
        modes?: string;
        model?: string;
        modelTier?: string;
        timeoutMs?: string;
        outputDir?: string;
        json?: boolean;
      }) => {
        const timeoutMs = Number.parseInt(options.timeoutMs ?? '420000', 10);
        const report = runCliSmokeBenchmark({
          live: options.live === true,
          modes: (options.modes ?? 'babel,bl').split(','),
          ...(options.model ? { model: options.model } : {}),
          ...(options.modelTier ? { modelTier: options.modelTier } : {}),
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 420_000,
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        });
        printJsonOrHuman(report, formatCliSmokeBenchmarkHuman(report), options.json === true);
        if (report.summary.failed > 0) {
          process.exit(1);
        }
      },
    );

  benchmarkCommand
    .command('lite')
    .description('Compare Babel Lite daily commands against full Babel command shapes')
    .option('--json', 'Emit structured JSON only')
    .option('--output-dir <path>', 'Benchmark artifact output directory')
    .option('--fixture <path>', 'Override Lite usability fixture path')
    .action((options: { json?: boolean; outputDir?: string; fixture?: string }) => {
      const report = buildLiteUsabilityReport({
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        ...(options.fixture ? { fixturePath: options.fixture } : {}),
      });
      printJsonOrHuman(report, formatLiteUsabilityReportHuman(report), options.json === true);
      if (report.summary.fail > 0) {
        process.exit(1);
      }
    });

  benchmarkCommand
    .command('real-tasks')
    .description('Prepare a non-mutating pilot checklist for real repo tasks')
    .option('--project-root <path>', 'Project root to pilot against', '.')
    .option('--output-dir <path>', 'Pilot artifact output directory')
    .option('--json', 'Emit structured JSON only')
    .action((options: { projectRoot?: string; outputDir?: string; json?: boolean }) => {
      const report = buildRealTaskPilotReport({
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      });
      printJsonOrHuman(report, formatRealTaskPilotHuman(report), options.json === true);
    });

  benchmarkCommand
    .command('product')
    .description('Run the Babel CLI product-gap benchmark')
    .option('--json', 'Emit structured JSON only')
    .option('--output-dir <path>', 'Benchmark artifact output directory')
    .action((options: { json?: boolean; outputDir?: string }) => {
      const report = runProductBenchmark({
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      });
      printJsonOrHuman(report, formatProductBenchmarkHuman(report), options.json === true);
      if (report.summary.fail > 0 || report.summary.not_implemented > 0) {
        process.exit(1);
      }
    });

  benchmarkCommand
    .command('parity')
    .description('Create the Phase 12 comparative parity benchmark artifact')
    .option('--json', 'Emit structured JSON only')
    .option('--output-dir <path>', 'Benchmark artifact output directory')
    .option('--fixture <path>', 'Measured parity results fixture JSON')
    .action((options: { json?: boolean; outputDir?: string; fixture?: string }) => {
      const report = runParityBenchmark({
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        ...(options.fixture ? { fixturePath: options.fixture } : {}),
      });
      printJsonOrHuman(report, formatParityBenchmarkHuman(report), options.json === true);
    });

  benchmarkCommand
    .command('production')
    .description('Create the scoped production-readiness proof benchmark artifact')
    .option('--json', 'Emit structured JSON only')
    .option('--output-dir <path>', 'Benchmark artifact output directory')
    .option('--proof-root <path>', 'Production proof artifact root')
    .action((options: { json?: boolean; outputDir?: string; proofRoot?: string }) => {
      const report = runProductionBenchmark({
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        ...(options.proofRoot ? { proofRoot: options.proofRoot } : {}),
      });
      printJsonOrHuman(report, formatProductionBenchmarkHuman(report), options.json === true);
    });

  benchmarkCommand
    .command('calibration')
    .description(
      'Run the Evidence Label calibration benchmark (OLS-MCC P2(b))',
    )
    .option('--json', 'Emit structured JSON only')
    .option('--output-dir <path>', 'Benchmark artifact output directory')
    .option('--tasks <n>', 'Number of test tasks to run (default: all)', '23')
    .option('--live', 'Run with live LLM calls (uses DEEPINFRA_API_KEY)')
    .option('--model <model>', 'Model ID for live mode (provider shorthand)')
    .option('--delay-ms <n>', 'Delay between LLM calls in ms', '500')
    .option(
      '--provider <name>',
      'LLM provider: deepinfra (default), deepseek, anthropic, or gemini',
      'deepinfra',
    )
    .option(
      '--label-mode <mode>',
      'Label comparison mode: numerical-vs-none (default) or numerical-vs-categorical (P1 variant)',
      'numerical-vs-none',
    )
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        tasks?: string;
        live?: boolean;
        model?: string;
        delayMs?: string;
        provider?: string;
        labelMode?: string;
      }) => {
        try {
          const labelMode = (options.labelMode === 'numerical-vs-none' || options.labelMode === 'numerical-vs-categorical')
            ? options.labelMode
            : undefined;
          if (options.live) {
            const provider = options.provider ?? 'deepinfra';
            let apiKey: string | undefined;
            let defaultModel: string;

            if (provider === 'anthropic') {
              apiKey = process.env['ANTHROPIC_API_KEY'];
              defaultModel = 'claude-haiku-4-5-20251001';
            } else if (provider === 'gemini') {
              apiKey = process.env['GEMINI_API_KEY'];
              defaultModel = 'gemini-2.5-flash-lite';
            } else if (provider === 'deepseek') {
              apiKey = process.env['DEEPSEEK_API_KEY'];
              defaultModel = 'deepseek-v4-flash';
            } else {
              apiKey = process.env['DEEPINFRA_API_KEY'];
              defaultModel = 'meta-llama/Llama-3.3-70B-Instruct';
            }

            if (!apiKey) {
              const envVar =
                provider === 'anthropic' ? 'ANTHROPIC_API_KEY' :
                provider === 'gemini' ? 'GEMINI_API_KEY' :
                provider === 'deepseek' ? 'DEEPSEEK_API_KEY' :
                'DEEPINFRA_API_KEY';
              printJsonErrorAndExit(
                `${envVar} is required for --live --provider ${provider}. Set it in your environment or use offline mode (omit --live).`,
                options.json === true,
              );
              return;
            }

            const model = options.model ?? defaultModel;
            const delayMs = Number.parseInt(options.delayMs ?? '500', 10);
            const taskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = await runCalibrationBenchmarkLive({
              modelId: model,
              ...(taskCount !== undefined ? { taskCount } : {}),
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              ...(labelMode ? { labelMode } : {}),
              delayMs: Number.isFinite(delayMs) ? delayMs : 500,
              llmCall: async (prompt: string): Promise<string> => {
                if (provider === 'anthropic') {
                  const resp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-api-key': apiKey,
                      'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                      model,
                      max_tokens: 1024,
                      temperature: 0,
                      messages: [{ role: 'user', content: prompt }],
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => 'unknown');
                    throw new Error(`${provider} API error ${resp.status}: ${errBody}`);
                  }
                  const data = (await resp.json()) as {
                    content: Array<{ type: string; text: string }>;
                  };
                  return data.content?.[0]?.text ?? '';
                } else if (provider === 'gemini') {
                  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-goog-api-key': apiKey,
                    },
                    body: JSON.stringify({
                      contents: [{ parts: [{ text: prompt }] }],
                      generationConfig: { temperature: 0, maxOutputTokens: 1024 },
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => 'unknown');
                    throw new Error(`${provider} API error ${resp.status}: ${errBody}`);
                  }
                  const data = (await resp.json()) as {
                    candidates?: Array<{ content?: { parts?: Array<{ text: string }> } }>;
                  };
                  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                } else {
                  const apiUrl = provider === 'deepseek'
                    ? 'https://api.deepseek.com/v1/chat/completions'
                    : 'https://api.deepinfra.com/v1/openai/chat/completions';
                  const resp = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model,
                      messages: [{ role: 'user', content: prompt }],
                      max_tokens: 1024,
                      temperature: 0,
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => 'unknown');
                    throw new Error(`${provider} API error ${resp.status}: ${errBody}`);
                  }
                  const data = (await resp.json()) as {
                    choices: Array<{ message: { content: string } }>;
                  };
                  return data.choices[0]?.message?.content ?? '';
                }
              },
            });
            printJsonOrHuman(
              report,
              formatCalibrationBenchmarkHuman(report),
              options.json === true,
            );
            if (report.summary.verdict === 'REFUTED') {
              process.exit(1);
            }
          } else {
            // Offline mode: produce skeleton
            const offlineTaskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = runCalibrationBenchmark({
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              ...(offlineTaskCount !== undefined ? { taskCount: offlineTaskCount } : {}),
              ...(labelMode ? { labelMode } : {}),
            });
            printJsonOrHuman(
              report,
              formatCalibrationBenchmarkHuman(report),
              options.json === true,
            );
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  benchmarkCommand
    .command('injection')
    .description(
      'Run the Authority Order injection resistance benchmark (OLS-MCC P0)',
    )
    .option('--json', 'Emit structured JSON only')
    .option('--output-dir <path>', 'Benchmark artifact output directory')
    .option('--tasks <n>', 'Number of test tasks to run (default: all)', '36')
    .option('--live', 'Run with live LLM calls (uses DEEPINFRA_API_KEY)')
    .option('--model <model>', 'Model ID for live mode (provider shorthand)')
    .option('--delay-ms <n>', 'Delay between LLM calls in ms', '500')
    .option(
      '--provider <name>',
      'LLM provider: deepinfra (default), deepseek, anthropic, or gemini',
      'deepinfra',
    )
    .option(
      '--variant <v1|v2>',
      'Authority Order variant to test (default: v2 hardened)',
      'v2',
    )
    .option(
      '--multi-turn-defense',
      'Enable Conversation Boundary Marker defense against multi-turn erosion attacks',
    )
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        tasks?: string;
        live?: boolean;
        model?: string;
        delayMs?: string;
        provider?: string;
        variant?: string;
        multiTurnDefense?: boolean;
      }) => {
        try {
          if (options.live) {
            const provider = options.provider ?? 'deepinfra';
            let apiKey: string | undefined;
            let defaultModel: string;

            if (provider === 'anthropic') {
              apiKey = process.env['ANTHROPIC_API_KEY'];
              defaultModel = 'claude-haiku-4-5-20251001';
            } else if (provider === 'gemini') {
              apiKey = process.env['GEMINI_API_KEY'];
              defaultModel = 'gemini-2.5-flash-lite';
            } else if (provider === 'deepseek') {
              apiKey = process.env['DEEPSEEK_API_KEY'];
              defaultModel = 'deepseek-v4-flash';
            } else {
              apiKey = process.env['DEEPINFRA_API_KEY'];
              defaultModel = 'meta-llama/Llama-3.3-70B-Instruct';
            }

            if (!apiKey) {
              const envVar =
                provider === 'anthropic' ? 'ANTHROPIC_API_KEY' :
                provider === 'gemini' ? 'GEMINI_API_KEY' :
                provider === 'deepseek' ? 'DEEPSEEK_API_KEY' :
                'DEEPINFRA_API_KEY';
              printJsonErrorAndExit(
                `${envVar} is required for --live --provider ${provider}. Set it in your environment or use offline mode (omit --live).`,
                options.json === true,
              );
              return;
            }

            const model = options.model ?? defaultModel;
            const delayMs = Number.parseInt(options.delayMs ?? '500', 10);
            const taskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = await runInjectionBenchmarkLive({
              modelId: model,
              ...(taskCount !== undefined ? { taskCount } : {}),
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              aoVariant: (options.variant === 'v1' ? 'v1' : 'v2') as 'v1' | 'v2',
              multiTurnDefense: options.multiTurnDefense === true,
              delayMs: Number.isFinite(delayMs) ? delayMs : 500,
              llmCall: async (prompt: string): Promise<string> => {
                if (provider === 'anthropic') {
                  const resp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-api-key': apiKey,
                      'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                      model,
                      max_tokens: 1024,
                      temperature: 0,
                      messages: [{ role: 'user', content: prompt }],
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => 'unknown');
                    throw new Error(`${provider} API error ${resp.status}: ${errBody}`);
                  }
                  const data = (await resp.json()) as {
                    content: Array<{ type: string; text: string }>;
                  };
                  return data.content?.[0]?.text ?? '';
                } else if (provider === 'gemini') {
                  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-goog-api-key': apiKey,
                    },
                    body: JSON.stringify({
                      contents: [{ parts: [{ text: prompt }] }],
                      generationConfig: { temperature: 0, maxOutputTokens: 1024 },
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => 'unknown');
                    throw new Error(`${provider} API error ${resp.status}: ${errBody}`);
                  }
                  const data = (await resp.json()) as {
                    candidates?: Array<{ content?: { parts?: Array<{ text: string }> } }>;
                  };
                  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                } else {
                  const apiUrl = provider === 'deepseek'
                    ? 'https://api.deepseek.com/v1/chat/completions'
                    : 'https://api.deepinfra.com/v1/openai/chat/completions';
                  const resp = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model,
                      messages: [{ role: 'user', content: prompt }],
                      max_tokens: 1024,
                      temperature: 0,
                    }),
                  });
                  if (!resp.ok) {
                    const errBody = await resp.text().catch(() => 'unknown');
                    throw new Error(`${provider} API error ${resp.status}: ${errBody}`);
                  }
                  const data = (await resp.json()) as {
                    choices: Array<{ message: { content: string } }>;
                  };
                  return data.choices[0]?.message?.content ?? '';
                }
              },
            });
            printJsonOrHuman(
              report,
              formatInjectionBenchmarkHuman(report),
              options.json === true,
            );
            if (report.summary.verdict === 'REFUTED') {
              process.exit(1);
            }
          } else {
            // Offline mode: produce skeleton
            const offlineTaskCount = options.tasks
              ? Number.parseInt(options.tasks, 10)
              : undefined;
            const report = runInjectionBenchmark({
              ...(options.outputDir ? { outputDir: options.outputDir } : {}),
              ...(offlineTaskCount !== undefined ? { taskCount: offlineTaskCount } : {}),
              aoVariant: (options.variant === 'v1' ? 'v1' : 'v2') as 'v1' | 'v2',
              multiTurnDefense: options.multiTurnDefense === true,
            });
            printJsonOrHuman(
              report,
              formatInjectionBenchmarkHuman(report),
              options.json === true,
            );
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  benchmarkCommand
    .command('analyze')
    .description('Analyze a Terminal-Bench run and emit a Codex repair work packet')
    .argument('[run]', 'Run directory, result.json path, or latest', 'latest')
    .option('--json', 'Emit structured JSON only')
    .option('--benchmarks-root <path>', 'Benchmarks workspace root')
    .option('--suite <name>', 'Terminal-Bench suite for latest lookup', 'pilot10')
    .action(
      (
        runArg: string | undefined,
        options: { json?: boolean; benchmarksRoot?: string; suite?: string },
      ) => {
        try {
          const run = resolveBenchmarkAnalyzeRun(runArg ?? 'latest', {
            ...(options.benchmarksRoot ? { benchmarksRoot: options.benchmarksRoot } : {}),
            suite: options.suite ?? 'pilot10',
          });
          const analysis = analyzeTerminalBenchRun({ run });
          printJsonOrHuman(
            analysis,
            formatBenchmarkRunAnalysisHuman(analysis),
            options.json === true,
          );
        } catch (err: unknown) {
          printCommandErrorAndExit(err, options.json === true);
        }
      },
    );

  benchmarkCommand
    .command('repair')
    .description(
      'Generate a focused benchmark repair plan and prompt from a failed Terminal-Bench run',
    )
    .argument('[run]', 'Run directory, result.json path, or latest', 'latest')
    .option('--json', 'Emit structured JSON only')
    .option('--benchmarks-root <path>', 'Benchmarks workspace root')
    .option('--suite <name>', 'Terminal-Bench suite for latest lookup', 'pilot10')
    .option('--max-tasks <n>', 'Full pilot task count for generated command', '10')
    .option('--output-dir <path>', 'Repair report/prompt artifact output directory')
    .action(
      (
        runArg: string | undefined,
        options: {
          json?: boolean;
          benchmarksRoot?: string;
          suite?: string;
          maxTasks?: string;
          outputDir?: string;
        },
      ) => {
        try {
          const run = resolveBenchmarkAnalyzeRun(runArg ?? 'latest', {
            ...(options.benchmarksRoot ? { benchmarksRoot: options.benchmarksRoot } : {}),
            suite: options.suite ?? 'pilot10',
          });
          const report = buildBenchmarkRepairReport({
            run,
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            ...(options.benchmarksRoot ? { benchmarksRoot: options.benchmarksRoot } : {}),
            suite: options.suite ?? 'pilot10',
            maxTasks: parsePositiveIntOption(options.maxTasks, 10),
          });
          printJsonOrHuman(report, formatBenchmarkRepairHuman(report), options.json === true);
        } catch (err: unknown) {
          printCommandErrorAndExit(err, options.json === true);
        }
      },
    );

  benchmarkCommand
    .command('repair-run')
    .description('Execute an iterative benchmark repair packet in an isolated workspace')
    .argument('[run]', 'Run directory, result.json path, or latest', 'latest')
    .option('--json', 'Emit structured JSON only')
    .option('--benchmarks-root <path>', 'Benchmarks workspace root')
    .option('--suite <name>', 'Terminal-Bench suite for latest lookup', 'pilot10')
    .option('--max-tasks <n>', 'Full pilot task count for generated command', '10')
    .option('--max-iterations <n>', 'Maximum repair/check/targeted cycles', '5')
    .option('--model <model>', 'Optional model family override for Babel repair and targeted rerun')
    .option('--model-tier <tier>', 'Model tier for Babel repair and targeted rerun', 'cheap')
    .option(
      '--execution-profile <profile>',
      'Execution profile for repair mode',
      'benchmark_container',
    )
    .option(
      '--deepinfra-timeout-ms <n>',
      'DeepInfra per-request timeout for repair and targeted rerun',
      '240000',
    )
    .option(
      '--waterfall-timeout-ms <n>',
      'Aggregate waterfall timeout for repair and targeted rerun',
      '720000',
    )
    .option('--verifier-timeout-ms <n>', 'Local Docker verifier timeout', '1200000')
    .option('--targeted-timeout-ms <n>', 'Outer timeout for targeted benchmark rerun', '1800000')
    .option('--output-dir <path>', 'Repair-loop artifact output directory')
    .option(
      '--dry-run',
      'Prepare workspace and commands without running Babel, Docker verifier, or targeted benchmark',
    )
    .option(
      '--skip-babel-repair',
      'Do not run Babel repair mode; useful for verifying an existing workspace/checkpoint',
    )
    .option('--skip-local-verifier', 'Do not run the local Docker verifier')
    .option('--skip-targeted', 'Do not run the targeted Terminal-Bench rerun after local pass')
    .option(
      '--fail-on-unresolved',
      'Exit non-zero unless the loop reaches a local or targeted pass',
    )
    .action(
      async (
        runArg: string | undefined,
        options: {
          json?: boolean;
          benchmarksRoot?: string;
          suite?: string;
          maxTasks?: string;
          maxIterations?: string;
          model?: string;
          modelTier?: string;
          executionProfile?: string;
          deepinfraTimeoutMs?: string;
          waterfallTimeoutMs?: string;
          verifierTimeoutMs?: string;
          targetedTimeoutMs?: string;
          outputDir?: string;
          dryRun?: boolean;
          skipBabelRepair?: boolean;
          skipLocalVerifier?: boolean;
          skipTargeted?: boolean;
          failOnUnresolved?: boolean;
        },
      ) => {
        try {
          const dryRun = options.dryRun === true;
          const skipBabelRepair = options.skipBabelRepair === true;
          if (!dryRun && !skipBabelRepair) {
            validateRuntimeEnvForCommand({ json: options.json === true });
          }
          const run = resolveBenchmarkAnalyzeRun(runArg ?? 'latest', {
            ...(options.benchmarksRoot ? { benchmarksRoot: options.benchmarksRoot } : {}),
            suite: options.suite ?? 'pilot10',
          });
          const report = await runBenchmarkRepairLoop({
            run,
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            ...(options.benchmarksRoot ? { benchmarksRoot: options.benchmarksRoot } : {}),
            suite: options.suite ?? 'pilot10',
            maxTasks: parsePositiveIntOption(options.maxTasks, 10),
            maxIterations: parsePositiveIntOption(options.maxIterations, 5),
            ...(options.model ? { model: options.model } : {}),
            ...(options.modelTier ? { modelTier: options.modelTier } : {}),
            ...(options.executionProfile ? { executionProfile: options.executionProfile } : {}),
            deepInfraTimeoutMs: parsePositiveIntOption(options.deepinfraTimeoutMs, 240000),
            waterfallTimeoutMs: parsePositiveIntOption(options.waterfallTimeoutMs, 720000),
            verifierTimeoutMs: parsePositiveIntOption(options.verifierTimeoutMs, 1200000),
            targetedTimeoutMs: parsePositiveIntOption(options.targetedTimeoutMs, 1800000),
            dryRun,
            skipBabelRepair,
            skipLocalVerifier: options.skipLocalVerifier === true,
            skipTargeted: options.skipTargeted === true,
          });
          printJsonOrHuman(report, formatBenchmarkRepairLoopHuman(report), options.json === true);
          if (
            options.failOnUnresolved === true &&
            report.status !== 'targeted_passed' &&
            report.status !== 'passed_local'
          ) {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  benchmarkCommand
    .command('loop')
    .description('Run the local readiness gate and plan the Terminal-Bench improvement loop')
    .option('--json', 'Emit structured JSON only')
    .option('--benchmarks-root <path>', 'Benchmarks workspace root')
    .option('--suite <name>', 'Terminal-Bench suite', 'pilot10')
    .option('--readiness <profile>', 'Readiness profile: fast, full, release', 'full')
    .option('--max-tasks <n>', 'Full pilot task count', '10')
    .option('--min-passes <n>', 'Promotion threshold for the full pilot', '5')
    .option('--target-task <name>', 'Task to use for the next targeted canary')
    .option('--model-tier <tier>', 'Model tier for generated benchmark commands', 'cheap')
    .option(
      '--deepinfra-timeout-ms <n>',
      'DeepInfra per-request timeout for generated benchmark commands',
      '240000',
    )
    .option(
      '--waterfall-timeout-ms <n>',
      'Aggregate waterfall timeout for generated benchmark commands',
      '720000',
    )
    .option('--deadline <iso>', 'Wall-clock deadline for generated benchmark commands')
    .option(
      '--min-remaining-ms <n>',
      'Minimum remaining deadline budget before starting benchmark work',
      '0',
    )
    .option(
      '--job-slug <slug>',
      'Stable job slug used in generated benchmark commands',
      'improvement-loop',
    )
    .option('--output-dir <path>', 'Loop report artifact output directory')
    .option(
      '--skip-local-checks',
      'Inspect benchmark history without running local readiness commands',
    )
    .option('--fail-on-unready', 'Exit non-zero when promotion readiness is not yet achieved')
    .action(
      (options: {
        json?: boolean;
        benchmarksRoot?: string;
        suite?: string;
        readiness?: string;
        maxTasks?: string;
        minPasses?: string;
        targetTask?: string;
        modelTier?: string;
        deepinfraTimeoutMs?: string;
        waterfallTimeoutMs?: string;
        deadline?: string;
        minRemainingMs?: string;
        jobSlug?: string;
        outputDir?: string;
        skipLocalChecks?: boolean;
        failOnUnready?: boolean;
      }) => {
        try {
          const report = buildBenchmarkImprovementLoopReport({
            ...(options.benchmarksRoot ? { benchmarksRoot: options.benchmarksRoot } : {}),
            ...(options.suite ? { suite: options.suite } : {}),
            readinessProfile: parseReadinessProfileOption(options.readiness),
            maxTasks: parsePositiveIntOption(options.maxTasks, 10),
            minFullPasses: parsePositiveIntOption(options.minPasses, 5),
            ...(options.targetTask ? { targetTask: options.targetTask } : {}),
            ...(options.modelTier ? { modelTier: options.modelTier } : {}),
            deepInfraTimeoutMs: parsePositiveIntOption(options.deepinfraTimeoutMs, 240000),
            waterfallTimeoutMs: parsePositiveIntOption(options.waterfallTimeoutMs, 720000),
            ...(options.deadline ? { deadlineAt: options.deadline } : {}),
            minRemainingMs: parsePositiveIntOption(options.minRemainingMs, 0),
            ...(options.jobSlug ? { jobSlug: options.jobSlug } : {}),
            ...(options.outputDir ? { outputDir: options.outputDir } : {}),
            runLocalChecks: options.skipLocalChecks !== true,
          });
          printJsonOrHuman(
            report,
            formatBenchmarkImprovementLoopHuman(report),
            options.json === true,
          );
          if (
            report.local_readiness.status === 'fail' ||
            (options.failOnUnready === true && report.readiness_gate.status === 'fail')
          ) {
            process.exit(1);
          }
        } catch (err: unknown) {
          printJsonErrorAndExit(
            err instanceof Error ? err.message : String(err),
            options.json === true,
          );
        }
      },
    );

  // ── Memory management commands ──────────────────────────────────────────
  const memoryCommand = program
    .command('memory')
    .description('Manage persistent project memories from Babel runs')
    .action(() => {
      memoryCommand.help({ error: false });
    });

  memoryCommand
    .command('list')
    .description('List all project memories')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Emit structured JSON only')
    .action(async (options: { projectRoot?: string; json?: boolean }) => {
      const { readProjectMemories } = await import('../services/memoryExtraction.js');
      const entries = readProjectMemories(options.projectRoot);
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        if (entries.length === 0) {
          console.log('No project memories found.');
          return;
        }
        const now = new Date();
        for (const entry of entries) {
          const age = Math.floor((now.getTime() - new Date(entry.date).getTime()) / 86_400_000);
          const stale = age > (entry.staleDays || 30) ? ' [STALE]' : '';
          console.log(`[${entry.date}] ${entry.topic} (${entry.impact})${stale}`);
          console.log(
            `  ${entry.content.slice(0, 120)}${entry.content.length > 120 ? '...' : ''}\n`,
          );
        }
      }
    });

  memoryCommand
    .command('query')
    .description('Search project memories by keyword')
    .argument('<term>', 'Search term')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Emit structured JSON only')
    .action(async (term: string, options: { projectRoot?: string; json?: boolean }) => {
      const { queryMemories } = await import('../services/memoryExtraction.js');
      const results = queryMemories(options.projectRoot, term);
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          console.log(`No memories match "${term}".`);
          return;
        }
        for (const entry of results) {
          console.log(`[${entry.date}] ${entry.topic} (${entry.impact})`);
          console.log(
            `  ${entry.content.slice(0, 200)}${entry.content.length > 200 ? '...' : ''}\n`,
          );
        }
      }
    });

  memoryCommand
    .command('prune')
    .description('Remove stale memories older than N days')
    .option('--max-age <days>', 'Maximum age in days', '30')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (options: { maxAge?: string; projectRoot?: string }) => {
      const { pruneStaleMemories } = await import('../services/memoryExtraction.js');
      const maxAge = Number.parseInt(options.maxAge ?? '30', 10) || 30;
      const pruned = pruneStaleMemories(options.projectRoot, maxAge);
      console.log(
        pruned > 0
          ? `Pruned ${pruned} stale memories (older than ${maxAge} days).`
          : 'No stale memories to prune.',
      );
    });

  memoryCommand
    .command('log')
    .description('Write a daily log entry for the current session')
    .argument('<summary...>', 'Summary of today work')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (summaryParts: string[], options: { projectRoot?: string }) => {
      const { writeDailyLog } = await import('../services/memoryExtraction.js');
      const summary = summaryParts.join(' ');
      writeDailyLog(options.projectRoot, summary);
      console.log('Daily log entry written.');
    });

  // ── File history commands ────────────────────────────────────────────────
  const historyCommand = program
    .command('history')
    .description('Show file change history from Babel runs')
    .action(() => {
      historyCommand.help({ error: false });
    });

  historyCommand
    .command('file')
    .description('Show which runs touched a specific file')
    .argument('<path>', 'File path relative to project root')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Emit structured JSON only')
    .action(async (filePath: string, options: { projectRoot?: string; json?: boolean }) => {
      const { getFileHistory } = await import('../services/fileHistory.js');
      const results = getFileHistory(filePath, options.projectRoot);
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          console.log(`No history found for "${filePath}".`);
          return;
        }
        for (const history of results) {
          const fileRecord = history.files.find(
            (f) => f.path === filePath || f.path.endsWith(filePath),
          );
          const changed = fileRecord?.changed ? 'modified' : 'read';
          console.log(
            `[${history.timestamp}] ${history.runId} — ${changed} (${history.files.filter((f) => f.changed).length} files changed total)`,
          );
        }
      }
    });

  historyCommand
    .command('task')
    .description('Show files touched by a specific run')
    .argument('<run-id>', 'Run ID')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Emit structured JSON only')
    .action(async (runId: string, options: { projectRoot?: string; json?: boolean }) => {
      const { getTaskFileHistory } = await import('../services/fileHistory.js');
      const history = getTaskFileHistory(runId, options.projectRoot);
      if (options.json) {
        console.log(JSON.stringify(history, null, 2));
      } else {
        if (!history) {
          console.log(`No history found for run "${runId}".`);
          return;
        }
        console.log(`Run: ${history.runId}  [${history.timestamp}]`);
        for (const file of history.files) {
          const status = file.changed ? 'CHANGED' : 'UNCHANGED';
          console.log(`  ${status}  ${file.path}`);
        }
      }
    });

  // ── Plan mode commands ───────────────────────────────────────────────────
  program
    .command('create-plan')
    .description('Create an implementation plan without executing it')
    .argument('<task...>', 'Task description')
    .option('--project <name>', 'Target project')
    .action(async (taskParts: string[], options: { project?: string }) => {
      try {
        const task = taskParts.join(' ');
        const { runBabelPipeline } = await import('../pipeline.js');
        const pipelineOptions: Record<string, unknown> = { mode: 'plan' };
        if (options.project) pipelineOptions['project'] = options.project;
        const result = await runBabelPipeline(task, pipelineOptions as any);
        console.log(`Plan created. Run directory: ${result.runDir}`);
        if (result.manualPromptPath) {
          console.log(`Manual prompt: ${result.manualPromptPath}`);
        }
        console.log(
          `\nNext: review the plan, then run "babel apply-plan ${result.runDir}" to execute.`,
        );
      } catch (error: any) {
        console.error(`Plan creation failed: ${error.message}`);
        process.exit(1);
      }
    });

  program
    .command('review-plan')
    .description('Show plan summary from a plan run directory')
    .argument('<plan-dir>', 'Plan run directory path')
    .action(async (planDir: string) => {
      try {
        const planPath = join(planDir, 'model_plan.json');
        if (!existsSync(planPath)) {
          console.error(`No plan found at ${planPath}`);
          process.exit(1);
        }
        const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
        console.log(`Plan: ${plan['task_summary'] ?? 'Unknown'}`);
        console.log(`Run Dir: ${planDir}`);
        const steps = plan['minimal_action_set'] as Array<Record<string, unknown>> | undefined;
        if (steps) {
          console.log(`\nSteps (${steps.length}):`);
          for (const step of steps) {
            console.log(`  ${step['step']}. ${step['tool']}: ${step['target']}`);
          }
        }
        const allowed = plan['out_of_scope'] as string[] | undefined;
        if (allowed && allowed.length > 0) {
          console.log(`\nOut of scope: ${allowed.join(', ')}`);
        }
        console.log(`\nReview the plan above, then use "babel apply-plan ${planDir}" to execute.`);
      } catch (error: any) {
        console.error(`Plan review failed: ${error.message}`);
        process.exit(1);
      }
    });

  program
    .command('apply-plan')
    .description('Execute a saved plan in verified mode')
    .argument('<plan-dir>', 'Plan run directory path')
    .option('--lock <files>', 'Comma-separated locked files')
    .action(async (planDir: string, options: { lock?: string }) => {
      try {
        const { runBabelPipeline } = await import('../pipeline.js');
        const pipelineOptions: Record<string, unknown> = { mode: 'deep' };
        if (options.lock)
          pipelineOptions['lockedFiles'] = options.lock.split(',').map((f) => f.trim());
        const result = await runBabelPipeline(planDir, pipelineOptions as any);
        console.log(`Plan applied. Status: ${result.status}`);
        console.log(`Run directory: ${result.runDir}`);
      } catch (error: any) {
        console.error(`Plan application failed: ${error.message}`);
        process.exit(1);
      }
    });

  // ── Daemon commands (Phase 4A) ──────────────────────────────────────────
  program
    .command('daemon')
    .description('Manage the Babel background daemon')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.parent?.opts();
      if (!opts?.experimental && !process.env['BABEL_DAEMON_ENABLED']) {
        console.warn(
          'Note: daemon features are under active development. Use --experimental to suppress this warning.',
        );
      }
    })
    .addCommand(
      new Command('start')
        .description('Start the daemon process (auto-spawns if not running)')
        .action(async () => {
          const { ensureDaemon, pingDaemon } = await import('../daemon/client.js');
          try {
            await ensureDaemon();
            const ping = await pingDaemon();
            console.log(`Daemon running. PID: ${ping.pid}, Uptime: ${ping.uptime}s`);
          } catch (err: any) {
            console.error(`Failed to start daemon: ${err.message}`);
            process.exit(1);
          }
        }),
    )
    .addCommand(
      new Command('restart').description('Restart the daemon process').action(async () => {
        const { ipcRequest } = await import('../daemon/ipc.js');
        const { ensureDaemon, pingDaemon } = await import('../daemon/client.js');
        try {
          // Graceful shutdown via IPC
          try {
            await ipcRequest('shutdown', undefined, { timeoutMs: 2000 });
            console.log('Previous daemon stopped.');
            // Brief pause to let PID file get cleaned up
            await new Promise((r) => setTimeout(r, 500));
          } catch {
            /* daemon may not be running — that's fine */
          }
          // Auto-spawn a new one
          await ensureDaemon();
          const ping = await pingDaemon();
          console.log(`Daemon restarted. PID: ${ping.pid}`);
        } catch (err: any) {
          console.error(`Failed to restart daemon: ${err.message}`);
          process.exit(1);
        }
      }),
    )
    .addCommand(
      new Command('stop').description('Stop the daemon process').action(async () => {
        const { stopDaemon } = await import('../daemon.js');
        stopDaemon();
      }),
    )
    .addCommand(
      new Command('status')
        .description('Show daemon status')
        .option('--json', 'Emit structured JSON only')
        .action(async (options: { json?: boolean }) => {
          const { getDaemonStatus } = await import('../daemon.js');
          const status = getDaemonStatus();
          if (options.json) {
            console.log(JSON.stringify(status, null, 2));
          } else {
            console.log(`Daemon: ${status.running ? 'RUNNING' : 'STOPPED'}`);
            if (status.running) {
              console.log(`  PID: ${status.pid}`);
              console.log(`  Uptime: ${Math.floor(status.uptime / 60)}m ${status.uptime % 60}s`);
              console.log(`  Queue: ${status.queueSize} tasks`);
              console.log(`  Active: ${status.activeTask ?? '(idle)'}`);
            }
          }
        }),
    );

  // ── Headless execution (Phase 4B) ───────────────────────────────────────
  program
    .command('exec')
    .description('Execute a task in headless/CI mode (non-interactive, JSON output)')
    .argument('<task...>', 'Task description')
    .option('--project <name>', 'Target project')
    .option('--mode <mode>', 'Pipeline mode: deep (or chat | chat-headless | plan)', 'deep')
    .option('--background', 'Enqueue as background task via daemon')
    .option('--budget <tokens>', 'Token budget ceiling')
    .option('--reasoning-effort <level>', 'Model reasoning effort: low | medium | high')
    .option('--json', 'Emit structured JSON only')
    .action(
      async (
        taskParts: string[],
        options: {
          project?: string;
          mode?: string;
          background?: boolean;
          budget?: string;
          reasoningEffort?: string;
          json?: boolean;
        },
      ) => {
        try {
          const task = taskParts.join(' ');

          if (options.background) {
            const { ensureDaemon, pingDaemon } = await import('../daemon/client.js');
            const { ipcRequest } = await import('../daemon/ipc.js');

            // Auto-spawn daemon if not running
            try {
              await ensureDaemon();
            } catch (err: any) {
              console.error(
                `Cannot enqueue background task: daemon is not running and could not be started.`,
              );
              console.error(`  ${err.message}`);
              console.error(`  Start the daemon manually: babel daemon start`);
              process.exit(1);
            }

            // Enqueue via IPC
            const result = (await ipcRequest('queue.enqueue', {
              task,
              mode: options.mode ?? 'deep',
              projectRoot: options.project ?? null,
            })) as { job_id: string; status: string };

            if (options.json) {
              console.log(
                JSON.stringify(
                  { status: 'queued', job_id: result.job_id, job_status: result.status },
                  null,
                  2,
                ),
              );
            } else {
              console.log(`Job queued: ${result.job_id}`);
              console.log(`Check status: babel daemon status`);
            }
            return;
          }

          const { runBabelPipeline } = await import('../pipeline.js');
          process.env['BABEL_HEADLESS'] = 'true';
          if (options.budget) process.env['BABEL_TOKEN_BUDGET'] = options.budget;

          if (options.reasoningEffort !== undefined) {
            const effort = options.reasoningEffort.toLowerCase();
            if (effort === 'low' || effort === 'medium' || effort === 'high') {
              process.env['BABEL_REASONING_EFFORT'] = effort;
            }
          }

          const result = await runBabelPipeline(task, {
            mode: (options.mode as ValidMode) ?? 'deep',
            ...(options.project ? { project: options.project } : {}),
          });

          if (options.json) {
            console.log(JSON.stringify({ status: result.status, runDir: result.runDir }, null, 2));
          } else {
            console.log(`Status: ${result.status}`);
            console.log(`Run: ${result.runDir}`);
          }

          const exitCode =
            result.status === 'COMPLETE' ||
            result.status === 'COMPLETE_NO_MODIFICATION' ||
            result.status === 'SMALL_FIX_COMPLETE' ||
            result.status === 'READ_ONLY_MODE_NO_EXECUTOR'
              ? 0
              : result.status === 'QA_REJECTED_MAX_LOOPS'
                ? 2
                : result.status === 'EXECUTOR_HALTED'
                  ? 1
                  : 3;
          process.exit(exitCode);
        } catch (error: any) {
          console.error(JSON.stringify({ error: error.message }));
          process.exit(3);
        }
      },
    );

  // ── Goal loop (P1.1 — experimental) ────────────────────────────────────
  program
    .command('goal')
    .description('Run an autonomous goal loop (experimental)')
    .argument('<goal...>', 'Goal description')
    .option('--max-iterations <n>', 'Maximum iterations (default: 5)', '5')
    .option('--budget <tokens>', 'Token budget ceiling')
    .option('--mode <mode>', 'Pipeline mode: deep (or chat | chat-headless | plan)', 'deep')
    .option('--project <name>', 'Target project')
    .option('--json', 'Emit structured JSON only')
    .action(
      async (
        goalParts: string[],
        options: {
          maxIterations?: string;
          budget?: string;
          mode?: string;
          project?: string;
          json?: boolean;
        },
      ) => {
        try {
          if (!program.opts().experimental && !process.env['BABEL_DAEMON_ENABLED']) {
            console.error('babel goal requires --experimental.');
            process.exit(1);
          }

          const goal = goalParts.join(' ');
          const { runGoalLoop } = await import('../services/goalLoop.js');

          const result = await runGoalLoop(goal, {
            maxIterations: parsePositiveIntOption(options.maxIterations, 5),
            ...(options.budget ? { tokenBudget: parseInt(options.budget, 10) } : {}),
            mode: (options.mode as ValidMode) ?? 'deep',
            ...(options.project ? { project: options.project } : {}),
          });

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Goal: ${result.goal}`);
            console.log(`Status: ${result.status}`);
            console.log(`Iterations: ${result.iterations.length}`);
            for (const it of result.iterations) {
              const icon =
                it.status === 'COMPLETE' ||
                it.status === 'COMPLETE_NO_MODIFICATION' ||
                it.status === 'SMALL_FIX_COMPLETE'
                  ? '✅'
                  : it.status === 'QA_REJECTED_MAX_LOOPS' || it.status === 'EXECUTOR_HALTED'
                    ? '❌'
                    : '⏭️';
              console.log(`  ${icon} #${it.iteration}: ${it.status} — ${it.summary}`);
            }
            if (result.finalRunDir) {
              console.log(`\nFinal run: ${result.finalRunDir}`);
              console.log(`Inspect: babel inspect run ${result.finalRunDir}`);
            }
          }

          process.exit(result.status === 'goal_met' ? 0 : 1);
        } catch (error: any) {
          console.error(JSON.stringify({ error: error.message }));
          process.exit(3);
        }
      },
    );
}

function parsePositiveIntOption(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseReadinessProfileOption(value: string | undefined): 'fast' | 'full' | 'release' {
  const normalized = String(value ?? 'full')
    .trim()
    .toLowerCase();
  if (normalized === 'fast' || normalized === 'full' || normalized === 'release') {
    return normalized;
  }
  throw new Error(`Invalid readiness profile "${value}". Valid values: fast, full, release`);
}

export function resolveBenchmarkAnalyzeRun(
  raw: string,
  options: { benchmarksRoot?: string; suite: string },
): string {
  if (raw !== 'latest') {
    return resolve(raw);
  }
  const workspaceRoot = dirname(BABEL_ROOT);
  const benchmarksRoot = resolve(options.benchmarksRoot ?? join(workspaceRoot, 'benchmarks'));
  const resultRoot = join(benchmarksRoot, 'runs', 'terminal-bench-2');
  if (!existsSync(resultRoot)) {
    throw buildMissingBenchmarkResultRootError({
      benchmarksRoot,
      resultRoot,
      suite: options.suite,
    });
  }
  const latest = collectBenchmarkResultPaths(resultRoot)
    .map((path) => ({
      path,
      mtimeMs: statSync(path).mtimeMs,
      metadata: readBenchmarkResultMetadata(path),
    }))
    .filter((entry) => entry.metadata.isJobResult)
    .filter((entry) => entry.metadata.suite === null || entry.metadata.suite === options.suite)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) {
    throw new Error(
      `No Terminal-Bench result.json files found for suite ${options.suite} under ${resultRoot}`,
    );
  }
  return latest.path;
}

function buildMissingBenchmarkResultRootError(input: {
  benchmarksRoot: string;
  resultRoot: string;
  suite: string;
}): ActionableCommandError {
  const loopCommand = `node .\\babel-cli\\dist\\index.js benchmark loop --readiness full --suite ${input.suite} --json`;
  const analyzeCommand = `node .\\babel-cli\\dist\\index.js benchmark analyze latest --suite ${input.suite} --json`;
  const payload = {
    status: 'blocked',
    reason: 'terminal_bench_result_root_missing',
    error: `Terminal-Bench result root not found: ${input.resultRoot}`,
    benchmarks_root: input.benchmarksRoot,
    expected_result_root: input.resultRoot,
    suite: input.suite,
    next: [
      'Create or configure the Terminal-Bench results root.',
      'Run a full benchmark loop to establish the baseline.',
      'Re-run benchmark analyze latest after the result.json exists.',
    ],
    commands: {
      run_full_baseline: loopCommand,
      analyze_latest: analyzeCommand,
    },
  };
  const human = [
    'Benchmark analysis blocked',
    `Reason: Terminal-Bench result root is missing.`,
    `Expected: ${input.resultRoot}`,
    '',
    'Next:',
    `- ${payload.next[0]}`,
    `- ${loopCommand}`,
    `- ${analyzeCommand}`,
  ].join('\n');
  return new ActionableCommandError(String(payload.error), payload, human);
}

function collectBenchmarkResultPaths(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectBenchmarkResultPaths(fullPath, out);
    } else if (entry.name === 'result.json') {
      out.push(fullPath);
    }
  }
  return out;
}

function readBenchmarkResultMetadata(path: string): { suite: string | null; isJobResult: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const suite = record['suite'];
      return {
        suite: typeof suite === 'string' ? suite : null,
        isJobResult:
          record['summary'] !== undefined &&
          (Array.isArray(record['results']) || Array.isArray(record['trials'])),
      };
    }
  } catch {
    return { suite: null, isJobResult: false };
  }
  return { suite: null, isJobResult: false };
}
