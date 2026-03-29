/**
 * claudeCli.ts — Claude CLI Runner
 *
 * Thin wrapper around `cliBase.spawnCliProcess` + `parseAndValidate`.
 *
 * Configuration (environment variables):
 *   BABEL_CLAUDE_CMD     - CLI binary name.          Default: "claude"
 *   BABEL_CLAUDE_ARGS    - Space-separated flags.    Default: "--print"
 *   BABEL_CLI_TIMEOUT_MS - Hard timeout in ms.       Default: 120000
 */

import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner }              from './base.js';
import { spawnCliProcess,
         parseAndValidate }            from './cliBase.js';
import type { CliConfig }              from './cliBase.js';

const config: CliConfig = {
  label:     'claudeCli',
  command:   process.env['BABEL_CLAUDE_CMD']  ?? 'claude',
  // --print  → disable interactive UI, write response to stdout
  // --compact → suppress system prompt / UI chrome for cleaner stdout
  args:      (process.env['BABEL_CLAUDE_ARGS'] ?? '--print --compact').split(' ').filter(Boolean),
  timeoutMs: Number(process.env['BABEL_CLI_TIMEOUT_MS'] ?? '120000'),
  stdinMode: 'pipe',   // pipe prompt to stdin for --print mode
};

export class ClaudeCliRunner implements LlmRunner {
  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    const output = await spawnCliProcess(prompt, config);
    return parseAndValidate(output, schema, config.label);
  }
}
