/**
 * geminiCli.ts — Gemini CLI Runner
 *
 * Thin wrapper around `cliBase.spawnCliProcess` + `parseAndValidate`.
 * Best suited for long-context tasks: large log analysis, document synthesis,
 * or any task where Gemini's extended context window is the differentiator.
 *
 * Prompt delivery:
 *   The runner pipes the prompt to Gemini's stdin — Gemini detects a non-TTY
 *   stdin and switches to non-interactive mode automatically. This avoids the
 *   Windows command-line length limit (~32 KB) exceeded by compiled Babel
 *   contexts when passing the prompt as a -p argument.
 *
 * Model selection:
 *   Pass a model ID to the constructor to override the default. The model is
 *   injected as `--model <id>` before any BABEL_GEMINI_ARGS flags. Any
 *   existing `--model` flag in BABEL_GEMINI_ARGS is stripped when a
 *   constructor model is provided to prevent duplicate --model arguments.
 *
 * Configuration (environment variables):
 *   BABEL_GEMINI_CMD      - CLI binary name.          Default: "gemini"
 *   BABEL_GEMINI_ARGS     - Extra flags (not --model). Default: "" (none)
 *   BABEL_CLI_TIMEOUT_MS  - Hard timeout in ms.       Default: 120000
 */

import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner }              from './base.js';
import { spawnCliProcess,
         parseAndValidate }            from './cliBase.js';
import type { CliConfig }              from './cliBase.js';

function buildConfig(model?: string): CliConfig {
  const cmd = process.env['BABEL_GEMINI_CMD'] ?? 'gemini';

  // Parse BABEL_GEMINI_ARGS, stripping any --model / --model=<x> entries when
  // the caller is supplying the model via constructor to avoid conflicts.
  const rawArgs = (process.env['BABEL_GEMINI_ARGS'] ?? '').split(' ').filter(Boolean);
  const baseArgs = model
    ? rawArgs.filter((arg, i, arr) => {
        if (arg === '--model' || arg === '-m') return false;          // flag itself
        if (i > 0 && (arr[i - 1] === '--model' || arr[i - 1] === '-m')) return false; // its value
        if (arg.startsWith('--model=') || arg.startsWith('-m=')) return false;
        return true;
      })
    : rawArgs;

  const modelArgs = model ? ['--model', model] : [];

  return {
    label:     model ? `geminiCli(${model})` : 'geminiCli',
    command:   cmd,
    args:      [...modelArgs, ...baseArgs],
    timeoutMs: Number(process.env['BABEL_CLI_TIMEOUT_MS'] ?? '120000'),
    // promptFlag left undefined → stdin mode (avoids Windows ENAMETOOLONG
    // when the compiled context exceeds the CreateProcess command-line limit).
  };
}

export class GeminiCliRunner implements LlmRunner {
  private readonly config: CliConfig;

  /**
   * @param model  Optional Gemini model ID, e.g. "gemini-3.1-flash-lite-preview".
   *               When omitted, BABEL_GEMINI_ARGS controls the model (or the
   *               CLI's own default is used).
   */
  constructor(model?: string) {
    this.config = buildConfig(model);
  }

  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    const output = await spawnCliProcess(prompt, this.config);
    return parseAndValidate(output, schema, this.config.label);
  }
}
