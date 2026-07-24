/**
 * sandbox.ts — SafeExecutor: sandboxed tool execution for the CLI Executor stage
 *
 * Provides the four tool primitives used by localTools.ts:
 *   fileRead   — reads a file; path must resolve within projectRoot
 *   fileWrite  — writes a file; path must resolve within projectRoot
 *   shellExec  — runs a whitelisted command with shell: false
 *   testRun    — alias of shellExec with a default test-runner timeout
 *
 * Security guarantees:
 *   1. Path traversal prevention: all file paths are resolved to absolute
 *      and verified to be within (or equal to) `projectRoot` before I/O.
 *   2. Command whitelist: only a defined set of safe command names may be
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
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  writeFileSync,
  existsSync,
  realpathSync,
  openSync,
  closeSync,
  renameSync,
  constants as fsConstants,
} from 'node:fs';
import { resolve, sep, dirname, basename, isAbsolute, relative } from 'node:path';
import {
  buildBenchmarkContainerCommand,
  getDockerUnavailableReason,
  isBenchmarkProjectExecutableCommand,
  shouldUseDockerSandbox,
} from './config/benchmarkContainer.js';
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
import { contextAwareOperatorCheck } from './utils/cmdTokenizer.js';
import { sanitizePath } from './cli/constants.js';

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

export interface ToolResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  denial?: StructuredDenial;
  mcp_lifecycle?: McpLifecycle;
  checkpoint_ids?: string[];
}

export interface ShellCommandValidationIssue {
  reason_code: string;
  message: string;
  evidence: string[] | null;
  command_base: string | null;
}

export interface ShellCommandValidationOptions {
  approvalQueue?: boolean;
  projectRoot?: string | null;
}

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Hard cap on combined stdout + stderr bytes returned from shellExec.
 * Prevents runaway commands from flooding the executor context window.
 * Excess bytes are dropped and a sentinel notice is appended.
 */
const MAX_SHELL_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB

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
}

interface PreparedShellInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
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
 * Windows: taskkill /T /F. POSIX: SIGTERM process group (detached spawn).
 */
export function terminateChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid) {
    const windowsRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
    const taskkillPath = resolve(windowsRoot, 'System32', 'taskkill.exe');
    try {
      const killer = spawn(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        env: getSafeEnv(),
      });
      const fallback = () => {
        try {
          child.kill();
        } catch {
          // Best effort: the child may already have exited.
        }
      };
      killer.once('error', fallback);
      killer.once('close', (code) => {
        if (code !== 0) fallback();
      });
      return;
    } catch {
      // Fall through to direct child termination.
    }
  }

  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall through when the process group has already exited.
    }
  }

  try {
    child.kill();
  } catch {
    // Best effort: the child may already have exited.
  }
}

/** Max wait after AbortSignal before forcing promise settle (W0.1 cancel p95). */
export const PROCESS_ABORT_SETTLE_MS = 2_000;

/**
 * W0.1 Process supervisor — async spawn with AbortSignal, output caps, tree kill.
 * Used by SafeExecutor.shellExecAsync (chat/REPL foreground path).
 */
export function spawnCommandAsync(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<AsyncSpawnResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      status: 1,
      stdout: '',
      stderr: '',
      error: new Error(`spawn ${executable} aborted`),
      stdoutTruncated: false,
      stderrTruncated: false,
      aborted: true,
    });
  }

  return new Promise((resolveResult) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        // POSIX: new process group so terminateChildTree can SIGTERM -pid.
        detached: process.platform !== 'win32',
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      resolveResult({
        status: 1,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err : new Error(String(err)),
        stdoutTruncated: false,
        stderrTruncated: false,
        aborted: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    let abortSettle: NodeJS.Timeout | null = null;

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
      });
    };

    const onAbort = () => {
      aborted = true;
      terminateChildTree(child);
      // Do not wait for the full command timeout if the child never emits close.
      if (!abortSettle) {
        abortSettle = setTimeout(() => {
          finish(1, new Error(`spawn ${executable} aborted`));
        }, PROCESS_ABORT_SETTLE_MS);
        abortSettle.unref?.();
      }
    };

    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChildTree(child);
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

    child.once('error', (err) => finish(1, err));
    child.once('close', (code) => {
      if (aborted) {
        finish(code ?? 1, new Error(`spawn ${executable} aborted`));
      } else if (timedOut) {
        finish(code ?? 1, new Error(`spawn ${executable} ETIMEDOUT`));
      } else {
        finish(code);
      }
    });
  });
}

function normalizeShellOutput(
  status: number | null,
  rawStdout: string,
  rawStderr: string,
  stdoutWasTruncated = false,
  stderrWasTruncated = false,
): ToolResult {
  let stdout = rawStdout;
  let stderr = rawStderr;
  if (process.platform === 'win32') {
    stdout = stdout.replace(/\r\n/g, '\n');
    stderr = stderr.replace(/\r\n/g, '\n');
  }

  const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
  const stderrBytes = Buffer.byteLength(stderr, 'utf8');
  if (stdoutBytes > MAX_SHELL_OUTPUT_BYTES || stdoutWasTruncated) {
    stdout =
      Buffer.from(stdout, 'utf8').subarray(0, MAX_SHELL_OUTPUT_BYTES).toString('utf8') +
      `\n[sandbox] stdout truncated — output exceeded ${MAX_SHELL_OUTPUT_BYTES / (1024 * 1024)} MB cap.`;
  }
  if (stderrBytes > MAX_SHELL_OUTPUT_BYTES || stderrWasTruncated) {
    stderr =
      Buffer.from(stderr, 'utf8').subarray(0, MAX_SHELL_OUTPUT_BYTES).toString('utf8') +
      `\n[sandbox] stderr truncated — output exceeded ${MAX_SHELL_OUTPUT_BYTES / (1024 * 1024)} MB cap.`;
  }
  return { exit_code: status ?? 1, stdout, stderr };
}

/** @visibleForTesting */
export { isTransientSpawnError };

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
const ALLOWED_COMMANDS = new Set([
  'npm',
  'node',
  'git',
  'java',
  'winget',
  'gradle',
  'gradlew',
  'gradlew.bat',
  'sdkmanager',
  'sdkmanager.bat',
  'adb',
  'adb.exe',
  'python',
  'python3',
  'py',
  'pytest',
  'pip',
  'pip3',
  'deno',
  'rg',
  // Read-only content inspection commands — safe, no side effects
  'type',
  'cat',
  'echo',
  'dir',
  'ls',
  'findstr',
  'grep',
]);

/**
 * Interpreter eval flags blocked by the sandbox.
 *
 * These flags enable arbitrary inline code execution through interpreters
 * that are in the allowlist for legitimate script-file workflows.
 *
 * Blocked flags per interpreter:
 *   node:    -e, --eval, -p, --print  (inline eval/print expressions)
 *   python:  -c                        (inline code string)
 *   deno:    eval                      (inline eval subcommand)
 *
 * What is NOT blocked (by design):
 *   - Script-file execution (node build.js, python test.py, deno test)
 *   - python -m (module execution, needed for pytest/pip/etc.)
 *   - deno run (script execution, needed for deno-based projects)
 *   - pip install (package management, gated by dependency-install approval)
 *
 * This is defense-in-depth — it does not prevent code execution through
 * script files written by the LLM.  An OS-level sandbox (Docker, chroot,
 * WSL namespace) is the only complete mitigation.
 */
const INTERPRETER_EVAL_FLAGS: Record<string, Set<string>> = {
  node: new Set(['-e', '--eval', '-p', '--print']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  py: new Set(['-c']),
  deno: new Set(['eval']),
};

/**
 * Characters that indicate a shell injection attempt. If any of these appear
 * anywhere in the command string, shellExec will refuse to execute.
 *
 * On Windows, commands pass through cmd.exe /c, which interprets additional
 * metacharacters (% for variable expansion, ^ for escaping). The command is
 * NFKC-normalized before testing to prevent Unicode homoglyph bypasses
 * (e.g. full-width ＆ → ASCII &).
 */
// Phase 3c: Platform-aware shell operator pattern.
// '%' and '^' are only dangerous on Windows (cmd.exe env-var / escape).
// On POSIX they are valid filename characters and should not be rejected.
const SHELL_OPERATOR_RE =
  process.platform === 'win32' ? /[;&|><`$(){}!\\\r\n%^]/ : /[;&|><`$(){}!\\\r\n]/;
const WINDOWS_ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

function normalizeCommandBase(rawCmd: string, platform: NodeJS.Platform): string {
  const normalizedRawCmd =
    platform === 'win32' ? rawCmd.replace(/^\.\//, '.\\').replace(/\//g, '\\') : rawCmd;

  return basename(normalizedRawCmd)
    .replace(/\.(cmd|exe|bat)$/i, '')
    .toLowerCase();
}

function getEffectiveAllowedCommands(executionProfile: string | null | undefined): Set<string> {
  const allowedCommands = new Set(ALLOWED_COMMANDS);
  for (const command of getExecutionProfileCommandAdditions(executionProfile)) {
    allowedCommands.add(command);
  }
  return allowedCommands;
}

function isDependencyInstallCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, ' ');
  return (
    /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/.test(normalized) ||
    /^(?:pip|pip3)\s+install\b/.test(normalized) ||
    /^(?:python|python3|py)\s+-m\s+pip\s+install\b/.test(normalized) ||
    /^uv\s+(?:sync|pip\s+install)\b/.test(normalized) ||
    /^poetry\s+(?:install|add)\b/.test(normalized) ||
    /^composer\s+install\b/.test(normalized) ||
    /^cargo\s+install\b/.test(normalized) ||
    /^go\s+install\b/.test(normalized) ||
    /^dotnet\s+add\s+package\b/.test(normalized) ||
    /^(?:apt|apt-get|winget|brew|choco)\s+(?:install|upgrade|add)\b/.test(normalized)
  );
}

function resolveWindowsCommandShell(): string {
  const comspec = process.env['ComSpec'] ?? process.env['COMSPEC'];
  if (comspec && existsSync(comspec)) {
    return comspec;
  }

  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  const systemCmd = `${systemRoot}\\System32\\cmd.exe`;
  return existsSync(systemCmd) ? systemCmd : 'cmd.exe';
}

export function getAllowedShellCommands(
  executionProfile: string | null | undefined = process.env['BABEL_EXECUTION_PROFILE'],
): string[] {
  return [...getEffectiveAllowedCommands(executionProfile)].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function validateExecutorShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  executionProfile: string | null | undefined = process.env['BABEL_EXECUTION_PROFILE'],
  options: ShellCommandValidationOptions = {},
): ShellCommandValidationIssue | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      reason_code: 'empty_command_rejected',
      message: 'Command rejected — shell_exec/test_run command cannot be empty.',
      evidence: [command],
      command_base: null,
    };
  }

  const profile = resolveExecutionProfile(executionProfile);
  const benchmarkContainerShellSyntaxAllowed = shouldUseDockerSandbox(executionProfile);

  if (
    profile.name === 'opencalw_manager' &&
    isDependencyInstallCommand(trimmed) &&
    process.env['BABEL_ALLOW_DEPENDENCY_INSTALL'] !== 'true'
  ) {
    if (
      isDependencyInstallApproved({
        command: trimmed,
        projectRoot: options.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? null,
        executionProfile: profile.name,
      })
    ) {
      return null;
    }

    const decision = getDependencyInstallApprovalDecision({
      command: trimmed,
      projectRoot: options.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? null,
      executionProfile: profile.name,
    });
    const queued =
      options.approvalQueue === true
        ? requestDependencyInstallApproval({
            command: trimmed,
            projectRoot: options.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? null,
            executionProfile: profile.name,
          }).record
        : decision;
    const approvalHint = queued
      ? ` Approval request ${queued.id} is ${queued.status}. Approve with: babel approvals approve ${queued.id}`
      : ' Create an approval with: babel approvals request-install --command "<command>" --project-root "<project>"';

    return {
      reason_code:
        queued?.status === 'denied'
          ? 'dependency_install_approval_denied'
          : 'dependency_install_requires_approval',
      message:
        `Command rejected — dependency installation requires explicit approval under ` +
        `execution profile "opencalw_manager": "${trimmed}".${approvalHint}`,
      evidence: [command, profile.name, ...(queued ? [queued.id, queued.status] : [])],
      command_base: null,
    };
  }

  // On Windows, backslashes in file-path arguments are path separators, not
  // shell operators. Normalize them before the operator check to prevent false
  // rejections on commands like "type src\math.js" or "cat project\file.txt".
  const operatorCheckCmd =
    platform === 'win32'
      ? trimmed.replace(
          /(?<=\s)([A-Za-z]:)?(?:[A-Za-z0-9_.-]+\\)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]{1,12}/g,
          (match) => match.replace(/\\/g, '/'),
        )
      : trimmed;

  if (
    SHELL_OPERATOR_RE.test(operatorCheckCmd.normalize('NFKC')) &&
    !benchmarkContainerShellSyntaxAllowed
  ) {
    // Second-pass context-aware check for Windows cmd.exe.
    // The regex pre-check matches all operator characters; the tokenizer
    // determines if they appear in a safe context (inside quotes, caret-escaped).
    // Only the 'explicitly_safe' verdict overrides the regex rejection.
    const contextCheck = contextAwareOperatorCheck(trimmed, platform);
    if (contextCheck.verdict !== 'explicitly_safe') {
      return {
        reason_code: 'shell_operator_rejected',
        message: `Command rejected — ${contextCheck.verdict === 'confirmed_dangerous' ? contextCheck.reason : 'shell operator detected'}: "${trimmed}"`,
        evidence: [command],
        command_base: null,
      };
    }
    // Tokenizer confirmed safe — operator characters are in quoted/escaped context.
    // Re-check with the normalized path form as well.
    const contextCheckNorm = contextAwareOperatorCheck(operatorCheckCmd, platform);
    if (contextCheckNorm.verdict !== 'explicitly_safe') {
      return {
        reason_code: 'shell_operator_rejected',
        message: `Command rejected — ${contextCheckNorm.verdict === 'confirmed_dangerous' ? contextCheckNorm.reason : 'shell operator detected'}: "${trimmed}"`,
        evidence: [command],
        command_base: null,
      };
    }
  }

  // `cd|chdir|pushd <path> && <cmd>` is operator-safe on Windows, but the
  // allowlist still saw command base `cd` and rejected. Validate
  // the right-hand command only — same policy as the tokenizer prefix strip.
  const cdPrefixMatch = trimmed.match(/^\s*(cd|chdir|pushd)\s+(.+?)\s*&&\s*(.+)$/is);
  if (cdPrefixMatch) {
    const dirPath = (cdPrefixMatch[2] ?? '').trim();
    const rightCmd = (cdPrefixMatch[3] ?? '').trim();
    if (dirPath.length > 0 && rightCmd.length > 0) {
      return validateExecutorShellCommand(rightCmd, platform, executionProfile, options);
    }
  }

  const argv = trimmed.split(/\s+/);
  const rawCmd = argv[0] ?? '';

  if (platform === 'win32' && WINDOWS_ENV_PREFIX_RE.test(rawCmd)) {
    return {
      reason_code: 'windows_env_prefix_unsupported',
      message:
        `Command rejected — Windows executor does not support POSIX env-prefix syntax ` +
        `like "${rawCmd}".`,
      evidence: [command, rawCmd],
      command_base: null,
    };
  }

  const cmdBase = normalizeCommandBase(rawCmd, platform);
  const benchmarkProjectExecutableAllowed =
    profile.name === 'benchmark_container' && isBenchmarkProjectExecutableCommand(rawCmd);

  if (platform === 'win32' && cmdBase === 'mkdir') {
    return {
      reason_code: 'command_allowlist_rejected',
      message:
        'Command rejected — "mkdir" is not in the allowed command list. ' +
        'Use file_write directly because it creates parent directories automatically.',
      evidence: [command, cmdBase],
      command_base: cmdBase,
    };
  }

  if (platform === 'win32' && cmdBase === 'chmod' && profile.name !== 'benchmark_container') {
    return {
      reason_code: 'command_allowlist_rejected',
      message:
        'Command rejected — "chmod" is not supported by the Windows executor. ' +
        'Do not plan POSIX permission commands on Windows.',
      evidence: [command, cmdBase],
      command_base: cmdBase,
    };
  }

  const allowedCommands = getEffectiveAllowedCommands(executionProfile);
  if (!allowedCommands.has(cmdBase) && !benchmarkProjectExecutableAllowed) {
    return {
      reason_code: 'command_allowlist_rejected',
      message: `Command rejected — "${cmdBase}" is not in the allowed command list for execution profile "${profile.name}".`,
      evidence: [command, cmdBase, profile.name],
      command_base: cmdBase,
    };
  }

  // Allow interpreter eval flags (-c, -e) when explicitly enabled
  // (e.g., SWE-bench verification needs python -c for quick test scripts).
  // This is opt-in: the benchmark harness sets BABEL_ALLOW_INTERPRETER_EVAL=1.
  const allowInterpreterEval =
    process.env['BABEL_ALLOW_INTERPRETER_EVAL'] === '1' ||
    process.env['BABEL_ALLOW_INTERPRETER_EVAL'] === 'true';

  // Block dangerous interpreter flags that enable arbitrary inline code
  // execution. This is defense-in-depth: the allowlist gates which commands
  // can run, but allowed interpreters (node, python, deno) provide their own
  // code-execution surfaces via eval flags.  Blocking those flags here
  // raises the bar without preventing legitimate script-file execution.
  const blockedFlags = INTERPRETER_EVAL_FLAGS[cmdBase];
  if (blockedFlags && !allowInterpreterEval) {
    for (const arg of argv.slice(1)) {
      const flagRoot = arg.split('=')[0];
      if (flagRoot && blockedFlags.has(flagRoot)) {
        return {
          reason_code: 'interpreter_eval_rejected',
          message:
            `[sandbox] Command rejected — dangerous interpreter flag "${flagRoot}" is blocked for "${cmdBase}". ` +
            `Use a script file within the project root instead of inline code execution.`,
          evidence: [command, arg],
          command_base: cmdBase,
        };
      }
    }
  }

  return null;
}

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

  return null;
}

// ─── SafeExecutor ─────────────────────────────────────────────────────────────

export type ExecutorMode = 'plan' | 'act';

export class SafeExecutor {
  private readonly projectRoot: string;
  private readonly shadowRoot: string | null;
  private readonly mode: ExecutorMode;
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
  constructor(projectRoot: string, shadowRoot: string | null = null, mode: ExecutorMode = 'act') {
    this.mode = mode;
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
      this.approvedReadRoots = rootsSource.split(',').map((r) => {
        const p = r.trim();
        return existsSync(p) ? realpathSync(p) : resolve(p);
      });
    } else {
      // Default: the workspace parent (one level above projectRoot), capped at /tmp
      const defaultReadRoot =
        process.platform === 'win32' ? '/tmp' : (process.env['HOME'] ?? '/');
      this.approvedReadRoots = [
        existsSync(defaultReadRoot) ? realpathSync(defaultReadRoot) : resolve(defaultReadRoot),
      ];
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
    if (!existsSync(targetPath)) {
      return;
    }

    const stats = lstatSync(targetPath);
    if (stats.isSymbolicLink()) {
      const symlinkTarget = realpathSync(targetPath);
      throw new Error(
        `[sandbox] Symlink traversal denied: "${inputPath}" targets symlink ` +
          `"${targetPath}" → "${symlinkTarget}" during final file write.`,
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
  ): void {
    this.assertSafeWritableTarget(inputPath, targetPath, enforceProjectRoot);

    const noFollowFlag = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const baseFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC;

    let fd: number;
    try {
      fd = openSync(targetPath, baseFlags | noFollowFlag, 0o666);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (noFollowFlag !== 0 && (code === 'EINVAL' || code === 'UNKNOWN' || code === 'ENOSYS')) {
        fd = openSync(targetPath, baseFlags, 0o666);
      } else {
        throw error;
      }
    }

    try {
      this.assertSafeWritableTarget(inputPath, targetPath, enforceProjectRoot);
      writeFileSync(fd, content, 'utf-8');
    } finally {
      closeSync(fd);
    }
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

  fileRead(inputPath: string, options?: { offset?: number; limit?: number }): ToolResult {
    try {
      const safePath = this.resolveSafeRead(inputPath);

      // Shadow Read-Through
      if (this.shadowRoot) {
        const relativePath = relative(this.projectRoot, safePath);
        const shadowPath = resolve(this.shadowRoot, relativePath);
        if (existsSync(shadowPath)) {
          const stats = statSync(shadowPath);
          if (!stats.isDirectory()) {
            const content = readFileSync(shadowPath, 'utf-8');
            return this.formatFileContent(content, options);
          }
        }
      }

      const stats = statSync(safePath);
      if (stats.isDirectory()) {
        const entries = readdirSync(safePath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
        const listing = [`Directory: ${safePath}`, ...entries].join('\n');
        return { exit_code: 0, stdout: listing, stderr: '' };
      }
      const content = readFileSync(safePath, 'utf-8');
      return this.formatFileContent(content, options);
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
    options?: { offset?: number; limit?: number },
  ): ToolResult {
    const MAX_BYTES = 100 * 1024;
    const totalBytes = Buffer.byteLength(content, 'utf-8');

    // Safety cap: truncate to 100 KB at the nearest newline boundary
    let truncatedContent = content;
    let capMessage = '';
    if (totalBytes > MAX_BYTES) {
      const buf = Buffer.from(content, 'utf-8');
      truncatedContent = buf.subarray(0, MAX_BYTES).toString('utf-8');
      // Find the last newline within the first 100 KB to avoid cutting mid-line
      const lastNewline = truncatedContent.lastIndexOf('\n');
      if (lastNewline > 0) {
        truncatedContent = truncatedContent.substring(0, lastNewline);
      }
      capMessage = ` [truncated at ${MAX_BYTES / 1024} KB]`;
    }

    // Split into lines; remove the trailing empty element from a final \n
    const allLines = truncatedContent.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    const totalLines = allLines.length;
    const startLine = options?.offset ?? 1;
    const maxLines = options?.limit ?? 200;

    const startIndex = Math.max(0, Math.min(startLine - 1, totalLines));
    const selectedLines = allLines.slice(startIndex, startIndex + maxLines);
    const endLine = startIndex + selectedLines.length;

    if (selectedLines.length === 0) {
      if (totalLines === 0) {
        return { exit_code: 0, stdout: '', stderr: '' };
      }
      return {
        exit_code: 0,
        stdout: `[File has ${totalLines} lines; lines ${startLine}–${startLine + maxLines - 1} are out of range]`,
        stderr: '',
      };
    }

    // Build line-numbered output
    const lineNumberWidth = String(endLine).length;
    const resultLines = selectedLines.map((line, i) => {
      const lineNum = String(startIndex + i + 1).padStart(lineNumberWidth);
      return `${lineNum}│${line}`;
    });

    // Build header when the view is truncated
    const headerParts: string[] = [];
    if (endLine < totalLines || startLine > 1) {
      headerParts.push(
        `[Showing lines ${startLine}-${endLine} of ${totalLines}${capMessage} — use offset/limit to see more]`,
      );
    } else if (capMessage) {
      headerParts.push(
        `[Showing lines 1-${totalLines}${capMessage} — use offset/limit to see more]`,
      );
    }

    return {
      exit_code: 0,
      stdout: [...headerParts, ...resultLines].join('\n'),
      stderr: '',
    };
  }

  listDirectory(inputPath: string): ToolResult {
    try {
      const safePath = this.resolveSafeRead(inputPath);

      // Shadow Read-Through (for directories, we might want to merge, but for now simple swap)
      let effectivePath = safePath;
      if (this.shadowRoot) {
        const relativePath = relative(this.projectRoot, safePath);
        const shadowPath = resolve(this.shadowRoot, relativePath);
        if (existsSync(shadowPath) && statSync(shadowPath).isDirectory()) {
          effectivePath = shadowPath;
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
      const entries = readdirSync(effectivePath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
      const listing = [
        `Directory: ${inputPath}${effectivePath === safePath ? '' : ' (shadowed)'}`,
        ...entries,
      ].join('\n');
      return { exit_code: 0, stdout: listing, stderr: '' };
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'directory_list', [inputPath]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }
  }

  fileWrite(inputPath: string, content: string): ToolResult {
    const planDenial = this.checkPlanModeDenial('file_write');
    if (planDenial) return planDenial;
    const profileDenial = this.checkExecutionProfileToolDenial('file_write');
    if (profileDenial) return profileDenial;

    try {
      const safePath = this.ensureWritableParentExists(inputPath, this.resolveSafe(inputPath));

      let targetPath = safePath;
      if (this.shadowRoot) {
        const relativePath = relative(this.projectRoot, safePath);
        targetPath = resolve(this.shadowRoot, relativePath);
      }

      mkdirSync(dirname(targetPath), { recursive: true });
      this.writeUtf8FileSafely(inputPath, targetPath, content, targetPath === safePath);
      return {
        exit_code: 0,
        stdout: `Written: ${inputPath}${targetPath === safePath ? '' : ' (shadowed)'}`,
        stderr: '',
      };
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'file_write', [inputPath]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
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
    const argv = command.trim().split(/\s+/);
    const rawCmd = argv[0] ?? '';
    const normalizedRawCmd =
      process.platform === 'win32' ? rawCmd.replace(/^\.\//, '.\\').replace(/\//g, '\\') : rawCmd;

    // ── CWD safety ───────────────────────────────────────────────────────────
    let safeCwd: string;
    try {
      safeCwd = this.resolveSafe(cwd);
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
    const spawnCmd = isWin ? resolveWindowsCommandShell() : normalizedRawCmd;
    const spawnArgs = isWin ? ['/c', normalizedRawCmd, ...argv.slice(1)] : argv.slice(1);

    const benchmarkDockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim();
    const useDockerSandbox = shouldUseDockerSandbox(process.env['BABEL_EXECUTION_PROFILE']);
    const containerCommand = useDockerSandbox
      ? buildBenchmarkContainerCommand({
          dockerImage: benchmarkDockerImage!,
          projectRoot: this.projectRoot,
          cwd: safeCwd,
          command,
        })
      : null;

    // H4: One-time warning when Docker sandbox is configured but unavailable
    if (!containerCommand && !dockerFallbackWarningEmitted) {
      const profile = resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']);
      if (profile.dockerSandbox) {
        if (process.env['BABEL_DOCKER_DISABLE'] === 'true') {
          // Docker explicitly disabled — no warning needed
        } else {
          dockerFallbackWarningEmitted = true;
          const reason = getDockerUnavailableReason();
          const fallbackMsg = reason
            ? `[sandbox] Docker not available — ${reason}`
            : `[sandbox] Docker not available — no Docker image configured for profile "${profile.name}".`;
          console.error(fallbackMsg);
        }
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

    return containerCommand
      ? {
          executable: containerCommand.executable,
          args: containerCommand.args,
          cwd: this.projectRoot,
          env: getSafeEnv(),
        }
      : { executable: spawnCmd, args: spawnArgs, cwd: resolvedCwd, env: getSafeEnv() };
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
      result = spawnSync(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: MAX_SHELL_OUTPUT_BYTES,
        env: prepared.env,
      });

      if (!result.error) {
        break; // Spawn succeeded — no spawn-level error.
      }

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

    if (result.error) {
      const isTransient = transientRetryCount > 0 && isTransientSpawnError(result.error.message);
      const prefix = isTransient
        ? '[sandbox] Transient spawn error (retries exhausted):'
        : '[sandbox] Spawn error:';
      return {
        exit_code: 1,
        stdout: '',
        stderr: `${prefix} ${result.error.message}`,
      };
    }

    return normalizeShellOutput(result.status, result.stdout ?? '', result.stderr ?? '');
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
  ): Promise<ToolResult> {
    const prepared = this.prepareShellExecution(command, cwd, toolName);
    if ('exit_code' in prepared) return prepared;

    let transientRetryCount = 0;
    let result: AsyncSpawnResult;
    while (true) {
      result = await spawnCommandAsync(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        timeoutMs,
        env: prepared.env,
        ...(signal ? { signal } : {}),
      });
      if (!result.error || result.aborted || !isTransientSpawnError(result.error.message)) break;
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

    if (result.error) {
      const transient =
        !result.aborted && transientRetryCount > 0 && isTransientSpawnError(result.error.message);
      return {
        exit_code: 1,
        stdout: '',
        stderr: `${transient ? '[sandbox] Transient spawn error (retries exhausted):' : '[sandbox] Spawn error:'} ${result.error.message}`,
      };
    }
    return normalizeShellOutput(
      result.status,
      result.stdout,
      result.stderr,
      result.stdoutTruncated,
      result.stderrTruncated,
    );
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
  ): Promise<ToolResult> {
    return this.shellExecAsync(command, cwd, timeoutMs, 'test_run', signal);
  }
}
