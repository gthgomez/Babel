/**
 * chatBackgroundShell.ts — Chat-path wiring for background shell jobs.
 *
 * Kept out of chatEngine.ts to respect the architectural file-size ratchet
 * (chatEngine is already >2k lines and must not grow).
 */

import {
  awaitBackgroundShell,
  hasBackgroundShellJob,
  capObservationText,
  DEFAULT_BACKGROUND_JOB_TIMEOUT_MS,
  startBackgroundShell,
  getBackgroundShellJob,
  killBackgroundShell,
  type BackgroundShellJob,
  type AwaitBackgroundShellResult,
} from './backgroundShell.js';
import { SafeExecutor, validateExecutorShellCommand } from '../sandbox.js';
import { readRuntimeMode } from '../config/runtimeMode.js';
import { isToolAllowedForExecutionProfile } from '../config/executionProfiles.js';
import { shouldUseDockerSandbox } from '../config/benchmarkContainer.js';
import {
  formatRegisteredToolObservation,
  type RunArtifactAccess,
} from './codingLoop/readArtifactExecutor.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import type {
  ChatCallbacks,
  ChatEngineActionExecutorHost,
} from './chatEngineContracts.js';
import { bindChatBackgroundPolicy, isChatBackgroundOwnerCurrent, prepareChatBackgroundDispatch, settleChatBackgroundVerifier } from './chatBackgroundVerifier.js';
import { defaultToolExecutor, type ToolExecutor, type PolicyGatedExecutionResult } from './toolExecutor.js';
import { isInvocationLive, refreshDryRunState } from '../localTools.js';

export interface BackgroundShellLogEntry {
  tool: string;
  target: string;
  detail?: string;
  error?: string;
  index: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

export interface BackgroundShellActionCtx {
  projectRoot: string;
  tool: string;
  target: string;
  toolId: number;
  index: number;
  /** Owning engine run id — scopes turn-cancel kills to this engine's jobs. */
  ownerId?: string | undefined;
  /** Canonical tool-call id for BDNS process correlation. */
  toolCallId?: string | undefined;
  pushLog: (entry: BackgroundShellLogEntry) => void;
  onToolComplete?: ((id: number, detail?: string | undefined, error?: string | undefined, exitCode?: number | undefined) => void) | undefined;
  /** Invoked after local validation and immediately before background process spawn. */
  onBeforeSpawn?: (() => void) | undefined;
  /** Invoked immediately before awaiting a validated known background job. */
  onBeforeAwait?: (() => void) | undefined;
  /** Checks whether the submission still owns this suspended action. */
  isSubmissionCurrent?: (() => boolean) | undefined;
  /** Settles the action without exposing output after its owner was replaced. */
  settleStale?: (() => BackgroundShellActionResult) | undefined;
  artifactAccess?: RunArtifactAccess | undefined;
  artifactCallId?: string | undefined;
  onStarted?: ((job: BackgroundShellJob) => void) | undefined;
  onResult?: ((result: AwaitBackgroundShellResult) => Promise<{ notes: string[]; policyRejected?: boolean }>) | undefined;
}

export type BackgroundShellActionResult = { index: number; observation: string };

/** await_command — collect a background shell job. */
export async function executeAwaitCommandAction(
  action: { task_id: string; timeout_seconds?: number | undefined },
  ctx: BackgroundShellActionCtx,
): Promise<BackgroundShellActionResult> {
  const timeoutMs = (action.timeout_seconds ?? 120) * 1000;
  // Unknown ids are local validation failures, not an external await effect.
  if (hasBackgroundShellJob(action.task_id)) ctx.onBeforeAwait?.();
  const result = await awaitBackgroundShell(action.task_id, timeoutMs);
  if (ctx.isSubmissionCurrent && !ctx.isSubmissionCurrent()) {
    return ctx.settleStale?.() ?? { index: ctx.index, observation: '' };
  }
  const settlement = await ctx.onResult?.(result) ?? { notes: [] };
  if (ctx.isSubmissionCurrent && !ctx.isSubmissionCurrent()) {
    return ctx.settleStale?.() ?? { index: ctx.index, observation: '' };
  }
  // Null describes a running process. An unknown job is a local tool failure,
  // not a still-running verifier with a fabricated process status.
  const exitCode = settlement.policyRejected ? 1 : result.status === 'running' ? null : result.exit_code ?? 1;
  const detail = settlement.policyRejected ? 'background execution denied after process settlement' : result.timed_out
    ? 'timed_out (still running)'
    : `exit ${result.exit_code ?? -1} (${result.status})`;
  ctx.pushLog({
    tool: ctx.tool,
    target: action.task_id,
    detail,
    index: ctx.index,
    exit_code: exitCode ?? 1,
    stdout: result.stdout.slice(0, 2000),
    stderr: result.stderr.slice(0, 1000),
  });
  ctx.onToolComplete?.(
    ctx.toolId,
    detail,
    result.timed_out || (exitCode !== null && exitCode !== 0) ? (result.stderr || detail) : undefined,
    exitCode ?? (result.timed_out ? 1 : 0),
  );
  const resultHeader = [
    `task_id: ${result.id}`,
    `command: ${result.command || '(unknown)'}`,
    `status: ${settlement.policyRejected ? 'policy_rejected' : result.status}`,
    `timed_out: ${result.timed_out}`,
    `elapsed_ms: ${result.elapsed_ms}`,
    `exit_code: ${exitCode ?? 'null'}`,
    ...(settlement.policyRejected ? [`process_exit_code: ${result.exit_code ?? 'null'}`] : []),
  ].join('\n');
  const actionForObservation: ChatToolAction = {
    type: 'await_command',
    task_id: action.task_id,
  };
  const observation = ctx.artifactAccess
    ? formatRegisteredToolObservation(
        actionForObservation,
        {
          exit_code: exitCode ?? -1,
          stdout: `${resultHeader}\n--- stdout ---\n${result.stdout || '(empty)'}`,
          stderr: result.stderr || '',
        },
        ctx.artifactAccess,
        ctx.artifactCallId ?? String(ctx.toolId),
        exitCode,
      )
    : [
        `### await_command ${action.task_id}`,
        `exit_code: ${exitCode ?? 'null'}`,
        '```',
        resultHeader,
        '--- stdout ---',
        capObservationText(result.stdout || '(empty)'),
        '--- stderr ---',
        capObservationText(result.stderr || '(empty)'),
        '```',
      ].join('\n');
  return {
    index: ctx.index,
    observation: [observation, ...settlement.notes].join('\n'),
  };
}

/** Binds await_command to the submission that dispatched it in Chat. */
export function executeChatAwaitCommandAction(
  action: Extract<ChatToolAction, { type: 'await_command' }>,
  ctx: {
    host: ChatEngineActionExecutorHost;
    projectRoot: string;
    tool: string;
    target: string;
    toolId: number;
    index: number;
    ownerGeneration: number;
    meta: { index: number; idempotencyKey?: string };
    callbacks: ChatCallbacks;
    artifactAccess?: RunArtifactAccess | undefined;
  },
): Promise<BackgroundShellActionResult> {
  const { host, ownerGeneration } = ctx;
  const job = getBackgroundShellJob(action.task_id);
  const isCurrent = () => host.isSubmissionCurrent(ownerGeneration) &&
    (!job || isChatBackgroundOwnerCurrent(host, job, ownerGeneration));
  const settleStale = () => host.settleStaleActionResult(ctx.tool, ctx.target, ctx.index,
    'background command does not belong to the current submission');
  if (!isCurrent()) return Promise.resolve(settleStale());
  return executeAwaitCommandAction(action, {
    projectRoot: ctx.projectRoot,
    tool: ctx.tool,
    target: ctx.target,
    toolId: ctx.toolId,
    index: ctx.index,
    pushLog: entry => {
      if (isCurrent()) host.toolCallLog.push(entry);
    },
    onToolComplete: ctx.callbacks.onToolComplete,
    onBeforeAwait: () => host.persistToolStartedAtExecutorDispatch(action, ctx.meta),
    isSubmissionCurrent: isCurrent,
    settleStale,
    artifactAccess: ctx.artifactAccess,
    artifactCallId: String(ctx.meta.idempotencyKey ?? ctx.toolId),
    onResult: result => settleChatBackgroundVerifier({
      host, job: getBackgroundShellJob(action.task_id), result,
      generation: ownerGeneration, index: ctx.index,
    }),
  });
}
/** Bind background dispatch provenance and invalidation to the submitting Chat task. */
export function createChatBackgroundExecutor(
  action: Extract<ChatToolAction, { type: 'run_command' }>,
  ctx: Parameters<typeof executeChatAwaitCommandAction>[1],
): { executor: ToolExecutor; waitForStart: (completion: Promise<PolicyGatedExecutionResult>) => Promise<BackgroundShellActionResult | null> } {
  const { host, ownerGeneration } = ctx;
  let startedJob: BackgroundShellJob | undefined;
  let announceStart!: (result: BackgroundShellActionResult) => void;
  const started = new Promise<BackgroundShellActionResult>(resolve => { announceStart = resolve; });
  const executor: ToolExecutor = {
    mapAction: defaultToolExecutor.mapAction,
    async execute(agentAction, context, budget) {
      refreshDryRunState();
      if (!isInvocationLive() || process.env['BABEL_SHADOW_ROOT'] || host.options.toolExecutorForTesting) {
        return (host.options.toolExecutorForTesting ?? defaultToolExecutor).execute(agentAction, context, budget);
      }
      if (context.signal?.aborted || !host.isSubmissionCurrent(ownerGeneration)) {
        return { action: agentAction, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: 'Background dispatch cancelled before spawn.' }] };
      }
      const startResult = startChatBackgroundCommand(action, ctx, job => { startedJob = job; }, context.signal);
      const job = startedJob;
      if (!job) return { action: agentAction, terminal: false, results: [{ exit_code: 1, stdout: '', stderr: startResult.observation }] };
      const onAbort = () => { if (!action.detached) killBackgroundShell(job.id); };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      if (context.signal?.aborted) onAbort();
      announceStart(startResult);
      try {
        await job.done;
        const completed = await awaitBackgroundShell(job.id, 1);
        return { action: agentAction, terminal: false, results: [{
          exit_code: completed.exit_code ?? 1, stdout: completed.stdout, stderr: completed.stderr,
        }] };
      } finally { context.signal?.removeEventListener('abort', onAbort); }
    },
  };
  return {
    executor,
    async waitForStart(completion) {
      // Attach rejection handling immediately: a caller may await the job much later.
      const settled = completion.then(() => null, () => null);
      const result = await Promise.race([started, settled]);
      if (startedJob) bindChatBackgroundPolicy(startedJob, completion);
      return result;
    },
  };
}

function startChatBackgroundCommand(
  action: Extract<ChatToolAction, { type: 'run_command' }>,
  ctx: Parameters<typeof executeChatAwaitCommandAction>[1],
  onStarted: (job: BackgroundShellJob) => void,
  signal?: AbortSignal,
): BackgroundShellActionResult {
  const { host, ownerGeneration } = ctx;
  let register: ((job: BackgroundShellJob) => void) | undefined;
  let didStart = false;
  return executeBackgroundRunCommandAction(action, {
    projectRoot: ctx.projectRoot, tool: ctx.tool, target: ctx.target,
    toolId: ctx.toolId, index: ctx.index,
    ownerId: host.engineRunId,
    toolCallId: ctx.meta.idempotencyKey,
    pushLog: entry => {
      if (didStart && host.isSubmissionCurrent(ownerGeneration)) host.toolCallLog.push(entry);
    },
    onToolComplete: (id, detail, error, exitCode) => {
      if (didStart && host.isSubmissionCurrent(ownerGeneration)) ctx.callbacks.onToolComplete?.(id, detail, error, exitCode);
    },
    onBeforeSpawn: () => {
      register = prepareChatBackgroundDispatch(host, action.command, action.cwd,
        ownerGeneration, ctx.meta.idempotencyKey ?? String(ctx.toolId), signal);
    },
    onStarted: job => { register?.(job); onStarted(job); didStart = true; },
  });
}
/** run_command(background=true) — non-blocking shell with sandbox parity gates. */
export function executeBackgroundRunCommandAction(
  action: { command: string; cwd?: string | undefined; detached?: boolean | undefined },
  ctx: BackgroundShellActionCtx,
): BackgroundShellActionResult {
  const denyBg = (message: string, detail = 'denied'): BackgroundShellActionResult => {
    ctx.pushLog({
      tool: ctx.tool,
      target: ctx.target,
      detail,
      error: message,
      index: ctx.index,
      exit_code: 1,
    });
    ctx.onToolComplete?.(ctx.toolId, detail, message, 1);
    return {
      index: ctx.index,
      observation: `### run_command (background) ${ctx.target}\nexit_code: 1\n\`\`\`\n[policy] ${message}\n\`\`\``,
    };
  };

  if (readRuntimeMode() === 'plan') {
    return denyBg(
      'Planning Restricted: Cannot execute shell while in Plan Mode. Use exit_plan_mode first.',
      'plan_denied',
    );
  }

  if (!isToolAllowedForExecutionProfile(process.env['BABEL_EXECUTION_PROFILE'], 'shell_exec')) {
    return denyBg(
      'Execution profile does not allow shell_exec (background run_command blocked).',
      'profile_denied',
    );
  }

  // Docker sandbox profiles require containerized shellExec; async background
  // path is host-only — refuse rather than silently skip container isolation.
  if (shouldUseDockerSandbox(process.env['BABEL_EXECUTION_PROFILE'])) {
    return denyBg(
      'Background shell is not available under Docker sandbox profiles. Use foreground run_command.',
      'docker_sandbox_denied',
    );
  }

  const validation = validateExecutorShellCommand(
    action.command,
    process.platform,
    process.env['BABEL_EXECUTION_PROFILE'],
    { approvalQueue: true, projectRoot: ctx.projectRoot },
  );
  if (validation) {
    return denyBg(validation.message);
  }

  let safeCwd: string;
  try {
    const executor = new SafeExecutor(
      ctx.projectRoot,
      process.env['BABEL_SHADOW_ROOT'] || null,
      readRuntimeMode(),
    );
    safeCwd = executor.resolveSafe(action.cwd ?? ctx.projectRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return denyBg(msg, 'cwd_denied');
  }

  try {
    ctx.onBeforeSpawn?.();
    const job = startBackgroundShell({
      command: action.command,
      cwd: safeCwd,
      timeoutMs: DEFAULT_BACKGROUND_JOB_TIMEOUT_MS,
      detached: action.detached === true,
      ...(ctx.ownerId !== undefined ? { ownerId: ctx.ownerId } : {}),
      ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
    });
    ctx.onStarted?.(job);
    ctx.pushLog({
      tool: ctx.tool,
      target: ctx.target,
      detail: `background started ${job.id}`,
      index: ctx.index,
      exit_code: 0,
    });
    ctx.onToolComplete?.(ctx.toolId, `bg ${job.id}`, undefined, 0);
    return {
      index: ctx.index,
      observation:
        `### run_command (background) ${ctx.target}\nexit_code: 0\n\`\`\`\n` +
        `Started background job ${job.id} (hard timeout ${DEFAULT_BACKGROUND_JOB_TIMEOUT_MS / 1000}s).\n` +
        `Use await_command with task_id="${job.id}" to collect exit code and output.\n` +
        `The agent loop is free to continue while this command runs.\n` +
        `Arguments use the shared quote-aware parser; quote paths containing spaces. Shell operators and expansion are unsupported.\n\`\`\``,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.pushLog({
      tool: ctx.tool,
      target: ctx.target,
      detail: 'error',
      error: msg,
      index: ctx.index,
      exit_code: 1,
    });
    ctx.onToolComplete?.(ctx.toolId, 'error', msg, 1);
    return {
      index: ctx.index,
      observation: `### run_command (background) ${ctx.target}\nexit_code: 1\n\`\`\`\n${msg}\n\`\`\``,
    };
  }
}
