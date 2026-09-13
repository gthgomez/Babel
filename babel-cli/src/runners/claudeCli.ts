/**
 * claudeCli.ts — Claude CLI Runner
 *
 * Thin wrapper around `cliBase.spawnCliProcess` + `parseAndValidate`.
 *
 * Configuration (environment variables):
 *   BABEL_CLAUDE_CMD     - CLI binary name.          Default: "claude"
 *   BABEL_CLAUDE_ARGS    - Space-separated flags.    Default: "--print"
 *   BABEL_CLI_TIMEOUT_MS - Hard timeout in ms.       Default: 120000
 *
 * Scope note: this is a LEGACY, UNREGISTERED public-use fallback runner (see the
 * note in `execute.ts`); it is not part of Babel's internal runner waterfall or
 * the review path. Because it spawns the `claude` binary it does NOT pass through
 * the `claude-babel-astra-lab` benchmark opt-in guard (`BABEL_BENCH_ALLOW_CLAUDE`).
 * If it is ever wired into review, it must be covered by docs/REVIEWER_SCOPE.md.
 */

import type { ZodType } from 'zod';
import type { LlmRunner, RunnerCallbacks } from './base.js';
import { spawnCliProcess, parseAndValidate } from './cliBase.js';
import type { CliConfig } from './cliBase.js';
import { parseCliArgString } from './cliArgParser.js';

const config: CliConfig = {
  label: 'claudeCli',
  command: process.env['BABEL_CLAUDE_CMD'] ?? 'claude',
  // --print  → disable interactive UI, write response to stdout
  // --compact → suppress system prompt / UI chrome for cleaner stdout
  args: parseCliArgString(process.env['BABEL_CLAUDE_ARGS'] ?? '--print --compact'),
  timeoutMs: Number(process.env['BABEL_CLI_TIMEOUT_MS'] ?? '120000'),
  stdinMode: 'pipe', // pipe prompt to stdin for --print mode
};

export class ClaudeCliRunner implements LlmRunner {
  async execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
  ): Promise<T> {
    const output = await spawnCliProcess(prompt, config);
    return parseAndValidate(output, schema, config.label);
  }
}
