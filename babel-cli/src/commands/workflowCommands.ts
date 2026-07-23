import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as readline from 'node:readline/promises';

import { Command } from 'commander';

import { BabelEventBus, runBabelPipeline, resumeManualBridge } from '../pipeline.js';
import { getAvailableModels, resolveFamilyModelPolicy } from '../modelPolicy.js';
import { createLiveRunRenderer } from '../ui/waterfall.js';
import {
  getExecutionProfileHelpText,
  getExecutionProfileToolPolicy,
  normalizeExecutionProfile,
  resolveExecutionProfile,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { buildSmokeFixtures } from '../services/smokeFixtures.js';
import {
  resolveApprovedWorkspacePath,
  verifyWorkspaceProject,
} from '../services/workspaceManager.js';
import {
  isModelEscalationApproved,
  requestModelEscalationApproval,
} from '../services/approvalQueue.js';
import { evaluateCompletionVerification } from '../services/completionVerification.js';
import {
  buildTerminalStatusSummary,
  isReadOnlyNoModificationRequest,
  type TerminalStatus,
} from '../services/terminalStatus.js';
import {
  BABEL_ROOT,
  VALID_MODEL_TIERS,
  VALID_MODES,
  VALID_ORCHESTRATORS,
  type ValidMode,
  type ValidOrchestrator,
} from '../cli/constants.js';
import {
  copyFileToClipboard,
  detectProjectFromCwd,
  extractHaltTagFromExecutionReport,
  extractMcpLifecycleFromExecutionReport,
  extractStructuredDenialFromExecutionReport,
  normalizeModelName,
  openPlanEditor,
  parseCommaSeparatedFiles,
  readClipboardPlanText,
  readLatestRunPointer,
  readStdinFully,
  resolveProjectRoot,
  withMutedConsole,
} from '../cli/helpers.js';
import {
  attachRunEventStream,
  buildAskResultPayload,
  buildLiteResultPayload,
  buildRunResultPayload,
  formatHumanOutputReviewNote,
  formatLiteResultHuman,
  formatRunResultHuman,
  getSchemaRetrySummary,
  makeRunStreamEvent,
  parseRunOutputFormat,
  type LiteResultPayload,
  type LiteVerb,
  writeHumanSummaryArtifact,
  writeJson,
  writeNdjson,
} from '../cli/structuredOutput.js';
import { validateRuntimeEnvForCommand } from './coreCommands.js';
import { applyRunCommandEnvFlags } from './runCommandEnv.js';
import {
  assertEnvFileActiveForPipelineCommand,
  formatEnvFileInactiveMessage,
  getEnvFileKeysNotActiveInProcess,
  isStrictEnvMode,
} from '../config/envBootstrap.js';
import { writeTextRunPrelude } from '../ui/runPrelude.js';
import { runCliChatTask } from '../interactive/execution/chatCore.js';
import { runAskAnswerPath } from '../services/askAnswer.js';
import { buildRecoveryAssessment, formatRecoveryAssessmentHuman } from '../services/recovery.js';
import {
  buildLiteContinueAssessment,
  formatLiteContinueAssessmentHuman,
  resumeLiteWorkerChain,
} from '../services/liteRecovery.js';
import { formatResumeExecutionHuman, resumeExecution } from '../services/resumeExecution.js';
import {
  runSmallFixPath,
  SmallFixRecoverableError,
  type SmallFixCompleted,
} from '../services/smallFix.js';
import { formatBabelFullHuman, runBabelFullPlan } from '../services/babelFull.js';
import {
  liteVerbForSelectedLane,
  resolveDailyProfile,
  routeLiteOrFull,
  type LiteFullAgentsMode,
  type LiteFullRouteDecision,
} from '../services/liteFullRouter.js';
import { AgentSession, buildSmallFixLitePayload } from '../agent/session.js';
import type { LiteSessionVerb } from '../agent/contracts.js';
import {
  applyLiteOfflineEnv,
  normalizeSmallFixProvider,
  providerUsesOfflineEnv,
  resolveSmallFixProviderForCommand,
  restoreLiteOfflineEnv,
  snapshotLiteOfflineEnv,
} from '../agent/provider/textProviderLane.js';
import { resolveAgentTarget } from '../services/targetResolver.js';
import { createLiteFixProgress } from '../ui/liteFixProgress.js';
import { runLiteSessionWithSchemaRecovery } from '../services/liteSessionRunner.js';
import { registerDogfoodCommands } from './dogfoodCommands.js';
import { loadPlanHandoff } from '../agent/planHandoff.js';
import { runPlanReviewLane } from '../agent/lanes/planReviewLane.js';
import { resolveFuzzyWorkspaceDirectory } from '../services/pathScanner.js';

export { buildSmallFixLitePayload, normalizeSmallFixProvider, resolveSmallFixProviderForCommand };
export const READ_ONLY_LITE_TOOLS = [
  'directory_list',
  'file_read',
  'semantic_search',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
];

interface DeepCommandOptions {
  project?: string;
  projectRoot?: string;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  executionProfile?: string;
  json?: boolean;
  ask?: boolean;
}

async function promptPlanApproval(task: string, autoApprove = false): Promise<boolean> {
  if (autoApprove) {
    process.stderr.write(`Auto-approved via --approve: ${task}\n`);
    return true;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    process.stderr.write('\n');
    process.stderr.write('Approve this plan and apply it now? [y/N] ');
    const answer = (await rl.question('')).trim().toLowerCase();
    if (/^(?:y|yes|approve|approved|apply|go)$/i.test(answer)) {
      process.stderr.write(`Applying approved task: ${task}\n`);
      return true;
    }
    process.stderr.write('Kept as plan-only. No files were changed.\n');
    return false;
  } finally {
    rl.close();
  }
}

async function runDeepCommand(taskParts: string[], options: DeepCommandOptions): Promise<void> {
  const task = normalizeLiteTask(taskParts);
  if (!task) {
    throw new Error('babel deep requires task text.');
  }

  if (options.ask === true) {
    process.env['BABEL_ASK'] = 'true';
  }

  validateRuntimeEnvForCommand({ json: options.json === true });
  const normalizedModel = normalizeModelName(options.model);
  const normalizedModelTier =
    options.modelTier !== undefined ? options.modelTier.trim().toLowerCase() : undefined;
  const executionProfile = normalizeExecutionProfile(options.executionProfile ?? 'safe_repo');
  const resolvedProject = options.project ?? detectProjectFromCwd() ?? undefined;

  if (executionProfile === null) {
    throw new Error(
      `Invalid execution profile "${options.executionProfile}". Valid values: ${getExecutionProfileHelpText().replace(/ \| /g, ', ')}`,
    );
  }
  if (options.model !== undefined && normalizedModel === undefined) {
    throw new Error(
      `Invalid model "${options.model}". Valid values: ${getAvailableModels()
        .map((m) => m.key)
        .join(', ')} (case-insensitive)`,
    );
  }
  if (
    normalizedModelTier !== undefined &&
    !VALID_MODEL_TIERS.includes(normalizedModelTier as (typeof VALID_MODEL_TIERS)[number])
  ) {
    throw new Error(
      `Invalid model tier "${options.modelTier}". Valid values: ${VALID_MODEL_TIERS.join(', ')}`,
    );
  }

  let resolvedProjectRoot: string | undefined;
  let resolvedWorkspaceRoot: string | null = null;
  let resolvedAllowedRoots: string[] = [];
  if (options.projectRoot !== undefined) {
    const resolved = resolveApprovedWorkspacePath(options.projectRoot);
    resolvedProjectRoot = resolved.path;
    resolvedAllowedRoots = resolved.approvedRoots;
  } else {
    const target = resolveAgentTarget({
      ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
    });
    resolvedProjectRoot = target.targetRoot;
    resolvedWorkspaceRoot = target.workspaceRoot;
  }

  if (resolvedProjectRoot !== undefined && !existsSync(resolvedProjectRoot)) {
    const message = `Resolved target root does not exist: ${resolvedProjectRoot}`;
    if (options.json === true) {
      writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
    } else {
      process.stdout.write(
        `${formatRunResultHuman({
          ...buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
          command: 'deep',
          task,
          project: resolvedProject ?? null,
          run_dir: null,
          changed_files: [],
          verification: {
            status: 'failed',
            commands: [],
            skipped_reason: message,
          },
          scope: {
            project_root: resolvedProjectRoot,
            allowed_write_paths: [],
            refused_paths: [resolvedProjectRoot],
          },
          checkpoint: {
            required: false,
            available: false,
            restore_command: null,
            inspect_command: null,
          },
          evidence: {
            run_dir: null,
            support_path: null,
            artifacts: [],
          },
        })}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const effectiveAllowExpensive = resolveEffectiveAllowExpensive({
    task,
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
    ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
    allowExpensive: options.allowExpensive === true,
    outputFormat: options.json === true ? 'json' : 'text',
    manual: false,
  });

  if (options.json !== true) {
    writeTextRunPrelude({
      task,
      mode: 'deep',
      ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
      orchestrator: process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9',
      executionProfile,
      ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
    });
  }

  const eventBus = new BabelEventBus();
  const runOutputContext = {
    task,
    mode: 'deep' as ValidMode,
    ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
    ...(normalizedModel !== undefined ? { requestedModel: normalizedModel } : {}),
    ...(normalizedModelTier !== undefined ? { requestedModelTier: normalizedModelTier } : {}),
    orchestrator: process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9',
    allowedTools: [],
    disallowedTools: [],
    executionProfile,
    ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
  };
  const liveRenderer =
    options.json === true ? null : createLiveRunRenderer(eventBus, runOutputContext);
  liveRenderer?.start();

  try {
    const result = await withExecutionProfileEnv(executionProfile, [], [], () =>
      withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () =>
        withMutedConsole(() =>
          runBabelPipeline(task, {
            ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
            ...(normalizedModel !== undefined ? { modelOverride: normalizedModel } : {}),
            ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
            ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
            ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
            mode: 'deep',
            executionProfile,
            eventBus,
          }),
        ),
      ),
    );
    liveRenderer?.stop();

    const completionVerification = buildCompletionVerificationForRun({
      pipelineStatus: result.status,
      executionProfile,
      ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
    });
    const payload = buildRunResultPayload(result, runOutputContext);
    payload['command'] = 'deep';
    payload['completion_verification'] = completionVerification;
    if (completionVerification.status === 'fail') {
      payload['status'] = 'VERIFIER_FAILED';
    }

    if (options.json === true) {
      writeJson(payload);
    } else {
      const human = formatRunResultHuman(payload);
      const review = writeHumanSummaryArtifact(
        result.runDir,
        human,
        [
          typeof liveRenderer?.getTranscript === 'function' ? liveRenderer.getTranscript() : '',
          human,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      process.stdout.write(`${human}\n`);
      const note = formatHumanOutputReviewNote(review);
      if (note) {
        process.stdout.write(`\n${note}\n`);
      }
    }

    if (!isSuccessfulRunStatus(result.status) || completionVerification.status === 'fail') {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    liveRenderer?.fail(err);
    const message = err instanceof Error ? err.message : String(err);
    if (options.json === true) {
      writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
    } else {
      process.stdout.write(
        `${formatRunResultHuman({
          ...buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
          command: 'deep',
          task,
          project: resolvedProject ?? null,
          run_dir: null,
          changed_files: [],
          verification: {
            status: 'failed',
            commands: [],
            skipped_reason: null,
          },
          checkpoint: {
            required: false,
            available: false,
            restore_command: null,
            inspect_command: null,
          },
          evidence: {
            run_dir: null,
            support_path: null,
            artifacts: [],
          },
        })}\n`,
      );
    }
    process.exitCode = 1;
  }
}

export { shouldRecoverLitePlanSchemaFailure } from '../services/liteSessionRunner.js';

function preflightRequestedModelPolicy(
  model: string,
  options: { modelTier?: string; allowExpensive?: boolean },
) {
  return resolveFamilyModelPolicy({
    family: model,
    ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
    allowExpensive: options.allowExpensive === true,
    babelRoot: BABEL_ROOT,
  });
}

function isModelEscalationPolicyError(message: string): boolean {
  return /expensive or blocked by policy|blocked by policy|explicit opt-in|\[ENTERPRISE_POLICY\]/i.test(
    message,
  );
}

function printModelEscalationApprovalRequired(options: {
  task: string;
  model?: string;
  modelTier?: string;
  projectRoot?: string;
  outputFormat?: string;
  manual?: boolean;
}): never {
  const request = requestModelEscalationApproval({
    task: options.task,
    model: options.model ?? null,
    modelTier: options.modelTier ?? null,
    projectRoot: options.projectRoot ?? null,
  });
  const payload = {
    status: options.manual === true ? 'MANUAL_BRIDGE_APPROVAL_REQUIRED' : 'APPROVAL_REQUIRED',
    action: 'Babel will call the selected model provider for this task.',
    scope: {
      task: options.task,
      project_root: options.projectRoot ?? null,
      model: options.model ?? null,
      model_tier: options.modelTier ?? null,
    },
    boundary:
      'This selected model route is expensive or blocked by policy, so Babel needs one explicit approval before it runs.',
    may_send: [
      'task text',
      'selected Babel prompt layers',
      'relevant file snippets',
      'verifier or log output',
    ],
    approval_required: true,
    approval_kind: 'model_escalation',
    approval_id: request.record.id,
    approval: request.record,
    approval_command: `babel approvals approve ${request.record.id}`,
    after_approval: 'Re-run the original command.',
    next: [
      'For a one-off interactive run, re-run with --allow-expensive if you accept this model/cost boundary.',
      `babel approvals approve ${request.record.id}`,
      'For unattended jobs, approve the queued request and re-run the blocked Babel command.',
    ],
  };
  if (options.outputFormat === 'stream-json') {
    writeNdjson(makeRunStreamEvent('run_error', payload));
  } else {
    writeJson(payload);
  }
  process.exit(1);
}

function resolveEffectiveAllowExpensive(options: {
  task: string;
  model?: string;
  modelTier?: string;
  projectRoot?: string;
  allowExpensive?: boolean;
  outputFormat?: string;
  manual?: boolean;
}): boolean {
  if (options.allowExpensive === true) {
    return true;
  }

  if (options.modelTier === 'escalation') {
    return true;
  }

  if (
    isModelEscalationApproved({
      task: options.task,
      model: options.model ?? null,
      modelTier: options.modelTier ?? null,
      projectRoot: options.projectRoot ?? null,
    })
  ) {
    return true;
  }

  return false;
}

function buildCompletionVerificationForRun(input: {
  pipelineStatus: string;
  executionProfile: ExecutionProfileName;
  projectRoot?: string;
}) {
  const verification =
    input.pipelineStatus === 'COMPLETE' &&
    input.executionProfile === 'opencalw_manager' &&
    input.projectRoot
      ? verifyWorkspaceProject(input.projectRoot)
      : null;

  return evaluateCompletionVerification({
    pipelineStatus: input.pipelineStatus,
    executionProfile: input.executionProfile,
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    verification,
  });
}

function buildRunCommandFailurePayload(input: {
  status: TerminalStatus;
  message: string;
}): Record<string, unknown> {
  const recovery = buildRecoveryAssessment({ run: 'latest' });
  const executionReport =
    recovery.available_artifacts.find((artifact) => artifact.key === 'execution_report')?.path ??
    null;
  const failureCapsule =
    recovery.available_artifacts.find((artifact) => artifact.key === 'failure_capsule')?.path ??
    null;
  const payload: Record<string, unknown> = {
    status: input.status,
    error: input.message,
    terminal_status: buildTerminalStatusSummary({
      status: input.status,
      condition: input.message,
    }),
    recovery: {
      status: recovery.status,
      classification: recovery.classification,
      retryable: recovery.retryable,
      reason: recovery.reason,
      next_action: recovery.next_action,
      next_command: recovery.next_command,
      run_dir: recovery.run_dir,
      available_artifacts: recovery.available_artifacts,
      missing_artifacts: recovery.missing_artifacts,
    },
  };
  if (
    recovery.status === 'CONTINUE_READY' &&
    recovery.run_dir &&
    recovery.classification !== null &&
    (executionReport || failureCapsule)
  ) {
    payload['status'] = recovery.retryable ? 'FAILED_RETRYABLE' : input.status;
    payload['reason'] = recovery.reason;
    payload['retryable'] = recovery.retryable;
    payload['run_dir'] = recovery.run_dir;
    payload['failure_capsule_path'] = failureCapsule;
    payload['execution_report_path'] = executionReport;
    payload['next_command'] = recovery.next_command ?? 'babel continue latest';
    payload['missing_artifacts'] = recovery.missing_artifacts;
  }
  return payload;
}

function isSuccessfulRunStatus(status: string): boolean {
  return (
    status === 'COMPLETE' ||
    status === 'COMPLETE_NO_MODIFICATION' ||
    status === 'READ_ONLY_NO_MODIFICATION'
  );
}

const READ_ONLY_RUN_TOOLS = [
  'directory_list',
  'file_read',
  'semantic_search',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
];

function isExplicitModeArg(): boolean {
  return process.argv.some((arg) => arg === '--mode' || arg.startsWith('--mode='));
}

function isSimpleReadOnlyQuestion(task: string): boolean {
  return (
    /\?/.test(task) ||
    /\b(what is|what's|explain|summarize|describe|where is|why is|how does|list|show me|inspect|audit)\b/i.test(
      task,
    )
  );
}

export function shouldUseReadOnlyRunQuestionPath(input: {
  task: string;
  explicitMode: boolean;
  hasAllowedTools: boolean;
  hasDisallowedTools: boolean;
  hasLock: boolean;
}): boolean {
  return (
    !input.explicitMode &&
    isSimpleReadOnlyQuestion(input.task) &&
    !input.hasAllowedTools &&
    !input.hasDisallowedTools &&
    !input.hasLock
  );
}

async function runReadOnlyQuestionAsRun(input: {
  task: string;
  project?: string;
  projectRoot: string;
  workspaceRoot?: string | null;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
}): Promise<Record<string, unknown>> {
  const ask = await runAskAnswerPath({
    task: input.task,
    ...(input.project !== undefined ? { project: input.project } : {}),
    projectRoot: input.projectRoot,
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelTier !== undefined ? { modelTier: input.modelTier } : {}),
    ...(input.allowExpensive === true ? { allowExpensive: true } : {}),
    ...(input.showModelPolicy === true ? { showModelPolicy: true } : {}),
  });
  const payload = buildAskResultPayload({
    answer: ask.answer,
    task: input.task,
    ...(input.project !== undefined ? { project: input.project } : {}),
    projectRoot: input.projectRoot,
    runDir: ask.runDir,
    usageSummary: ask.usageSummary,
    sessionLoopSteps: ask.sessionLoopSteps,
  }) as unknown as Record<string, unknown>;
  payload['command'] = 'run';
  payload['mode'] = 'chat';
  payload['checks'] = ['read-only answer path'];
  payload['tool_policy'] = {
    allowed_tools: READ_ONLY_RUN_TOOLS,
    disallowed_tools: [],
  };
  payload['routing'] = {
    orchestrator: 'lite_read_only',
    requested_model: input.model ?? null,
    requested_model_tier: input.modelTier ?? null,
    target_project: input.project ?? null,
    task_category: 'Research',
    pipeline_mode: 'chat',
    domain_id: null,
    model_adapter_id: null,
    selected_entry_ids: [],
    prompt_manifest_count: 0,
  };
  payload['completion_verification'] = {
    schema_version: 1,
    status: 'not_required',
    reason: 'Completion verification is not required for read-only answer runs.',
    required: false,
    verification: null,
  };
  return payload;
}

async function runChatEngineAsRun(input: {
  task: string;
  project?: string;
  projectRoot: string;
  workspaceRoot?: string | null;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  outputFormat?: 'text' | 'json' | 'stream-json';
  onStreamEvent?: (event: { type: 'assistant_chunk'; chunk: string } | { type: 'thought'; text: string }) => void;
}): Promise<Record<string, unknown>> {
  const { payload } = await runCliChatTask(input);
  return payload;
}

async function withToolPolicyEnv<T>(
  allowedTools: string[],
  disallowedTools: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const previousAllowed = process.env['BABEL_ALLOWED_TOOLS'];
  const previousDisallowed = process.env['BABEL_DISALLOWED_TOOLS'];

  if (allowedTools.length > 0) {
    process.env['BABEL_ALLOWED_TOOLS'] = JSON.stringify(allowedTools);
  } else {
    delete process.env['BABEL_ALLOWED_TOOLS'];
  }

  if (disallowedTools.length > 0) {
    process.env['BABEL_DISALLOWED_TOOLS'] = JSON.stringify(disallowedTools);
  } else {
    delete process.env['BABEL_DISALLOWED_TOOLS'];
  }

  try {
    return await fn();
  } finally {
    if (previousAllowed === undefined) {
      delete process.env['BABEL_ALLOWED_TOOLS'];
    } else {
      process.env['BABEL_ALLOWED_TOOLS'] = previousAllowed;
    }

    if (previousDisallowed === undefined) {
      delete process.env['BABEL_DISALLOWED_TOOLS'];
    } else {
      process.env['BABEL_DISALLOWED_TOOLS'] = previousDisallowed;
    }
  }
}

function uniqueTools(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function mergeAllowedTools(userAllowed: string[], profileAllowed: string[]): string[] {
  const normalizedUserAllowed = uniqueTools(userAllowed);
  const normalizedProfileAllowed = uniqueTools(profileAllowed);
  if (normalizedProfileAllowed.length === 0) {
    return normalizedUserAllowed;
  }
  if (normalizedUserAllowed.length === 0) {
    return normalizedProfileAllowed;
  }
  return normalizedUserAllowed.filter((tool) => normalizedProfileAllowed.includes(tool));
}

async function withExecutionProfileEnv<T>(
  executionProfileName: ExecutionProfileName,
  allowedTools: string[],
  disallowedTools: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const profilePolicy = getExecutionProfileToolPolicy(executionProfileName);
  const mergedAllowedTools = mergeAllowedTools(allowedTools, profilePolicy.allowedTools);
  const mergedDisallowedTools = uniqueTools([...disallowedTools, ...profilePolicy.disallowedTools]);

  process.env['BABEL_EXECUTION_PROFILE'] = executionProfileName;
  try {
    return await withToolPolicyEnv(mergedAllowedTools, mergedDisallowedTools, fn);
  } finally {
    if (previousProfile === undefined) {
      delete process.env['BABEL_EXECUTION_PROFILE'];
    } else {
      process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    }
  }
}

async function withProjectRootEnv<T>(
  projectRoot: string | undefined,
  allowedRoots: string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (!projectRoot) {
    return fn();
  }

  const previousProjectRoot = process.env['BABEL_PROJECT_ROOT'];
  const previousAllowedRoots = process.env['BABEL_ALLOWED_ROOTS'];
  process.env['BABEL_PROJECT_ROOT'] = projectRoot;
  if (allowedRoots.length > 0) {
    process.env['BABEL_ALLOWED_ROOTS'] = allowedRoots.join(',');
  }

  try {
    return await fn();
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env['BABEL_PROJECT_ROOT'];
    } else {
      process.env['BABEL_PROJECT_ROOT'] = previousProjectRoot;
    }

    if (previousAllowedRoots === undefined) {
      delete process.env['BABEL_ALLOWED_ROOTS'];
    } else {
      process.env['BABEL_ALLOWED_ROOTS'] = previousAllowedRoots;
    }
  }
}

async function runManualBridgeStart(
  task: string,
  options: {
    project?: string;
    model?: string;
    sessionId?: string;
    sessionStartPath?: string;
    localLearningRoot?: string;
    orchestratorVersion?: string;
    modelTier?: string;
    allowExpensive?: boolean;
    showModelPolicy?: boolean;
    lockedFiles?: string[];
    executionProfile?: ExecutionProfileName;
  },
): Promise<void> {
  validateRuntimeEnvForCommand({ json: true });

  const executionProfile =
    options.executionProfile ??
    resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']).name;
  const result = await withExecutionProfileEnv(executionProfile, [], [], () =>
    withMutedConsole(() =>
      runBabelPipeline(task, {
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.model !== undefined ? { modelOverride: options.model } : {}),
        ...(options.orchestratorVersion !== undefined
          ? { orchestratorVersion: options.orchestratorVersion as ValidOrchestrator }
          : {}),
        ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
        ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
        ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.sessionStartPath !== undefined
          ? { sessionStartPath: options.sessionStartPath }
          : {}),
        ...(options.localLearningRoot !== undefined
          ? { localLearningRoot: options.localLearningRoot }
          : {}),
        ...(options.lockedFiles !== undefined && options.lockedFiles.length > 0
          ? { lockedFiles: options.lockedFiles }
          : {}),
        executionProfile,
        mode: 'plan',
      }),
    ),
  );

  if (result.status !== 'MANUAL_BRIDGE_REQUIRED' || !result.manualPromptPath) {
    throw new Error(`Manual bridge expected MANUAL_BRIDGE_REQUIRED, got ${result.status}`);
  }

  const clipboard = copyFileToClipboard(result.manualPromptPath);
  const payload: Record<string, unknown> = {
    status: 'MANUAL_BRIDGE_REQUIRED',
    run_dir: result.runDir,
    prompt_path: result.manualPromptPath,
    next: [
      'babel apply',
      'If plan.json is not ready, apply opens editor at <run_dir>/manual/plan.json.',
      'You can also run: babel apply --plan clipboard',
      'Or paste via stdin: babel apply --plan -',
    ],
  };
  if (options.showModelPolicy === true && result.modelPolicy) {
    payload['model_policy'] = result.modelPolicy;
  }

  if (clipboard.ok) {
    payload['clipboard'] = 'COPIED';
  } else {
    payload['clipboard'] = 'FAILED';
    payload['warning'] = clipboard.warning;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeLiteTask(taskParts: string[]): string {
  return taskParts.join(' ').trim();
}

type LiteCommandOptions = {
  project?: string;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  projectRoot?: string;
  executionProfile?: string;
  liteOnly?: boolean;
  agents?: string;
  provider?: string;
  workerChain?: boolean;
  rollbackOnFail?: boolean;
  json?: boolean;
  stream?: boolean;
  finalOnly?: boolean;
  humanSummary?: boolean;
  ask?: boolean;
};

async function handleLiteContinueCommand(
  run: string,
  options: {
    project?: string;
    projectRoot?: string;
    provider?: string;
    json?: boolean;
    resume?: boolean;
  },
): Promise<void> {
  const resolvedProjectRoot =
    options.projectRoot !== undefined
      ? resolve(options.projectRoot)
      : process.env['BABEL_PROJECT_ROOT'] !== undefined
        ? resolve(process.env['BABEL_PROJECT_ROOT'])
        : undefined;
  const continueOptions = {
    run,
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    json: options.json === true,
  };

  if (options.resume !== false) {
    const resumed = await resumeLiteWorkerChain(continueOptions);
    if (resumed) {
      if (options.json === true) {
        writeJson(resumed.payload);
      } else if (resumed.humanText) {
        process.stdout.write(`${resumed.humanText}\n`);
      }
      if (resumed.exitCode !== 0) {
        process.exitCode = resumed.exitCode;
      }
      return;
    }
  }

  const assessment = buildLiteContinueAssessment(continueOptions);
  if (options.json === true) {
    writeJson(assessment);
  } else {
    process.stdout.write(`${formatLiteContinueAssessmentHuman(assessment)}\n`);
  }
  if (assessment.status !== 'CONTINUE_READY' && assessment.status !== 'CHAIN_COMPLETE') {
    process.exitCode = 1;
  }
}

function buildLiteTask(verb: LiteVerb, task: string): string {
  if (verb === 'ask') {
    return `Answer in read-only mode. Do not modify files. Do not propose an edit unless the user asks for a plan or fix. ${task}`;
  }
  if (verb === 'plan') {
    return `Plan only, do not modify. ${task}`;
  }
  if (verb === 'patch' || verb === 'propose' || verb === 'diff') {
    return `Produce a proposal-only patch or diff plan. Do not modify files. Do not apply changes. ${task}`;
  }
  return task;
}

function toSessionVerb(verb: LiteVerb): LiteSessionVerb {
  return verb;
}

function printLiteResult(
  result: Awaited<ReturnType<typeof runBabelPipeline>>,
  context: {
    verb: LiteVerb;
    task: string;
    mode: ValidMode;
    project?: string;
    projectRoot?: string;
    requestedModel?: string;
    requestedModelTier?: string;
    allowedTools?: string[];
    selectedLane?: Exclude<LiteVerb, 'do'>;
    routeDecision?: LiteFullRouteDecision;
    json?: boolean;
  },
): void {
  const payload = buildLiteResultPayload(result, {
    verb: context.verb,
    task: context.task,
    mode: context.mode,
    ...(context.project !== undefined ? { project: context.project } : {}),
    ...(context.projectRoot !== undefined ? { projectRoot: context.projectRoot } : {}),
    ...(context.requestedModel !== undefined ? { requestedModel: context.requestedModel } : {}),
    ...(context.requestedModelTier !== undefined
      ? { requestedModelTier: context.requestedModelTier }
      : {}),
    orchestrator: process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9',
    ...(context.allowedTools !== undefined ? { allowedTools: context.allowedTools } : {}),
    ...(context.selectedLane !== undefined ? { selectedLane: context.selectedLane } : {}),
    ...(context.routeDecision !== undefined ? { routeDecision: context.routeDecision } : {}),
  });

  if (context.json === true) {
    writeJson(payload);
  } else {
    process.stdout.write(`${formatLiteResultHuman(payload)}\n`);
  }
}

function printFullRouteResult(input: {
  task: string;
  routeDecision: ReturnType<typeof routeLiteOrFull>;
  projectRoot?: string;
  agentsMode: LiteFullAgentsMode;
  json?: boolean;
}): void {
  const result = runBabelFullPlan(input.task, {
    routeDecision: input.routeDecision,
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    agentsMode: input.agentsMode,
  });
  if (input.json === true) {
    writeJson(result);
  } else {
    process.stdout.write(`${formatBabelFullHuman(result)}\n`);
  }
}

function normalizeAgentsMode(value: string | undefined): LiteFullAgentsMode {
  const normalized = (value ?? 'read-only').trim().toLowerCase();
  if (normalized === 'off') return 'off';
  if (normalized === 'read-only' || normalized === 'readonly') return 'read-only';
  throw new Error(`Invalid agents mode "${value}". Valid values: off, read-only`);
}

function getRecoverableErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof SmallFixRecoverableError) {
    return {
      run_dir: error.runDir,
      support_path: error.supportPath,
      recoverable: error.recoverable,
      next: error.next,
      failure_code: error.failureCode,
      next_command: error.nextCommand,
      recovery: buildRecoveryAssessment({ run: error.runDir }),
    };
  }
  if (error === null || typeof error !== 'object') {
    return {};
  }
  const record = error as Record<string, unknown>;
  const runDir = typeof record['runDir'] === 'string' ? record['runDir'] : null;
  if (!runDir) {
    return {};
  }
  return {
    run_dir: runDir,
    support_path: typeof record['supportPath'] === 'string' ? record['supportPath'] : runDir,
    recoverable: true,
    next: [
      typeof record['nextCommand'] === 'string' ? record['nextCommand'] : 'babel continue latest',
    ],
    next_command:
      typeof record['nextCommand'] === 'string' ? record['nextCommand'] : 'babel continue latest',
    recovery: buildRecoveryAssessment({ run: runDir }),
  };
}

export function classifyDoTask(task: string): Exclude<LiteVerb, 'do'> {
  const normalized = task.toLowerCase();
  const hasMutationIntent =
    /\b(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove)\b/.test(
      normalized,
    );
  const startsWithPlanningIntent =
    /^\s*(plan|design|approach|compare|outline)\b/.test(normalized) ||
    /\b(implementation path|migration plan)\b/.test(normalized);
  if (
    startsWithPlanningIntent &&
    !/^\s*(apply|fix|repair|write|create|delete|remove)\b/.test(normalized)
  ) {
    return 'plan';
  }
  if (
    /\b(explain|summarize|what|why|how|read[- ]only|do not edit|do not modify|without editing|without changes)\b/.test(
      normalized,
    ) &&
    !hasMutationIntent
  ) {
    return 'ask';
  }
  if (
    /\b(plan|design|approach|compare|implementation path)\b/.test(normalized) &&
    !hasMutationIntent
  ) {
    return 'plan';
  }
  if (
    /\b(investigate|analy[sz]e|audit|diagnose|diagnostic|assess|report|findings?|evaluate)\b/.test(
      normalized,
    ) &&
    !hasMutationIntent
  ) {
    return 'report';
  }
  if (
    /\b(patch|diff|propose|proposal)\b/.test(normalized) &&
    !/\b(apply|edit|modify|change|fix|repair|implement|write|create|delete|remove)\b/.test(
      normalized,
    )
  ) {
    return 'patch';
  }
  if (hasMutationIntent) {
    return 'fix';
  }
  return 'plan';
}

async function runLiteCommand(
  verb: LiteVerb,
  taskParts: string[],
  options: LiteCommandOptions,
): Promise<void> {
  let task = normalizeLiteTask(taskParts);
  if (!task) {
    if (verb === 'undo') {
      task = 'Restore last checkpoint';
    } else {
      throw new Error(`babel ${verb} requires task text.`);
    }
  }

  if (options.ask === true) {
    process.env['BABEL_ASK'] = 'true';
  }

  validateRuntimeEnvForCommand({ json: options.json === true });

  // Capture the working directory at boot for consumers that need a directory
  // anchor. BABEL_SESSION_START_PATH is intentionally NOT set here — it should
  // only contain a session-start JSON file path set by the launch scripts.
  // Setting it to process.cwd() would cause downstream consumers like
  // readSessionStartProjectPath to attempt readFileSync on a directory.
  const cwdAtBoot = process.cwd();
  process.env['BABEL_TASK'] = task;

  const normalizedModel = normalizeModelName(options.model);
  const normalizedModelTier =
    options.modelTier !== undefined ? options.modelTier.trim().toLowerCase() : undefined;
  const executionProfile = normalizeExecutionProfile(options.executionProfile ?? 'safe_repo');
  const resolvedProject = options.project ?? detectProjectFromCwd() ?? undefined;
  const routeDecision = routeLiteOrFull(task, {
    requestedVerb: verb === 'report' ? 'do' : verb,
    forceLiteOnly: options.liteOnly === true,
    dailyProfile: resolveDailyProfile(),
  });

  if (executionProfile === null) {
    throw new Error(
      `Invalid execution profile "${options.executionProfile}". Valid values: ${getExecutionProfileHelpText().replace(/ \| /g, ', ')}`,
    );
  }

  if (options.model !== undefined && normalizedModel === undefined) {
    throw new Error(
      `Invalid model "${options.model}". Valid values: ${getAvailableModels()
        .map((m) => m.key)
        .join(', ')} (case-insensitive)`,
    );
  }

  if (
    normalizedModelTier !== undefined &&
    !VALID_MODEL_TIERS.includes(normalizedModelTier as (typeof VALID_MODEL_TIERS)[number])
  ) {
    throw new Error(
      `Invalid model tier "${options.modelTier}". Valid values: ${VALID_MODEL_TIERS.join(', ')}`,
    );
  }

  let resolvedProjectRoot: string | undefined;
  let resolvedWorkspaceRoot: string | null = null;
  let resolvedAllowedRoots: string[] = [];
  if (options.projectRoot !== undefined) {
    if (executionProfile === 'opencalw_manager') {
      const resolved = resolveApprovedWorkspacePath(options.projectRoot);
      resolvedProjectRoot = resolved.path;
      resolvedAllowedRoots = resolved.approvedRoots;
    } else {
      resolvedProjectRoot = resolve(options.projectRoot);
    }
  } else if (resolvedProject !== undefined) {
    resolvedProjectRoot =
      resolveProjectRoot(resolvedProject) ?? (verb === 'ask' ? process.cwd() : undefined);
  } else if (verb === 'ask') {
    resolvedProjectRoot = process.cwd();
  }
  if (
    verb === 'ask' ||
    verb === 'plan' ||
    verb === 'patch' ||
    verb === 'propose' ||
    verb === 'diff' ||
    (verb === 'do' && routeDecision.selected_lane === 'lite_ask')
  ) {
    const target = resolveAgentTarget({
      ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
      ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    });
    resolvedProjectRoot = target.targetRoot;
    resolvedWorkspaceRoot = target.workspaceRoot;
  }

  if (resolvedProjectRoot !== undefined && !existsSync(resolvedProjectRoot)) {
    const message = `Resolved target root does not exist: ${resolvedProjectRoot}`;
    const payload: LiteResultPayload = {
      status: 'TARGET_NOT_FOUND',
      user_status: 'blocked',
      command: verb,
      lite_command: verb,
      selected_lane: routeDecision.selected_lane,
      task,
      project: resolvedProject ?? null,
      run_dir: null,
      scope: {
        project_root: resolvedProjectRoot,
        allowed_write_paths: [],
        refused_paths: [resolvedProjectRoot],
      },
      changed_files: [],
      verification: {
        status: 'skipped',
        commands: [],
        skipped_reason: message,
      },
      checkpoint: {
        required: false,
        available: false,
        restore_command: null,
        inspect_command: null,
      },
      evidence: {
        run_dir: null,
        support_path: null,
        artifacts: [],
      },
      checks: [],
      tests_or_checks: [],
      errors: [message],
      usage: {
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        modelBreakdown: {},
        cost_ledger_path: null,
      },
      next: ['Choose an existing project root or run /target to inspect the current target.'],
      support_path: null,
      details: {
        support_path: null,
        full_babel_equivalent: routeDecision.full_babel_equivalent,
      },
      schema_retries: 0,
      recovered_after_schema_retry: false,
    } as LiteResultPayload;
    if (options.json === true || options.stream === true) {
      writeJson(payload);
    } else {
      process.stdout.write(`${formatLiteResultHuman(payload)}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const effectiveAllowExpensive = resolveEffectiveAllowExpensive({
    task,
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
    ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
    allowExpensive: options.allowExpensive === true,
    outputFormat: options.json === true ? 'json' : 'text',
    manual: false,
  });

  const resolvedProvider = resolveSmallFixProviderForCommand(options);
  const useWorkerChain =
    options.workerChain === true ||
    (verb === 'do' && process.env['BABEL_LITE_WORKER_CHAIN'] === '1');
  const usesSmallFixProgress = verb === 'fix' || verb === 'do';
  const fixProgress = usesSmallFixProgress
    ? createLiteFixProgress({
        json: options.json === true,
        stream: options.stream === true,
      })
    : undefined;
  const sessionOptions: ConstructorParameters<typeof AgentSession>[0] = {
    task,
    verb: toSessionVerb(verb),
    ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
    ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
    ...(resolvedWorkspaceRoot !== null ? { workspaceRoot: resolvedWorkspaceRoot } : {}),
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
    ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
    ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
    ...(verb === 'fix' ||
    verb === 'do' ||
    verb === 'propose' ||
    verb === 'patch' ||
    verb === 'diff' ||
    useWorkerChain
      ? { provider: resolvedProvider }
      : {}),
    ...(useWorkerChain ? { workerChain: true } : {}),
    ...((verb === 'fix' || verb === 'do') && options.rollbackOnFail === true
      ? { rollbackOnFail: true }
      : {}),
    executionProfile,
    liteOnly: options.liteOnly === true,
    agentsMode: normalizeAgentsMode(options.agents),
    json: options.json === true,
    stream: options.stream === true,
    routeDecision,
    ...(fixProgress !== undefined ? { progress: fixProgress } : {}),
    ...(options.humanSummary === true ? { humanSummary: true } : {}),
    // anchorPath is patched in below after pre-flight scanner runs
  };

  // VCS: Pre-flight scanner — resolve anchor path from task text before
  // constructing the session. Only fires for mutating verbs (fix/do) where
  // directory anchoring is most critical.
  let resolvedAnchorPath: string | undefined;
  if ((verb === 'fix' || verb === 'do') && options.projectRoot === undefined) {
    try {
      const scanResult = await resolveFuzzyWorkspaceDirectory(task, cwdAtBoot);
      if (scanResult.anchorPath !== null) {
        resolvedAnchorPath = scanResult.anchorPath;
        // If we resolved a better anchor and projectRoot wasn't explicitly set,
        // also update resolvedProjectRoot so the sandbox uses the right root.
        if (resolvedProjectRoot === undefined) {
          resolvedProjectRoot = resolvedAnchorPath;
        }
      }
    } catch {
      // Pre-flight scanner failures are non-fatal — continue with current dir
    }
  }

  // Patch anchorPath into sessionOptions now that the scanner has resolved it
  if (resolvedAnchorPath !== undefined) {
    (sessionOptions as unknown as Record<string, unknown>)['anchorPath'] = resolvedAnchorPath;
    process.env['BABEL_ANCHOR_PATH'] = resolvedAnchorPath;
  }

  const offlineEnvSnapshot = snapshotLiteOfflineEnv();
  if (providerUsesOfflineEnv(verb) || useWorkerChain) {
    applyLiteOfflineEnv(resolvedProvider);
  }

  const allowedToolsVerb = useWorkerChain
    ? 'fix'
    : verb === 'do'
      ? liteVerbForSelectedLane(routeDecision.selected_lane)
      : verb;

  const runSession = (activeSession: AgentSession) =>
    withExecutionProfileEnv(
      executionProfile,
      [], // tool allowlist no longer needed — sandbox gates handle chat mode
      [],
      () =>
        withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () =>
          withMutedConsole(() => activeSession.run()),
        ),
    );

  let result;
  try {
    if (options.finalOnly === true && options.json !== true && options.stream !== true) {
      process.stderr.write(`Babel: running ${verb}\n`);
    }
    result = await runLiteSessionWithSchemaRecovery(runSession, sessionOptions, {
      verb,
      selectedLane: routeDecision.selected_lane,
      workerChain: useWorkerChain,
    });
  } finally {
    restoreLiteOfflineEnv(offlineEnvSnapshot);
  }

  const humanText =
    result.humanText ??
    ('status' in result.payload
      ? formatLiteResultHuman(result.payload as LiteResultPayload)
      : null);
  const payloadRecord = result.payload as Record<string, unknown>;
  const runDir = typeof payloadRecord['run_dir'] === 'string' ? payloadRecord['run_dir'] : null;
  const progressTranscript =
    fixProgress !== undefined ? fixProgress.getTranscript().join('\n') : '';

  if (options.json === true) {
    writeJson(result.payload);
    if (humanText && runDir && (options.humanSummary === true || usesSmallFixProgress)) {
      writeHumanSummaryArtifact(runDir, humanText, progressTranscript);
    }
  } else if (options.stream === true && verb === 'ask') {
    const humanText =
      result.humanText ??
      ('status' in result.payload
        ? formatLiteResultHuman(result.payload as LiteResultPayload)
        : null);
    const payloadRecord = result.payload as Record<string, unknown>;
    const runDir = typeof payloadRecord['run_dir'] === 'string' ? payloadRecord['run_dir'] : null;
    if (humanText && runDir) {
      writeHumanSummaryArtifact(runDir, humanText);
    }
  } else {
    if (humanText) {
      process.stdout.write(`${humanText}\n`);
      if (runDir) {
        const review = writeHumanSummaryArtifact(runDir, humanText, progressTranscript);
        const note = formatHumanOutputReviewNote(review);
        if (note) {
          process.stdout.write(`${note}\n`);
        }
      }
    }
  }
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

async function handleResumeCommand(options: {
  run?: string;
  plan?: string;
  project?: string;
}): Promise<void> {
  validateRuntimeEnvForCommand({ json: true });

  let resolvedRun = options.run;
  if (!resolvedRun) {
    const latest = readLatestRunPointer(options.project);
    if (!latest) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'NO_LATEST_RUN',
            how_to: ['babel plan example_llm_router "..."', 'babel run --project example_llm_router "..."'],
          },
          null,
          2,
        )}\n`,
      );
      process.exit(1);
    }
    resolvedRun = latest.run_dir;
  }

  try {
    const autoDiscoveredPath = join(resolvedRun, 'manual', 'plan.json');
    let result;

    if (options.plan === undefined) {
      if (!existsSync(autoDiscoveredPath)) {
        mkdirSync(join(resolvedRun, 'manual'), { recursive: true });
        writeFileSync(autoDiscoveredPath, '{\n}\n', 'utf-8');
        const editor = openPlanEditor(autoDiscoveredPath);
        const rawPlanText = readFileSync(autoDiscoveredPath, 'utf-8');
        result = await withMutedConsole(() => resumeManualBridge(resolvedRun, { rawPlanText }));
        if (result.status === 'MANUAL_PLAN_INVALID') {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'MANUAL_PLAN_INVALID',
                run_dir: result.runDir,
                plan_path: autoDiscoveredPath,
                editor: editor.editor,
                repair_prompt_path: result.repairPromptPath,
                errors: result.errors ?? [],
              },
              null,
              2,
            )}\n`,
          );
          process.exit(1);
        }
      } else {
        result = await withMutedConsole(() => resumeManualBridge(resolvedRun, autoDiscoveredPath));
      }
    } else if (options.plan === '-') {
      const rawPlanText = await readStdinFully();
      result = await withMutedConsole(() => resumeManualBridge(resolvedRun, { rawPlanText }));
    } else if (options.plan.toLowerCase() === 'clipboard') {
      const rawPlanText = readClipboardPlanText();
      result = await withMutedConsole(() => resumeManualBridge(resolvedRun, { rawPlanText }));
    } else {
      const planPath = options.plan;
      if (!planPath) {
        throw new Error('Plan path is required.');
      }
      result = await withMutedConsole(() => resumeManualBridge(resolvedRun, planPath));
    }

    if (result.status === 'MANUAL_PLAN_INVALID') {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'MANUAL_PLAN_INVALID',
            run_dir: result.runDir,
            repair_prompt_path: result.repairPromptPath,
            errors: result.errors ?? [],
          },
          null,
          2,
        )}\n`,
      );
      process.exit(1);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          status: result.status,
          run_dir: result.runDir,
        },
        null,
        2,
      )}\n`,
    );

    if (result.status !== 'COMPLETE') {
      process.exit(1);
    }
  } catch (err: unknown) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'MANUAL_RESUME_FAILED',
          run_dir: resolvedRun,
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
}

async function handleActionResumeCommand(
  run: string,
  options: {
    project?: string;
    model?: string;
    modelTier?: string;
    allowExpensive?: boolean;
    json?: boolean;
  },
): Promise<void> {
  const normalizedModel =
    options.model !== undefined ? normalizeModelName(options.model) : undefined;
  const result = await withMutedConsole(() =>
    resumeExecution({
      run,
      ...(options.project !== undefined ? { project: options.project } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
      ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
    }),
  );
  if (options.json === true) {
    writeJson(result);
  } else {
    process.stdout.write(`${formatResumeExecutionHuman(result)}\n`);
  }
  if (result.status !== 'RESUME_COMPLETE') {
    process.exitCode = 1;
  }
}

async function handleSmokeCommand(options: { project: string }): Promise<void> {
  validateRuntimeEnvForCommand({ json: true });

  try {
    const task = 'Plan mode smoke test: validate executor robustness with fixture plans.';

    const manualResult = await withMutedConsole(() =>
      runBabelPipeline(task, {
        project: options.project,
        mode: 'plan',
      }),
    );

    if (manualResult.status !== 'MANUAL_BRIDGE_REQUIRED' || !manualResult.manualPromptPath) {
      throw new Error(`Manual start failed with status ${manualResult.status}`);
    }

    const runDir = manualResult.runDir;
    const manifestProjectRoot = manualResult.manifest.target_project_path?.trim();
    const resolvedProjectRoot =
      manifestProjectRoot && existsSync(manifestProjectRoot)
        ? manifestProjectRoot
        : (resolveProjectRoot(options.project) ?? process.env['BABEL_PROJECT_ROOT']);
    if (!resolvedProjectRoot) {
      throw new Error('Unable to resolve project root for smoke fixtures.');
    }
    const fixtures = buildSmokeFixtures(runDir, resolvedProjectRoot);
    const cases: Array<{
      name: string;
      status: 'PASS' | 'HALT';
      halt_tag: string;
      denial_category?: string | null;
      denial_reason_code?: string | null;
      mcp_phase?: string | null;
      mcp_outcome?: string | null;
      mcp_reason_code?: string | null;
    }> = [];

    for (const fixture of fixtures) {
      const maxAttempts =
        fixture.name === 'sandbox_rejection' || fixture.name === 'mcp_unknown_server' ? 1 : 3;
      let resumed = await withMutedConsole(() => resumeManualBridge(runDir, fixture.path));
      let haltTag = extractHaltTagFromExecutionReport(runDir);
      let denial = extractStructuredDenialFromExecutionReport(runDir);
      let mcpLifecycle = extractMcpLifecycleFromExecutionReport(runDir);

      if (fixture.name !== 'sandbox_rejection' && fixture.name !== 'mcp_unknown_server') {
        for (let attempt = 2; attempt <= maxAttempts; attempt++) {
          const shouldRetry =
            resumed.status === 'QA_REJECTED_MAX_LOOPS' ||
            (resumed.status === 'COMPLETE' &&
              (haltTag === 'ACTIVATION_GATE_FAIL' || haltTag === 'UNKNOWN'));
          if (!shouldRetry) {
            break;
          }
          resumed = await withMutedConsole(() => resumeManualBridge(runDir, fixture.path));
          haltTag = extractHaltTagFromExecutionReport(runDir);
          denial = extractStructuredDenialFromExecutionReport(runDir);
          mcpLifecycle = extractMcpLifecycleFromExecutionReport(runDir);
        }
      }

      if (fixture.name === 'sandbox_rejection') {
        if (resumed.status === 'QA_REJECTED_MAX_LOOPS') {
          cases.push({ name: fixture.name, status: 'PASS', halt_tag: 'QA_REJECTED_EXPECTED' });
          continue;
        }
        const denialCategory =
          typeof denial?.['category'] === 'string' ? String(denial['category']) : null;
        const denialReasonCode =
          typeof denial?.['reason_code'] === 'string' ? String(denial['reason_code']) : null;
        if (
          resumed.status === 'COMPLETE' &&
          haltTag === 'STEP_VERIFICATION_FAIL' &&
          denialCategory === 'sandbox_policy' &&
          denialReasonCode !== null
        ) {
          cases.push({
            name: fixture.name,
            status: 'PASS',
            halt_tag: haltTag,
            denial_category: denialCategory,
            denial_reason_code: denialReasonCode,
          });
          continue;
        }
        if (resumed.status === 'MANUAL_PLAN_INVALID') {
          cases.push({ name: fixture.name, status: 'HALT', halt_tag: 'MANUAL_PLAN_INVALID' });
          continue;
        }
        cases.push({
          name: fixture.name,
          status: 'HALT',
          halt_tag: resumed.status,
          denial_category: denialCategory,
          denial_reason_code: denialReasonCode,
        });
        continue;
      }

      if (fixture.name === 'mcp_unknown_server') {
        const lifecyclePhase =
          typeof mcpLifecycle?.['phase'] === 'string' ? String(mcpLifecycle['phase']) : null;
        const lifecycleOutcome =
          typeof mcpLifecycle?.['outcome'] === 'string' ? String(mcpLifecycle['outcome']) : null;
        const lifecycleReasonCode =
          typeof mcpLifecycle?.['reason_code'] === 'string'
            ? String(mcpLifecycle['reason_code'])
            : null;
        if (
          resumed.status === 'COMPLETE' &&
          haltTag === 'STEP_VERIFICATION_FAIL' &&
          lifecyclePhase === 'server_lookup' &&
          lifecycleOutcome === 'failure' &&
          lifecycleReasonCode === 'unknown_server'
        ) {
          cases.push({
            name: fixture.name,
            status: 'PASS',
            halt_tag: haltTag,
            mcp_phase: lifecyclePhase,
            mcp_outcome: lifecycleOutcome,
            mcp_reason_code: lifecycleReasonCode,
          });
          continue;
        }
        cases.push({
          name: fixture.name,
          status: 'HALT',
          halt_tag: resumed.status,
          mcp_phase: lifecyclePhase,
          mcp_outcome: lifecycleOutcome,
          mcp_reason_code: lifecycleReasonCode,
        });
        continue;
      }

      if (resumed.status === 'COMPLETE') {
        if (haltTag === 'NONE') {
          cases.push({ name: fixture.name, status: 'PASS', halt_tag: 'NONE' });
        } else {
          cases.push({ name: fixture.name, status: 'HALT', halt_tag: haltTag });
        }
      } else if (resumed.status === 'MANUAL_PLAN_INVALID') {
        cases.push({ name: fixture.name, status: 'HALT', halt_tag: 'MANUAL_PLAN_INVALID' });
      } else {
        cases.push({ name: fixture.name, status: 'HALT', halt_tag: resumed.status });
      }
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'SMOKE_COMPLETE',
          project: options.project,
          run_dir: runDir,
          manual_prompt_path: manualResult.manualPromptPath,
          cases,
        },
        null,
        2,
      )}\n`,
    );

    if (cases.some((item) => item.status === 'HALT')) {
      process.exit(1);
    }
  } catch (err: unknown) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'SMOKE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
}

export function registerWorkflowCommands(program: Command): void {
  const addSessionOptions = (command: Command): Command =>
    command
      .option('-p, --project <name>', 'Target project')
      .option('-m, --model <model>', 'Override the model family')
      .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')}`)
      .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
      .option('--show-model-policy', 'Include model policy metadata where available')
      .option(
        '--project-root <path>',
        'Explicit project root for arbitrary approved workspace repos',
      )
      .option('--lite-only', 'Refuse instead of escalating to babel deep')
      .option('--agents <mode>', 'Agent mode for complex routes: off | read-only', 'read-only')
      .option('--provider <provider>', 'Provider: live | mock (mock = offline demo)')
      .option('--rollback-on-fail', 'Restore the pre-mutation checkpoint when verification fails')
      .option('--stream', 'Stream conversational LLM answers in real time (read-only routes)')
      .option('--final-only', 'Send progress to stderr and the final answer to stdout')
      .option('--human-summary', 'With --json, also write human_summary.txt to the run dir')
      .option('--json', 'Emit structured JSON only')
      .option('--ask', 'Ask for approval before executing any mutating tool');

  /**
   * Shared fatal error handler for Lite commands.
   * Prints or writes JSON error details, then exits the process.
   */
  function handleLiteFatalError(err: unknown, command: string, options: { json?: boolean }): never {
    const message = err instanceof Error ? err.message : String(err);
    const recovery = getRecoverableErrorFields(err);
    if (options.json === true) {
      writeJson({
        status: 'LITE_FAILED',
        command,
        user_status: 'failed',
        error: message,
        recoverable: recovery['recoverable'] === true,
        next: Array.isArray(recovery['next']) ? recovery['next'] : [],
        ...recovery,
      });
    } else {
      console.error(`Babel: ${message}`);
      if (typeof recovery['support_path'] === 'string') {
        console.error(`Support: ${recovery['support_path']}`);
      }
      if (Array.isArray(recovery['next']) && recovery['next'].length > 0) {
        for (const step of recovery['next']) {
          console.error(`Next: ${step}`);
        }
      } else if (typeof recovery['next_command'] === 'string') {
        console.error(`Next: ${recovery['next_command']}`);
      }
    }
    process.exit(1);
  }

  const runSessionAction = (verb: LiteVerb) => async (taskParts: string[], options: LiteCommandOptions) => {
    try {
      await runLiteCommand(verb, taskParts, options);
    } catch (err: unknown) {
      handleLiteFatalError(err, verb, options);
    }
  };


  program
    .command('deep')
    .argument('<task...>', 'Task text')
    .description('Run the governed apply-and-verify path for harder or higher-risk work')
    .option('-p, --project <name>', 'Target project')
    .option('--project-root <path>', 'Explicit project root for arbitrary approved workspace repos')
    .option('-m, --model <model>', 'Override the model family')
    .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')}`)
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option('--show-model-policy', 'Include model policy metadata where available')
    .option('--json', 'Emit structured JSON only')
    .option('--ask', 'Ask for approval before executing any mutating tool')
    .addHelpText(
      'after',
      `
Examples:
  $ babel deep "Harden the implementation plan for this repo-wide migration"
  $ babel deep "Apply the bounded migration and verify it" --project-root /tmp/example_game_suite\\MyGame

Notes:
  - babel deep runs the governed pipeline with planning, review, execution, and verification.
  - Use babel run only when you need explicit low-level mode or stream output controls.
`,
    )
    .action(async (taskParts: string[], options: DeepCommandOptions) => {
      await runDeepCommand(taskParts, options);
    });

  addSessionOptions(
    program
      .command('undo')
      .description('Restore the latest checkpoint from the most recent recoverable run')
      .addHelpText(
        'after',
        `
Examples:
  $ babel undo
  $ babel undo --project example_saas_backend
  $ babel undo --project-root /tmp/my-repo

Notes:
  - Restores files captured before the last mutating Babel run.
  - If undo refuses (files changed since the checkpoint), use babel checkpoint restore <id> --force.
  - In the REPL, /restore <id> and /checkpoint list are equivalent recovery surfaces.
`,
      )
      .action(async (_taskParts: string[], options: LiteCommandOptions) => {
        try {
          await runLiteCommand('undo', [], options);
        } catch (err: unknown) {
          handleLiteFatalError(err, 'undo', options);
        }
      }),
  );

  program
    .command('continue')
    .argument('[run]', 'latest or a run directory', 'latest')
    .description('Resume a linked Lite worker chain or inspect the latest recovery step')
    .option('-p, --project <name>', 'Use latest run pointer for this project')
    .option('--project-root <path>', 'Repo root for worker-chain manifest lookup')
    .option(
      '--provider <provider>',
      'Provider override when resuming fix/propose steps: live | mock',
    )
    .option('--inspect-only', 'Inspect recovery state without resuming worker-chain steps')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel continue latest
  $ babel continue <BABEL_REPO_ROOT>\\runs\\20260601_010101_task
  $ babel continue latest --inspect-only

Notes:
  - continue resumes linked worker-chain steps when a manifest exists.
  - Use --inspect-only to classify recovery without executing the next step.
`,
    )
    .action(
      async (
        run: string,
        options: {
          project?: string;
          projectRoot?: string;
          provider?: string;
          inspectOnly?: boolean;
          json?: boolean;
        },
      ) => {
        await handleLiteContinueCommand(run, {
          ...(options.project !== undefined ? { project: options.project } : {}),
          ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          json: options.json === true,
          resume: options.inspectOnly !== true,
        });
      },
    );

  program
    .command('run')
    .argument('<task>', 'task prompt')
    .description(
      'Advanced pipeline lane for explicit modes, audit, output, and tool/model controls',
    )
    .option(
      '-p, --project <name>',
      'Target project (example_saas_backend | example_llm_router | AuditGuard | example_mobile_suite | example_game_suite | godot_td | app_test_babel)',
    )
    .option('--mode <mode>', `Pipeline mode: ${VALID_MODES.join(' | ')}`, 'chat')
    .option(
      '-m, --model <model>',
      'Override the Orchestrator and force a specific model family (qwen3|deepseek|step-flash|scout|nemotron|qwen3-32b, case-insensitive)',
    )
    .option(
      '--model-tier <tier>',
      `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')} (defaults to configured policy tier)`,
    )
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option(
      '--show-model-policy',
      'Print the resolved backend model, provider ID, and approximate cost metadata',
    )
    .option('--session-id <id>', 'Associate this raw evidence bundle with a Local Mode session ID')
    .option(
      '--session-start-path <path>',
      'Attach this run to an exact Local Mode session-start artifact',
    )
    .option(
      '--local-learning-root <path>',
      'Attach this run to a specific Local Mode learning root',
    )
    .option('--project-root <path>', 'Explicit project root for arbitrary approved workspace repos')
    .option(
      '--orchestrator <version>',
      'Advanced: override orchestrator contract version (default v9)',
    )
    .option('--log-file <path>', 'Override the default per-run log with a custom log file path')
    .option(
      '--no-auto-log',
      'Disable the default automatic per-run terminal transcript (babel.log)',
    )
    .option(
      '--lock <files>',
      'Comma-separated list of project-relative file paths the executor must not write',
    )
    .option(
      '--allowed-tools <tools>',
      'Comma-separated executor tool allowlist; when set, all other tools are denied',
    )
    .option(
      '--disallowed-tools <tools>',
      'Comma-separated executor tool denylist; deny rules take precedence',
    )
    .option(
      '--execution-profile <profile>',
      `Execution profile: ${getExecutionProfileHelpText()}`,
      'safe_repo',
    )
    .option('--benchmark', 'Enable performance benchmarking and output manifest resolution latency')
    .option('--json', 'Emit final run result as structured JSON only')
    .option(
      '--output-format <format>',
      'Output format: text | json | stream-json | jsonl | ndjson',
      'text',
    )
    .option('--ask', 'Ask for approval before executing any mutating tool')
    .option('--yes', 'Auto-approve all standard operations (headless/CI mode)')
    .option('--read-only', 'Auto-deny all mutating file writes (read-only audit mode)')
    .option('--strict-env', 'Fail when .env keys stay inactive after bootstrap')
    .option('--budget <tokens>', 'Hard token budget ceiling; pipeline halts if exceeded')
    .option('--reasoning-effort <level>', 'Model reasoning effort: low | medium | high')
    .option('--cost-optimize', 'Enable automated cost-aware model selection')
    .option('--offline', 'Use local models only (requires Ollama on localhost:11434)')
    .option(
      '--use-chat-pipeline',
      'Use legacy runChatPipeline instead of ChatEngine for --mode chat',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ babel "Fix failing tests"
  $ babel plan "Compare the implementation options"
  $ babel deep "Harden the migration path"
  $ babel run "Add dark mode toggle" --mode deep
  $ babel run "Fan out investigation" --mode deep
  $ babel run "Prepare rollout plan" --mode plan --show-model-policy
  $ babel run "Refine ingestion worker" --model deepseek --model-tier standard
  $ babel run "Inspect catalog" --json
  $ babel run "Fix lint" --output-format stream-json
  $ babel run "Audit only" --allowed-tools directory_list,file_read,semantic_search
  $ babel run "Fix tests" --execution-profile dev_local
  $ babel run "Fix tests" --execution-profile opencalw_manager --project-root /tmp/example_game_suite\\MyGame
  $ babel run "Solve task" --execution-profile benchmark_container --mode deep

Notes:
  - Prefer babel "<task>", babel plan, and babel deep for the user-facing CLI.
  - --json emits one final JSON object; --output-format stream-json/jsonl/ndjson emits newline-delimited JSON events plus a final run_complete event.
  - If --project is omitted, Babel auto-detects the current repo when run from a known workspace project.
  - --model-tier selects the backend model tier under the current family route; default is loaded from config/model-policy.json.
  - Remote provider calls are normal when credentials are configured; Babel should show the boundary without blocking everyday use.
  - Explicit --model-tier escalation or --allow-expensive is treated as consent for that one interactive run.
  - Shorthand is supported: babel <Project> "<task...>" maps to babel run --project <Project> "<task...>".
`,
    )
    .action(
      async (
        task: string,
        options: {
          project?: string;
          mode?: string;
          model?: string;
          modelTier?: string;
          allowExpensive?: boolean;
          showModelPolicy?: boolean;
          sessionId?: string;
          sessionStartPath?: string;
          localLearningRoot?: string;
          projectRoot?: string;
          orchestrator?: string;
          logFile?: string;
          autoLog?: boolean;
          lock?: string;
          allowedTools?: string;
          disallowedTools?: string;
          executionProfile?: string;
          benchmark?: boolean;
          json?: boolean;
          outputFormat?: string;
          ask?: boolean;
          yes?: boolean;
          readOnly?: boolean;
          strictEnv?: boolean;
          budget?: string;
          reasoningEffort?: string;
          costOptimize?: boolean;
          offline?: boolean;
          useChatPipeline?: boolean;
        },
      ) => {
        if (process.env['BABEL_LITE_WORKER_CHAIN'] === '1') {
          try {
            const liteOptions: LiteCommandOptions = {};
            if (options.project !== undefined) liteOptions.project = options.project;
            if (options.model !== undefined) liteOptions.model = options.model;
            if (options.modelTier !== undefined) liteOptions.modelTier = options.modelTier;
            if (options.allowExpensive !== undefined) liteOptions.allowExpensive = options.allowExpensive;
            if (options.showModelPolicy !== undefined) liteOptions.showModelPolicy = options.showModelPolicy;
            if (options.projectRoot !== undefined) liteOptions.projectRoot = options.projectRoot;
            if (options.executionProfile !== undefined) liteOptions.executionProfile = options.executionProfile;
            if (options.json !== undefined) liteOptions.json = options.json;
            if (options.ask !== undefined) liteOptions.ask = options.ask;
            liteOptions.workerChain = true;

            await runLiteCommand('do', [task], liteOptions);
            return;
          } catch (err: unknown) {
            handleLiteFatalError(err, 'do', options);
          }
        }

        applyRunCommandEnvFlags(options);
        assertEnvFileActiveForPipelineCommand();
        const isManualMode = options.mode === 'manual';
        const requestedMode = options.mode ?? 'chat';
        const outputFormat = parseRunOutputFormat(options.outputFormat, options.json);
        if (outputFormat === null) {
          const message = `Invalid output format "${options.outputFormat}". Valid values: text, json, stream-json, jsonl, ndjson`;
          if (options.json === true) {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            console.error(`Babel: ${message}`);
          }
          process.exit(1);
        }

        const isStructuredOutput = outputFormat !== 'text';
        const resolvedProject = options.project ?? detectProjectFromCwd() ?? undefined;
        validateRuntimeEnvForCommand({ json: isManualMode || isStructuredOutput });
        const shouldUseReadOnlyQuestionPath = shouldUseReadOnlyRunQuestionPath({
          task,
          explicitMode: isExplicitModeArg(),
          hasAllowedTools: options.allowedTools !== undefined,
          hasDisallowedTools: options.disallowedTools !== undefined,
          hasLock: options.lock !== undefined,
        });
        const mode = shouldUseReadOnlyQuestionPath ? 'chat' : requestedMode;

        const normalizedModel = normalizeModelName(options.model);
        const normalizedModelTier =
          options.modelTier !== undefined ? options.modelTier.trim().toLowerCase() : undefined;
        const lockedFiles = parseCommaSeparatedFiles(options.lock);
        const allowedTools = shouldUseReadOnlyQuestionPath
          ? READ_ONLY_RUN_TOOLS
          : parseCommaSeparatedFiles(options.allowedTools);
        const disallowedTools = parseCommaSeparatedFiles(options.disallowedTools);
        const executionProfile = normalizeExecutionProfile(options.executionProfile);
        let resolvedProjectRoot: string | undefined;
        let resolvedWorkspaceRoot: string | null = null;
        let resolvedAllowedRoots: string[] = [];

        if (!VALID_MODES.includes(mode as ValidMode)) {
          const message = `Invalid mode "${mode}". Valid values: ${VALID_MODES.join(', ')}`;
          if (isStructuredOutput) {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            console.error(`Babel: ${message}`);
          }
          process.exit(1);
        }

        if (executionProfile === null) {
          const message = `Invalid execution profile "${options.executionProfile}". Valid values: ${getExecutionProfileHelpText().replace(/ \| /g, ', ')}`;
          if (isStructuredOutput) {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            console.error(`Babel: ${message}`);
          }
          process.exit(1);
        }

        if (options.projectRoot !== undefined) {
          try {
            if (executionProfile === 'opencalw_manager') {
              const resolved = resolveApprovedWorkspacePath(options.projectRoot);
              resolvedProjectRoot = resolved.path;
              resolvedAllowedRoots = resolved.approvedRoots;
            } else {
              resolvedProjectRoot = resolve(options.projectRoot);
            }
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (isStructuredOutput) {
              writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
            } else {
              console.error(`Babel: ${message}`);
            }
            process.exit(1);
          }
        }

        if (resolvedProjectRoot === undefined) {
          const target = resolveAgentTarget({
            ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
          });
          resolvedProjectRoot = target.targetRoot;
          resolvedWorkspaceRoot = target.workspaceRoot;
        }

        if (!existsSync(resolvedProjectRoot)) {
          const message = `Resolved target root does not exist: ${resolvedProjectRoot}`;
          if (isStructuredOutput) {
            if (outputFormat === 'stream-json') {
              writeNdjson(
                makeRunStreamEvent('run_error', {
                  error: message,
                  status: 'EXECUTOR_HALTED',
                  result: buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
                }),
              );
            } else {
              writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
            }
          } else {
            process.stdout.write(
              `${formatRunResultHuman({
                status: 'EXECUTOR_HALTED',
                user_status: 'blocked',
                command: 'run',
                task,
                project: resolvedProject ?? null,
                run_dir: null,
                scope: {
                  project_root: resolvedProjectRoot,
                  allowed_write_paths: [],
                  refused_paths: [resolvedProjectRoot],
                },
                changed_files: [],
                verification: {
                  status: 'skipped',
                  commands: [],
                  skipped_reason: message,
                },
                checkpoint: {
                  required: false,
                  available: false,
                  restore_command: null,
                  inspect_command: null,
                },
                evidence: {
                  run_dir: null,
                  support_path: null,
                  artifacts: [],
                },
                terminal_status: buildTerminalStatusSummary({
                  status: 'EXECUTOR_HALTED',
                  condition: message,
                }),
                errors: [message],
                next: ['Choose an existing project root and retry.'],
              })}\n`,
            );
          }
          process.exitCode = 1;
          return;
        }

        if (options.model !== undefined && normalizedModel === undefined) {
          const message = `Invalid model "${options.model}". Valid values: ${getAvailableModels()
            .map((m) => m.key)
            .join(', ')} (case-insensitive)`;
          if (isStructuredOutput) {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            console.error(`Babel: ${message}`);
          }
          process.exit(1);
        }

        if (
          normalizedModelTier !== undefined &&
          !VALID_MODEL_TIERS.includes(normalizedModelTier as (typeof VALID_MODEL_TIERS)[number])
        ) {
          const message = `Invalid model tier "${options.modelTier}". Valid values: ${VALID_MODEL_TIERS.join(', ')}`;
          if (isStructuredOutput) {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            console.error(`Babel: ${message}`);
          }
          process.exit(1);
        }

        if (
          options.orchestrator !== undefined &&
          !VALID_ORCHESTRATORS.includes(options.orchestrator as ValidOrchestrator)
        ) {
          const message = `Invalid orchestrator "${options.orchestrator}". Valid values: ${VALID_ORCHESTRATORS.join(', ')}`;
          if (isStructuredOutput) {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            console.error(`Babel: ${message}`);
          }
          process.exit(1);
        }

        const effectiveAllowExpensive = resolveEffectiveAllowExpensive({
          task,
          ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
          ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
          ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
          allowExpensive: options.allowExpensive === true,
          outputFormat,
          manual: mode === 'manual',
        });

        if (normalizedModel !== undefined) {
          try {
            preflightRequestedModelPolicy(normalizedModel, {
              ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
              ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (isModelEscalationPolicyError(message)) {
              printModelEscalationApprovalRequired({
                task,
                ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
                ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
                ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
                outputFormat,
                manual: mode === 'manual',
              });
            }
            if (mode === 'manual') {
              process.stdout.write(
                `${JSON.stringify(
                  {
                    status: 'MANUAL_BRIDGE_FAILED',
                    error: message,
                  },
                  null,
                  2,
                )}\n`,
              );
              process.exit(1);
            }
            if (isStructuredOutput) {
              writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
            } else {
              console.error(`Babel: ${message}`);
            }
            process.exit(1);
          }
        }

        if (mode === 'manual') {
          try {
            await withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () =>
              runManualBridgeStart(task, {
                ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
                ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
                ...(options.orchestrator !== undefined
                  ? { orchestratorVersion: options.orchestrator }
                  : {}),
                ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
                ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
                ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
                ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
                ...(options.sessionStartPath !== undefined
                  ? { sessionStartPath: options.sessionStartPath }
                  : {}),
                ...(options.localLearningRoot !== undefined
                  ? { localLearningRoot: options.localLearningRoot }
                  : {}),
                ...(lockedFiles.length > 0 ? { lockedFiles } : {}),
                executionProfile,
              }),
            );
            return;
          } catch (err: unknown) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  status: 'MANUAL_BRIDGE_FAILED',
                  error: err instanceof Error ? err.message : String(err),
                },
                null,
                2,
              )}\n`,
            );
            process.exit(1);
          }
        }

        const runOutputContext = {
          task,
          mode: mode as ValidMode,
          ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
          ...(normalizedModel !== undefined ? { requestedModel: normalizedModel } : {}),
          ...(normalizedModelTier !== undefined ? { requestedModelTier: normalizedModelTier } : {}),
          orchestrator: options.orchestrator ?? process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9',
          allowedTools,
          disallowedTools,
          executionProfile,
          ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
        };

        const useChatEnginePath =
          (mode === 'chat' || mode === 'chat-headless') && !shouldUseReadOnlyQuestionPath && options.useChatPipeline !== true;

        if (!isStructuredOutput && !isManualMode && !useChatEnginePath) {
          writeTextRunPrelude({
            task,
            mode: mode as ValidMode,
            ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
            ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
            ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
            orchestrator: options.orchestrator ?? process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9',
            executionProfile,
            ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
          });
        }

        if (shouldUseReadOnlyQuestionPath) {
          if (outputFormat === 'stream-json') {
            writeNdjson(
              makeRunStreamEvent('run_start', {
                task,
                mode: mode as ValidMode,
                project: resolvedProject ?? null,
              }),
            );
          }
          try {
            const payload = await withExecutionProfileEnv(
              executionProfile,
              allowedTools,
              disallowedTools,
              () =>
                withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () =>
                  withMutedConsole(() =>
                    runReadOnlyQuestionAsRun({
                      task,
                      ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
                      projectRoot: resolvedProjectRoot!,
                      ...(resolvedWorkspaceRoot !== null
                        ? { workspaceRoot: resolvedWorkspaceRoot }
                        : {}),
                      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
                      ...(normalizedModelTier !== undefined
                        ? { modelTier: normalizedModelTier }
                        : {}),
                      ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
                      ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
                    }),
                  ),
                ),
            );
            if (outputFormat === 'stream-json') {
              writeNdjson(makeRunStreamEvent('run_complete', { result: payload }));
            } else if (outputFormat === 'json') {
              writeJson(payload);
            } else {
              const human = formatRunResultHuman(payload);
              const runDir = typeof payload['run_dir'] === 'string' ? payload['run_dir'] : null;
              const review = writeHumanSummaryArtifact(runDir, human);
              process.stdout.write(`${human}\n`);
              const note = formatHumanOutputReviewNote(review);
              if (note) {
                process.stdout.write(`\n${note}\n`);
              }
            }
            if (payload['status'] !== 'ANSWER_READY') {
              process.exitCode = 1;
            }
            return;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (outputFormat === 'stream-json') {
              writeNdjson(
                makeRunStreamEvent('run_error', {
                  error: message,
                  status: 'EXECUTOR_HALTED',
                  result: buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
                }),
              );
            } else if (outputFormat === 'json') {
              writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
            } else {
              process.stdout.write(
                `${formatRunResultHuman({
                  ...buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
                  command: 'run',
                  task,
                  project: resolvedProject ?? null,
                  run_dir: null,
                  changed_files: [],
                  verification: {
                    status: 'failed',
                    commands: ['read-only answer path'],
                    skipped_reason: null,
                  },
                  scope: {
                    project_root: resolvedProjectRoot,
                    allowed_write_paths: [],
                    refused_paths: [],
                  },
                  checkpoint: {
                    required: false,
                    available: false,
                    restore_command: null,
                    inspect_command: null,
                  },
                  evidence: {
                    run_dir: null,
                    support_path: null,
                    artifacts: [],
                  },
                })}\n`,
              );
            }
            process.exitCode = 1;
            return;
          }
        }

        if (useChatEnginePath) {
          if (outputFormat === 'stream-json') {
            writeNdjson(
              makeRunStreamEvent('run_start', {
                task,
                mode: mode as ValidMode,
                project: resolvedProject ?? null,
              }),
            );
          }
          try {
            const { payload, exitCode } = await withExecutionProfileEnv(
              executionProfile,
              allowedTools,
              disallowedTools,
              () =>
                withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () =>
                  withMutedConsole(() =>
                    runCliChatTask({
                      task,
                      ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
                      projectRoot: resolvedProjectRoot!,
                      ...(resolvedWorkspaceRoot !== null
                        ? { workspaceRoot: resolvedWorkspaceRoot }
                        : {}),
                      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
                      ...(normalizedModelTier !== undefined
                        ? { modelTier: normalizedModelTier }
                        : {}),
                      ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
                      ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
                      outputFormat: isStructuredOutput
                        ? (outputFormat as 'json' | 'stream-json')
                        : 'text',
                      ...(outputFormat === 'stream-json'
                        ? {
                            onStreamEvent: (event) => {
                              if (event.type === 'assistant_chunk') {
                                writeNdjson(
                                  makeRunStreamEvent('assistant_chunk', { chunk: event.chunk }),
                                );
                              }
                            },
                          }
                        : {}),
                    }),
                  ),
                ),
            );
            if (outputFormat === 'stream-json') {
              writeNdjson(makeRunStreamEvent('run_complete', { result: payload }));
            } else if (outputFormat === 'json') {
              writeJson(payload);
            } else {
              const usedConversational =
                process.stdout.isTTY && !process.env['CI'] && !process.env['NO_COLOR'];
              if (!usedConversational) {
                const human = formatRunResultHuman(payload);
                process.stdout.write(`${human}\n`);
              }
            }
            process.exitCode = exitCode;
            return;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (outputFormat === 'stream-json') {
              writeNdjson(
                makeRunStreamEvent('run_error', {
                  error: message,
                  status: 'EXECUTOR_HALTED',
                  result: buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
                }),
              );
            } else if (outputFormat === 'json') {
              writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
            } else {
              process.stdout.write(
                `${formatRunResultHuman({
                  ...buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
                  command: 'run',
                  task,
                  project: resolvedProject ?? null,
                  run_dir: null,
                  changed_files: [],
                  verification: {
                    status: 'failed',
                    commands: ['chat engine path'],
                    skipped_reason: null,
                  },
                  scope: {
                    project_root: resolvedProjectRoot,
                    allowed_write_paths: [],
                    refused_paths: [],
                  },
                  checkpoint: {
                    required: false,
                    available: false,
                    restore_command: null,
                    inspect_command: null,
                  },
                  evidence: {
                    run_dir: null,
                    support_path: null,
                    artifacts: [],
                  },
                })}\n`,
              );
            }
            process.exitCode = 1;
            return;
          }
        }

        if (isStructuredOutput) {
          const eventBus = new BabelEventBus();
          if (outputFormat === 'stream-json') {
            attachRunEventStream(eventBus, runOutputContext);
          }

          try {
            const result = await withExecutionProfileEnv(
              executionProfile,
              allowedTools,
              disallowedTools,
              () =>
                withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () =>
                  withMutedConsole(() =>
                    runBabelPipeline(task, {
                      ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
                      ...(normalizedModel !== undefined ? { modelOverride: normalizedModel } : {}),
                      ...(options.orchestrator !== undefined
                        ? { orchestratorVersion: options.orchestrator as ValidOrchestrator }
                        : {}),
                      ...(normalizedModelTier !== undefined
                        ? { modelTier: normalizedModelTier }
                        : {}),
                      ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
                      ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
                      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
                      ...(options.sessionStartPath !== undefined
                        ? { sessionStartPath: options.sessionStartPath }
                        : {}),
                      ...(options.localLearningRoot !== undefined
                        ? { localLearningRoot: options.localLearningRoot }
                        : {}),
                      ...(lockedFiles.length > 0 ? { lockedFiles } : {}),
                      mode: mode as ValidMode,
                      executionProfile,
                      ...(options.logFile !== undefined ? { logFile: options.logFile } : {}),
                      ...(options.autoLog !== undefined ? { autoLog: options.autoLog } : {}),
                      ...(options.benchmark === true ? { benchmark: true } : {}),
                      eventBus,
                    }),
                  ),
                ),
            );

            const completionVerification = buildCompletionVerificationForRun({
              pipelineStatus: result.status,
              executionProfile,
              ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
            });
            const payload = buildRunResultPayload(result, runOutputContext);
            payload['completion_verification'] = completionVerification;
            if (completionVerification.status === 'fail') {
              payload['status'] = 'VERIFIER_FAILED';
            }
            if (outputFormat === 'stream-json') {
              writeNdjson(makeRunStreamEvent('run_complete', { result: payload }));
            } else {
              writeJson(payload);
            }

            if (!isSuccessfulRunStatus(result.status) || completionVerification.status === 'fail') {
              process.exitCode = 1;
            }
            return;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const readOnlyNoModification = isReadOnlyNoModificationRequest({
              task,
              mode,
              allowedTools,
            });
            const failureStatus = readOnlyNoModification
              ? 'READ_ONLY_NO_MODIFICATION'
              : 'EXECUTOR_HALTED';
            if (outputFormat === 'stream-json') {
              writeNdjson(
                makeRunStreamEvent('run_error', {
                  error: message,
                  status: failureStatus,
                  result: buildRunCommandFailurePayload({ status: failureStatus, message }),
                }),
              );
            } else {
              writeJson(buildRunCommandFailurePayload({ status: failureStatus, message }));
            }
            process.exitCode = readOnlyNoModification ? 0 : 1;
            return;
          }
        }

        const eventBus = new BabelEventBus();
        const liveRenderer = createLiveRunRenderer(eventBus, runOutputContext);
        liveRenderer.start();

        try {
          const result = await withExecutionProfileEnv(
            executionProfile,
            allowedTools,
            disallowedTools,
            () =>
              withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () =>
                withMutedConsole(() =>
                  runBabelPipeline(task, {
                    ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
                    ...(normalizedModel !== undefined ? { modelOverride: normalizedModel } : {}),
                    ...(options.orchestrator !== undefined
                      ? { orchestratorVersion: options.orchestrator as ValidOrchestrator }
                      : {}),
                    ...(normalizedModelTier !== undefined
                      ? { modelTier: normalizedModelTier }
                      : {}),
                    ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
                    ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
                    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
                    ...(options.sessionStartPath !== undefined
                      ? { sessionStartPath: options.sessionStartPath }
                      : {}),
                    ...(options.localLearningRoot !== undefined
                      ? { localLearningRoot: options.localLearningRoot }
                      : {}),
                    ...(lockedFiles.length > 0 ? { lockedFiles } : {}),
                    mode: mode as ValidMode,
                    executionProfile,
                    ...(options.logFile !== undefined ? { logFile: options.logFile } : {}),
                    ...(options.autoLog !== undefined ? { autoLog: options.autoLog } : {}),
                    ...(options.benchmark === true ? { benchmark: true } : {}),
                    eventBus,
                  }),
                ),
              ),
          );

          liveRenderer.stop();
          const completionVerification = buildCompletionVerificationForRun({
            pipelineStatus: result.status,
            executionProfile,
            ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
          });
          const payload = buildRunResultPayload(result, runOutputContext);
          payload['completion_verification'] = completionVerification;
          if (completionVerification.status === 'fail') {
            payload['status'] = 'VERIFIER_FAILED';
          }
          const human = formatRunResultHuman(payload);
          const review = writeHumanSummaryArtifact(
            result.runDir,
            human,
            [
              typeof liveRenderer.getTranscript === 'function' ? liveRenderer.getTranscript() : '',
              human,
            ]
              .filter(Boolean)
              .join('\n'),
          );
          process.stdout.write(`${human}\n`);
          const note = formatHumanOutputReviewNote(review);
          if (note) {
            process.stdout.write(`\n${note}\n`);
          }
          if (completionVerification.required) {
            process.stdout.write(
              `\nCompletion verification: ${completionVerification.status} — ${completionVerification.reason}\n`,
            );
          }

          if (!isSuccessfulRunStatus(result.status) || completionVerification.status === 'fail') {
            process.exitCode = 1;
          }
        } catch (err: unknown) {
          liveRenderer.fail(err);
          const message = err instanceof Error ? err.message : String(err);
          const readOnlyNoModification = isReadOnlyNoModificationRequest({
            task,
            mode,
            allowedTools,
          });
          const failureStatus = readOnlyNoModification
            ? 'READ_ONLY_NO_MODIFICATION'
            : 'EXECUTOR_HALTED';
          const payload = {
            ...buildRunCommandFailurePayload({ status: failureStatus, message }),
            command: 'run',
            task,
            project: resolvedProject ?? null,
            run_dir: null,
            changed_files: [],
            verification: {
              status: readOnlyNoModification ? 'not_required' : 'failed',
              commands: readOnlyNoModification ? ['read-only run path'] : [],
              skipped_reason: null,
            },
            checkpoint: {
              required: false,
              available: false,
              restore_command: null,
              inspect_command: null,
            },
            evidence: {
              run_dir: null,
              support_path: null,
              artifacts: [],
            },
            next: readOnlyNoModification
              ? [
                  'Review the read-only result and rerun with an applying command if changes are needed.',
                ]
              : ['Run babel continue latest to inspect recovery state and the next command.'],
          };
          process.stdout.write(`${formatRunResultHuman(payload)}\n`);
          process.exitCode = readOnlyNoModification ? 0 : 1;
        }
      },
    );

  program
    .command('plan')
    .description('Prepare a plan, ask for approval, then apply it in the same terminal flow')
    .argument('<intent...>', 'Task text, or legacy: <project> <task...>')
    .option('-p, --project <name>', 'Target project for the user-facing plan lane')
    .option(
      '-m, --model <model>',
      'Force a specific model family for the manual-bridge worker (qwen3|deepseek|step-flash|scout|nemotron|qwen3-32b, case-insensitive)',
    )
    .option(
      '--model-tier <tier>',
      `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')} (defaults to configured policy tier)`,
    )
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option(
      '--show-model-policy',
      'Include resolved backend model policy details in the manual-bridge JSON output',
    )
    .option('--project-root <path>', 'Explicit project root for arbitrary approved workspace repos')
    .option('--session-id <id>', 'Associate this manual-bridge run with a Local Mode session ID')
    .option(
      '--session-start-path <path>',
      'Attach this manual-bridge run to an exact Local Mode session-start artifact',
    )
    .option(
      '--local-learning-root <path>',
      'Attach this manual-bridge run to a specific Local Mode learning root',
    )
    .option(
      '--orchestrator <version>',
      'Advanced: override orchestrator contract version (default v9)',
    )
    .option('--final-only', 'Send progress to stderr and the final answer to stdout')
    .option('--approve', 'Auto-approve apply in non-TTY environments (explicit opt-in)')
    .option('--shadow', 'Apply to shadow root only (dry-run preview before live apply)')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel plan "Prepare rollout plan"
  $ babel plan "Compare the implementation options"
  $ babel plan example_saas_backend "Prepare rollout plan"
  $ babel plan example_llm_router "Draft migration plan" --model deepseek --model-tier standard --show-model-policy

Notes:
  - babel plan runs a planner, a separate review agent, then asks whether to apply it now.
  - --json keeps the read-only plan artifact contract for automation.
  - babel plan <known-project> "<task>" is kept as the legacy Manual Bridge JSON flow.
`,
    )
    .action(
      async (
        intent: string[],
        options: {
          project?: string;
          model?: string;
          modelTier?: string;
          allowExpensive?: boolean;
          showModelPolicy?: boolean;
          projectRoot?: string;
          sessionId?: string;
          sessionStartPath?: string;
          localLearningRoot?: string;
          orchestrator?: string;
          finalOnly?: boolean;
          approve?: boolean;
          shadow?: boolean;
          json?: boolean;
        },
      ) => {
        const firstToken = intent[0] ?? '';
        const legacyProject =
          firstToken !== '' && resolveProjectRoot(firstToken) !== null && intent.length > 1
            ? firstToken
            : undefined;

        if (legacyProject === undefined) {
          try {
            await runLiteCommand('plan', intent, options);
            if (options.json === true || options.finalOnly === true) {
              return;
            }
            const task = normalizeLiteTask(intent);
            if (!task) {
              return;
            }
            const projectRoot =
              options.projectRoot !== undefined
                ? resolve(options.projectRoot)
                : process.env['BABEL_PROJECT_ROOT'] !== undefined
                  ? resolve(process.env['BABEL_PROJECT_ROOT'])
                  : process.cwd();
            const handoff = loadPlanHandoff({ repoPath: projectRoot, task });
            if (handoff !== null) {
              const review = await runPlanReviewLane({
                task,
                planRunDir: handoff.planRunDir,
                projectRoot,
              });
              process.stderr.write(`${review.humanText}\n`);
            }
            const routeDecision = routeLiteOrFull(task, {
              requestedVerb: 'do',
              dailyProfile: resolveDailyProfile(),
            });
            if (!routeDecision.intent.mutation_allowed) {
              process.stderr.write(
                'Plan is ready. This task remains no-write until you ask Babel to apply a concrete change.\n',
              );
              return;
            }
            const approved = await promptPlanApproval(task, options.approve === true);
            if (!approved) {
              return;
            }
            const previousDryRun = process.env['BABEL_DRY_RUN'];
            const previousDryRunSource = process.env['BABEL_DRY_RUN_SOURCE'];
            if (options.shadow === true) {
              process.env['BABEL_DRY_RUN'] = 'true';
              process.env['BABEL_DRY_RUN_SOURCE'] = 'cli';
            }
            if (routeDecision.selected_lane === 'deep_lane') {
              await runDeepCommand(intent, {
                ...(options.project !== undefined ? { project: options.project } : {}),
                ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
                ...(options.model !== undefined ? { model: options.model } : {}),
                ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
                ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
                ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
                ...(((options as { json?: boolean }).json ?? false) ? { json: true } : {}),
              });
              if (options.shadow === true) {
                if (previousDryRun === undefined) {
                  delete process.env['BABEL_DRY_RUN'];
                } else {
                  process.env['BABEL_DRY_RUN'] = previousDryRun;
                }
                if (previousDryRunSource === undefined) {
                  delete process.env['BABEL_DRY_RUN_SOURCE'];
                } else {
                  process.env['BABEL_DRY_RUN_SOURCE'] = previousDryRunSource;
                }
              }
              return;
            }
            try {
              await runLiteCommand('do', intent, options);
            } finally {
              if (options.shadow === true) {
                if (previousDryRun === undefined) {
                  delete process.env['BABEL_DRY_RUN'];
                } else {
                  process.env['BABEL_DRY_RUN'] = previousDryRun;
                }
                if (previousDryRunSource === undefined) {
                  delete process.env['BABEL_DRY_RUN_SOURCE'];
                } else {
                  process.env['BABEL_DRY_RUN_SOURCE'] = previousDryRunSource;
                }
              }
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            if (options.json === true) {
              writeJson({ status: 'LITE_FAILED', command: 'plan', error: message });
            } else {
              console.error(`Babel: ${message}`);
            }
            process.exit(1);
          }
          return;
        }

        validateRuntimeEnvForCommand({ json: true });

        const project = legacyProject;
        const task = intent.slice(1).join(' ').trim();
        const normalizedModel = normalizeModelName(options.model);
        const normalizedModelTier =
          options.modelTier !== undefined ? options.modelTier.trim().toLowerCase() : undefined;
        const executionProfile = normalizeExecutionProfile('safe_repo');

        if (!task) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'PLAN_ALIAS_FAILED',
                error: 'Intent is required.',
              },
              null,
              2,
            )}\n`,
          );
          process.exit(1);
        }
        if (options.model !== undefined && normalizedModel === undefined) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'PLAN_ALIAS_FAILED',
                error: `Invalid model "${options.model}". Valid values: ${getAvailableModels()
                  .map((m) => m.key)
                  .join(', ')} (case-insensitive)`,
              },
              null,
              2,
            )}\n`,
          );
          process.exit(1);
        }
        if (
          normalizedModelTier !== undefined &&
          !VALID_MODEL_TIERS.includes(normalizedModelTier as (typeof VALID_MODEL_TIERS)[number])
        ) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'PLAN_ALIAS_FAILED',
                error: `Invalid model tier "${options.modelTier}". Valid values: ${VALID_MODEL_TIERS.join(', ')}`,
              },
              null,
              2,
            )}\n`,
          );
          process.exit(1);
        }
        if (
          options.orchestrator !== undefined &&
          !VALID_ORCHESTRATORS.includes(options.orchestrator as ValidOrchestrator)
        ) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'PLAN_ALIAS_FAILED',
                error: `Invalid orchestrator "${options.orchestrator}". Valid values: ${VALID_ORCHESTRATORS.join(', ')}`,
              },
              null,
              2,
            )}\n`,
          );
          process.exit(1);
        }
        if (executionProfile === null) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'PLAN_ALIAS_FAILED',
                error: `Invalid execution profile "safe_repo". Valid values: ${getExecutionProfileHelpText().replace(/ \| /g, ', ')}`,
              },
              null,
              2,
            )}\n`,
          );
          process.exit(1);
        }
        const effectiveAllowExpensive = resolveEffectiveAllowExpensive({
          task,
          ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
          ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
          allowExpensive: options.allowExpensive === true,
          outputFormat: 'json',
          manual: true,
        });
        if (normalizedModel !== undefined) {
          try {
            preflightRequestedModelPolicy(normalizedModel, {
              ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
              ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (isModelEscalationPolicyError(message)) {
              printModelEscalationApprovalRequired({
                task,
                ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
                ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
                outputFormat: 'json',
                manual: true,
              });
            }
            process.stdout.write(
              `${JSON.stringify(
                {
                  status: 'PLAN_ALIAS_FAILED',
                  error: message,
                },
                null,
                2,
              )}\n`,
            );
            process.exit(1);
          }
        }
        try {
          await runManualBridgeStart(task, {
            project,
            ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
            ...(options.orchestrator !== undefined
              ? { orchestratorVersion: options.orchestrator }
              : {}),
            ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
            ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
            ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options.sessionStartPath !== undefined
              ? { sessionStartPath: options.sessionStartPath }
              : {}),
            ...(options.localLearningRoot !== undefined
              ? { localLearningRoot: options.localLearningRoot }
              : {}),
            executionProfile,
          });
        } catch (err: unknown) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: 'PLAN_ALIAS_FAILED',
                error: err instanceof Error ? err.message : String(err),
              },
              null,
              2,
            )}\n`,
          );
          process.exit(1);
        }
      },
    );

  program
    .command('resume')
    .argument('[run]', 'latest or a run directory for action-taking resume')
    .description('Resume a retryable run and take the next action')
    .option('--run <run_dir>', 'Existing Babel run directory path')
    .option('--project <name>', 'Use latest run pointer for this project when --run is omitted')
    .option(
      '--plan <path>',
      'Path to manual plan.json, "-" for stdin, or "clipboard"; when omitted, resume uses <run_dir>/manual/plan.json',
    )
    .option('-m, --model <model>', 'Override the model family for provider retries')
    .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')}`)
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option('--json', 'Emit structured JSON only')
    .addHelpText(
      'after',
      `
Examples:
  $ babel resume latest
  $ bl resume latest
  $ babel resume --run C:/path/to/run --plan C:/path/to/plan.json
  $ babel resume --project example_saas_backend --plan clipboard
  $ type ./plan.json | babel resume --run C:/path/to/run --plan -

Important:
  - babel resume latest retries actionable saved runs; babel continue latest only inspects them.
  - If --run is omitted, Babel may fall back to the latest run pointer for the selected project or the global latest run.
  - If --plan is omitted, Babel uses <run_dir>/manual/plan.json and may create/open that file for editing first.
`,
    )
    .action(
      async (
        run: string | undefined,
        options: {
          run?: string;
          plan?: string;
          project?: string;
          model?: string;
          modelTier?: string;
          allowExpensive?: boolean;
          json?: boolean;
        },
      ) => {
        if (options.run !== undefined || options.plan !== undefined) {
          await handleResumeCommand(options);
          return;
        }
        await handleActionResumeCommand(run ?? 'latest', options);
      },
    );

  program
    .command('apply')
    .description('Legacy alias for resume (Manual Bridge resume flow)')
    .option('--run <run_dir>', 'Existing Babel run directory path')
    .option('--project <name>', 'Use latest run pointer for this project when --run is omitted')
    .option(
      '--plan <path>',
      'Path to manual plan.json, "-" for stdin, or "clipboard"; when omitted, apply uses <run_dir>/manual/plan.json',
    )
    .addHelpText(
      'after',
      `
Notes:
  - apply is kept for compatibility. Prefer resume in new docs and examples.
  - If --run is omitted, Babel may fall back to the latest run pointer for the selected project or the global latest run.
  - If --plan is omitted, Babel uses <run_dir>/manual/plan.json and may create/open that file for editing first.
`,
    )
    .action(async (options: { run?: string; plan?: string; project?: string }) => {
      await handleResumeCommand(options);
    });

  program
    .command('smoke')
    .description(
      'Advanced diagnostic: run Manual Bridge smoke suite and summarize executor outcomes',
    )
    .requiredOption(
      '--project <name>',
      'Target project (example_saas_backend | example_llm_router | AuditGuard | example_mobile_suite | example_game_suite | godot_td | app_test_babel)',
    )
    .addHelpText(
      'after',
      `
Examples:
  $ babel smoke --project example_saas_backend

Notes:
  - This is a diagnostic harness for Manual Bridge executor behavior, not a normal product test runner.
`,
    )
    .action(async (options: { project: string }) => {
      await handleSmokeCommand(options);
    });

  program
    .command('test')
    .description('Legacy alias for smoke diagnostic; not a general project test runner')
    .option(
      '--project <name>',
      'Target project (example_saas_backend | example_llm_router | AuditGuard | example_mobile_suite | example_game_suite | godot_td | app_test_babel)',
    )
    .argument('[project]', 'Target project')
    .addHelpText(
      'after',
      `
Notes:
  - test is kept for compatibility. Prefer smoke for this diagnostic command.
  - This command does not run a repo's normal unit/integration test suite.
`,
    )
    .action(async (projectArg: string | undefined, options: { project?: string }) => {
      const project = options.project ?? projectArg;
      if (!project) {
        process.stdout.write(
          `${JSON.stringify(
            {
              status: 'TEST_ALIAS_FAILED',
              error: 'Project is required. Use --project <name> or positional project.',
            },
            null,
            2,
          )}\n`,
        );
        process.exit(1);
      }
      await handleSmokeCommand({ project });
    });

  registerDogfoodCommands(program);

  // ── Worktree isolation commands ───────────────────────────────────────
  program
    .command('worktree')
    .description('Manage git worktree isolation for safe parallel work')
    .addCommand(
      new Command('create')
        .description('Create an isolated git worktree')
        .argument('<name>', 'Worktree name')
        .option('--project-root <path>', 'Project root', process.cwd())
        .option('--branch <name>', 'Branch name (default: babel-worktree-<name>)')
        .option('--detach', 'Detach HEAD (no branch)')
        .action(async (name, options) => {
          const { createWorktree } = await import('../services/worktreeIsolation.js');
          try {
            const info = createWorktree(name, {
              projectRoot: options.projectRoot,
              branch: options.branch,
              detach: options.detach,
            });
            console.log(JSON.stringify(info, null, 2));
          } catch (error: any) {
            console.error(`Worktree create failed: ${error.message}`);
            process.exit(1);
          }
        }),
    )
    .addCommand(
      new Command('enter')
        .description('Enter an existing worktree (sets BABEL_WORKTREE_ROOT)')
        .argument('<name>', 'Worktree name')
        .option('--project-root <path>', 'Project root', process.cwd())
        .action(async (name, options) => {
          const { enterWorktree } = await import('../services/worktreeIsolation.js');
          try {
            enterWorktree(name, options.projectRoot);
            const root = process.env['BABEL_WORKTREE_ROOT'];
            console.log(`Entered worktree "${name}" at ${root}`);
          } catch (error: any) {
            console.error(`Worktree enter failed: ${error.message}`);
            process.exit(1);
          }
        }),
    )
    .addCommand(
      new Command('exit')
        .description('Exit the active worktree (clears BABEL_WORKTREE_ROOT)')
        .action(async () => {
          const { exitWorktree, getActiveWorktreeRoot } =
            await import('../services/worktreeIsolation.js');
          const root = getActiveWorktreeRoot();
          exitWorktree();
          console.log(root ? `Exited worktree at ${root}` : 'No active worktree.');
        }),
    )
    .addCommand(
      new Command('list')
        .description('List all git worktrees')
        .option('--project-root <path>', 'Project root', process.cwd())
        .action(async (options) => {
          const { listWorktrees, getActiveWorktreeRoot } =
            await import('../services/worktreeIsolation.js');
          const entries = listWorktrees(options.projectRoot);
          if (entries.length === 0) {
            console.log('No worktrees found.');
            return;
          }
          const active = getActiveWorktreeRoot();
          for (const entry of entries) {
            const marker = entry.active ? ' *' : '  ';
            const head = entry.detached ? `(detached: ${entry.branch.slice(0, 8)})` : entry.branch;
            console.log(`${marker} ${entry.name}  ${head}  ${entry.path}`);
          }
          if (!active) {
            console.log('\n  No active worktree session.');
          }
        }),
    )
    .addCommand(
      new Command('remove')
        .description('Remove a worktree and its branch')
        .argument('<name>', 'Worktree name')
        .option('--project-root <path>', 'Project root', process.cwd())
        .option('--force', 'Force removal of dirty worktree')
        .action(async (name, options) => {
          const { removeWorktree } = await import('../services/worktreeIsolation.js');
          try {
            removeWorktree(name, {
              projectRoot: options.projectRoot,
              force: options.force,
            });
            console.log(`Removed worktree "${name}".`);
          } catch (error: any) {
            console.error(`Worktree remove failed: ${error.message}`);
            process.exit(1);
          }
        }),
    );
}
