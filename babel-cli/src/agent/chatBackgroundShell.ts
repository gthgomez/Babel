/**
 * chatBackgroundShell.ts — Chat-path wiring for background shell jobs.
 *
 * Kept out of chatEngine.ts to respect the architectural file-size ratchet
 * (chatEngine is already >2k lines and must not grow).
 */

import {
  awaitBackgroundShell,
  capObservationText,
  DEFAULT_BACKGROUND_JOB_TIMEOUT_MS,
  startBackgroundShell,
} from './backgroundShell.js';
import { SafeExecutor, validateExecutorShellCommand } from '../sandbox.js';
import { readRuntimeMode } from '../config/runtimeMode.js';
import { isToolAllowedForExecutionProfile } from '../config/executionProfiles.js';
import { shouldUseDockerSandbox } from '../config/benchmarkContainer.js';

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
  pushLog: (entry: BackgroundShellLogEntry) => void;
  onToolComplete?: ((id: number, detail?: string | undefined) => void) | undefined;
}

export type BackgroundShellActionResult = { index: number; observation: string };

/** await_command — collect a background shell job. */
export async function executeAwaitCommandAction(
  action: { task_id: string; timeout_seconds?: number | undefined },
  ctx: BackgroundShellActionCtx,
): Promise<BackgroundShellActionResult> {
  const timeoutMs = (action.timeout_seconds ?? 120) * 1000;
  const result = await awaitBackgroundShell(action.task_id, timeoutMs);
  const exitCode = result.timed_out ? null : result.exit_code;
  const detail = result.timed_out
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
  ctx.onToolComplete?.(ctx.toolId, detail);
  const body = [
    `task_id: ${result.id}`,
    `command: ${result.command || '(unknown)'}`,
    `status: ${result.status}`,
    `timed_out: ${result.timed_out}`,
    `elapsed_ms: ${result.elapsed_ms}`,
    `exit_code: ${result.exit_code ?? 'null'}`,
    '--- stdout ---',
    capObservationText(result.stdout || '(empty)'),
    '--- stderr ---',
    capObservationText(result.stderr || '(empty)'),
  ].join('\n');
  return {
    index: ctx.index,
    observation: `### await_command ${action.task_id}\nexit_code: ${exitCode ?? 'null'}\n\`\`\`\n${body}\n\`\`\``,
  };
}

/** run_command(background=true) — non-blocking shell with sandbox parity gates. */
export function executeBackgroundRunCommandAction(
  action: { command: string; cwd?: string | undefined },
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
    ctx.onToolComplete?.(ctx.toolId, detail);
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
    const job = startBackgroundShell({
      command: action.command,
      cwd: safeCwd,
      timeoutMs: DEFAULT_BACKGROUND_JOB_TIMEOUT_MS,
    });
    ctx.pushLog({
      tool: ctx.tool,
      target: ctx.target,
      detail: `background started ${job.id}`,
      index: ctx.index,
      exit_code: 0,
    });
    ctx.onToolComplete?.(ctx.toolId, `bg ${job.id}`);
    return {
      index: ctx.index,
      observation:
        `### run_command (background) ${ctx.target}\nexit_code: 0\n\`\`\`\n` +
        `Started background job ${job.id} (hard timeout ${DEFAULT_BACKGROUND_JOB_TIMEOUT_MS / 1000}s).\n` +
        `Use await_command with task_id="${job.id}" to collect exit code and output.\n` +
        `The agent loop is free to continue while this command runs.\n` +
        `Argv is whitespace-split only (same as shellExec — avoid quoted multi-arg syntax).\n\`\`\``,
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
    ctx.onToolComplete?.(ctx.toolId, 'error');
    return {
      index: ctx.index,
      observation: `### run_command (background) ${ctx.target}\nexit_code: 1\n\`\`\`\n${msg}\n\`\`\``,
    };
  }
}
