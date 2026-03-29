/**
 * cliBase.ts — Shared CLI Process Runner
 *
 * Provides the common spawn, output-capture, JSON-extraction, and Zod-validation
 * logic used by all three CLI runners (Claude, Codex, Gemini). Each runner
 * supplies a `CliConfig`; this module does all the work.
 *
 * Windows deprecation fix:
 *   Passing an args array with `shell: true` triggers Node's DeprecationWarning
 *   DEP0190. Instead of shell mode, we spawn cmd.exe directly on Windows so
 *   .cmd shims in PATH resolve correctly, while keeping the args array clean.
 */

import { spawn }        from 'node:child_process';
import type { ZodType, ZodTypeDef } from 'zod';
import { extractJson }  from '../utils/extractJson.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CliConfig {
  /** Short label used in error messages and debug output, e.g. "claudeCli". */
  label:     string;
  /** Executable name, e.g. "claude", "codex", "gemini". */
  command:   string;
  /** Flags to pass after the command, e.g. ["--print"]. */
  args:      string[];
  /** Hard timeout in milliseconds before the child process is killed. */
  timeoutMs: number;
  /**
   * When set, the prompt is appended as `[promptFlag, prompt]` to the args
   * array instead of being written to stdin. Use for CLIs like Codex that
   * accept the prompt via a named flag (e.g. `-p "<prompt>"`).
   * Leave unset to use stdin (default for Claude, Gemini, etc.).
   */
  promptFlag?: string;
  /**
   * Controls the stdin file descriptor passed to the child process.
   *   'pipe'   — (default) pipe stdin; used by Gemini/Claude stdin-mode runners.
   *   'ignore' — detach stdin entirely; used by Codex and Claude to prevent the
   *              CLI from opening a TTY for interactive approval prompts even
   *              when --full-auto / --print flags are set.
   */
  stdinMode?: 'pipe' | 'ignore';
}

/** Raw captured output from a CLI run. */
export interface CliOutput {
  stdout: string;
  stderr: string;
}

// ─── CliParseError ────────────────────────────────────────────────────────────

/**
 * Thrown by `parseAndValidate` when the CLI output cannot be parsed as JSON or
 * fails Zod validation. Carries the raw stdout/stderr so `execute.ts` can write
 * them to the Evidence Bundle for debugging.
 */
export class CliParseError extends Error {
  readonly rawStdout: string;
  readonly rawStderr: string;
  readonly zodError:  unknown;

  constructor(
    message:   string,
    stdout:    string,
    stderr:    string,
    zodError?: unknown,
  ) {
    super(message);
    this.name      = 'CliParseError';
    this.rawStdout = stdout;
    this.rawStderr = stderr;
    this.zodError  = zodError;
  }
}

// ─── Rate-limit detection ─────────────────────────────────────────────────────

const RATE_LIMIT_SIGNALS = [
  'rate limit',
  'rate_limit',
  'quota exceeded',
  'too many requests',
  '429',
] as const;

function containsRateLimitSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_SIGNALS.some(s => lower.includes(s));
}

// ─── Windows-safe spawn ───────────────────────────────────────────────────────

/**
 * Spawns a CLI process and captures stdout/stderr.
 *
 * On Windows, we spawn `cmd.exe /c <command> [...args]` without `shell: true`
 * so that .cmd shims in PATH resolve correctly without triggering Node's
 * DEP0190 DeprecationWarning ("Passing args to a child process with shell
 * option true").
 *
 * On POSIX, we spawn the command directly with no shell at all.
 */
export function spawnCliProcess(prompt: string, config: CliConfig): Promise<CliOutput> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';

    // Prompt delivery modes:
    //   promptFlag === undefined  → stdin (default: Claude, etc.)
    //   promptFlag === ''         → positional arg appended bare (codex exec)
    //   promptFlag === '-p' etc.  → flag+value pair appended (Gemini, etc.)
    const trailingArgs =
      config.promptFlag === undefined ? [] :
      config.promptFlag === ''        ? [prompt] :
                                        [config.promptFlag, prompt];
    const cliArgs = [...config.args, ...trailingArgs];

    const cmd  = isWin ? 'cmd.exe' : config.command;
    const args = isWin ? ['/c', config.command, ...cliArgs] : cliArgs;

    const stdinFd = config.stdinMode === 'ignore' ? 'ignore' : 'pipe';

    const proc = spawn(cmd, args, {
      stdio: [stdinFd, 'pipe', 'pipe'],
      env:   process.env,
      // No `shell` option — cmd.exe handles PATH resolution on Windows.
    });

    let stdout = '';
    let stderr = '';

    // ── Activity tracking ─────────────────────────────────────────────────────
    // Records the last time stdout or stderr produced bytes. Used to distinguish
    // an "active timeout" (process was generating output, just too slow) from a
    // "silent hang" (no bytes received for a long time — more likely a true lock-up).
    const startTime     = Date.now();
    let lastActivityAt  = startTime;
    let bytesStdout     = 0;
    let bytesStderr     = 0;

    // Heartbeat: every 15 s, log a one-liner so the user can see Codex is alive.
    const HEARTBEAT_INTERVAL_MS = 15_000;
    const heartbeat = setInterval(() => {
      const elapsedS = Math.round((Date.now() - startTime)      / 1000);
      const idleS    = Math.round((Date.now() - lastActivityAt) / 1000);
      process.stderr.write(
        `[${config.label}] running — ${bytesStdout}b stdout  ${bytesStderr}b stderr  ` +
        `${elapsedS}s elapsed  ${idleS}s since last output\n`,
      );
    }, HEARTBEAT_INTERVAL_MS);

    const timer = setTimeout(() => {
      clearInterval(heartbeat);
      proc.kill('SIGTERM');
      const elapsedS = Math.round((Date.now() - startTime)      / 1000);
      const idleS    = Math.round((Date.now() - lastActivityAt) / 1000);
      // Classify: "active" if output arrived in the last 30 s; "silent" otherwise.
      const classification = idleS < 30
        ? `ACTIVE (last byte ${idleS}s ago — process was running; consider raising BABEL_CODEX_TIMEOUT_MS or BABEL_CLI_TIMEOUT_MS)`
        : `SILENT (no output for ${idleS}s — likely a true hang)`;
      reject(new Error(
        `[${config.label}] Timed out after ${elapsedS}s ` +
        `(${bytesStdout}b received). Status: ${classification}.`,
      ));
    }, config.timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout          += chunk.toString('utf-8');
      bytesStdout     += chunk.length;
      lastActivityAt   = Date.now();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr          += chunk.toString('utf-8');
      bytesStderr     += chunk.length;
      lastActivityAt   = Date.now();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (err.code === 'ENOENT') {
        reject(new Error(
          `[${config.label}] Binary "${config.command}" not found in PATH. ` +
          `Install the CLI or set the corresponding BABEL_*_CMD env var.`,
        ));
      } else {
        reject(new Error(`[${config.label}] Spawn error: ${err.message}`));
      }
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      clearInterval(heartbeat);

      if (containsRateLimitSignal(stderr) || containsRateLimitSignal(stdout)) {
        reject(new Error(
          `rate limit: ${config.label} subscription limit reached. ` +
          `stderr: ${stderr.slice(0, 200)}`,
        ));
        return;
      }

      if (code !== 0) {
        reject(new Error(
          `[${config.label}] Process exited with code ${String(code)}. ` +
          `stderr: ${stderr.slice(0, 300)}`,
        ));
        return;
      }

      if (!stdout.trim()) {
        reject(new Error(`[${config.label}] CLI returned empty output.`));
        return;
      }

      resolve({ stdout, stderr });
    });

    // Only write to stdin in pure stdin mode (promptFlag === undefined AND
    // stdinMode !== 'ignore'). Positional / flag modes pass the prompt via
    // args, so stdin must stay empty; 'ignore' means stdin is not a pipe at
    // all, so no write or end call is needed.
    if (config.stdinMode !== 'ignore') {
      if (config.promptFlag === undefined) {
        proc.stdin!.write(prompt, 'utf-8');
      }
      proc.stdin!.end();
    }
  });
}

// ─── JSON extraction + Zod validation ────────────────────────────────────────

/**
 * Extracts JSON from the CLI output and validates it against `schema`.
 *
 * Throws `CliParseError` (not plain `Error`) on JSON extraction failure or
 * Zod validation failure, so `execute.ts` can detect it and write debug files
 * to the Evidence Bundle.
 */
export function parseAndValidate<T>(
  output: CliOutput,
  schema: ZodType<T, ZodTypeDef, unknown>,
  label:  string,
): T {
  let parsed: unknown;

  try {
    parsed = extractJson(output.stdout);
  } catch (err) {
    throw new CliParseError(
      `[${label}] invalid json: ${err instanceof Error ? err.message : String(err)}`,
      output.stdout,
      output.stderr,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new CliParseError(
      `[${label}] Zod validation failed:\n${result.error.toString()}`,
      output.stdout,
      output.stderr,
      result.error,
    );
  }

  return result.data;
}
