import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
import { resolveApprovedWorkspacePath, verifyWorkspaceProject } from '../services/workspaceManager.js';
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
  VALID_PROJECTS,
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
import { printBanner, validateRuntimeEnvForCommand } from './coreCommands.js';
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

export { buildSmallFixLitePayload, normalizeSmallFixProvider, resolveSmallFixProviderForCommand };
export const READ_ONLY_LITE_TOOLS = ['directory_list', 'file_read', 'semantic_search', 'web_search', 'web_fetch'];

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
  return /expensive or blocked by policy|blocked by policy|explicit opt-in|\[ENTERPRISE_POLICY\]/i.test(message);
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
    boundary: 'This selected model route is expensive or blocked by policy, so Babel needs one explicit approval before it runs.',
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

  if (isModelEscalationApproved({
    task: options.task,
    model: options.model ?? null,
    modelTier: options.modelTier ?? null,
    projectRoot: options.projectRoot ?? null,
  })) {
    return true;
  }

  return false;
}

function buildCompletionVerificationForRun(input: {
  pipelineStatus: string;
  executionProfile: ExecutionProfileName;
  projectRoot?: string;
}) {
  const verification = input.pipelineStatus === 'COMPLETE' &&
    input.executionProfile === 'workspace_manager' &&
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
  const executionReport = recovery.available_artifacts.find(artifact => artifact.key === 'execution_report')?.path ?? null;
  const failureCapsule = recovery.available_artifacts.find(artifact => artifact.key === 'failure_capsule')?.path ?? null;
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
  if (recovery.status === 'CONTINUE_READY' && recovery.run_dir && recovery.classification !== null && (executionReport || failureCapsule)) {
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
  return status === 'COMPLETE' ||
    status === 'COMPLETE_NO_MODIFICATION' ||
    status === 'READ_ONLY_NO_MODIFICATION';
}

const READ_ONLY_RUN_TOOLS = ['directory_list', 'file_read', 'semantic_search', 'web_search', 'web_fetch'];

function isExplicitModeArg(): boolean {
  return process.argv.some(arg => arg === '--mode' || arg.startsWith('--mode='));
}

function isSimpleReadOnlyQuestion(task: string): boolean {
  return /\?/.test(task) ||
    /\b(what is|what's|explain|summarize|describe|where is|why is|how does|list|show me|inspect|audit)\b/i.test(task);
}

function isProviderSchemaFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /zod validation|invalid json|schema|parse/i.test(message);
}

export function shouldUseReadOnlyRunQuestionPath(input: {
  task: string;
  explicitMode: boolean;
  hasAllowedTools: boolean;
  hasDisallowedTools: boolean;
  hasLock: boolean;
}): boolean {
  return !input.explicitMode &&
    isSimpleReadOnlyQuestion(input.task) &&
    !input.hasAllowedTools &&
    !input.hasDisallowedTools &&
    !input.hasLock;
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
  }) as unknown as Record<string, unknown>;
  payload['command'] = 'run';
  payload['mode'] = 'direct';
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
    pipeline_mode: 'direct',
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
  return [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))];
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
  return normalizedUserAllowed.filter(tool => normalizedProfileAllowed.includes(tool));
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

  const executionProfile = options.executionProfile ?? resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']).name;
  const result = await withExecutionProfileEnv(executionProfile, [], [], () => withMutedConsole(() => runBabelPipeline(task, {
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.model !== undefined ? { modelOverride: options.model } : {}),
    ...(options.orchestratorVersion !== undefined ? { orchestratorVersion: options.orchestratorVersion as ValidOrchestrator } : {}),
    ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
    ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
    ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
    ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
    ...(options.lockedFiles !== undefined && options.lockedFiles.length > 0 ? { lockedFiles: options.lockedFiles } : {}),
    executionProfile,
    mode: 'manual',
  })));

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
};

async function handleLiteContinueCommand(
  run: string,
  options: { project?: string; projectRoot?: string; provider?: string; json?: boolean; resume?: boolean },
): Promise<void> {
  const resolvedProjectRoot = options.projectRoot !== undefined
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

export function resolveLitePipelineMode(verb: LiteVerb): ValidMode {
  if (verb === 'ask' || verb === 'plan' || verb === 'patch' || verb === 'propose' || verb === 'diff' || verb === 'review' || verb === 'undo') {
    return 'direct';
  }
  return 'verified';
}

export function resolveLiteAllowedTools(verb: LiteVerb): string[] {
  return verb === 'ask' || verb === 'plan' || verb === 'patch' || verb === 'propose' || verb === 'diff' || verb === 'review' || verb === 'undo'
    ? READ_ONLY_LITE_TOOLS
    : [];
}

function toSessionVerb(verb: LiteVerb): LiteSessionVerb {
  return verb;
}

function printLiteResult(result: Awaited<ReturnType<typeof runBabelPipeline>>, context: {
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
}): void {
  const payload = buildLiteResultPayload(result, {
    verb: context.verb,
    task: context.task,
    mode: context.mode,
    ...(context.project !== undefined ? { project: context.project } : {}),
    ...(context.projectRoot !== undefined ? { projectRoot: context.projectRoot } : {}),
    ...(context.requestedModel !== undefined ? { requestedModel: context.requestedModel } : {}),
    ...(context.requestedModelTier !== undefined ? { requestedModelTier: context.requestedModelTier } : {}),
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
    next: [typeof record['nextCommand'] === 'string' ? record['nextCommand'] : 'babel continue latest'],
    next_command: typeof record['nextCommand'] === 'string' ? record['nextCommand'] : 'babel continue latest',
    recovery: buildRecoveryAssessment({ run: runDir }),
  };
}

export function classifyDoTask(task: string): Exclude<LiteVerb, 'do'> {
  const normalized = task.toLowerCase();
  const hasMutationIntent = /\b(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove)\b/.test(normalized);
  if (/\b(explain|summarize|what|why|how|read[- ]only|do not edit|do not modify|without editing|without changes)\b/.test(normalized) && !hasMutationIntent) {
    return 'ask';
  }
  if (/\b(plan|design|approach|compare|implementation path)\b/.test(normalized) && !hasMutationIntent) {
    return 'plan';
  }
  if (/\b(patch|diff|propose|proposal)\b/.test(normalized) && !/\b(apply|edit|modify|change|fix|repair|implement|write|create|delete|remove)\b/.test(normalized)) {
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
    if (verb === 'review') {
      task = 'Review current diff';
    } else if (verb === 'undo') {
      task = 'Restore last checkpoint';
    } else {
      throw new Error(`bl ${verb} requires task text.`);
    }
  }

  validateRuntimeEnvForCommand({ json: options.json === true });

  const normalizedModel = normalizeModelName(options.model);
  const normalizedModelTier = options.modelTier !== undefined ? options.modelTier.trim().toLowerCase() : undefined;
  const executionProfile = normalizeExecutionProfile(options.executionProfile ?? 'safe_repo');
  const resolvedProject = options.project ?? detectProjectFromCwd() ?? undefined;
  const routeDecision = routeLiteOrFull(task, {
    requestedVerb: verb,
    forceLiteOnly: options.liteOnly === true,
  });

  if (executionProfile === null) {
    throw new Error(`Invalid execution profile "${options.executionProfile}". Valid values: ${getExecutionProfileHelpText().replace(/ \| /g, ', ')}`);
  }

  if (options.model !== undefined && normalizedModel === undefined) {
    throw new Error(`Invalid model "${options.model}". Valid values: ${getAvailableModels().map(m => m.key).join(', ')} (case-insensitive)`);
  }

  if (normalizedModelTier !== undefined && !VALID_MODEL_TIERS.includes(normalizedModelTier as typeof VALID_MODEL_TIERS[number])) {
    throw new Error(`Invalid model tier "${options.modelTier}". Valid values: ${VALID_MODEL_TIERS.join(', ')}`);
  }

  let resolvedProjectRoot: string | undefined;
  let resolvedWorkspaceRoot: string | null = null;
  let resolvedAllowedRoots: string[] = [];
  if (options.projectRoot !== undefined) {
    if (executionProfile === 'workspace_manager') {
      const resolved = resolveApprovedWorkspacePath(options.projectRoot);
      resolvedProjectRoot = resolved.path;
      resolvedAllowedRoots = resolved.approvedRoots;
    } else {
      resolvedProjectRoot = resolve(options.projectRoot);
    }
  } else if (resolvedProject !== undefined) {
    resolvedProjectRoot = resolveProjectRoot(resolvedProject) ?? (verb === 'ask' ? process.cwd() : undefined);
  } else if (verb === 'ask') {
    resolvedProjectRoot = process.cwd();
  }
  if (
    verb === 'ask' ||
    verb === 'plan' ||
    verb === 'patch' ||
    verb === 'propose' ||
    verb === 'diff' ||
    verb === 'review' ||
    verb === 'undo' ||
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
    };
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
  const useWorkerChain = options.workerChain === true ||
    (verb === 'do' && process.env['BABEL_LITE_WORKER_CHAIN'] === '1');
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
    ...(verb === 'fix' || verb === 'do' || verb === 'propose' || verb === 'patch' || verb === 'diff' || useWorkerChain
      ? { provider: resolvedProvider }
      : {}),
    ...(useWorkerChain ? { workerChain: true } : {}),
    ...(verb === 'fix' && options.rollbackOnFail === true ? { rollbackOnFail: true } : {}),
    executionProfile,
    liteOnly: options.liteOnly === true,
    agentsMode: normalizeAgentsMode(options.agents),
    json: options.json === true,
    stream: options.stream === true,
    routeDecision,
  };
  const session = new AgentSession(sessionOptions);

  const offlineEnvSnapshot = snapshotLiteOfflineEnv();
  if (providerUsesOfflineEnv(verb) || useWorkerChain) {
    applyLiteOfflineEnv(resolvedProvider);
  }

  const allowedToolsVerb = useWorkerChain
    ? 'fix'
    : (verb === 'do' ? liteVerbForSelectedLane(routeDecision.selected_lane) : verb);

  const runSession = (activeSession: AgentSession) => withExecutionProfileEnv(
    executionProfile,
    resolveLiteAllowedTools(allowedToolsVerb),
    [],
    () => withProjectRootEnv(
      resolvedProjectRoot,
      resolvedAllowedRoots,
      () => withMutedConsole(() => activeSession.run()),
    ),
  );

  let result;
  try {
    try {
      result = await runSession(session);
    } catch (error: unknown) {
      if (verb !== 'plan' || !isProviderSchemaFailure(error)) {
        throw error;
      }
      const fallbackSession = new AgentSession({
        ...sessionOptions,
        provider: 'mock',
      });
      result = await runSession(fallbackSession);
      const payload = result.payload as LiteResultPayload;
      payload.schema_retries = (payload.schema_retries ?? 0) + 1;
      payload.recovered_after_schema_retry = true;
      payload.route_reason = payload.route_reason
        ? `${payload.route_reason} Recovered from provider schema failure with the local read-only planner.`
        : 'Recovered from provider schema failure with the local read-only planner.';
      result.humanText = formatLiteResultHuman(payload);
    }
  } finally {
    restoreLiteOfflineEnv(offlineEnvSnapshot);
  }

  if (options.json === true) {
    writeJson(result.payload);
  } else if (options.stream === true && verb === 'ask') {
    const humanText = result.humanText
      ?? ('status' in result.payload ? formatLiteResultHuman(result.payload as LiteResultPayload) : null);
    const payloadRecord = result.payload as Record<string, unknown>;
    const runDir = typeof payloadRecord['run_dir'] === 'string' ? payloadRecord['run_dir'] : null;
    if (humanText && runDir) {
      writeHumanSummaryArtifact(runDir, humanText);
    }
  } else {
    const humanText = result.humanText
      ?? ('status' in result.payload ? formatLiteResultHuman(result.payload as LiteResultPayload) : null);
    if (humanText) {
      process.stdout.write(`${humanText}\n`);
      const payloadRecord = result.payload as Record<string, unknown>;
      const runDir = typeof payloadRecord['run_dir'] === 'string' ? payloadRecord['run_dir'] : null;
      if (runDir) {
        const review = writeHumanSummaryArtifact(runDir, humanText);
        if (review?.status === 'needs_attention') {
          process.stdout.write('Output review: target mismatch detected\n');
        }
      }
    }
  }

  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

async function handleResumeCommand(
  options: { run?: string; plan?: string; project?: string },
): Promise<void> {
  validateRuntimeEnvForCommand({ json: true });

  let resolvedRun = options.run;
  if (!resolvedRun) {
    const latest = readLatestRunPointer(options.project);
    if (!latest) {
      process.stdout.write(`${JSON.stringify({
        status: 'NO_LATEST_RUN',
        how_to: [
          'babel plan example_llm_router "..."',
          'babel run --project example_llm_router "..."',
        ],
      }, null, 2)}\n`);
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
          process.stdout.write(`${JSON.stringify({
            status: 'MANUAL_PLAN_INVALID',
            run_dir: result.runDir,
            plan_path: autoDiscoveredPath,
            editor: editor.editor,
            repair_prompt_path: result.repairPromptPath,
            errors: result.errors ?? [],
          }, null, 2)}\n`);
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
      process.stdout.write(`${JSON.stringify({
        status: 'MANUAL_PLAN_INVALID',
        run_dir: result.runDir,
        repair_prompt_path: result.repairPromptPath,
        errors: result.errors ?? [],
      }, null, 2)}\n`);
      process.exit(1);
    }

    process.stdout.write(`${JSON.stringify({
      status: result.status,
      run_dir: result.runDir,
    }, null, 2)}\n`);

    if (result.status !== 'COMPLETE') {
      process.exit(1);
    }
  } catch (err: unknown) {
    process.stdout.write(`${JSON.stringify({
      status: 'MANUAL_RESUME_FAILED',
      run_dir: resolvedRun,
      error: err instanceof Error ? err.message : String(err),
    }, null, 2)}\n`);
    process.exit(1);
  }
}

async function handleActionResumeCommand(
  run: string,
  options: { project?: string; model?: string; modelTier?: string; allowExpensive?: boolean; json?: boolean },
): Promise<void> {
  const normalizedModel = options.model !== undefined ? normalizeModelName(options.model) : undefined;
  const result = await withMutedConsole(() => resumeExecution({
    run,
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(options.modelTier !== undefined ? { modelTier: options.modelTier } : {}),
    ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
  }));
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
    const task = 'Manual Bridge smoke test: validate executor robustness with fixture plans.';

    const manualResult = await withMutedConsole(() => runBabelPipeline(task, {
      project: options.project,
      mode: 'manual',
    }));

    if (manualResult.status !== 'MANUAL_BRIDGE_REQUIRED' || !manualResult.manualPromptPath) {
      throw new Error(`Manual start failed with status ${manualResult.status}`);
    }

    const runDir = manualResult.runDir;
    const manifestProjectRoot = manualResult.manifest.target_project_path?.trim();
    const resolvedProjectRoot = manifestProjectRoot && existsSync(manifestProjectRoot)
      ? manifestProjectRoot
      : resolveProjectRoot(options.project) ?? process.env['BABEL_PROJECT_ROOT'];
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
        fixture.name === 'sandbox_rejection' || fixture.name === 'mcp_unknown_server'
          ? 1
          : 3;
      let resumed = await withMutedConsole(() => resumeManualBridge(runDir, fixture.path));
      let haltTag = extractHaltTagFromExecutionReport(runDir);
      let denial = extractStructuredDenialFromExecutionReport(runDir);
      let mcpLifecycle = extractMcpLifecycleFromExecutionReport(runDir);

      if (fixture.name !== 'sandbox_rejection' && fixture.name !== 'mcp_unknown_server') {
        for (let attempt = 2; attempt <= maxAttempts; attempt++) {
          const shouldRetry =
            (resumed.status === 'QA_REJECTED_MAX_LOOPS') ||
            (resumed.status === 'COMPLETE' && (haltTag === 'ACTIVATION_GATE_FAIL' || haltTag === 'UNKNOWN'));
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
        const denialCategory = typeof denial?.['category'] === 'string' ? String(denial['category']) : null;
        const denialReasonCode = typeof denial?.['reason_code'] === 'string' ? String(denial['reason_code']) : null;
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
        const lifecyclePhase = typeof mcpLifecycle?.['phase'] === 'string' ? String(mcpLifecycle['phase']) : null;
        const lifecycleOutcome = typeof mcpLifecycle?.['outcome'] === 'string' ? String(mcpLifecycle['outcome']) : null;
        const lifecycleReasonCode = typeof mcpLifecycle?.['reason_code'] === 'string' ? String(mcpLifecycle['reason_code']) : null;
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

    process.stdout.write(`${JSON.stringify({
      status: 'SMOKE_COMPLETE',
      project: options.project,
      run_dir: runDir,
      manual_prompt_path: manualResult.manualPromptPath,
      cases,
    }, null, 2)}\n`);

    if (cases.some((item) => item.status === 'HALT')) {
      process.exit(1);
    }
  } catch (err: unknown) {
    process.stdout.write(`${JSON.stringify({
      status: 'SMOKE_FAILED',
      error: err instanceof Error ? err.message : String(err),
    }, null, 2)}\n`);
    process.exit(1);
  }
}

export function registerWorkflowCommands(program: Command): void {
  const liteCommand = program
    .command('lite')
    .alias('l')
    .description('Babel Lite: short ask, plan, fix, and do commands for everyday work')
    .addHelpText('after', `
Examples:
  $ bl "Fix failing tests"
  $ bl ask "Why is this failing?"
  $ bl plan "Compare the implementation options"
  $ bl propose "Propose the smallest safe diff"
  $ bl fix "Fix failing tests"
  $ bl review
  $ bl undo

Notes:
  - Bare bl "<task>" routes through the daily do lane.
  - ask/plan/propose/diff/review are read-only; fix is the default mutation lane.
  - patch is a compatibility alias for propose.
  - undo restores the latest checkpoint from the latest fix run.
  - Use babel run for advanced audit flags, JSON event streams, or explicit governed modes.
`);

  const addLiteOptions = (command: Command): Command => command
    .option('-p, --project <name>', 'Target project')
    .option('-m, --model <model>', 'Override the model family')
    .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')}`)
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option('--show-model-policy', 'Include model policy metadata where available')
    .option('--project-root <path>', 'Explicit project root for arbitrary approved workspace repos')
    .option('--execution-profile <profile>', `Execution profile: ${getExecutionProfileHelpText()}`, 'safe_repo')
    .option('--lite-only', 'Refuse instead of escalating from Lite to Babel Full')
    .option('--agents <mode>', 'Full lane agent mode: off | read-only', 'read-only')
    .option('--provider <provider>', 'Provider: live | mock (mock = offline demo; fix, propose, patch, diff)')
    .option('--worker-chain', 'Run plan→propose→fix→review→undo in one linked session (bl do)')
    .option('--stream', 'Stream conversational LLM answers in real time (ask only)')
    .option('--json', 'Emit structured JSON only');

  const runLiteAction = (verb: LiteVerb) => async (taskParts: string[], options: LiteCommandOptions) => {
    try {
      await runLiteCommand(verb, taskParts, options);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const recovery = getRecoverableErrorFields(err);
      if (options.json === true) {
        writeJson({
          status: 'LITE_FAILED',
          command: verb,
          user_status: 'failed',
          error: message,
          recoverable: recovery['recoverable'] === true,
          next: Array.isArray(recovery['next']) ? recovery['next'] : [],
          ...recovery,
        });
      } else {
        console.error(`[babel-lite] ${message}`);
        if (typeof recovery['support_path'] === 'string') {
          console.error(`[babel-lite] support: ${recovery['support_path']}`);
        }
        if (Array.isArray(recovery['next']) && recovery['next'].length > 0) {
          for (const step of recovery['next']) {
            console.error(`[babel-lite] next: ${step}`);
          }
        } else if (typeof recovery['next_command'] === 'string') {
          console.error(`[babel-lite] next: ${recovery['next_command']}`);
        }
      }
      process.exit(1);
    }
  };

  const registerLiteVerb = (verb: LiteVerb, description: string, options: { hidden?: boolean } = {}): void => {
    const command = addLiteOptions(liteCommand
      .command(verb)
      .argument('<task...>', 'Task text')
      .description(description));
    if (options.hidden === true) {
      (command as unknown as { _hidden: boolean })._hidden = true;
    }
    command.action(runLiteAction(verb));
  };

  registerLiteVerb('ask', 'Inspect and explain without editing files');
  registerLiteVerb('plan', 'Prepare a read-only implementation plan artifact');
  registerLiteVerb('propose', 'Produce a proposal-only diff without applying changes');
  registerLiteVerb('diff', 'Produce a proposal-only diff without applying changes');
  addLiteOptions(liteCommand
    .command('fix')
    .argument('<task...>', 'Task text')
    .description('Apply a focused fix, using the small-fix fast path when safe'))
    .option('--rollback-on-fail', 'On verifier failure, auto-restore the pre-mutation checkpoint')
    .action(runLiteAction('fix'));
  registerLiteVerb('do', 'Let Babel choose the daily work lane for the task');
  registerLiteVerb('patch', 'Compatibility alias for proposal-only diff behavior', { hidden: false });
  addLiteOptions(liteCommand
    .command('review')
    .argument('[task...]', 'Optional review focus')
    .description('Review the current diff without mutating source'))
    .action(runLiteAction('review'));

  addLiteOptions(liteCommand
    .command('undo')
    .argument('[task...]', 'Optional undo note')
    .description('Restore the last checkpoint from the latest Lite fix run'))
    .action(runLiteAction('undo'));

  liteCommand
    .command('continue')
    .argument('[run]', 'latest or a run directory', 'latest')
    .description('Resume a linked Lite worker chain or inspect the latest recovery step')
    .option('-p, --project <name>', 'Use latest run pointer for this project')
    .option('--project-root <path>', 'Repo root for worker-chain manifest lookup')
    .option('--provider <provider>', 'Provider override when resuming fix/propose steps: live | mock')
    .option('--inspect-only', 'Inspect recovery state without resuming worker-chain steps')
    .option('--json', 'Emit structured JSON only')
    .action(async (run: string, options: {
      project?: string;
      projectRoot?: string;
      provider?: string;
      inspectOnly?: boolean;
      json?: boolean;
    }) => {
      await handleLiteContinueCommand(run, {
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        json: options.json === true,
        resume: options.inspectOnly !== true,
      });
    });

  liteCommand
    .command('resume')
    .argument('[run]', 'latest or a run directory', 'latest')
    .description('Resume a retryable Lite/Babel run and take the next action')
    .option('-p, --project <name>', 'Use latest run pointer for this project')
    .option('-m, --model <model>', 'Override the model family for provider retries')
    .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')}`)
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option('--json', 'Emit structured JSON only')
    .action(async (run: string, options: { project?: string; model?: string; modelTier?: string; allowExpensive?: boolean; json?: boolean }) => {
      await handleActionResumeCommand(run, options);
    });

  addLiteOptions(program
    .command('ask')
    .argument('<task...>', 'Task text')
    .description('Ask Babel to inspect and explain without editing files'))
    .addHelpText('after', `
Examples:
  $ babel ask "Why is this failing?"
  $ babel ask "Summarize this repo" --project-root ./example-project

Notes:
  - This is the same user-shaped lane as bl ask.
  - It uses read-only tools and skips the plan/QA loop by default.
`)
    .action(runLiteAction('ask'));

  addLiteOptions(program
    .command('propose')
    .argument('<task...>', 'Task text')
    .description('Produce a proposal-only diff without applying changes'))
    .action(runLiteAction('propose'));

  addLiteOptions(program
    .command('review')
    .argument('[task...]', 'Optional review focus')
    .description('Review the current diff without mutating source'))
    .action(runLiteAction('review'));

  addLiteOptions(program
    .command('undo')
    .argument('[task...]', 'Optional undo note')
    .description('Restore the last checkpoint from the latest Lite fix run'))
    .action(runLiteAction('undo'));

  addLiteOptions(program
    .command('fix')
    .argument('<task...>', 'Task text')
    .description('Ask Babel to make a focused safe edit'))
    .option('--rollback-on-fail', 'On verifier failure, auto-restore the pre-mutation checkpoint')
    .addHelpText('after', `
Examples:
  $ babel fix "Fix failing tests"
  $ babel fix "Repair the CLI help"

Notes:
  - This is the same user-shaped lane as bl fix.
  - Use babel run when you need full audit flags or JSON event streams.
`)
    .action(runLiteAction('fix'));

  addLiteOptions(program
    .command('do')
    .argument('<task...>', 'Task text')
    .description('Ask Babel to choose the daily work lane and do the task'))
    .addHelpText('after', `
Examples:
  $ babel do "Fix failing tests"
  $ babel do "Explain this failure without editing"

Notes:
  - do chooses ask, plan, small-fix, or verified fallback from the task shape.
  - Use --json to see the selected lane.
`)
    .action(runLiteAction('do'));

  program
    .command('full')
    .argument('<task...>', 'Task text')
    .description('Use Babel Full with read-only Spark plan hardening before governed execution')
    .option('-p, --project <name>', 'Target project')
    .option('--project-root <path>', 'Explicit project root for arbitrary approved workspace repos')
    .option('--agents <mode>', 'Full lane agent mode: off | read-only', 'read-only')
    .option('--json', 'Emit structured JSON only')
    .addHelpText('after', `
Examples:
  $ babel full "Harden the implementation plan for this repo-wide migration"
  $ babel full "Audit plugin/public proof closure" --agents read-only --json

Notes:
  - Babel Full writes route, read-only Spark evidence, hardened plan, QA review, and cost artifacts under runs/babel-full.
  - Mutating live subagents remain disabled in this proof batch.
`)
    .action((taskParts: string[], options: { project?: string; projectRoot?: string; agents?: string; json?: boolean }) => {
      const task = normalizeLiteTask(taskParts);
      if (!task) {
        throw new Error('babel full requires task text.');
      }
      validateRuntimeEnvForCommand({ json: options.json === true });
      const routeDecision = routeLiteOrFull(task, { requestedVerb: 'full' });
      const resolvedProjectRoot = options.projectRoot !== undefined
        ? resolve(options.projectRoot)
        : undefined;
      printFullRouteResult({
        task,
        routeDecision,
        ...(resolvedProjectRoot !== undefined ? { projectRoot: resolvedProjectRoot } : {}),
        agentsMode: normalizeAgentsMode(options.agents),
        json: options.json === true,
      });
    });

  program
    .command('continue')
    .argument('[run]', 'latest or a run directory', 'latest')
    .description('Resume a linked Lite worker chain or inspect the latest recovery step')
    .option('-p, --project <name>', 'Use latest run pointer for this project')
    .option('--project-root <path>', 'Repo root for worker-chain manifest lookup')
    .option('--provider <provider>', 'Provider override when resuming fix/propose steps: live | mock')
    .option('--inspect-only', 'Inspect recovery state without resuming worker-chain steps')
    .option('--json', 'Emit structured JSON only')
    .addHelpText('after', `
Examples:
  $ babel continue latest
  $ babel continue ./example-project/runs/<run-id>
  $ bl continue latest

Notes:
  - continue resumes linked Lite worker-chain steps when a manifest exists.
  - Use --inspect-only to classify recovery without executing the next step.
`)
    .action(async (run: string, options: {
      project?: string;
      projectRoot?: string;
      provider?: string;
      inspectOnly?: boolean;
      json?: boolean;
    }) => {
      await handleLiteContinueCommand(run, {
        ...(options.project !== undefined ? { project: options.project } : {}),
        ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        json: options.json === true,
        resume: options.inspectOnly !== true,
      });
    });

  program
    .command('run')
    .argument('<task>', 'task prompt')
    .description('Advanced pipeline lane for explicit modes, audit, output, and tool/model controls')
    .option('-p, --project <name>', 'Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite | example_game_workspace | example_game_suite | example_autonomous_agent | example_mobile_reference)')
    .option('--mode <mode>', `Pipeline mode: ${VALID_MODES.join(' | ')} (manual emits Manual Bridge handoff JSON)`, 'verified')
    .option('-m, --model <model>', 'Override the Orchestrator and force a specific model family (qwen3|deepseek|step-flash|scout|nemotron|qwen3-32b, case-insensitive)')
    .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')} (defaults to configured policy tier)`)
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option('--show-model-policy', 'Print the resolved backend model, provider ID, and approximate cost metadata')
    .option('--session-id <id>', 'Associate this raw evidence bundle with a Local Mode session ID')
    .option('--session-start-path <path>', 'Attach this run to an exact Local Mode session-start artifact')
    .option('--local-learning-root <path>', 'Attach this run to a specific Local Mode learning root')
    .option('--project-root <path>', 'Explicit project root for arbitrary approved workspace repos')
    .option('--orchestrator <version>', 'Advanced: override orchestrator contract version (default v9)')
    .option('--log-file <path>', 'Override the default per-run log with a custom log file path')
    .option('--no-auto-log', 'Disable the default automatic per-run terminal transcript (babel.log)')
    .option('--lock <files>', 'Comma-separated list of project-relative file paths the executor must not write')
    .option('--allowed-tools <tools>', 'Comma-separated executor tool allowlist; when set, all other tools are denied')
    .option('--disallowed-tools <tools>', 'Comma-separated executor tool denylist; deny rules take precedence')
    .option('--execution-profile <profile>', `Execution profile: ${getExecutionProfileHelpText()}`, 'safe_repo')
    .option('--benchmark', 'Enable performance benchmarking and output manifest resolution latency')
    .option('--json', 'Emit final run result as structured JSON only')
    .option('--output-format <format>', 'Output format: text | json | stream-json | headless | jsonl | ndjson', 'text')
    .addHelpText('after', `
Examples:
  $ bl ask "Why is this failing?"
  $ bl fix "Fix failing tests"
  $ bl plan "Compare the implementation options"
  $ babel "Fix failing tests"
  $ babel ask "Why is this failing?"
  $ babel fix "Fix failing tests"
  $ babel run "Fix failing tests"
  $ babel run "Add dark mode toggle" --mode verified
  $ babel run "Fan out investigation" --mode parallel_swarm
  $ babel run "Prepare rollout plan" --mode manual --show-model-policy
  $ babel run "Refine ingestion worker" --model deepseek --model-tier standard
  $ babel run "Inspect catalog" --json
  $ babel run "Fix lint" --output-format stream-json
  $ babel run "Fix lint" --output-format headless
  $ babel run "Audit only" --allowed-tools directory_list,file_read,semantic_search
  $ babel run "Fix tests" --execution-profile dev_local
  $ babel run "Fix tests" --execution-profile workspace_manager --project-root ./example-game
  $ babel run "Solve task" --execution-profile benchmark_container --mode autonomous

Notes:
  - Use bl for daily work; babel run is the advanced pipeline lane under "babel advanced".
  - bl ask|fix|plan maps to user-shaped defaults.
  - babel ask|fix|plan are the same user-shaped lanes from the main CLI.
  - babel lite ask|fix|patch|plan and babel l ask|fix|patch|plan are compatibility shorthands for the same Lite path.
  - --mode manual switches run into the Manual Bridge start flow and emits handoff JSON instead of the standard banner/status output.
  - --json emits one final JSON object; --output-format stream-json/headless/jsonl/ndjson emits newline-delimited JSON events plus a final run_complete event.
  - If --project is omitted, Babel auto-detects the current repo when run from a known workspace project.
  - --model-tier selects the backend model tier under the current family route; default is loaded from config/model-policy.json.
  - Remote provider calls are normal when credentials are configured; Babel should show the boundary without blocking everyday use.
  - Explicit --model-tier escalation or --allow-expensive is treated as consent for that one interactive run.
  - Shorthand is supported: babel <Project> "<task...>" maps to babel run --project <Project> "<task...>".
`)
  .action(async (
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
      },
    ) => {
      const isManualMode = options.mode === 'manual';
      const requestedMode = options.mode ?? 'verified';
      const outputFormat = parseRunOutputFormat(options.outputFormat, options.json);
      if (outputFormat === null) {
        const message = `Invalid output format "${options.outputFormat}". Valid values: text, json, stream-json, headless, jsonl, ndjson`;
        if (options.json === true) {
          writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
        } else {
          console.error(`[babel] ${message}`);
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
      const mode = shouldUseReadOnlyQuestionPath ? 'direct' : requestedMode;

      const normalizedModel = normalizeModelName(options.model);
      const normalizedModelTier = options.modelTier !== undefined ? options.modelTier.trim().toLowerCase() : undefined;
      const lockedFiles = parseCommaSeparatedFiles(options.lock);
      const allowedTools = shouldUseReadOnlyQuestionPath ? READ_ONLY_RUN_TOOLS : parseCommaSeparatedFiles(options.allowedTools);
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
          console.error(`[babel] ${message}`);
        }
        process.exit(1);
      }

      if (executionProfile === null) {
        const message = `Invalid execution profile "${options.executionProfile}". Valid values: ${getExecutionProfileHelpText().replace(/ \| /g, ', ')}`;
        if (isStructuredOutput) {
          writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
        } else {
          console.error(`[babel] ${message}`);
        }
        process.exit(1);
      }

      if (options.projectRoot !== undefined) {
        try {
          if (executionProfile === 'workspace_manager') {
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
            console.error(`[babel] ${message}`);
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
            writeNdjson(makeRunStreamEvent('run_error', {
              error: message,
              status: 'EXECUTOR_HALTED',
              result: buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
            }));
          } else {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          }
        } else {
          process.stdout.write(`${formatRunResultHuman({
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
          })}\n`);
        }
        process.exitCode = 1;
        return;
      }

      if (options.model !== undefined && normalizedModel === undefined) {
        const message = `Invalid model "${options.model}". Valid values: ${getAvailableModels().map(m => m.key).join(', ')} (case-insensitive)`;
        if (isStructuredOutput) {
          writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
        } else {
          console.error(`[babel] ${message}`);
        }
        process.exit(1);
      }

      if (normalizedModelTier !== undefined && !VALID_MODEL_TIERS.includes(normalizedModelTier as typeof VALID_MODEL_TIERS[number])) {
        const message = `Invalid model tier "${options.modelTier}". Valid values: ${VALID_MODEL_TIERS.join(', ')}`;
        if (isStructuredOutput) {
          writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
        } else {
          console.error(`[babel] ${message}`);
        }
        process.exit(1);
      }

      if (options.orchestrator !== undefined && !VALID_ORCHESTRATORS.includes(options.orchestrator as ValidOrchestrator)) {
        const message = `Invalid orchestrator "${options.orchestrator}". Valid values: ${VALID_ORCHESTRATORS.join(', ')}`;
        if (isStructuredOutput) {
          writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
        } else {
          console.error(`[babel] ${message}`);
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
            process.stdout.write(`${JSON.stringify({
              status: 'MANUAL_BRIDGE_FAILED',
              error: message,
            }, null, 2)}\n`);
            process.exit(1);
          }
          if (isStructuredOutput) {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            console.error(`[babel] Fatal: ${message}`);
          }
          process.exit(1);
        }
      }

      if (mode === 'manual') {
        try {
          await withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () => runManualBridgeStart(task, {
            ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
            ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
            ...(options.orchestrator !== undefined ? { orchestratorVersion: options.orchestrator } : {}),
            ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
            ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
            ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
            ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
            ...(lockedFiles.length > 0 ? { lockedFiles } : {}),
            executionProfile,
          }));
          return;
        } catch (err: unknown) {
          process.stdout.write(`${JSON.stringify({
            status: 'MANUAL_BRIDGE_FAILED',
            error: err instanceof Error ? err.message : String(err),
          }, null, 2)}\n`);
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

      if (shouldUseReadOnlyQuestionPath) {
        if (outputFormat === 'stream-json') {
          writeNdjson(makeRunStreamEvent('run_start', {
            task,
            mode: mode as ValidMode,
            project: resolvedProject ?? null,
          }));
        }
        try {
          const payload = await withExecutionProfileEnv(
            executionProfile,
            allowedTools,
            disallowedTools,
            () => withProjectRootEnv(
              resolvedProjectRoot,
              resolvedAllowedRoots,
              () => withMutedConsole(() => runReadOnlyQuestionAsRun({
                task,
                ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
                projectRoot: resolvedProjectRoot!,
                ...(resolvedWorkspaceRoot !== null ? { workspaceRoot: resolvedWorkspaceRoot } : {}),
                ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
                ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
                ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
                ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
              })),
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
            if (review?.status === 'needs_attention') {
              process.stdout.write('\nOutput review: target mismatch detected\n');
            }
          }
          if (payload['status'] !== 'ANSWER_READY') {
            process.exitCode = 1;
          }
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (outputFormat === 'stream-json') {
            writeNdjson(makeRunStreamEvent('run_error', {
              error: message,
              status: 'EXECUTOR_HALTED',
              result: buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }),
            }));
          } else if (outputFormat === 'json') {
            writeJson(buildRunCommandFailurePayload({ status: 'EXECUTOR_HALTED', message }));
          } else {
            process.stdout.write(`${formatRunResultHuman({
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
            })}\n`);
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
          const result = await withExecutionProfileEnv(executionProfile, allowedTools, disallowedTools, () => withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () => withMutedConsole(() => runBabelPipeline(task, {
            ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
            ...(normalizedModel !== undefined ? { modelOverride: normalizedModel } : {}),
            ...(options.orchestrator !== undefined ? { orchestratorVersion: options.orchestrator as ValidOrchestrator } : {}),
            ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
            ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
            ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
            ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
            ...(lockedFiles.length > 0 ? { lockedFiles } : {}),
            mode: mode as ValidMode,
            executionProfile,
            ...(options.logFile !== undefined ? { logFile: options.logFile } : {}),
            ...(options.autoLog !== undefined ? { autoLog: options.autoLog } : {}),
            ...(options.benchmark === true ? { benchmark: true } : {}),
            eventBus,
          }))));

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
            writeNdjson(makeRunStreamEvent('run_error', {
              error: message,
              status: failureStatus,
              result: buildRunCommandFailurePayload({ status: failureStatus, message }),
            }));
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
        const result = await withExecutionProfileEnv(executionProfile, allowedTools, disallowedTools, () => withProjectRootEnv(resolvedProjectRoot, resolvedAllowedRoots, () => withMutedConsole(() => runBabelPipeline(task, {
          ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
          ...(normalizedModel !== undefined ? { modelOverride: normalizedModel } : {}),
          ...(options.orchestrator !== undefined ? { orchestratorVersion: options.orchestrator as ValidOrchestrator } : {}),
          ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
          ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
          ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
          ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
          ...(lockedFiles.length > 0 ? { lockedFiles } : {}),
          mode: mode as ValidMode,
          executionProfile,
          ...(options.logFile !== undefined ? { logFile: options.logFile } : {}),
          ...(options.autoLog !== undefined ? { autoLog: options.autoLog } : {}),
          ...(options.benchmark === true ? { benchmark: true } : {}),
          eventBus,
        }))));

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
          [typeof liveRenderer.getTranscript === 'function' ? liveRenderer.getTranscript() : '', human].filter(Boolean).join('\n'),
        );
        process.stdout.write(`${human}\n`);
        if (review?.status === 'needs_attention') {
          process.stdout.write('\nOutput review: target mismatch detected\n');
        }
        if (completionVerification.required) {
          process.stdout.write(`\nCompletion verification: ${completionVerification.status} — ${completionVerification.reason}\n`);
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
            ? ['Review the read-only result and rerun with an applying command if changes are needed.']
            : ['Run babel continue latest to inspect recovery state and the next command.'],
        };
        process.stdout.write(`${formatRunResultHuman(payload)}\n`);
        process.exitCode = readOnlyNoModification ? 0 : 1;
      }
    });

  program
    .command('plan')
    .description('Plan work without editing files')
    .argument('<intent...>', 'Task text, or legacy: <project> <task...>')
    .option('-p, --project <name>', 'Target project for the user-facing plan lane')
    .option('-m, --model <model>', 'Force a specific model family for the manual-bridge worker (qwen3|deepseek|step-flash|scout|nemotron|qwen3-32b, case-insensitive)')
    .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')} (defaults to configured policy tier)`)
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option('--show-model-policy', 'Include resolved backend model policy details in the manual-bridge JSON output')
    .option('--project-root <path>', 'Explicit project root for arbitrary approved workspace repos')
    .option('--session-id <id>', 'Associate this manual-bridge run with a Local Mode session ID')
    .option('--session-start-path <path>', 'Attach this manual-bridge run to an exact Local Mode session-start artifact')
    .option('--local-learning-root <path>', 'Attach this manual-bridge run to a specific Local Mode learning root')
    .option('--orchestrator <version>', 'Advanced: override orchestrator contract version (default v9)')
    .option('--execution-profile <profile>', `Execution profile: ${getExecutionProfileHelpText()}`, 'safe_repo')
    .option('--json', 'Emit structured JSON only')
    .addHelpText('after', `
Examples:
  $ babel plan "Prepare rollout plan"
  $ babel plan "Compare the implementation options"
  $ babel plan example_saas_backend "Prepare rollout plan"
  $ babel plan example_llm_router "Draft migration plan" --model deepseek --model-tier standard --show-model-policy
  $ babel plan example_llm_router "Draft migration plan" --session-id launch-demo-001
  $ babel plan example_saas_backend "Audit risk only" --execution-profile read_only_audit

Notes:
  - babel plan "<task>" is the user-facing no-edit plan lane.
  - babel plan <known-project> "<task>" is kept as the legacy Manual Bridge JSON flow.
  - Use babel run "<task>" --mode manual when you explicitly need Manual Bridge internals.
`)
    .action(async (
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
        executionProfile?: string;
        json?: boolean;
      },
    ) => {
      const legacyProject = VALID_PROJECTS.includes(intent[0] as typeof VALID_PROJECTS[number]) && intent.length > 1
        ? intent[0]
        : undefined;

      if (legacyProject === undefined) {
        try {
          await runLiteCommand('plan', intent, options);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (options.json === true) {
            writeJson({ status: 'LITE_FAILED', command: 'plan', error: message });
          } else {
            console.error(`[babel] ${message}`);
          }
          process.exit(1);
        }
        return;
      }

      validateRuntimeEnvForCommand({ json: true });

      const project = legacyProject;
      const task = intent.slice(1).join(' ').trim();
      const normalizedModel = normalizeModelName(options.model);
      const normalizedModelTier = options.modelTier !== undefined ? options.modelTier.trim().toLowerCase() : undefined;
      const executionProfile = normalizeExecutionProfile(options.executionProfile);

      if (!task) {
        process.stdout.write(`${JSON.stringify({
          status: 'PLAN_ALIAS_FAILED',
          error: 'Intent is required.',
        }, null, 2)}\n`);
        process.exit(1);
      }
      if (options.model !== undefined && normalizedModel === undefined) {
        process.stdout.write(`${JSON.stringify({
          status: 'PLAN_ALIAS_FAILED',
          error: `Invalid model "${options.model}". Valid values: ${getAvailableModels().map(m => m.key).join(', ')} (case-insensitive)`,
        }, null, 2)}\n`);
        process.exit(1);
      }
      if (normalizedModelTier !== undefined && !VALID_MODEL_TIERS.includes(normalizedModelTier as typeof VALID_MODEL_TIERS[number])) {
        process.stdout.write(`${JSON.stringify({
          status: 'PLAN_ALIAS_FAILED',
          error: `Invalid model tier "${options.modelTier}". Valid values: ${VALID_MODEL_TIERS.join(', ')}`,
        }, null, 2)}\n`);
        process.exit(1);
      }
      if (options.orchestrator !== undefined && !VALID_ORCHESTRATORS.includes(options.orchestrator as ValidOrchestrator)) {
        process.stdout.write(`${JSON.stringify({
          status: 'PLAN_ALIAS_FAILED',
          error: `Invalid orchestrator "${options.orchestrator}". Valid values: ${VALID_ORCHESTRATORS.join(', ')}`,
        }, null, 2)}\n`);
        process.exit(1);
      }
      if (executionProfile === null) {
        process.stdout.write(`${JSON.stringify({
          status: 'PLAN_ALIAS_FAILED',
          error: `Invalid execution profile "${options.executionProfile}". Valid values: ${getExecutionProfileHelpText().replace(/ \| /g, ', ')}`,
        }, null, 2)}\n`);
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
          process.stdout.write(`${JSON.stringify({
            status: 'PLAN_ALIAS_FAILED',
            error: message,
          }, null, 2)}\n`);
          process.exit(1);
        }
      }
      try {
        await runManualBridgeStart(task, {
          project,
          ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
          ...(options.orchestrator !== undefined ? { orchestratorVersion: options.orchestrator } : {}),
          ...(normalizedModelTier !== undefined ? { modelTier: normalizedModelTier } : {}),
          ...(effectiveAllowExpensive === true ? { allowExpensive: true } : {}),
          ...(options.showModelPolicy === true ? { showModelPolicy: true } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          ...(options.sessionStartPath !== undefined ? { sessionStartPath: options.sessionStartPath } : {}),
          ...(options.localLearningRoot !== undefined ? { localLearningRoot: options.localLearningRoot } : {}),
          executionProfile,
        });
      } catch (err: unknown) {
        process.stdout.write(`${JSON.stringify({
          status: 'PLAN_ALIAS_FAILED',
          error: err instanceof Error ? err.message : String(err),
        }, null, 2)}\n`);
        process.exit(1);
      }
    });

  program
    .command('resume')
    .argument('[run]', 'latest or a run directory for action-taking resume')
    .description('Resume a retryable run and take the next action')
    .option('--run <run_dir>', 'Existing Babel run directory path')
    .option('--project <name>', 'Use latest run pointer for this project when --run is omitted')
    .option('--plan <path>', 'Path to manual plan.json, "-" for stdin, or "clipboard"; when omitted, resume uses <run_dir>/manual/plan.json')
    .option('-m, --model <model>', 'Override the model family for provider retries')
    .option('--model-tier <tier>', `Model policy tier: ${VALID_MODEL_TIERS.join(' | ')}`)
    .option('--allow-expensive', 'Approve an expensive or policy-blocked model for this run')
    .option('--json', 'Emit structured JSON only')
    .addHelpText('after', `
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
`)
    .action(async (run: string | undefined, options: { run?: string; plan?: string; project?: string; model?: string; modelTier?: string; allowExpensive?: boolean; json?: boolean }) => {
      if (options.run !== undefined || options.plan !== undefined) {
        await handleResumeCommand(options);
        return;
      }
      await handleActionResumeCommand(run ?? 'latest', options);
    });

  program
    .command('apply')
    .description('Legacy alias for resume (Manual Bridge resume flow)')
    .option('--run <run_dir>', 'Existing Babel run directory path')
    .option('--project <name>', 'Use latest run pointer for this project when --run is omitted')
    .option('--plan <path>', 'Path to manual plan.json, "-" for stdin, or "clipboard"; when omitted, apply uses <run_dir>/manual/plan.json')
    .addHelpText('after', `
Notes:
  - apply is kept for compatibility. Prefer resume in new docs and examples.
  - If --run is omitted, Babel may fall back to the latest run pointer for the selected project or the global latest run.
  - If --plan is omitted, Babel uses <run_dir>/manual/plan.json and may create/open that file for editing first.
`)
    .action(async (options: { run?: string; plan?: string; project?: string }) => {
      await handleResumeCommand(options);
    });

  program
    .command('smoke')
    .description('Advanced diagnostic: run Manual Bridge smoke suite and summarize executor outcomes')
    .requiredOption('--project <name>', 'Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite | example_game_workspace | example_game_suite | example_autonomous_agent | example_mobile_reference)')
    .addHelpText('after', `
Examples:
  $ babel smoke --project example_saas_backend

Notes:
  - This is a diagnostic harness for Manual Bridge executor behavior, not a normal product test runner.
`)
    .action(async (options: { project: string }) => {
      await handleSmokeCommand(options);
    });

  program
    .command('test')
    .description('Legacy alias for smoke diagnostic; not a general project test runner')
    .option('--project <name>', 'Target project (example_saas_backend | example_llm_router | example_web_audit | example_mobile_suite | example_game_workspace | example_game_suite | example_autonomous_agent | example_mobile_reference)')
    .argument('[project]', 'Target project')
    .addHelpText('after', `
Notes:
  - test is kept for compatibility. Prefer smoke for this diagnostic command.
  - This command does not run a repo's normal unit/integration test suite.
`)
    .action(async (projectArg: string | undefined, options: { project?: string }) => {
      const project = options.project ?? projectArg;
      if (!project) {
        process.stdout.write(`${JSON.stringify({
          status: 'TEST_ALIAS_FAILED',
          error: 'Project is required. Use --project <name> or positional project.',
        }, null, 2)}\n`);
        process.exit(1);
      }
      await handleSmokeCommand({ project });
    });
}
