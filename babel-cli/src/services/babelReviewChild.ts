import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BABEL_OPENCODE_GO_HELPER_ENV } from '../runners/openCodeGoCredential.js';
import { terminateChildTree } from '../processTree.js';
import {
  finiteReviewHostLifetime,
  type ReviewAuthorityCandidate,
  type ReviewAuthorityMonitor,
  type ReviewAuthorityTerminalCause,
  type ReviewHostLifetime,
} from './reviewSupervisor.js';
import {
  attachReviewProcessContainment,
  type ReviewProcessContainment,
  type ReviewProcessContainmentKind,
} from './reviewProcessContainment.js';

const MAX_REVIEW_CHILD_TIMEOUT_MS = 1_800_000;

/**
 * Allow the trusted controller to select a larger, still finite child
 * process envelope when reviewing a large audit. Invalid or oversized values
 * fall back to the purpose default; an ambient variable can never make the
 * review unbounded.
 */
export function reviewChildProcessTimeoutMs(purpose: 'review' | 'repair_proposal' = 'review', parent: NodeJS.ProcessEnv = process.env): number {
  const fallback = purpose === 'repair_proposal' ? 3_050_000 : 1_260_000;
  const raw = parent['BABEL_REVIEW_CHILD_TIMEOUT_MS'];
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= MAX_REVIEW_CHILD_TIMEOUT_MS ? parsed : fallback;
}

/** Construct a fresh child environment; never forward GitHub or ambient provider keys. */
export function babelReviewChildEnv(input: { source: string; trustedRoot: string; output: string; runs: string; model: string; purpose?: 'review' | 'repair_proposal' }, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const purpose = input.purpose ?? 'review';
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    if (parent[key]) env[key] = parent[key];
  }
  // The documented credential-helper override is a filesystem path, not a
  // secret, so the child may see it. Without this the reviewer always resolved
  // the canonical helper and docs/BABEL_PR_REVIEW.md's override claim was false.
  const helperOverride = parent[BABEL_OPENCODE_GO_HELPER_ENV]?.trim();
  return { ...env,
    ...(helperOverride ? { [BABEL_OPENCODE_GO_HELPER_ENV]: helperOverride } : {}),
    BABEL_ROOT: input.trustedRoot, BABEL_PROJECT_ROOT: input.source, BABEL_RUNS_DIR: input.runs,
    BABEL_REVIEW_OUTPUT: input.output, BABEL_REVIEW_MODEL: input.model,
    BABEL_REVIEW_PURPOSE: purpose,
    BABEL_EXECUTION_PROFILE: 'read_only_audit', BABEL_READ_ONLY: 'true', BABEL_HEADLESS: '1',
    // Reviewer prompts intentionally contain governance words such as
    // "untrusted", "security", and "regression". Do not let automatic task
    // classification reinterpret those words as an implementor/governance
    // task: this child is a bounded read-only investigation for both review
    // and repair-proposal purposes.
    BABEL_CHAT_TASK_CLASS: 'investigate',
    // A trusted final review is still a bounded read-only investigation, but
    // related source reads can legitimately resemble a read loop. Keep the
    // heuristic kill observable without letting it terminate certification;
    // wall, turn, cost, process-timeout, cancellation, and tool-policy bounds
    // remain hard limits. Repair proposals retain the normal investigate
    // policy because this exception is scoped to final review children.
    ...(purpose === 'review' ? { BABEL_POLICY_MODE_STALL_KILL: 'shadow' } : {}),
    // Large trusted audits may need more than the original 24-turn / 12-minute
    // envelope after stall heuristics are shadowed. Keep both limits finite and
    // overridable by the controller, but give normal reviews room to finish a
    // complete read-only pass and its bounded format repair.
    BABEL_CHAT_MAX_COST: parent['BABEL_CHAT_MAX_COST'] ?? 'unlimited',
    BABEL_CHAT_MAX_WALL_MS: parent['BABEL_CHAT_MAX_WALL_MS'] ?? (purpose === 'repair_proposal' ? '3000000' : '1200000'),
    BABEL_CHAT_MAX_TURNS: parent['BABEL_CHAT_MAX_TURNS'] ?? (purpose === 'repair_proposal' ? '100' : '36'),
    BABEL_CHAT_STALL_TURNS: parent['BABEL_CHAT_STALL_TURNS'] ?? (purpose === 'repair_proposal' ? '5' : '15'),
    BABEL_ALLOWED_TOOLS: JSON.stringify(['file_read', 'directory_list', 'grep', 'glob']),
    BABEL_DISALLOWED_TOOLS: JSON.stringify(['shell_exec', 'test_run', 'file_write', 'mcp_request', 'memory_query', 'memory_store', 'semantic_search']),
    BABEL_READ_ONLY_NO_INDEX_WRITE: '1',
    BABEL_TOOL_PROFILE: 'native',
    NO_COLOR: '1',
  };
}

export interface LaunchBabelReviewChildInput {
  source: string;
  trustedRoot: string;
  output: string;
  runs: string;
  model: string;
  purpose?: 'review' | 'repair_proposal';
  worker: string;
  tsx: string;
  /** Legacy finite timeout. Ignored when a typed hostLifetime is supplied. */
  timeoutMs?: number;
  hostLifetime?: ReviewHostLifetime;
  authority?: ReviewAuthorityMonitor;
  candidate?: ReviewAuthorityCandidate;
  abortSignal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onExit?: () => void;
}

export interface BabelReviewChildResult {
  exitCode: number | null;
  timedOut: boolean;
  cleanupTimedOut: boolean;
  terminalCause: ReviewAuthorityTerminalCause;
  containment: ReviewProcessContainmentKind;
  containmentError?: string;
  artifact: Record<string, unknown> | null;
}

function windowsGatedWorkerArgs(loader: string, worker: string, gate: string): string[] {
  const workerUrl = pathToFileURL(worker).href;
  const bootstrap = `import { existsSync, unlinkSync } from 'node:fs';
const gate = ${JSON.stringify(gate)};
while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 10));
try { unlinkSync(gate); } catch {}
await import(${JSON.stringify(workerUrl)});`;
  return ['--import', loader, '--input-type=module', '--eval', bootstrap];
}

function terminateReviewTree(
  child: ChildProcess,
  containment: ReviewProcessContainment,
): void {
  // Closing the Job Object is the primary Windows containment path. The shared
  // helper remains a defense-in-depth fallback and the POSIX group terminator.
  containment.release();
  terminateChildTree(child);
}

/** One separate process per review. Private logs survive timeout and malformed output. */
export async function launchBabelReviewChild(input: LaunchBabelReviewChildInput): Promise<BabelReviewChildResult> {
  // tsx's CLI is a process wrapper. Import its package-exported loader in the
  // actual worker process so the lease PID and timeout target own inference.
  // A file URL also handles drive letters and spaces on Windows.
  const loader = pathToFileURL(join(dirname(input.tsx), 'loader.mjs')).href;
  const lifetime = input.hostLifetime ?? finiteReviewHostLifetime(
    input.timeoutMs ?? reviewChildProcessTimeoutMs(input.purpose, process.env),
  );
  if (lifetime.kind === 'follow_authority') {
    if (!input.authority || !input.candidate) {
      throw new Error('Follow-authority review lifetime requires host authority and an exact candidate.');
    }
    const initial = input.authority.inspect(input.candidate);
    if (!initial.admitted) throw new Error(`Review authority denied launch: ${initial.cause}.`);
  }
  if (input.abortSignal?.aborted) throw new Error('Trusted review child launch aborted.');

  const isWindows = process.platform === 'win32';
  const gate = isWindows ? `${input.output}.${randomUUID()}.start` : undefined;
  const childArgs = gate
    ? windowsGatedWorkerArgs(loader, input.worker, gate)
    : ['--import', loader, input.worker];
  const child = spawn(process.execPath, childArgs, {
    cwd: input.source,
    env: babelReviewChildEnv(input),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // A separate POSIX process group lets the shared terminateChildTree helper
    // signal every descendant even when the worker event loop is wedged.
    detached: !isWindows,
  });
  const log = input.output + '.log';
  // Host-private diagnostic data, never directly posted to GitHub.
  child.stdout?.on('data', chunk => appendFileSync(log, chunk, { mode: 0o600 }));
  child.stderr?.on('data', chunk => appendFileSync(log, chunk, { mode: 0o600 }));

  let containment: ReviewProcessContainment = Object.freeze({
    kind: isWindows ? 'windows_taskkill_fallback' as const : 'posix_process_group' as const,
    release() {},
  });
  if (child.pid) containment = await attachReviewProcessContainment(child.pid);
  if (child.pid) {
    try {
      input.onSpawn?.(child.pid);
    } catch (error) {
      terminateReviewTree(child, containment);
      throw error;
    }
  }
  if (gate) writeFileSync(gate, 'ready\n', { encoding: 'utf8', mode: 0o600 });

  let timedOut = false;
  let cleanupTimedOut = false;
  let terminalCause: ReviewAuthorityTerminalCause = 'worker_exit';
  let closeObserved = false;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let authorityPoll: ReturnType<typeof setInterval> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let requestStop: (cause: ReviewAuthorityTerminalCause) => void = () => {};
  const onAbort = (): void => requestStop('host_abort');

  const code = await new Promise<number | null>((resolveCode, rejectCode) => {
    let settled = false;
    const settle = (codeValue: number | null): void => {
      if (settled) return;
      settled = true;
      resolveCode(codeValue);
    };
    requestStop = (cause: ReviewAuthorityTerminalCause): void => {
      if (terminalCause !== 'worker_exit') return;
      terminalCause = cause;
      timedOut = cause === 'finite_timeout';
      if (cause === 'finite_timeout' || cause === 'host_abort') input.authority?.recordTerminal(cause);
      terminateReviewTree(child, containment);
      cleanupTimer = setTimeout(() => {
        if (closeObserved) return;
        cleanupTimedOut = true;
        input.authority?.recordTerminal('cleanup_timeout');
        settle(null);
      }, lifetime.cleanupTimeoutMs);
      cleanupTimer.unref?.();
    };

    child.once('error', rejectCode);
    child.once('close', (closedCode) => {
      closeObserved = true;
      settle(closedCode);
    });

    if (lifetime.kind === 'finite') {
      lifetimeTimer = setTimeout(() => requestStop('finite_timeout'), lifetime.timeoutMs);
      lifetimeTimer.unref?.();
    } else {
      authorityPoll = setInterval(() => {
        const admission = input.authority!.inspect(input.candidate!);
        if (!admission.admitted) requestStop(admission.cause);
      }, lifetime.pollIntervalMs);
      authorityPoll.unref?.();
    }
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });
  }).finally(() => {
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    if (authorityPoll) clearInterval(authorityPoll);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    input.abortSignal?.removeEventListener('abort', onAbort);
    if (closeObserved) {
      containment.release();
      input.onExit?.();
    }
  });
  let artifact: Record<string, unknown> | null = null;
  try { artifact = JSON.parse(readFileSync(input.output, 'utf8')) as Record<string, unknown>; } catch { /* retained as failed process evidence */ }
  return {
    exitCode: code,
    timedOut,
    cleanupTimedOut,
    terminalCause,
    containment: containment.kind,
    ...(containment.error ? { containmentError: containment.error } : {}),
    artifact,
  };
}
