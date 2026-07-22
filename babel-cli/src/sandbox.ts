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

import { spawnSync }                      from 'node:child_process';
import { mkdirSync, readFileSync,
         readdirSync, statSync, lstatSync,
         writeFileSync, existsSync, realpathSync, openSync, closeSync, constants as fsConstants }                  from 'node:fs';
import {
  resolve,
  sep,
  dirname,
  basename,
  isAbsolute,
  relative,
} from 'node:path';
import {
  buildBenchmarkContainerCommand,
  isBenchmarkProjectExecutableCommand,
  shouldUseBenchmarkContainerExecution,
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
  phase: 'server_lookup' | 'spawn' | 'write_request' | 'await_response' | 'response_parse' | 'complete';
  outcome: 'success' | 'failure';
  reason_code: string | null;
  server: string;
  evidence: string[] | null;
}

export interface ToolResult {
  exit_code: number;
  stdout:    string;
  stderr:    string;
  denial?:   StructuredDenial;
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

/** Commands allowed in shellExec / testRun. Checked against argv[0] basename. */
const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
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
]);

/**
 * Characters that indicate a shell injection attempt. If any of these appear
 * anywhere in the command string, shellExec will refuse to execute.
 */
const SHELL_OPERATOR_RE = /[;&|><`$(){}!\\\r\n]/;
const WINDOWS_ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

function normalizeCommandBase(rawCmd: string, platform: NodeJS.Platform): string {
  const normalizedRawCmd = platform === 'win32'
    ? rawCmd
        .replace(/^\.\//, '.\\')
        .replace(/\//g, '\\')
    : rawCmd;

  return basename(normalizedRawCmd).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();
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
  return /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/.test(normalized) ||
    /^(?:pip|pip3)\s+install\b/.test(normalized) ||
    /^(?:python|python3|py)\s+-m\s+pip\s+install\b/.test(normalized) ||
    /^uv\s+(?:sync|pip\s+install)\b/.test(normalized) ||
    /^poetry\s+(?:install|add)\b/.test(normalized) ||
    /^composer\s+install\b/.test(normalized) ||
    /^cargo\s+install\b/.test(normalized) ||
    /^go\s+install\b/.test(normalized) ||
    /^dotnet\s+add\s+package\b/.test(normalized) ||
    /^(?:apt|apt-get|winget|brew|choco)\s+(?:install|upgrade|add)\b/.test(normalized);
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
  return [...getEffectiveAllowedCommands(executionProfile)].sort((left, right) => left.localeCompare(right));
}

export function validateExecutorShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  executionProfile: string | null | undefined = process.env['BABEL_EXECUTION_PROFILE'],
  benchmarkDockerImage: string | null | undefined = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'],
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
  const benchmarkContainerShellSyntaxAllowed = shouldUseBenchmarkContainerExecution(
    profile.name,
    benchmarkDockerImage,
  );

  if (
    profile.name === 'workspace_manager' &&
    isDependencyInstallCommand(trimmed) &&
    process.env['BABEL_ALLOW_DEPENDENCY_INSTALL'] !== 'true'
  ) {
    if (isDependencyInstallApproved({
      command: trimmed,
      projectRoot: options.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? null,
      executionProfile: profile.name,
    })) {
      return null;
    }

    const decision = getDependencyInstallApprovalDecision({
      command: trimmed,
      projectRoot: options.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? null,
      executionProfile: profile.name,
    });
    const queued = options.approvalQueue === true
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
      reason_code: queued?.status === 'denied'
        ? 'dependency_install_approval_denied'
        : 'dependency_install_requires_approval',
      message:
        `Command rejected — dependency installation requires explicit approval under ` +
        `execution profile "workspace_manager": "${trimmed}".${approvalHint}`,
      evidence: [command, profile.name, ...(queued ? [queued.id, queued.status] : [])],
      command_base: null,
    };
  }

  if (SHELL_OPERATOR_RE.test(trimmed) && !benchmarkContainerShellSyntaxAllowed) {
    return {
      reason_code: 'shell_operator_rejected',
      message: `Command rejected — shell operator detected in: "${trimmed}"`,
      evidence: [command],
      command_base: null,
    };
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
    profile.name === 'benchmark_container' &&
    isBenchmarkProjectExecutableCommand(rawCmd);

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
   * @param projectRoot  Absolute path to the project root. All file I/O
   *                     must resolve to a path within this directory.
   *                     Resolved to absolute on construction.
   * @param mode         Current operational mode ('plan' | 'act').
   */
  constructor(projectRoot: string, shadowRoot: string | null = null, mode: ExecutorMode = 'act') {
    this.mode = mode;
    const resolvedRoot = existsSync(projectRoot) ? realpathSync(projectRoot) : resolve(projectRoot);
    this.shadowRoot = shadowRoot && existsSync(shadowRoot) ? realpathSync(shadowRoot) : (shadowRoot ? resolve(shadowRoot) : null);
    const allowedRootsRaw = process.env['BABEL_ALLOWED_ROOTS']?.trim();
    const isProduction = process.env['BABEL_ENV'] === 'production';

    if (isProduction && !allowedRootsRaw) {
      throw new Error(
        '[sandbox] Security Violation: BABEL_ALLOWED_ROOTS is mandatory when BABEL_ENV=production. ' +
        'Please define authorized project roots to continue.'
      );
    }

    if (allowedRootsRaw) {
      const allowedRoots = allowedRootsRaw.split(',').map(r => {
        const p = r.trim();
        return existsSync(p) ? realpathSync(p) : resolve(p);
      });
      const isAllowed = allowedRoots.some(allowed => {
        if (process.platform === 'win32') {
          const rootNorm = resolvedRoot.toLowerCase();
          const allowedNorm = allowed.toLowerCase();
          return rootNorm === allowedNorm || rootNorm.startsWith(allowedNorm + sep);
        }
        return resolvedRoot === allowed || resolvedRoot.startsWith(allowed + sep);
      });

      if (!isAllowed) {
        throw new Error(
          `[sandbox] Project root "${resolvedRoot}" is not within any authorized paths (BABEL_ALLOWED_ROOTS).`
        );
      }
    }
    this.projectRoot = resolvedRoot;
  }

  // ── Path safety ─────────────────────────────────────────────────────────────

  private resolveProjectPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    const canonical = trimmed.replace(/\\/g, '/');
    const canonicalLower = canonical.toLowerCase();
    const projectPrefix = '/project';
    const appPrefix = '/app';

    if (
      canonicalLower === projectPrefix ||
      canonicalLower.startsWith(`${projectPrefix}/`)
    ) {
      const rest = canonical.slice(projectPrefix.length).replace(/^\/+/, '');
      return resolve(this.projectRoot, rest);
    }

    const profile = resolveExecutionProfile(process.env['BABEL_EXECUTION_PROFILE']);
    if (
      profile.name === 'benchmark_container' &&
      (canonicalLower === appPrefix || canonicalLower.startsWith(`${appPrefix}/`))
    ) {
      const rest = canonical.slice(appPrefix.length).replace(/^\/+/, '');
      return resolve(this.projectRoot, rest);
    }

    if (isAbsolute(trimmed)) {
      return resolve(trimmed);
    }

    return resolve(this.projectRoot, trimmed);
  }

  private isWithinProjectRoot(candidatePath: string): boolean {
    const root = this.projectRoot;
    const target = candidatePath;

    if (process.platform === 'win32') {
      const rootNorm = root.toLowerCase();
      const targetNorm = target.toLowerCase();
      return (
        targetNorm === rootNorm ||
        targetNorm.startsWith(rootNorm + sep)
      );
    }

    return (
      target === root ||
      target.startsWith(root + sep)
    );
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

    const segments = relativeToRoot
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0);

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

    return this.resolveSafe(inputPath);
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

    const noFollowFlag = typeof fsConstants.O_NOFOLLOW === 'number'
      ? fsConstants.O_NOFOLLOW
      : 0;
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
   * Returns a denial result if the executor is in 'plan' mode and a mutating
   * tool was called.
   */
  private checkPlanModeDenial(tool: string): ToolResult | null {
    if (this.mode !== 'plan') {
      return null;
    }

    const message = `[sandbox] Planning Restricted: Cannot execute mutating tool "${tool}" while in Plan Mode. ` +
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

  // ── File operations ──────────────────────────────────────────────────────────

  fileRead(inputPath: string): ToolResult {
    try {
      const safePath = this.resolveSafe(inputPath);

      // Shadow Read-Through
      if (this.shadowRoot) {
        const relativePath = relative(this.projectRoot, safePath);
        const shadowPath = resolve(this.shadowRoot, relativePath);
        if (existsSync(shadowPath)) {
          const stats = statSync(shadowPath);
          if (!stats.isDirectory()) {
            const content = readFileSync(shadowPath, 'utf-8');
            return { exit_code: 0, stdout: content, stderr: '' };
          }
        }
      }

      const stats = statSync(safePath);
      if (stats.isDirectory()) {
        const entries = readdirSync(safePath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
        const listing = [
          `Directory: ${safePath}`,
          ...entries,
        ].join('\n');
        return { exit_code: 0, stdout: listing, stderr: '' };
      }
      const content  = readFileSync(safePath, 'utf-8');
      return { exit_code: 0, stdout: content, stderr: '' };
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'file_read', [inputPath]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }
  }

  listDirectory(inputPath: string): ToolResult {
    try {
      const safePath = this.resolveSafe(inputPath);

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
        stderr: ''
      };
    } catch (err) {
      const denied = maybePolicyDeniedResult(err, 'file_write', [inputPath]);
      if (denied) return denied;
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }
  }

  // ── Shell execution ──────────────────────────────────────────────────────────

  /**
   * Executes a whitelisted shell command with `shell: false`.
   *
   * @param command    Full command string, e.g. "npm test" or "python -m pytest".
   * @param cwd        Working directory — must resolve within projectRoot.
   * @param timeoutMs  Hard kill timeout in milliseconds.
   */
  shellExec(
    command: string,
    cwd: string,
    timeoutMs: number,
    toolName = 'shell_exec',
  ): ToolResult {
    const planDenial = this.checkPlanModeDenial(toolName);
    if (planDenial) return planDenial;
    const profileDenial = this.checkExecutionProfileToolDenial(toolName);
    if (profileDenial) return profileDenial;

    const compatibilityIssue = validateExecutorShellCommand(
      command,
      process.platform,
      process.env['BABEL_EXECUTION_PROFILE'],
      process.env['BABEL_BENCHMARK_DOCKER_IMAGE'],
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
    const argv    = command.trim().split(/\s+/);
    const rawCmd  = argv[0] ?? '';
    const normalizedRawCmd = process.platform === 'win32'
      ? rawCmd
          .replace(/^\.\//, '.\\')
          .replace(/\//g, '\\')
      : rawCmd;

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
    const isWin     = process.platform === 'win32';
    const spawnCmd  = isWin ? resolveWindowsCommandShell() : normalizedRawCmd;
    const spawnArgs = isWin ? ['/c', normalizedRawCmd, ...argv.slice(1)] : argv.slice(1);

    const benchmarkDockerImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim();
    const containerCommand = shouldUseBenchmarkContainerExecution(
      process.env['BABEL_EXECUTION_PROFILE'],
      benchmarkDockerImage,
    )
      ? buildBenchmarkContainerCommand({
          dockerImage: benchmarkDockerImage!,
          projectRoot: this.projectRoot,
          cwd: safeCwd,
          command,
        })
      : null;

    const result = containerCommand
      ? spawnSync(containerCommand.executable, containerCommand.args, {
          cwd:      this.projectRoot,
          timeout:  timeoutMs,
          encoding: 'utf-8',
          env:      getSafeEnv(),
        })
      : spawnSync(spawnCmd, spawnArgs, {
      cwd:      safeCwd,
      timeout:  timeoutMs,
      encoding: 'utf-8',
      env:      getSafeEnv(),
      // No `shell` option — cmd.exe handles PATH resolution on Windows.
    });

    if (result.error) {
      return {
        exit_code: 1,
        stdout:    '',
        stderr:    `[sandbox] Spawn error: ${result.error.message}`,
      };
    }

    return {
      exit_code: result.status ?? 1,
      stdout:    result.stdout ?? '',
      stderr:    result.stderr ?? '',
    };
  }

  /** Sugar over shellExec with a default timeout suitable for test runners. */
  testRun(command: string, cwd: string, timeoutMs: number): ToolResult {
    return this.shellExec(command, cwd, timeoutMs, 'test_run');
  }
}
