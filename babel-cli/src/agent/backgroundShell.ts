/**
 * backgroundShell.ts — Chat-session background shell jobs.
 *
 * Long-running commands can be started with run_command(background=true) and
 * later collected via await_command(task_id). This prevents wall-clock stalls
 * where a single blocking shellExec holds the agent loop for minutes.
 *
 * Security: callers must validate commands (whitelist / operators), plan mode,
 * execution profile, and cwd-within-project before startBackgroundShell.
 * This module applies getSafeEnv(), output caps, hard job timeout, and lifecycle.
 *
 * Argv contract matches sandbox shellExec: whitespace split only (no quoted
 * multi-arg shell syntax). Prefer simple commands (npm test, node script.js).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';

import { getSafeEnv } from '../utils/safeEnv.js';

/** Cap retained on the job record (same ballpark as SafeExecutor maxBuffer). */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
/** Max chars of stdout/stderr injected into LLM observations (context budget). */
export const OBSERVATION_OUTPUT_CAP_CHARS = 32_000;
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;
/** Hard wall-clock kill for background children when caller omits timeoutMs. */
export const DEFAULT_BACKGROUND_JOB_TIMEOUT_MS = 600_000;
const MAX_CONCURRENT_JOBS = 8;

export type BackgroundShellStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface BackgroundShellJob {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  status: BackgroundShellStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  /** Resolves when the process exits (or is killed). */
  done: Promise<void>;
}

export interface StartBackgroundShellInput {
  command: string;
  /** Must already be validated to sit within project root by the caller. */
  cwd: string;
  /** Hard wall-clock kill for the child (default DEFAULT_BACKGROUND_JOB_TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface AwaitBackgroundShellResult {
  id: string;
  command: string;
  status: BackgroundShellStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  elapsed_ms: number;
}

type InternalJob = BackgroundShellJob & { child?: ChildProcessWithoutNullStreams };

let nextId = 1;
const jobs = new Map<string, InternalJob>();

function resolveWindowsCommandShell(): string {
  return process.env['ComSpec']?.trim() || 'cmd.exe';
}

function appendCapped(current: string, chunk: string, label: 'stdout' | 'stderr'): string {
  if (Buffer.byteLength(current, 'utf8') >= MAX_OUTPUT_BYTES) {
    // Already at/over cap — drop further chunks (avoid re-allocating 5MB each time).
    return current;
  }
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= MAX_OUTPUT_BYTES) return next;
  return (
    Buffer.from(next, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8') +
    `\n[background_shell] ${label} truncated — exceeded ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB cap.`
  );
}

/** Truncate text for model observations (not for job storage). */
export function capObservationText(
  text: string,
  maxChars: number = OBSERVATION_OUTPUT_CAP_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return (
    text.slice(0, maxChars) +
    `\n[truncated — ${omitted} more chars omitted from observation; full output retained on job record]`
  );
}

function activeCount(): number {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.status === 'running') n++;
  }
  return n;
}

function killChild(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

/**
 * Start a command without blocking the agent loop. Returns immediately with a
 * task id the model can later pass to await_command.
 */
export function startBackgroundShell(input: StartBackgroundShellInput): BackgroundShellJob {
  if (activeCount() >= MAX_CONCURRENT_JOBS) {
    throw new Error(
      `Too many background shell jobs (max ${MAX_CONCURRENT_JOBS}). Await or kill existing jobs first.`,
    );
  }

  const command = input.command.trim();
  if (!command) throw new Error('background shell command must be non-empty');

  // Caller is responsible for project-root safety; still normalize to absolute.
  const cwd = pathResolve(input.cwd);
  const id = `bg-${nextId++}`;
  const isWin = process.platform === 'win32';
  // Whitespace split only — same tokenizer as sandbox shellExec (no quotes).
  const argv = command.split(/\s+/);
  const rawCmd = argv[0] ?? '';
  const normalizedRawCmd = isWin
    ? rawCmd.replace(/^\.\//, '.\\').replace(/\//g, '\\')
    : rawCmd;
  const spawnCmd = isWin ? resolveWindowsCommandShell() : normalizedRawCmd;
  const spawnArgs = isWin ? ['/c', normalizedRawCmd, ...argv.slice(1)] : argv.slice(1);

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const job: InternalJob = {
    id,
    command,
    cwd,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    stdout: '',
    stderr: '',
    done,
  };

  const timeoutMs =
    input.timeoutMs !== undefined && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_BACKGROUND_JOB_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spawnCmd, spawnArgs, {
      cwd,
      // M10 parity with SafeExecutor.shellExec — strip secrets from child env.
      env: getSafeEnv(),
      windowsHide: true,
      // shell: false — cmd.exe invoked directly on Windows (same as SafeExecutor).
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    job.exitCode = 1;
    resolveDone();
    jobs.set(id, job);
    return job;
  }

  job.child = child;
  jobs.set(id, job);

  const killTimer = setTimeout(() => {
    if (job.status !== 'running') return;
    killChild(child);
    job.status = 'killed';
    job.error = `Background shell timed out after ${timeoutMs}ms`;
    job.exitCode = job.exitCode ?? 1;
  }, timeoutMs);
  // Do not keep the process alive solely for idle job timers.
  if (typeof killTimer.unref === 'function') killTimer.unref();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    job.stdout = appendCapped(job.stdout, chunk, 'stdout');
  });
  child.stderr.on('data', (chunk: string) => {
    job.stderr = appendCapped(job.stderr, chunk, 'stderr');
  });

  child.on('error', (err) => {
    clearTimeout(killTimer);
    if (job.status === 'running') {
      job.status = 'failed';
      job.error = err.message;
      job.exitCode = 1;
    }
    resolveDone();
  });

  child.on('close', (code) => {
    clearTimeout(killTimer);
    if (job.status === 'running') {
      job.status = code === 0 ? 'completed' : 'failed';
      job.exitCode = code ?? 1;
    } else if (job.exitCode === null) {
      job.exitCode = code ?? 1;
    }
    resolveDone();
  });

  return job;
}

/**
 * Wait for a background job to finish (or until timeoutMs).
 * Does not kill the job on await timeout — returns timed_out=true so the model
 * can decide whether to keep waiting or call kill_background_shell / re-await.
 */
export async function awaitBackgroundShell(
  taskId: string,
  timeoutMs: number = DEFAULT_AWAIT_TIMEOUT_MS,
): Promise<AwaitBackgroundShellResult> {
  const job = jobs.get(taskId);
  if (!job) {
    return {
      id: taskId,
      command: '',
      status: 'failed',
      exit_code: null,
      stdout: '',
      stderr: `Unknown background task_id: ${taskId}`,
      timed_out: false,
      elapsed_ms: 0,
    };
  }

  const started = Date.now();
  let timedOut = false;

  await Promise.race([
    job.done,
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        timedOut = job.status === 'running';
        resolve();
      }, Math.max(1, timeoutMs));
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);

  return {
    id: job.id,
    command: job.command,
    status: job.status,
    exit_code: job.exitCode,
    stdout: job.stdout,
    stderr: job.stderr + (job.error ? `\n${job.error}` : ''),
    timed_out: timedOut,
    elapsed_ms: Date.now() - started,
  };
}

/** Best-effort kill of a running background job. */
export function killBackgroundShell(taskId: string): AwaitBackgroundShellResult {
  const job = jobs.get(taskId);
  if (!job) {
    return {
      id: taskId,
      command: '',
      status: 'failed',
      exit_code: null,
      stdout: '',
      stderr: `Unknown background task_id: ${taskId}`,
      timed_out: false,
      elapsed_ms: 0,
    };
  }

  if (job.status === 'running') {
    killChild(job.child);
    job.status = 'killed';
    job.error = job.error ?? 'Killed by killBackgroundShell';
    job.exitCode = job.exitCode ?? 1;
  }

  return {
    id: job.id,
    command: job.command,
    status: job.status,
    exit_code: job.exitCode,
    stdout: job.stdout,
    stderr: job.stderr + (job.error ? `\n${job.error}` : ''),
    timed_out: false,
    elapsed_ms: Date.now() - job.startedAt,
  };
}

export function getBackgroundShellJob(taskId: string): BackgroundShellJob | undefined {
  const job = jobs.get(taskId);
  if (!job) return undefined;
  const { child: _child, ...publicJob } = job;
  return publicJob;
}

/**
 * Kill all running jobs and clear the process-global registry.
 * Call at chat session start/end so task ids and output do not leak across sessions.
 */
export function clearBackgroundShellRegistry(): void {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      killChild(job.child);
      job.status = 'killed';
      job.error = job.error ?? 'Cleared with background shell registry';
      job.exitCode = job.exitCode ?? 1;
    }
  }
  jobs.clear();
  nextId = 1;
}

/** Test helper alias — clears registry between unit tests. */
export function resetBackgroundShellRegistryForTests(): void {
  clearBackgroundShellRegistry();
}
