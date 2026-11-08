import { basename } from 'node:path';
import { isBenchmarkProjectExecutableCommand, shouldUseDockerSandbox } from './config/benchmarkContainer.js';
import { getExecutionProfileCommandAdditions, isToolAllowedForExecutionProfile, resolveExecutionProfile } from './config/executionProfiles.js';
import { getDependencyInstallApprovalDecision, isDependencyInstallApproved, requestDependencyInstallApproval } from './services/approvalQueue.js';
import { contextAwareOperatorCheck } from './utils/cmdTokenizer.js';
import { CommandArgvParseError, parseCommandArgv } from './utils/commandArgv.js';
import { classifyExecutionRisk } from './authority/commandSpec.js';

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

export const ALLOWED_COMMANDS = new Set([
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
export const SHELL_OPERATOR_RE =
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
    profile.name === 'workspace_manager' &&
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
        `execution profile "workspace_manager": "${trimmed}".${approvalHint}`,
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

  let argv: string[];
  try {
    argv = parseCommandArgv(trimmed, platform);
  } catch (err) {
    const message = err instanceof CommandArgvParseError ? err.message : String(err);
    return {
      reason_code: 'command_argv_parse_error',
      message: `Command rejected — ${message}.`,
      evidence: [command],
      command_base: null,
    };
  }
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

  const classificationRoot = options.projectRoot ?? process.env['BABEL_PROJECT_ROOT'] ?? '';
  const classified = classifyExecutionRisk(
    trimmed,
    classificationRoot ? { repoRoot: classificationRoot } : {},
  );
  if (classified.executionRisk === 'forbidden') {
    return {
      reason_code: 'unclassified_executable',
      message: `Command rejected — ${classified.reason ?? 'unclassified executable'}: "${trimmed}"`,
      evidence: [command],
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
