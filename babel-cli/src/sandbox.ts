import { formatFileReadContent, type ReadDeliveryWindow, type ReadByteCompleteness } from './services/readDelivery.js';
import { createHash } from 'node:crypto';
import { checkedFileBytes } from './utils/checkedFileRead.js';
import { acquireEffectDirectoryAnchors, type EffectDirectoryAnchors } from './executor/effectDirectoryAnchors.js';
/**
 * sandbox.ts — SafeExecutor: sandboxed tool execution for the CLI Executor stage
 *
 * Provides the four tool primitives used by localTools.ts:
 *   fileRead   — reads a file; path must resolve within projectRoot
 *   fileWrite  — writes a file; path must resolve within projectRoot
 *   shellExec  — runs an allowed command with shell: false
 *   testRun    — alias of shellExec with a default test-runner timeout
 *
 * Security guarantees:
 *   1. Path traversal prevention: all file paths are resolved to absolute
 *      and verified to be within (or equal to) `projectRoot` before I/O.
 *   2. Command allowlist: only a defined set of safe command names may be
 *      executed (npm, npx, node, git, python, pytest, etc.).
 *   3. Shell injection prevention: normal local execution rejects shell
 *      operator characters (; | & > < ` $ ( ) { } ! \). The isolated
 *      benchmark container profile may use POSIX shell syntax inside Docker.
 *   4. shell: false: spawnSync is never called with the shell option. On
 *      Windows, cmd.exe is invoked directly (same pattern as cliBase.ts)
 *      so that .cmd shims in PATH resolve without triggering Node DEP0190.
 *
 * `ToolResult` is defined here and re-exported from localTools.ts so that
 * downstream consumers are not broken.
 *
 * Environment variables:
 *   BABEL_PROJECT_ROOT  — Override the default project root (process.cwd()).
 *                         Set this to the target project's absolute path.
 */

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
} from 'node:child_process';
import {
  terminateChildTree as terminateChildTreeShared,
  waitForProcessGroupExit,
} from './processTree.js';
import {
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  existsSync,
  realpathSync,
  renameSync,
  openSync,
  closeSync,
  constants,
} from 'node:fs';
import { resolve, sep, dirname, basename, isAbsolute, relative, join } from 'node:path';
import {
  evaluateGovernedIsolation,
  getDockerDaemonMode,
  getDockerImageRuntimeIdentity,
  getDockerUnavailableReason,
  isBenchmarkProjectExecutableCommand,
  shouldUseDockerSandbox,
} from './config/benchmarkContainer.js';
import { validateDockerIsolationArgs } from './config/dockerIsolationArgs.js';
import { prepareOwnedContainerInvocation, removeOwnedContainer, removeOwnedContainerSync, type PreparedShellInvocation } from './sandboxContainerLifecycle.js';
import {
  getExecutionProfileCommandAdditions,
  isToolAllowedForExecutionProfile,
  resolveExecutionProfile,
} from './config/executionProfiles.js';
import {
  getDependencyInstallApprovalDecision,
  isDependencyInstallApproved,
  requestDependencyInstallApproval,
} from './services/approvalQueue.js';
import { getSafeEnv } from './utils/safeEnv.js';
import { childEnvForSandbox, hardenGitHostEnvironment } from './authority/unprivilegedChildEnv.js';
import { contextAwareOperatorCheck } from './utils/cmdTokenizer.js';
import {
  buildWindowsCommandShellArgs,
  CommandArgvParseError,
  parseCommandArgv,
} from './utils/commandArgv.js';
import { classifyExecutionRisk, requiresDockerIsolation } from './authority/commandSpec.js';
import { classifyResolvedCommand, commandControlledRoots, hostWindowsSystem32Directory, isCanonicalWindowsSystemShell, isResolvedCommandCurrent, resolveCommandExecutable, type ResolvedCommandExecutable } from './authority/commandResolver.js';
import { sanitizePath } from './cli/constants.js';
import { isCanonicalMcpSuccessResult } from './tools/mcpTransport.js';
import { OutputBuffer } from './ui/outputBuffer.js';
import { isSandboxReadableTestPath, writeUtf8FileSafely, type TrustedFileCreationEvidence } from './sandboxFileWrites.js';
export type { TrustedFileCreationEvidence } from './sandboxFileWrites.js';
import type { ProcessWitness, ProcessWitnessInput } from './diagnostics/bdns/processWitness.js';
import { MAX_SHELL_OUTPUT_BYTES, normalizeShellOutput } from './shellOutputNormalize.js';
import {
  cancelledBeforeSpawnShellResult,
  isChildRuntimeSupervisorError,
  isSpawnSyncRuntimeSupervisorError,
  normalizeSupervisorTerminatedShellOutput,
} from './sandboxSupervisorTermination.js';

// ─── Shared result type ───────────────────────────────────────────────────────

/** Result returned by every SafeExecutor tool method. */
export interface StructuredDenial {
  category: 'sandbox_policy' | 'executor_policy' | 'planning_restricted';
  reason_code: string;
  message: string;
  tool: string | null;
  active_mode: string | null;
  required_mode: string | null;
  evidence: string[] | null;
}

export interface McpLifecycle {
  phase:
    | 'server_lookup'
    | 'spawn'
    | 'write_request'
    | 'await_response'
    | 'response_parse'
    | 'complete';
  outcome: 'success' | 'failure';
  reason_code: string | null;
  server: string;
  evidence: string[] | null;
}

/** How the host may render a high-risk tool result. */
export type ToolRenderIntent =
  | 'shell_output'
  | 'mutation_receipt'
  | 'mcp_result'
  | 'tool_failure';

/** Structured failure used when a tool handler returns an unusable result shape. */
export interface ToolResultFailure {
  code:
    | 'invalid_tool_result'
    | 'invalid_mcp_tool_result'
    | 'mcp_tool_error'
    | 'mcp_rpc_error'
    | 'mcp_protocol_error'
    | 'no_compatible_mcp_tool'
    | 'mcp_approval_required';
  category: 'output_contract' | 'tool_execution' | 'transport' | 'input_contract';
  tool: string;
}

/**
 * Host-origin record that a command's process could not be launched at all.
 *
 * Set only by this sandbox boundary — never derived from child stdout/stderr,
 * tool arguments or a model-supplied label — so it is the trusted discriminator
 * for a genuine launch (capability) failure. A child that prints a lookalike
 * `[sandbox] Spawn error:` line in its own output does not produce it.
 */
export interface HostLaunchFailure {
  code: 'spawn_error' | 'transient_spawn_error';
}

export interface ToolResult {
  /** Host-origin child start evidence; does not assert that tests ran or passed. */
  process_started?: boolean;
  /** Host supervisor outcome; a started cancellation is never a natural test exit. */
  process_termination?: 'exited' | 'cancelled' | 'timed_out' | 'terminated';
  /** Successful glob data: count is returned paths, not display lines or total matches. */
  glob_result?: { paths: string[]; returned_count: number; truncated: boolean };
  /** Host-origin directory page identity and continuation, never parsed from display text. */
  directory_page?: { revision: string; after: string | null; next_after: string | null };
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Source completeness for capped file reads; absent for other tools. */
  output_completeness?: ReadByteCompleteness;
  /** Exact host-delivered coverage, independent of byte completeness. */
  read_window?: ReadDeliveryWindow;
  /**
   * Present only when the sandbox itself failed to launch the process. Absent
   * for every child-produced result, including a child that prints a
   * lookalike diagnostic.
   */
  launch_failure?: HostLaunchFailure | undefined;
  denial?: StructuredDenial;
  mcp_lifecycle?: McpLifecycle;
  checkpoint_ids?: string[];
  render_intent?: ToolRenderIntent;
  failure?: ToolResultFailure;
  /**
   * True when no process was started. A zero exit then means the command
   * never ran, and it must not be recorded as verifier evidence.
   */
  simulated?: boolean;
}

const trustedFileCreationEvidence = new WeakMap<object, TrustedFileCreationEvidence>();

export function getTrustedFileCreationEvidence(
  result: object,
): TrustedFileCreationEvidence | undefined {
  return trustedFileCreationEvidence.get(result);
}

export function preserveTrustedFileCreationEvidence<T extends object>(source: object, target: T): T {
  const evidence = trustedFileCreationEvidence.get(source);
  if (evidence) trustedFileCreationEvidence.set(target, evidence);
  return target;
}

/** Match host-attested creation paths to governed mutation targets (Windows 8.3 safe). */
export function matchesTrustedCreationPath(evidencePath: string, targetPath: string): boolean {
  if (process.platform !== 'win32') return evidencePath === targetPath;
  try {
    return realpathSync.native(evidencePath).toLowerCase() === realpathSync.native(targetPath).toLowerCase();
  } catch {
    return false;
  }
}

/** Bind rollback ownership only after full create-only settlement (never partial/incomplete). */
export function creationOwnershipFromTrustedEvidence(
  evidence: TrustedFileCreationEvidence | undefined,
  targetPath: string,
  intendedContent: string,
): { device: string; inode: string; expectedContent: string } | undefined {
  if (!evidence || evidence.settlementIncomplete || !matchesTrustedCreationPath(evidence.path, targetPath)) {
    return undefined;
  }
  return {
    device: evidence.device,
    inode: evidence.inode,
    expectedContent: intendedContent,
  };
}

/**
 * A rootful capability-dropped container runs as uid/gid 0. Only share a new
 * test file when that identity can traverse, but cannot mutate, every mounted
 * directory from the project root to its parent. This excludes writable
 * parents where an in-container process could race path validation.
 */
function rootfulContainerHasStableReadPath(
  projectRoot: string,
  targetPath: string,
  identity: { uid: number; gid: number },
): boolean {
  const parentPath = dirname(targetPath);
  const relativeParent = relative(projectRoot, parentPath);
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) return false;
  const directories = [projectRoot, ...relativeParent.split(sep).filter(Boolean).map((_, index, segments) => {
    let current = projectRoot;
    for (let part = 0; part <= index; part += 1) current = resolve(current, segments[part]!);
    return current;
  })];
  for (const directory of directories) {
    let stats;
    try {
      stats = statSync(directory);
    } catch {
      return false;
    }
    const mode = stats.mode & 0o777;
    // Do not share the project with the same host UID: a container running as
    // that owner could read existing owner-only files such as .env even when
    // the directory itself is not writable.
    if (stats.uid === identity.uid) return false;
    // Any group/other write bit can also act as an ACL mask for a named root
    // entry. Reject it conservatively; this function only broadens file reads.
    if ((mode & 0o022) !== 0) return false;
    const permissions = stats.gid === identity.gid ? { traverse: 0o010, write: 0o020 }
      : { traverse: 0o001, write: 0o002 };
    const containerCanTraverse = (mode & permissions.traverse) !== 0;
    const containerCanWrite = (mode & permissions.write) !== 0;
    if (!containerCanTraverse || containerCanWrite) return false;
  }
  return true;
}

function attachTrustedFileCreationEvidence<T extends object>(
  target: T,
  evidence: TrustedFileCreationEvidence | undefined,
): T {
  if (evidence) trustedFileCreationEvidence.set(target, evidence);
  return target;
}

export type ShellExecutionBackend = 'docker-container' | 'host-process';
const trustedShellExecutionBackend = new WeakMap<object, ShellExecutionBackend>();

/** Return only backend provenance attached by this module to a real SafeExecutor result. */
export function getTrustedShellExecutionBackend(result: ToolResult): ShellExecutionBackend | undefined {
  return trustedShellExecutionBackend.get(result);
}

/** Copy an existing trusted backend fact across a host-created result projection. */
export function preserveTrustedShellExecutionBackend<T extends object>(source: object, destination: T): T {
  const backend = trustedShellExecutionBackend.get(source);
  if (backend) trustedShellExecutionBackend.set(destination, backend);
  return destination;
}

function attachExecutionBackend(result: ToolResult, prepared: PreparedShellInvocation): ToolResult {
  if (result.process_started !== true) return result
  const backend = prepared.ownedContainerName ? 'docker-container' : 'host-process'
  trustedShellExecutionBackend.set(result, backend)
  return result
}

/**
 * Validate the small set of results that can be mistaken for execution evidence.
 * This runs at the executor registry boundary, where a handler can still be
 * replaced by a plugin, test double, or future transport implementation.
 * Malformed payloads are never reflected in the error because tool output may
 * contain untrusted or credential-like material.
 */
export function validateHighRiskToolResult(
  tool: string,
  candidate: unknown,
): ToolResult {
  const isMcp = tool.startsWith('mcp_');
  const isShell = tool === 'shell_exec' || tool === 'test_run';
  const isMutation = tool === 'file_write' || tool === 'file_delete';
  if (!isMcp && !isShell && !isMutation) return candidate as ToolResult;

  const invalid = (): ToolResult => ({
    exit_code: 1,
    stdout: '',
    stderr: `[TOOL_RESULT_INVALID] ${tool} returned an invalid output contract.`,
    render_intent: 'tool_failure',
    failure: { code: isMcp ? 'invalid_mcp_tool_result' : 'invalid_tool_result', category: 'output_contract', tool },
  });
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return invalid();

  const result = candidate as Partial<ToolResult>;
  if (
    !Number.isInteger(result.exit_code) ||
    (result.exit_code ?? -1) < 0 ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string'
  ) return invalid();

  // A mutation may only report success with an explicit receipt. Shell commands
  // legitimately have empty stdout, so their exit code remains authoritative.
  if (result.exit_code === 0 && isMutation && result.stdout.trim().length === 0) return invalid();

  // An MCP success is execution evidence from an untrusted subprocess. Do not
  // accept arbitrary handler stdout merely because it has exit code zero: the
  // transport must attest a completed lifecycle and emit the recognised
  // secret-safe MCP success envelope.
  if (result.exit_code === 0 && isMcp) {
    const lifecycle = result.mcp_lifecycle;
    if (
      lifecycle?.phase !== 'complete' ||
      lifecycle.outcome !== 'success' ||
      lifecycle.reason_code !== 'response_received' ||
      typeof lifecycle.server !== 'string' ||
      lifecycle.server.trim().length === 0
    ) return invalid();
    try {
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      if (!isCanonicalMcpSuccessResult(payload) || payload['server'] !== lifecycle.server) return invalid();
    } catch {
      return invalid();
    }
  }

  const render_intent: ToolRenderIntent = result.exit_code !== 0
    ? 'tool_failure'
    : isMcp
      ? 'mcp_result'
      : isMutation
        ? 'mutation_receipt'
        : 'shell_output';
  const validated = { ...(result as ToolResult), render_intent };
  return preserveTrustedShellExecutionBackend(result as object, validated);
}

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Patterns that indicate a transient infrastructure error during spawn.
 * When matched, the spawn operation is retried up to MAX_TRANSIENT_SPAWN_RETRIES
 * times before being reported as a failure. These errors should NOT consume
 * the LLM repair budget downstream.
 */
const TRANSIENT_SPAWN_ERROR_PATTERNS = [
  'ENOENT',
  'EPIPE',
  'broken pipe',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'socket hang up',
  'Cannot connect to the Docker daemon',
  'Is the docker daemon running',
  'Connection refused',
  'Container .* is not running',
  'Error response from daemon',
];

const MAX_TRANSIENT_SPAWN_RETRIES = 2;

/** Module-level sentinel for one-shot Docker fallback warning */
let dockerFallbackWarningEmitted = false;
let isolationEscalationWarningEmitted = false;

/**
 * Operator-facing sandbox notices.
 *
 * During TUI / TTY sessions, write a full newline-terminated line via
 * OutputBuffer so stderr cannot glue onto an open tool-start line
 * ("Running npm test[sandbox] …"). Non-TTY keeps console.error.
 */
function emitSandboxOperatorNotice(message: string): void {
  const line = `[sandbox] ${message}`;
  const useTuiChannel =
    process.env['BABEL_INTERACTIVE'] === '1' || Boolean(process.stdout.isTTY);
  if (useTuiChannel) {
    OutputBuffer.getInstance().write(`\n  \x1b[2m${line}\x1b[0m\n`);
    return;
  }
  console.error(line);
}

/**
 * Determines whether a spawn error message corresponds to a transient
 * infrastructure error that should be retried rather than forwarded to the
 * LLM repair path.
 */
function isTransientSpawnError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return TRANSIENT_SPAWN_ERROR_PATTERNS.some((pattern) => {
    if (pattern.includes('.*')) {
      // Regex pattern (e.g., "Container .* is not running")
      return new RegExp(pattern, 'i').test(errorMessage);
    }
    return lower.includes(pattern.toLowerCase());
  });
}

/**
 * Synchronous sleep using Atomics.wait on a shared buffer.
 * This is safe to use in the spawn retry loop because spawnSync is already
 * synchronous and blocks the main thread.
 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Non-blocking counterpart used by foreground async shell execution retries. */
function sleepAsync(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolveDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveDelay(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveDelay(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface AsyncSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  aborted: boolean;
  /** Process reached the spawn callback before the error (runtime, not launch). */
  processStarted: boolean;
  /** Wall-clock supervisor timeout after a successful launch. */
  timedOut: boolean;
  /** Particular aborted client closure; daemon cleanup must follow this barrier. */
  termination?: Promise<void>;
}

function appendCappedChunk(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
): { bytes: number; truncated: boolean } {
  const remaining = MAX_SHELL_OUTPUT_BYTES - currentBytes;
  if (remaining <= 0) return { bytes: currentBytes, truncated: chunk.length > 0 };
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { bytes: currentBytes + chunk.length, truncated: false };
  }
  chunks.push(chunk.subarray(0, remaining));
  return { bytes: MAX_SHELL_OUTPUT_BYTES, truncated: true };
}

/**
 * W0.1 Process supervisor: kill the spawned process and its descendants.
 * Windows: synchronous taskkill /T /F (async taskkill delayed cancel settlement).
 * POSIX: SIGTERM process group (detached spawn), then SIGKILL fallback.
 */
export function terminateChildTree(child: ChildProcessWithoutNullStreams): { treeKillAccepted: boolean } {
  return terminateChildTreeShared(child);
}

/**
 * Max wait after AbortSignal before forcing promise settle if `close` never fires.
 * Product cancel p95 is under 250ms; 500ms local/CI budget covers OS reaping jitter.
 * Prefer immediate finish after terminateChildTree (see onAbort).
 */
export const PROCESS_ABORT_SETTLE_MS = 500;

/**
 * Deferred child-tree terminations requested by aborted async spawns.
 *
 * Cancel settles the tool result before the tree kill so Windows cancel latency
 * is not dominated by `taskkill`. A caller that immediately removes the child's
 * working tree must first await this latch, otherwise the still-live child can
 * hold the directory on Windows and fail the delete with EBUSY.
 */
export class ProcessTerminationError extends Error {
  readonly code = 'PROCESS_TERMINATION_FAILED';

  constructor(readonly ownerId: string, readonly executionId: string, cause: unknown) {
    super(`Process ${executionId} for ${ownerId} did not terminate cleanly`, { cause });
    this.name = 'ProcessTerminationError';
  }
}

const pendingProcessTerminations = new Map<number, { ownerId: string; promise: Promise<void> }>();
const failedProcessTerminations = new Map<number, ProcessTerminationError>();
let processTerminationSequence = 0;

/** Retain a deferred closure result until the initiating owner acknowledges it. */
export function registerPendingProcessTermination(
  termination: Promise<void>,
  ownerId: string,
  executionId: string,
): void {
  const id = ++processTerminationSequence;
  pendingProcessTerminations.set(id, { ownerId, promise: termination });
  void termination.then(
    () => { pendingProcessTerminations.delete(id); },
    (cause: unknown) => {
      pendingProcessTerminations.delete(id);
      failedProcessTerminations.set(id, new ProcessTerminationError(ownerId, executionId, cause));
    },
  );
}

/** Resolve once every deferred abort-path child-tree termination has closed. */
export async function awaitPendingProcessTerminations(ownerId?: string): Promise<void> {
  await Promise.allSettled(
    [...pendingProcessTerminations.values()]
      .filter((pending) => ownerId === undefined || pending.ownerId === ownerId)
      .map((pending) => pending.promise),
  );
  const failures = [...failedProcessTerminations.entries()]
    .filter(([, failure]) => ownerId === undefined || failure.ownerId === ownerId);
  for (const [id] of failures) failedProcessTerminations.delete(id);
  if (failures.length === 1) throw failures[0]![1];
  if (failures.length > 1) {
    throw new AggregateError(failures.map(([, failure]) => failure),
      'Multiple deferred process terminations failed');
  }
}

/**
 * W0.1 Process supervisor — async spawn with AbortSignal, output caps, tree kill.
 * Used by SafeExecutor.shellExecAsync (chat/REPL foreground path).
 */
export function spawnCommandAsync(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    processWitness?: ProcessWitness;
    processContext?: Pick<ProcessWitnessInput, 'sessionId' | 'turnId' | 'toolCallId' | 'toolName' | 'projectRoot'>;
  },
): Promise<AsyncSpawnResult> {
  const processInput: ProcessWitnessInput = {
    executable,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    ...(options.processContext ?? {}),
  };
  const executionId = options.processWitness?.requested(processInput);
  if (options.signal?.aborted) {
    if (executionId) options.processWitness?.cancelRequested(processInput, executionId);
    return Promise.resolve({
      status: 1,
      stdout: '',
      stderr: '',
      error: new Error(`spawn ${executable} aborted`),
      stdoutTruncated: false,
      stderrTruncated: false,
      aborted: true,
      processStarted: false,
      timedOut: false,
    });
  }

  return new Promise((resolveResult) => {
    let child: ChildProcessWithoutNullStreams;
    let processStarted = false;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        ...(process.platform === 'win32' && basename(executable).toLowerCase() === 'cmd.exe'
          ? { windowsVerbatimArguments: true }
          : {}),
        // POSIX: new process group so terminateChildTree can SIGTERM -pid.
        detached: process.platform !== 'win32',
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      if (executionId) options.processWitness?.failedToStart(processInput, executionId, err);
      resolveResult({
        status: 1,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err : new Error(String(err)),
        stdoutTruncated: false,
        stderrTruncated: false,
        aborted: false,
        processStarted: false,
        timedOut: false,
      });
      return;
    }

    child.once('spawn', () => {
      processStarted = true;
      if (executionId) options.processWitness?.started(processInput, executionId, child.pid);
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let witnessTerminalRecorded = false;
    let timeout: NodeJS.Timeout | null = null;
    let abortSettle: NodeJS.Timeout | null = null;
    let termination: Promise<void> | undefined;
    let releaseAbortPhysicalClose: (() => void) | undefined;
    const abortPhysicalClose = new Promise<void>((resolveAbortPhysicalClose) => {
      releaseAbortPhysicalClose = resolveAbortPhysicalClose;
    });
    let releasePhysicalClose: (() => void) | undefined;
    const physicalClose = new Promise<void>((resolvePhysicalClose) => {
      releasePhysicalClose = resolvePhysicalClose;
    });

    const recordWitnessTerminal = (status: number | null, error?: Error) => {
      if (witnessTerminalRecorded || !executionId) return;
      witnessTerminalRecorded = true;
      if (executionId) {
        if (!processStarted && error) options.processWitness?.failedToStart(processInput, executionId, error);
        else options.processWitness?.exited(processInput, executionId, {
          exitCode: status,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
          ...(error ? { error: error.message } : {}),
        });
      }
    };

    const finish = (status: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (abortSettle) clearTimeout(abortSettle);
      options.signal?.removeEventListener('abort', onAbort);
      resolveResult({
        status,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        ...(error ? { error } : {}),
        stdoutTruncated,
        stderrTruncated,
        aborted,
        processStarted,
        timedOut,
        ...(termination ? { termination } : {}),
      });
    };

    const onAbort = () => {
      aborted = true;
      if (executionId) options.processWitness?.cancelRequested(processInput, executionId);
      // Unblock the tool awaiter first (cancel p95). Defer tree-kill to the next
      // event-loop turn so spawnSync(taskkill) cannot hold the promise microtask
      // queue — otherwise Windows cancel latency is dominated by taskkill, not
      // by AbortSignal delivery.
      termination = new Promise<void>((resolveTermination, rejectTermination) => {
        let complete = false;
        const closeTimeout = setTimeout(() => {
          if (complete) return;
          complete = true;
          rejectTermination(new Error(`Aborted process ${executable} did not close after tree termination`));
        }, 5_000);
        setImmediate(() => {
          void (async () => {
            try {
              const pid = child.pid;
              if (!pid) {
                throw new Error(`Aborted spawn missing child pid for ${executable}`);
              }
              const terminationAttempt = terminateChildTree(child);
              if (process.platform === 'win32' && !terminationAttempt.treeKillAccepted) {
                throw new Error('Windows process-tree termination was not confirmed by taskkill');
              }
              const groupExited = await waitForProcessGroupExit(pid, 5_000);
              if (!groupExited) {
                throw new Error(`Aborted process group ${pid} did not exit after tree termination`);
              }
              await abortPhysicalClose;
              if (complete) return;
              complete = true;
              clearTimeout(closeTimeout);
              resolveTermination();
            } catch (error) {
              if (complete) return;
              complete = true;
              clearTimeout(closeTimeout);
              rejectTermination(error);
            }
          })();
        });
      });
      registerPendingProcessTermination(
        termination,
        options.processContext?.sessionId ?? 'unscoped',
        executionId ?? `${executable}:${child.pid ?? 'unknown'}`,
      );
      finish(1, new Error(`spawn ${executable} aborted`));
    };

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        if (executionId) options.processWitness?.timeout(processInput, executionId);
        // The parent's `close` event says nothing about its descendants. A
        // supervisor deadline must not settle until the owned process group is
        // physically gone, or callers observe a "timed out" tool while an
        // orphaned test/child process still runs.
        termination = new Promise<void>((resolveTermination, rejectTermination) => {
          let complete = false;
          const closeTimeout = setTimeout(() => {
            if (complete) return;
            complete = true;
            rejectTermination(new Error(`Timed-out process ${executable} did not close after tree termination`));
          }, 5_000);
          setImmediate(() => {
            void (async () => {
              try {
                const pid = child.pid;
                const terminationAttempt = terminateChildTree(child);
                if (process.platform === 'win32' && pid && !terminationAttempt.treeKillAccepted) {
                  throw new Error('Windows process-tree termination was not confirmed by taskkill');
                }
                // No pid means there is no owned process group to observe, but
                // the direct child may still emit its physical close.
                if (pid) {
                  const groupExited = await waitForProcessGroupExit(pid, 5_000);
                  if (!groupExited) {
                    throw new Error(`Timed-out process group ${pid} did not exit after tree termination`);
                  }
                }
                await physicalClose;
                if (complete) return;
                complete = true;
                clearTimeout(closeTimeout);
                resolveTermination();
              } catch (error) {
                if (complete) return;
                complete = true;
                clearTimeout(closeTimeout);
                rejectTermination(error);
              }
            })();
          });
        });
        // The close handler attaches the observable rejection; this prevents an
        // unhandled rejection if the process hangs and close never arrives.
        void termination.catch(() => {});
        registerPendingProcessTermination(
          termination,
          options.processContext?.sessionId ?? 'unscoped',
          executionId ?? `${executable}:${child.pid ?? 'unknown'}`,
        );
      }, options.timeoutMs);
      timeout.unref?.();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer | string) => {
      const update = appendCappedChunk(
        stdoutChunks,
        stdoutBytes,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
      stdoutBytes = update.bytes;
      stdoutTruncated ||= update.truncated;
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const update = appendCappedChunk(
        stderrChunks,
        stderrBytes,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      );
      stderrBytes = update.bytes;
      stderrTruncated ||= update.truncated;
    });

    child.once('error', (err) => {
      if (!processStarted) recordWitnessTerminal(1, err);
      finish(1, err);
    });
    child.once('close', (code) => {
      releasePhysicalClose?.();
      if (aborted) {
        recordWitnessTerminal(code ?? 1, new Error(`spawn ${executable} aborted`));
        if (executionId) options.processWitness?.killed(processInput, executionId);
        releaseAbortPhysicalClose?.();
        finish(code ?? 1, new Error(`spawn ${executable} aborted`));
      } else if (timedOut) {
        const settleTimedOut = (error?: Error) => {
          recordWitnessTerminal(code ?? 1, error ?? new Error(`spawn ${executable} ETIMEDOUT`));
          finish(error ? 1 : code ?? 1, error ?? new Error(`spawn ${executable} ETIMEDOUT`));
        };
        if (termination) {
          void termination.then(
            () => settleTimedOut(),
            (error: unknown) => settleTimedOut(error instanceof Error ? error : new Error(String(error))),
          );
        } else {
          settleTimedOut();
        }
      } else if (process.platform !== 'win32' && child.pid) {
        void (async () => {
          let descendantsSettled = await waitForProcessGroupExit(child.pid!, 150);
          let hadLingeringDescendants = false;
          if (!descendantsSettled) {
            hadLingeringDescendants = true;
            terminateChildTree(child);
            descendantsSettled = await waitForProcessGroupExit(child.pid!, 5_000);
          }
          let finalCode = code;
          let error: Error | undefined;
          if (!descendantsSettled) {
            error = new Error(`spawn ${executable} process-tree termination could not be confirmed`);
            finalCode = 1;
          } else if (hadLingeringDescendants) {
            error = new Error(`Owned descendants remained after ${executable} direct exit and were terminated`);
            finalCode = 1;
          }
          recordWitnessTerminal(finalCode ?? 1, error);
          finish(finalCode, error);
        })();
      } else {
        recordWitnessTerminal(code);
        finish(code);
      }
    });
  });
}

/** @visibleForTesting */
export { isTransientSpawnError, normalizeSupervisorTerminatedShellOutput };

/**
 * Commands allowed in shellExec / testRun. Checked against argv[0] basename.
 *
 * SECURITY: Several commands in this set (python, node, npm, pip, deno)
 * provide arbitrary code execution paths. The allowlist is a convenience
 * guardrail — it prevents accidental use of dangerous system commands but
 * does NOT prevent code execution through allowed interpreters.
 *
 * `npx` is deliberately excluded from the base set: it downloads and executes
 * remote packages. Use `npx` only in Docker-isolated profiles (benchmark_container)
 * or through the MCP server launch path (which has its own validation).
 *
 * For production use, restrict further via BABEL_ALLOWED_TOOLS env var.
 */
export { ALLOWED_COMMANDS, getAllowedShellCommands, validateExecutorShellCommand } from './sandboxCommands.js';
export type { ShellCommandValidationIssue, ShellCommandValidationOptions } from './sandboxCommands.js';
import { SHELL_OPERATOR_RE, validateExecutorShellCommand } from './sandboxCommands.js';

function buildSandboxPolicyDenial(
  reasonCode: string,
  message: string,
  tool: string,
  evidence: string[] | null = null,
): StructuredDenial {
  return {
    category: 'sandbox_policy',
    reason_code: reasonCode,
    message,
    tool,
    active_mode: null,
    required_mode: null,
    evidence: evidence && evidence.length > 0 ? [...evidence] : null,
  };
}

function policyDeniedResult(
  reasonCode: string,
  message: string,
  tool: string,
  evidence: string[] | null = null,
): ToolResult {
  return {
    exit_code: 1,
    stdout: '',
    stderr: message,
    denial: buildSandboxPolicyDenial(reasonCode, message, tool, evidence),
  };
}

/** Return whether a path names credential-class material. */
export function isCredentialReadPath(inputPath: string): boolean {
  const normalized = inputPath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  const name = basename(normalized);

  if (name === '.env.example') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (['id_rsa', 'id_ed25519', 'credentials.json'].includes(name)) return true;
  if (/\.(pem|p12|pfx)$/.test(name)) return true;

  return (
    segments.includes('.ssh') ||
    segments.includes('secrets') ||
    segments.some((segment, index) => segment === '.aws' && segments[index + 1] === 'credentials')
  );
}
function maybePolicyDeniedResult(
  err: unknown,
  tool: string,
  evidence: string[] | null = null,
): ToolResult | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('[sandbox] Path traversal denied:')) {
    return policyDeniedResult('path_jail_rejected', message, tool, evidence);
  }

  if (message.startsWith('[sandbox] Symlink traversal denied:')) {
    return policyDeniedResult('symlink_escape_rejected', message, tool, evidence);
  }

  if (message.startsWith('[sandbox] Credential read denied:')) {
    return policyDeniedResult('credential_read_denied', message, tool, evidence);
  }

  return null;
}

// ─── SafeExecutor ─────────────────────────────────────────────────────────────

export type ExecutorMode = 'plan' | 'act';

const MAX_FILE_READ_SOURCE_BYTES = 1024 * 1024;

export class SafeExecutor {
  private readonly projectRoot: string;
  private readonly shadowRoot: string | null;
  private readonly mode: ExecutorMode;
  private readonly processWitness: ProcessWitness | undefined;
  /**
   * VCS: Approved read roots — reads may escape projectRoot into these dirs.
   * Populated from BABEL_OPENCLAW_APPROVED_ROOTS (or BABEL_ALLOWED_ROOTS) at construction.
   * Writes are always locked to projectRoot.
   */
  private readonly approvedReadRoots: string[];

  /**
   * @param projectRoot  Absolute path to the project root. All file I/O
   *                     must resolve to a path within this directory.
   *                     Resolved to absolute on construction.
   * @param mode         Current operational mode ('plan' | 'act').
   */
  constructor(
    projectRoot: string,
    shadowRoot: string | null = null,
    mode: ExecutorMode = 'act',
    processWitness?: ProcessWitness,
  ) {
    this.mode = mode;
    this.processWitness = processWitness;
    const resolvedRoot = existsSync(projectRoot) ? realpathSync(projectRoot) : resolve(projectRoot);
    this.shadowRoot =
      shadowRoot && existsSync(shadowRoot)
        ? realpathSync(shadowRoot)
        : shadowRoot
          ? resolve(shadowRoot)
          : null;
    const allowedRootsRaw = process.env['BABEL_ALLOWED_ROOTS']?.trim();
    const isProduction = process.env['BABEL_ENV'] === 'production';

    if (isProduction && !allowedRootsRaw) {
      throw new Error(
        '[sandbox] Security Violation: BABEL_ALLOWED_ROOTS is mandatory when BABEL_ENV=production. ' +
          'Please define authorized project roots to continue.',
      );
    }

    if (allowedRootsRaw) {
      const allowedRoots = allowedRootsRaw.split(',').map((r) => {
        const p = r.trim();
        return existsSync(p) ? realpathSync(p) : resolve(p);
      });
      const isAllowed = allowedRoots.some((allowed) => {
        if (process.platform === 'win32') {
          const rootNorm = resolvedRoot.toLowerCase();
          const allowedNorm = allowed.toLowerCase();
          return rootNorm === allowedNorm || rootNorm.startsWith(allowedNorm + sep);
        }
        return resolvedRoot === allowed || resolvedRoot.startsWith(allowed + sep);
      });

      if (!isAllowed) {
        throw new Error(
          `[sandbox] Project root "${resolvedRoot}" is not within any authorized paths (BABEL_ALLOWED_ROOTS).`,
        );
      }
    }
    this.projectRoot = resolvedRoot;

    // VCS: build approved read roots list
    const openclawRoots = process.env['BABEL_OPENCLAW_APPROVED_ROOTS']?.trim();
    const rootsSource = openclawRoots ?? allowedRootsRaw;
    if (rootsSource) {
      this.approvedReadRoots = rootsSource.split(/[;,]/).map((r) => {
        const p = r.trim();
        return existsSync(p) ? realpathSync(p) : resolve(p);
      });
    } else {
      // Default to the active project. Cross-project reads require explicit authority.
      this.approvedReadRoots = [this.projectRoot];
    }
  }

  // ── Path safety ─────────────────────────────────────────────────────────────

  private resolveProjectPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    const canonical = trimmed.replace(/\\/g, '/');
    const canonicalLower = canonical.toLowerCase();
    const projectPrefix = '/project';
    const appPrefix = '/app';

    if (canonicalLower === projectPrefix || canonicalLower.startsWith(`${projectPrefix}/`)) {
      const rest = canonical.slice(projectPrefix.length).replace(/^\/+/, '');
      return resolve(this.projectRoot, sanitizePath(rest));
    }

    const profile = resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']);
    if (
      profile.name === 'benchmark_container' &&
      (canonicalLower === appPrefix || canonicalLower.startsWith(`${appPrefix}/`))
    ) {
      const rest = canonical.slice(appPrefix.length).replace(/^\/+/, '');
      return resolve(this.projectRoot, sanitizePath(rest));
    }

    if (isAbsolute(trimmed)) {
      return resolve(trimmed);
    }

    return resolve(this.projectRoot, sanitizePath(trimmed));
  }

  private isWithinProjectRoot(candidatePath: string): boolean {
    const root = this.projectRoot;
    const target = candidatePath;

    if (process.platform === 'win32') {
      const rootNorm = root.toLowerCase();
      const targetNorm = target.toLowerCase();
      return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + sep);
    }

    return target === root || target.startsWith(root + sep);
  }

  /**
   * VCS: Returns true if the candidate path is within ANY approved read root.
   * Used by resolveSafeRead() to allow cross-project reads within the workspace.
   */
  private isWithinAnyApprovedRoot(candidatePath: string): boolean {
    return this.approvedReadRoots.some((root) => {
      if (process.platform === 'win32') {
        const rootNorm = root.toLowerCase();
        const targetNorm = candidatePath.toLowerCase();
        return targetNorm === rootNorm || targetNorm.startsWith(rootNorm + sep);
      }
      return candidatePath === root || candidatePath.startsWith(root + sep);
    });
  }

  private ensureWithinProjectRoot(inputPath: string, candidatePath: string): void {
    if (this.isWithinProjectRoot(candidatePath)) {
      return;
    }

    throw new Error(
      `[sandbox] Path traversal denied: "${inputPath}" resolves to` +
        ` "${candidatePath}" (canonical: "${candidatePath}") which is outside project root "${this.projectRoot}".`,
    );
  }

  private resolveSymlinkAwarePath(inputPath: string, resolvedPath: string): string {
    const relativeToRoot = relative(this.projectRoot, resolvedPath);
    if (relativeToRoot === '') {
      return this.projectRoot;
    }

    const segments = relativeToRoot.split(/[\\/]+/).filter((segment) => segment.length > 0);

    let current = this.projectRoot;

    for (const segment of segments) {
      const nextPath = resolve(current, segment);
      if (!existsSync(nextPath)) {
        current = nextPath;
        continue;
      }

      const stats = lstatSync(nextPath);
      if (stats.isSymbolicLink()) {
        const symlinkTarget = realpathSync(nextPath);
        if (!this.isWithinProjectRoot(symlinkTarget)) {
          throw new Error(
            `[sandbox] Symlink traversal denied: "${inputPath}" reaches symlink ` +
              `"${nextPath}" → "${symlinkTarget}" outside project root "${this.projectRoot}".`,
          );
        }
        current = symlinkTarget;
        continue;
      }

      const canonicalNext = realpathSync(nextPath);
      this.ensureWithinProjectRoot(inputPath, canonicalNext);
      current = canonicalNext;
    }

    return current;
  }

  private ensureWritableParentExists(inputPath: string, safePath: string): string {
    const parentPath = dirname(safePath);
    const relativeParent = relative(this.projectRoot, parentPath);

    if (relativeParent && relativeParent !== '.') {
      let current = this.projectRoot;
      for (const segment of relativeParent.split(/[\\/]+/).filter((value) => value.length > 0)) {
        const nextPath = resolve(current, segment);
        if (!existsSync(nextPath)) {
          mkdirSync(nextPath);
        }

        const stats = lstatSync(nextPath);
        if (stats.isSymbolicLink()) {
          const symlinkTarget = realpathSync(nextPath);
          throw new Error(
            `[sandbox] Symlink traversal denied: "${inputPath}" reaches symlink ` +
              `"${nextPath}" → "${symlinkTarget}" during parent directory creation.`,
          );
        }

        const canonicalNext = realpathSync(nextPath);
        this.ensureWithinProjectRoot(inputPath, canonicalNext);
        current = canonicalNext;
      }
    }

    return safePath;
  }

  private assertSafeWritableTarget(
    inputPath: string,
    targetPath: string,
    enforceProjectRoot: boolean,
  ): void {
    let stats;
    try {
      stats = lstatSync(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `[sandbox] Symlink traversal denied: "${inputPath}" targets symlink ` +
          `"${targetPath}" during final file write.`,
      );
    }

    if (enforceProjectRoot) {
      const canonicalTarget = realpathSync(targetPath);
      this.ensureWithinProjectRoot(inputPath, canonicalTarget);
    }
  }

  private writeUtf8FileSafely(
    inputPath: string,
    targetPath: string,
    content: string,
    enforceProjectRoot: boolean,
    options?: { createOnly?: true; sandboxReadableTest?: true; onCreated?: (evidence: TrustedFileCreationEvidence) => void },
  ): void {
    writeUtf8FileSafely(inputPath, targetPath, content, enforceProjectRoot,
      (input, target, enforceRoot) => this.assertSafeWritableTarget(input, target, enforceRoot), options);
  }

  /**
   * Resolves `inputPath` against `projectRoot` and verifies the result stays
   * within the root. Throws a descriptive error on traversal attempts.
   */
  resolveSafe(inputPath: string): string {
    const resolved = this.resolveProjectPath(inputPath);
    this.ensureWithinProjectRoot(inputPath, resolved);
    return this.resolveSymlinkAwarePath(inputPath, resolved);
  }

  /**
   * VCS: Like resolveSafe(), but allows the resolved path to be anywhere
   * within the approved workspace read roots (not just projectRoot).
   * Used exclusively by read-only tools (fileRead, listDirectory).
   * Writes always use resolveSafe().
   */
  resolveSafeRead(inputPath: string): string {
    // Use the same prefix-aware resolution as resolveSafe() so that /project/
    // and /app/ virtual prefixes are remapped to projectRoot correctly.
    const resolved = this.resolveProjectPath(inputPath);

    // Allow if within projectRoot (standard case, same as resolveSafe)
    if (this.isWithinProjectRoot(resolved)) {
      return this.resolveSymlinkAwarePath(inputPath, resolved);
    }

    // VCS extension: also allow if within any approved read root
    // (enables cross-project reads within the workspace without escaping safety).
    // M13: Resolve symlinks before returning to prevent symlink-based escape
    // from the approved read root boundaries.
    if (this.isWithinAnyApprovedRoot(resolved)) {
      const realResolved = realpathSync(resolved);
      if (!this.isWithinAnyApprovedRoot(realResolved)) {
        throw new Error(
          `[sandbox] Symlink traversal denied: "${inputPath}" resolves to ` +
            `"${realResolved}" outside approved read roots via symlink.`,
        );
      }
      return realResolved;
    }

    throw new Error(
      `[sandbox] Path traversal denied: "${inputPath}" resolves to "${resolved}" ` +
        `which is outside approved read roots.`,
    );
  }

  /**
   * Returns a denial result if the executor is in 'plan' mode and a mutating
   * tool was called.
   */
  private checkPlanModeDenial(tool: string): ToolResult | null {
    if (this.mode !== 'plan') {
      return null;
    }

    const message =
      `[sandbox] Planning Restricted: Cannot execute mutating tool "${tool}" while in Plan Mode. ` +
      `Please design your approach and use exit_plan_mode to proceed to implementation.`;

    return {
      exit_code: 1,
      stdout: '',
      stderr: message,
      denial: {
        category: 'planning_restricted',
        reason_code: 'planning_restricted',
        message,
        tool,
        active_mode: 'plan',
        required_mode: 'act',
        evidence: null,
      },
    };
  }

  private checkExecutionProfileToolDenial(tool: string): ToolResult | null {
    if (isToolAllowedForExecutionProfile(process.env['BABEL_EXECUTION_PROFILE'], tool)) {
      return null;
    }

    const profile = resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']);
    return policyDeniedResult(
      'execution_profile_tool_rejected',
      `[sandbox] Execution profile "${profile.name}" does not allow mutating tool "${tool}".`,
      tool,
      [profile.name, tool],
    );
  }

  /**
   * Check execution profile denial, and if the tool is `test_run`, also
   * check `shell_exec` — `testRun()` is a direct passthrough to `shellExec()`,
   * so it must be at least as restricted as `shell_exec`.
   */
  private checkExecutionProfileToolDenialWithTestRun(tool: string): ToolResult | null {
    const denial = this.checkExecutionProfileToolDenial(tool);
    if (denial) return denial;
    if (tool === 'test_run') {
      return this.checkExecutionProfileToolDenial('shell_exec');
    }
    return null;
  }

  // ── File operations ──────────────────────────────────────────────────────────

  fileRead(
    inputPath: string,
    options?: { offset?: number; limit?: number; raw?: boolean },
  ): ToolResult {
    try {
      const safePath = this.resolveSafeRead(inputPath);

      if (isCredentialReadPath(safePath)) {
        throw new Error(
          `[sandbox] Credential read denied: "${inputPath}" is credential-class material. ` +
            'Read .env.example or inspect required variable names without loading secret values.',
        );
      }

      // Shadow Read-Through
      if (this.shadowRoot) {
        const relativePath = relative(this.projectRoot, safePath);
        const shadowPath = resolve(this.shadowRoot, relativePath);
        if (existsSync(shadowPath)) {
          const effectiveShadowPath = realpathSync(shadowPath);
          if (isCredentialReadPath(effectiveShadowPath)) {
            throw new Error(
              `[sandbox] Credential read denied: "${inputPath}" resolves to credential-class shadow material.`,
            );
          }
          const exactStats = statSync(effectiveShadowPath, { bigint: true });
          const stats = statSync(effectiveShadowPath);
          if (!stats.isDirectory()) {
            if (stats.size > MAX_FILE_READ_SOURCE_BYTES) {
              throw new Error('File is too large for file_read; use read_range to inspect it.');
            }
            const shadowRoot = this.shadowRoot;
            const content = checkedFileBytes(effectiveShadowPath, MAX_FILE_READ_SOURCE_BYTES, () => {
              const rel = relative(shadowRoot, realpathSync(shadowPath));
              return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && realpathSync(shadowPath) === effectiveShadowPath;
            }, stats, exactStats);
            if (!content) throw new Error('File changed or escaped its approved read boundary.');
            return this.formatFileContent(content.toString('utf8'), options);
          }
        }
      }

      const exactStats = statSync(safePath, { bigint: true });
      const stats = statSync(safePath);
      if (stats.isDirectory()) {
        return { exit_code: 1, stdout: '', stderr: 'file_read requires a regular file; use directory_list for a guarded directory listing.' };
      }
      if (stats.size > MAX_FILE_READ_SOURCE_BYTES) {
        throw new Error('File is too large for file_read; use read_range to inspect it.');
      }
      const content = checkedFileBytes(safePath, MAX_FILE_READ_SOURCE_BYTES, () =>
        this.resolveSafeRead(inputPath) === safePath && realpathSync(safePath) === safePath, stats, exactStats);
      if (!content) {
        // checkedFileBytes intentionally collapses every failure to null. Distinguish
        // an OS permission denial from an identity/boundary change so the terminal
        // classifier can report a typed permission block instead of a generic failure.
        let probe: number | undefined
        try { probe = openSync(safePath, constants.O_RDONLY) }
        catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'EACCES' || code === 'EPERM') throw err
        } finally { if (probe !== undefined) closeSync(probe) }
        throw new Error('File changed or escaped its approved read boundary.');
      }
      return this.formatFileContent(content.toString('utf8'), options);
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'file_read', [inputPath]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }
  }

  /**
   * Formats file content with line numbers, offset/limit slicing, and a 100 KB
   * safety cap. When the output is truncated (by offset/limit or by the cap),
   * a header line explains the range shown.
   */
  private formatFileContent(
    content: string,
    options?: { offset?: number; limit?: number; raw?: boolean },
  ): ToolResult {
    return formatFileReadContent(content, options);
  }

  async listDirectoryGuarded(inputPath: string, signal?: AbortSignal, page?: { after?: string | undefined; revision?: string | undefined }): Promise<ToolResult> {
    let anchors: EffectDirectoryAnchors | undefined;
    try {
      signal?.throwIfAborted();
      const safePath = this.resolveSafeRead(inputPath);
      const directories = [safePath];
      if (this.shadowRoot) {
        const shadowPath = resolve(this.shadowRoot, relative(this.projectRoot, safePath));
        if (existsSync(shadowPath)) {
          const shadow = realpathSync(shadowPath);
          const rel = relative(this.shadowRoot, shadow);
          if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Shadow directory escaped its approved boundary.');
          if (statSync(shadow).isDirectory()) directories.push(shadow);
        }
      }
      anchors = await acquireEffectDirectoryAnchors(directories);
      signal?.throwIfAborted();
      const result = await this.listDirectoryImpl(inputPath, anchors, page, signal);
      signal?.throwIfAborted();
      return result;
    } catch (err) {
      signal?.throwIfAborted();
      const denied = maybePolicyDeniedResult(err, 'directory_list', [inputPath]);
      return denied ?? { exit_code: 1, stdout: '', stderr: String(err) };
    } finally { await anchors?.release(); }
  }

  listDirectory(inputPath: string): ToolResult {
    return this.listDirectoryImpl(inputPath);
  }

  private listDirectoryImpl(inputPath: string): ToolResult;
  private listDirectoryImpl(inputPath: string, anchors: EffectDirectoryAnchors, page?: { after?: string | undefined; revision?: string | undefined }, signal?: AbortSignal): ToolResult | Promise<ToolResult>;
  private listDirectoryImpl(inputPath: string, anchors?: EffectDirectoryAnchors, page?: { after?: string | undefined; revision?: string | undefined }, signal?: AbortSignal): ToolResult | Promise<ToolResult> {
    try {
      const safePath = this.resolveSafeRead(inputPath);

      if (isCredentialReadPath(safePath)) {
        throw new Error(
          `[sandbox] Credential read denied: "${inputPath}" is credential-class material. ` +
            'Read .env.example or inspect required variable names without loading secret values.',
        );
      }

      // Shadow Read-Through (for directories, we might want to merge, but for now simple swap)
      let effectivePath = safePath;
      if (this.shadowRoot) {
        const relativePath = relative(this.projectRoot, safePath);
        const shadowPath = resolve(this.shadowRoot, relativePath);
        if (existsSync(shadowPath)) {
          const effectiveShadowPath = realpathSync(shadowPath);
          if (isCredentialReadPath(effectiveShadowPath)) {
            throw new Error(
              `[sandbox] Credential read denied: "${inputPath}" resolves to credential-class shadow material.`,
            );
          }
          if (statSync(effectiveShadowPath).isDirectory()) {
            effectivePath = effectiveShadowPath;
          }
        }
      }

      const stats = statSync(effectivePath);
      if (!stats.isDirectory()) {
        return {
          exit_code: 1,
          stdout: '',
          stderr: `[sandbox] directory_list expected a directory but received: ${effectivePath}`,
        };
      }
      if (!anchors) return { exit_code: 1, stdout: '', stderr: 'Directory listing requires a guarded directory handle.' };
      if ((page?.after === undefined) !== (page?.revision === undefined)) return { exit_code: 1, stdout: '', stderr: 'Directory continuation requires both after and revision from a previous page.' };
      if (page?.after !== undefined && (!page.after || page.after.length > 4096 || !/^[a-f0-9]{64}$/.test(page.revision ?? ''))) return { exit_code: 1, stdout: '', stderr: 'Invalid directory continuation; start the listing again.' };
      const validateDirectory = (): boolean => {
        if (this.resolveSafeRead(inputPath) !== safePath || realpathSync(safePath) !== safePath || realpathSync(effectivePath) !== effectivePath) return false;
        if (effectivePath === safePath) return true;
        if (!this.shadowRoot) return false;
        const shadowPath = resolve(this.shadowRoot, relative(this.projectRoot, safePath));
        const rel = relative(this.shadowRoot, realpathSync(shadowPath));
        return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && realpathSync(shadowPath) === effectivePath;
      };
      if (!validateDirectory()) throw new Error('Directory changed or escaped its approved read boundary.');
      return (async (): Promise<ToolResult> => {
      try {
      const directoryPath = anchors ? dirname(anchors.path(join(effectivePath, '__babel_directory_anchor__'))) : effectivePath;
      const revisionOf = (): string => {
        const value = statSync(directoryPath, { bigint: true });
        return createHash('sha256').update(`babel-directory-v1\0${value.dev}\0${value.ino}\0${value.mtimeNs}\0${value.ctimeNs}`).digest('hex');
      };
      const revision = revisionOf();
      if (page?.revision && page.revision !== revision) return { exit_code: 1, stdout: '', stderr: 'Directory changed since the previous page; start the listing again.' };
      const entries: Array<{ name: string; kind: string }> = [];
      let eligible = 0;
      let scanned = 0;
      const directory = opendirSync(directoryPath);
      try {
        for (let item = directory.readSync(); item; item = directory.readSync()) {
          if (++scanned % 128 === 0) {
            await new Promise<void>(resolveYield => setImmediate(resolveYield));
            anchors.path(join(effectivePath, '__babel_directory_anchor__'));
          }
          signal?.throwIfAborted();
          if (page?.after !== undefined && item.name <= page.after) continue;
          eligible++;
          let index = 0;
          while (index < entries.length && entries[index]!.name < item.name) index++;
          entries.splice(index, 0, { name: item.name, kind: item.isDirectory() ? 'dir' : 'file' });
          if (entries.length > 201) entries.pop();
        }
      } finally { directory.closeSync(); }
      const after = statSync(effectivePath);
      anchors.path(join(effectivePath, '__babel_directory_anchor__'));
      if (!validateDirectory() || after.dev !== stats.dev || after.ino !== stats.ino || revisionOf() !== revision) throw new Error('Directory changed or escaped its approved read boundary.');
      const lines = [`Directory: ${inputPath}${effectivePath === safePath ? '' : ' (shadowed)'}`, `Revision: ${revision}`];
      let delivered = 0;
      for (const entry of entries.slice(0, 200)) {
        const name = /[\x00-\x1f\x7f]/.test(entry.name) ? JSON.stringify(entry.name) : entry.name;
        const line = `${entry.kind} ${name}`;
        if (Buffer.byteLength(`${lines.join('\n')}\n${line}`, 'utf8') > 96 * 1024) break;
        lines.push(line); delivered++;
      }
      if (eligible > delivered) {
        if (!delivered) return { exit_code: 1, stdout: '', stderr: 'A directory entry exceeds the observation budget.' };
        lines.push(`Continuation: ${JSON.stringify({ after: entries[delivered - 1]!.name, revision })}`);
      }
      const listing = lines.join('\n');
      return { exit_code: 0, stdout: listing, stderr: '', directory_page: { revision, after: page?.after ?? null, next_after: eligible > delivered ? entries[delivered - 1]!.name : null } };
      } catch (err) {
        const denied = maybePolicyDeniedResult(err, 'directory_list', [inputPath]);
        if (denied) return denied;
        return { exit_code: 1, stdout: '', stderr: String(err) };
      }
      })();
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'directory_list', [inputPath]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }
  }

  fileWrite(inputPath: string, content: string, options?: { createOnly?: true }): ToolResult {
    const planDenial = this.checkPlanModeDenial('file_write');
    if (planDenial) return planDenial;
    const profileDenial = this.checkExecutionProfileToolDenial('file_write');
    if (profileDenial) return profileDenial;

    let creationEvidence: TrustedFileCreationEvidence | undefined;
    try {
      const requestedPath = this.resolveProjectPath(inputPath);
      this.ensureWithinProjectRoot(inputPath, requestedPath);
      // Check the caller's final target before resolveSafe follows an in-root alias.
      this.assertSafeWritableTarget(inputPath, requestedPath, true);
      const safePath = this.ensureWritableParentExists(inputPath, this.resolveSafe(inputPath));

      let targetPath = safePath;
      if (this.shadowRoot) {
        const relativePath = relative(this.projectRoot, safePath);
        targetPath = resolve(this.shadowRoot, relativePath);
      }

      mkdirSync(dirname(targetPath), { recursive: true });
      const dockerExtraArgs = validateDockerIsolationArgs();
      const explicitContainerIdentity = dockerExtraArgs.ok && dockerExtraArgs.args.some((arg) => {
        const normalized = arg.toLowerCase();
        return normalized === '--user' || normalized.startsWith('--user=') ||
          normalized === '--userns' || normalized.startsWith('--userns=');
      },
      );
      const dockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] ?? '';
      const immutableDockerImage = /^sha256:[a-f0-9]{64}$/i.test(dockerImage) || /@sha256:[a-f0-9]{64}$/i.test(dockerImage);
      const sandboxReadableTestEligible = process.platform === 'linux' && !this.shadowRoot && targetPath === safePath &&
        shouldUseDockerSandbox(process.env['BABEL_EXECUTION_PROFILE']) && getDockerDaemonMode() === 'rootful' &&
        immutableDockerImage && dockerExtraArgs.ok && !explicitContainerIdentity &&
        isSandboxReadableTestPath(relative(this.projectRoot, safePath));
      const runtimeIdentity = sandboxReadableTestEligible ? getDockerImageRuntimeIdentity(dockerImage) : null;
      const sandboxReadableTest = sandboxReadableTestEligible && runtimeIdentity?.uid === 0 &&
        rootfulContainerHasStableReadPath(this.projectRoot, targetPath, runtimeIdentity);
      this.writeUtf8FileSafely(inputPath, targetPath, content, targetPath === safePath, {
        ...(options?.createOnly ? { createOnly: true as const } : {}),
        ...(sandboxReadableTest ? { sandboxReadableTest: true as const } : {}),
        onCreated: evidence => { creationEvidence = evidence; },
      });
      return attachTrustedFileCreationEvidence({
        exit_code: 0,
        stdout: `Written: ${inputPath}${targetPath === safePath ? '' : ' (shadowed)'}`,
        stderr: '',
      }, creationEvidence);
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'file_write', [inputPath]);
      if (denied) return attachTrustedFileCreationEvidence(denied, creationEvidence);
      return attachTrustedFileCreationEvidence({ exit_code: 1, stdout: '', stderr: String(err) }, creationEvidence);
    }
  }

  /**
   * Delete a file inside the project root. Path must resolve within projectRoot.
   * The file is moved to a .babel-trash/ directory inside the run directory rather
   * than permanently removed, enabling rollback via checkpoint restoration.
   */
  fileDelete(inputPath: string): ToolResult {
    const planDenial = this.checkPlanModeDenial('file_delete');
    if (planDenial) return planDenial;
    const profileDenial = this.checkExecutionProfileToolDenial('file_delete');
    if (profileDenial) return profileDenial;

    try {
      const safePath = this.resolveSafe(inputPath);
      if (!existsSync(safePath)) {
        return { exit_code: 0, stdout: `Already absent: ${inputPath}`, stderr: '' };
      }
      const stat = statSync(safePath);
      if (!stat.isFile()) {
        return { exit_code: 1, stdout: '', stderr: `Not a regular file: ${inputPath}` };
      }

      // Soft-delete: move to trash directory so checkpoints can restore it
      const trashDir = resolve(this.projectRoot, '.babel-trash');
      mkdirSync(trashDir, { recursive: true });
      const trashName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${basename(inputPath)}`;
      const trashPath = resolve(trashDir, trashName);
      renameSync(safePath, trashPath);

      return {
        exit_code: 0,
        stdout: `Deleted: ${inputPath} (moved to ${trashName})`,
        stderr: '',
      };
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'file_delete', [inputPath]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }
  }

  // ── Shell execution ──────────────────────────────────────────────────────────

  private prepareShellExecution(
    command: string,
    cwd: string,
    toolName: string,
  ): PreparedShellInvocation | ToolResult {
    const planDenial = this.checkPlanModeDenial(toolName);
    if (planDenial) return planDenial;
    const profileDenial = this.checkExecutionProfileToolDenialWithTestRun(toolName);
    if (profileDenial) return profileDenial;

    const compatibilityIssue = validateExecutorShellCommand(
      command,
      process.platform,
      process.env['BABEL_EXECUTION_PROFILE'],
      { approvalQueue: true, projectRoot: this.projectRoot },
    );
    if (compatibilityIssue) {
      return policyDeniedResult(
        compatibilityIssue.reason_code,
        `[sandbox] ${compatibilityIssue.message}`,
        toolName,
        compatibilityIssue.evidence,
      );
    }

    // ── Parse argv ──────────────────────────────────────────────────────────
    let argv: string[];
    try {
      argv = parseCommandArgv(command.trim(), process.platform);
    } catch (err) {
      const message = err instanceof CommandArgvParseError ? err.message : String(err);
      return policyDeniedResult(
        'command_argv_parse_error',
        `[sandbox] ${message}.`,
        toolName,
        [command],
      );
    }
    const rawCmd = argv[0] ?? '';
    const normalizedRawCmd =
      process.platform === 'win32' ? rawCmd.replace(/^\.\//, '.\\').replace(/\//g, '\\') : rawCmd;

    // ── CWD safety ───────────────────────────────────────────────────────────
    let safeCwd: string;
    try {
      // /app describes the container's cwd, not a model-facing file alias.
      // File targets must retain their upstream policy/transaction identity.
      const canonicalCwd = cwd.trim().replace(/\\/g, '/');
      const projectCwd = /^\/app(?:\/|$)/i.test(canonicalCwd) && shouldUseDockerSandbox()
        ? `/project${canonicalCwd.slice('/app'.length)}`
        : cwd;
      safeCwd = this.resolveSafe(projectCwd);
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, toolName, [cwd]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }

    // ── Spawn (shell: false, Windows cmd.exe shim resolution) ───────────────
    // Resolve cwd with realpathSync just before spawn to close the TOCTOU
    // window between resolveSafe() and the actual process creation.
    let resolvedCwd: string;
    try {
      resolvedCwd = realpathSync(safeCwd);
      // Re-validate the realpath-resolved path against projectRoot to prevent
      // a symlink swap between resolveSafe() and realpathSync() from escaping
      // the sandbox.
      this.ensureWithinProjectRoot(cwd, resolvedCwd);
    } catch {
      // If realpath fails (e.g., directory was deleted between check and spawn),
      // fall back to the already-validated safeCwd.
      resolvedCwd = safeCwd;
    }
    const isWin = process.platform === 'win32';

    const benchmarkDockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim();
    const isolation = evaluateGovernedIsolation(
      process.env['BABEL_EXECUTION_PROFILE'],
      benchmarkDockerImage,
    );
    const useDockerSandbox =
      isolation.kind === 'docker' &&
      shouldUseDockerSandbox(process.env['BABEL_EXECUTION_PROFILE']);
    // Report the missing isolation prerequisite before resolving a tool that
    // belongs inside the container rather than on the host.
    if (isolation.kind === 'fail_closed') {
      return policyDeniedResult(
        'isolation_unavailable',
        `[sandbox] isolation_unavailable: ${isolation.reason}`,
        toolName,
        [command],
      );
    }
    let env = childEnvForSandbox();
    const resolvedExecutable = useDockerSandbox ? null : resolveCommandExecutable(rawCmd, {
      cwd: resolvedCwd,
      env,
      platform: process.platform,
      controlledRoots: commandControlledRoots(this.projectRoot, process.env['BABEL_SHADOW_ROOT']),
    });
    if (!useDockerSandbox && !resolvedExecutable) {
      return policyDeniedResult(
        'executable_resolution_failed',
        `[sandbox] Command rejected — executable could not be resolved in the child environment: "${rawCmd}"`,
        toolName,
        [rawCmd],
      );
    }
    const classified = useDockerSandbox
      ? classifyExecutionRisk(command, { repoRoot: this.projectRoot })
      : classifyResolvedCommand(resolvedExecutable!, argv.slice(1), { repoRoot: this.projectRoot, invokedBase: rawCmd });
    // Project-or-container-only commands stay denied on host profiles even
    // when the governed isolation decision resolved to a host kind — unless
    // the operator explicitly authorized a host fallback for this run. The
    // explicit escalation keeps host execution auditable instead of making it
    // the silent default for Docker-only risk classes.
    const hostFallbackAuthorized = ['1', 'true', 'yes'].includes(
      (process.env['BABEL_ALLOW_HOST_FALLBACK'] ?? '').toLowerCase(),
    );
    if (requiresDockerIsolation(classified.executionRisk) && isolation.kind !== 'docker') {
      if (!hostFallbackAuthorized) {
        return policyDeniedResult(
          'isolation_required',
          `[sandbox] isolation_required: ${classified.base || command} executes project or container-only code and is denied on the host.`,
          toolName,
          [command, classified.executionRisk],
        );
      }
      // Explicit host fallback: keep the auditable boundary visible at the
      // point of execution instead of silently honoring the env var.
      console.warn(
        `[sandbox] host fallback authorized for project-or-container-only command "${classified.base || command}" (BABEL_ALLOW_HOST_FALLBACK is set)`,
      );
    }
    if (classified.executionRisk === 'forbidden') {
      return policyDeniedResult(
        'unclassified_executable',
        `[sandbox] Command rejected — ${classified.reason ?? 'unclassified executable'}: "${command}"`,
        toolName,
        [command],
      );
    }
    if (isolation.kind === 'host_escalated' && !isolationEscalationWarningEmitted) {
      isolationEscalationWarningEmitted = true;
      emitSandboxOperatorNotice(
        `isolation boundary escalated to host for profile "${isolation.profile}" — ${isolation.reason}`,
      );
    }

    // Legacy one-time warning path (host_escalated already logged above).
    if (
      isolation.kind === 'host_escalated' &&
      !useDockerSandbox &&
      !dockerFallbackWarningEmitted &&
      process.env['BABEL_DOCKER_DISABLE'] !== 'true'
    ) {
      dockerFallbackWarningEmitted = true;
      const reason = getDockerUnavailableReason();
      if (reason) {
        emitSandboxOperatorNotice(`Docker not available — ${reason}`);
      }
    }

    // M12: Defense-in-depth shell operator check — validate the command again
    // right before spawn, even though validateExecutorShellCommand already
    // checked it earlier. This catches any code path that reaches spawn
    // without going through the normal validation chain.
    const benchmarkContainerShellSyntaxAllowed = useDockerSandbox;
    // Normalize Windows path backslashes before operator check (same as above)
    const operatorCheckCmd2 = isWin
      ? command
          .trim()
          .replace(
            /(?<=\s)([A-Za-z]:)?(?:[A-Za-z0-9_.-]+\\)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12}/g,
            (match) => match.replace(/\\/g, '/'),
          )
      : command.trim();
    if (
      SHELL_OPERATOR_RE.test(operatorCheckCmd2.normalize('NFKC')) &&
      !benchmarkContainerShellSyntaxAllowed
    ) {
      // Second-pass context-aware check (defense-in-depth M12)
      const contextCheck2 = contextAwareOperatorCheck(command, process.platform);
      if (contextCheck2.verdict !== 'explicitly_safe') {
        return policyDeniedResult(
          'shell_operator_rejected',
          `[sandbox] Command rejected — ${contextCheck2.verdict === 'confirmed_dangerous' ? contextCheck2.reason : 'shell operator detected'}: "${command}"`,
          toolName,
          [command],
        );
      }
    }

    if (classified.effectFamily === 'git') {
      env = hardenGitHostEnvironment(env);
    }

    let hostExecutable = resolvedExecutable?.path ?? normalizedRawCmd;
    let hostArgs = argv.slice(1);
    let commandShell: ResolvedCommandExecutable | undefined;
    if (isWin && !useDockerSandbox) {
      const hostSystem32 = hostWindowsSystem32Directory();
      const expectedShell = hostSystem32 ? resolve(hostSystem32, 'cmd.exe') : undefined;
      const resolvedShell = expectedShell ? resolveCommandExecutable(expectedShell, {
        cwd: resolvedCwd,
        env,
        platform: process.platform,
        controlledRoots: commandControlledRoots(this.projectRoot, env['BABEL_SHADOW_ROOT']),
      }) : null;
      if (!resolvedShell?.trusted || !hostSystem32 || !isCanonicalWindowsSystemShell(resolvedShell.path, hostSystem32)) {
        return policyDeniedResult(
          'executable_resolution_failed',
          '[sandbox] Command rejected — trusted Windows command shell could not be resolved.',
          toolName,
          ['cmd.exe'],
        );
      }
      commandShell = resolvedShell;
      hostExecutable = commandShell.path;
      hostArgs = buildWindowsCommandShellArgs([resolvedExecutable!.path, ...argv.slice(1)]);
    }

    return useDockerSandbox
      ? prepareOwnedContainerInvocation({ dockerImage: benchmarkDockerImage!, projectRoot: this.projectRoot, cwd: safeCwd, command }, env)
      : {
          executable: hostExecutable,
          args: hostArgs,
          cwd: resolvedCwd,
          env,
          validateExecutable: () =>
            isResolvedCommandCurrent(resolvedExecutable!) &&
            (commandShell === undefined || isResolvedCommandCurrent(commandShell)),
        };
  }

  /**
   * Compatibility API for synchronous callers (tests, non-REPL).
   * Chat/REPL foreground tools MUST use shellExecAsync (W0.1) so process wait
   * time does not freeze the event loop and AbortSignal can cancel.
   */
  shellExec(command: string, cwd: string, timeoutMs: number, toolName = 'shell_exec'): ToolResult {
    const prepared = this.prepareShellExecution(command, cwd, toolName);
    if ('exit_code' in prepared) return prepared;

    let transientRetryCount = 0;
    let result: SpawnSyncReturns<string>;
    while (true) {
      if (prepared.validateExecutable && !prepared.validateExecutable()) {
        return policyDeniedResult('executable_identity_changed', '[sandbox] Command rejected — executable identity changed before spawn.', toolName, [prepared.executable]);
      }
      result = spawnSync(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: MAX_SHELL_OUTPUT_BYTES,
        env: prepared.env,
        ...(process.platform === 'win32' && basename(prepared.executable).toLowerCase() === 'cmd.exe'
          ? { windowsVerbatimArguments: true }
          : {}),
      });

      if (!result.error) {
        break; // Spawn succeeded — no spawn-level error.
      }

      if (result.pid > 0 && isSpawnSyncRuntimeSupervisorError(result.error)) break;

      if (!isTransientSpawnError(result.error.message)) {
        break; // Non-transient error — fail immediately without retry.
      }

      transientRetryCount += 1;
      if (transientRetryCount > MAX_TRANSIENT_SPAWN_RETRIES) {
        break; // Retries exhausted — fall through to error handling below.
      }

      // Exponential backoff: 1 second + jitter, then 2 seconds + jitter.
      const delayMs = 1000 * Math.pow(2, transientRetryCount - 1) + Math.floor(Math.random() * 500);
      sleep(delayMs);
    }

    const processTermination = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
      ? 'timed_out' : 'terminated';
    if (prepared.ownedContainerName && (result.error || result.status !== 0)) {
      try { removeOwnedContainerSync(prepared.ownedContainerName, prepared.env, Boolean(result.error && result.pid > 0)); }
      catch (error) { return attachExecutionBackend({ exit_code: 1, stdout: result.stdout ?? '', stderr: String(error), process_started: result.pid > 0, process_termination: processTermination }, prepared); }
    }
    if (result.error) {
      if (isSpawnSyncRuntimeSupervisorError(result.error)) {
        return attachExecutionBackend({ ...normalizeSupervisorTerminatedShellOutput(
          result.status,
          result.stdout ?? '',
          result.stderr ?? '',
        ), process_started: result.pid > 0, process_termination: processTermination }, prepared);
      }
      const isTransient = transientRetryCount > 0 && isTransientSpawnError(result.error.message);
      const prefix = isTransient
        ? '[sandbox] Transient spawn error (retries exhausted):'
        : '[sandbox] Spawn error:';
      return attachExecutionBackend({
        exit_code: 1,
        stdout: '',
        stderr: `${prefix} ${result.error.message}`,
        launch_failure: { code: isTransient ? 'transient_spawn_error' : 'spawn_error' },
        process_started: result.pid > 0,
      }, prepared);
    }

    return attachExecutionBackend({ ...normalizeShellOutput(result.status, result.stdout ?? '', result.stderr ?? ''), process_started: result.pid > 0,
      process_termination: result.status === null ? 'terminated' : 'exited' }, prepared);
  }

  /**
   * W0.1 async process supervisor entry for foreground shell.
   * Cancellation via AbortSignal (ChatEngine.abortController); tree kill on abort/timeout.
   */
  async shellExecAsync(
    command: string,
    cwd: string,
    timeoutMs: number,
    toolName = 'shell_exec',
    signal?: AbortSignal,
    processContext?: Pick<ProcessWitnessInput, 'sessionId' | 'turnId' | 'toolCallId'>,
  ): Promise<ToolResult> {
    // Settle cancellation before lookup; Windows shell built-ins may be unresolvable.
    if (signal?.aborted) return cancelledBeforeSpawnShellResult();
    const prepared = this.prepareShellExecution(command, cwd, toolName);
    if ('exit_code' in prepared) return prepared;

    let transientRetryCount = 0;
    let result: AsyncSpawnResult;
    const sessionId = processContext?.sessionId ?? process.env['BABEL_SESSION_ID'];
    while (true) {
      if (prepared.validateExecutable && !prepared.validateExecutable()) {
        return policyDeniedResult('executable_identity_changed', '[sandbox] Command rejected — executable identity changed before spawn.', toolName, [prepared.executable]);
      }
      result = await spawnCommandAsync(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        timeoutMs,
        env: prepared.env,
        ...(signal ? { signal } : {}),
        ...(this.processWitness ? { processWitness: this.processWitness } : {}),
        processContext: {
          projectRoot: this.projectRoot,
          toolName,
          ...(sessionId ? { sessionId } : {}),
          ...(processContext?.turnId ? { turnId: processContext.turnId } : {}),
          ...(processContext?.toolCallId ? { toolCallId: processContext.toolCallId } : {}),
        },
      });
      if (!result.error || result.aborted || isChildRuntimeSupervisorError(result.error, result.processStarted, result.timedOut) || !isTransientSpawnError(result.error.message)) break;
      transientRetryCount += 1;
      if (transientRetryCount > MAX_TRANSIENT_SPAWN_RETRIES) break;
      const delayMs = 1000 * Math.pow(2, transientRetryCount - 1) + Math.floor(Math.random() * 500);
      if (!(await sleepAsync(delayMs, signal))) {
        result = {
          ...result,
          error: new Error(`spawn ${prepared.executable} aborted`),
          aborted: true,
        };
        break;
      }
    }

    if (prepared.ownedContainerName && (result.error || result.aborted || result.status !== 0)) {
      const cleanup = (async () => {
        let clientFailure: unknown;
        try { await result.termination; } catch (error) { clientFailure = error; }
        await removeOwnedContainer(prepared.ownedContainerName!, prepared.env,
          Boolean(result.termination || (result.error && result.processStarted)));
        if (clientFailure) throw clientFailure;
      })();
      registerPendingProcessTermination(cleanup, sessionId ?? 'unscoped', prepared.ownedContainerName);
      try { await cleanup; }
      catch (error) {
        await awaitPendingProcessTerminations(sessionId ?? 'unscoped');
        throw error;
      }
    }
    if (result.timedOut) {
      await awaitPendingProcessTerminations(sessionId ?? 'unscoped');
    }
    if (result.error) {
      if (result.aborted) {
        return attachExecutionBackend({
          exit_code: 1,
          stdout: '',
          stderr: `[sandbox] Spawn error: ${result.error.message}`,
          process_started: result.processStarted, process_termination: 'cancelled',
        }, prepared);
      }
      if (isChildRuntimeSupervisorError(result.error, result.processStarted, result.timedOut)) {
        return attachExecutionBackend({ ...normalizeSupervisorTerminatedShellOutput(
          result.status,
          result.stdout,
          result.stderr,
          result.stdoutTruncated,
          result.stderrTruncated,
        ), process_started: result.processStarted, process_termination: result.timedOut ? 'timed_out' : 'terminated' }, prepared);
      }
      const transient =
        transientRetryCount > 0 && isTransientSpawnError(result.error.message);
      return attachExecutionBackend({
        exit_code: 1,
        stdout: '',
        stderr: `${transient ? '[sandbox] Transient spawn error (retries exhausted):' : '[sandbox] Spawn error:'} ${result.error.message}`,
        launch_failure: {
          code: transient ? ('transient_spawn_error' as const) : ('spawn_error' as const),
        },
        process_started: result.processStarted,
      }, prepared);
    }
    return attachExecutionBackend({ ...normalizeShellOutput(
      result.status,
      result.stdout,
      result.stderr,
      result.stdoutTruncated,
      result.stderrTruncated,
    ), process_started: result.processStarted,
      process_termination: result.aborted ? 'cancelled' : result.timedOut ? 'timed_out' : result.status === null ? 'terminated' : 'exited' }, prepared);
  }

  /** Sugar over shellExec with a default timeout suitable for test runners. */
  testRun(command: string, cwd: string, timeoutMs: number): ToolResult {
    return this.shellExec(command, cwd, timeoutMs, 'test_run');
  }

  testRunAsync(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
    processContext?: Pick<ProcessWitnessInput, 'sessionId' | 'turnId' | 'toolCallId'>,
  ): Promise<ToolResult> {
    return this.shellExecAsync(command, cwd, timeoutMs, 'test_run', signal, processContext);
  }
}
