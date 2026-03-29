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
 *   3. Shell injection prevention: a regex blocks strings containing shell
 *      operator characters (; | & > < ` $ ( ) { } ! \).
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
         writeFileSync }                  from 'node:fs';
import {
  resolve,
  sep,
  dirname,
  basename,
  isAbsolute,
} from 'node:path';

// ─── Shared result type ───────────────────────────────────────────────────────

/** Result returned by every SafeExecutor tool method. */
export interface ToolResult {
  exit_code: number;
  stdout:    string;
  stderr:    string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

/** Commands allowed in shellExec / testRun. Checked against argv[0] basename. */
const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
  'node',
  'git',
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

// ─── SafeExecutor ─────────────────────────────────────────────────────────────

export class SafeExecutor {
  private readonly projectRoot: string;

  /**
   * @param projectRoot  Absolute path to the project root. All file I/O
   *                     must resolve to a path within this directory.
   *                     Resolved to absolute on construction.
   */
  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  // ── Path safety ─────────────────────────────────────────────────────────────

  private resolveProjectPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    const canonical = trimmed.replace(/\\/g, '/');
    const canonicalLower = canonical.toLowerCase();
    const projectPrefix = '/project';

    if (
      canonicalLower === projectPrefix ||
      canonicalLower.startsWith(`${projectPrefix}/`)
    ) {
      const rest = canonical.slice(projectPrefix.length).replace(/^\/+/, '');
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

  /**
   * Resolves `inputPath` against `projectRoot` and verifies the result stays
   * within the root. Throws a descriptive error on traversal attempts.
   */
  resolveSafe(inputPath: string): string {
    const resolved = this.resolveProjectPath(inputPath);
    // Append sep so that /foo/bar does not match /foo/barbaz.
    if (!this.isWithinProjectRoot(resolved)) {
      throw new Error(
        `[sandbox] Path traversal denied: "${inputPath}" resolves to` +
        ` "${resolved}" which is outside project root "${this.projectRoot}".`,
      );
    }
    return resolved;
  }

  // ── File operations ──────────────────────────────────────────────────────────

  fileRead(inputPath: string): ToolResult {
    try {
      const safePath = this.resolveSafe(inputPath);
      const content  = readFileSync(safePath, 'utf-8');
      return { exit_code: 0, stdout: content, stderr: '' };
    } catch (err) {
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }
  }

  fileWrite(inputPath: string, content: string): ToolResult {
    try {
      const safePath = this.resolveSafe(inputPath);
      mkdirSync(dirname(safePath), { recursive: true });
      writeFileSync(safePath, content, 'utf-8');
      return { exit_code: 0, stdout: `Written: ${safePath}`, stderr: '' };
    } catch (err) {
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
  shellExec(command: string, cwd: string, timeoutMs: number): ToolResult {
    // ── Injection guard ──────────────────────────────────────────────────────
    if (SHELL_OPERATOR_RE.test(command)) {
      return {
        exit_code: 1,
        stdout:    '',
        stderr:    `[sandbox] Command rejected — shell operator detected in: "${command}"`,
      };
    }

    // ── Parse argv ──────────────────────────────────────────────────────────
    const argv    = command.trim().split(/\s+/);
    const rawCmd  = argv[0] ?? '';

    // ── Whitelist check ──────────────────────────────────────────────────────
    // Strip .cmd / .exe suffixes that Windows appends to shims in PATH.
    const cmdBase = basename(rawCmd).replace(/\.(cmd|exe)$/i, '').toLowerCase();
    if (!ALLOWED_COMMANDS.has(cmdBase)) {
      return {
        exit_code: 1,
        stdout:    '',
        stderr:    `[sandbox] Command rejected — "${cmdBase}" is not in the allowed command list.`,
      };
    }

    // ── CWD safety ───────────────────────────────────────────────────────────
    let safeCwd: string;
    try {
      safeCwd = this.resolveSafe(cwd);
    } catch (err) {
      return { exit_code: 1, stdout: '', stderr: String(err) };
    }

    // ── Spawn (shell: false, Windows cmd.exe shim resolution) ───────────────
    const isWin     = process.platform === 'win32';
    const spawnCmd  = isWin ? 'cmd.exe' : rawCmd;
    const spawnArgs = isWin ? ['/c', rawCmd, ...argv.slice(1)] : argv.slice(1);

    // Strip API keys from the environment so spawned processes (npm, git, etc.)
    // cannot read them via process.env — they have no legitimate need for LLM keys.
    const SECRET_KEYS = new Set([
      'GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
    ]);
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !SECRET_KEYS.has(k)),
    ) as NodeJS.ProcessEnv;

    const result = spawnSync(spawnCmd, spawnArgs, {
      cwd:      safeCwd,
      timeout:  timeoutMs,
      encoding: 'utf-8',
      env:      safeEnv,
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
    return this.shellExec(command, cwd, timeoutMs);
  }
}
