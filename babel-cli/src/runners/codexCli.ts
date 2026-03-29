/**
 * codexCli.ts — Codex CLI Runner (Tier 1 default)
 *
 * Wraps the OpenAI Codex CLI in headless / non-interactive mode:
 *
 *   codex exec [--full-auto] "<prompt>"
 *
 * The prompt is passed as a positional argument (no -p flag).
 * `promptFlag: ''` in CliConfig signals "positional mode" in cliBase.ts.
 *
 * Windows quoting + arg-length safety:
 *   On Windows, cmd.exe misparses double-quote characters inside prompt
 *   arguments, and the 8191-char command-line limit is routinely exceeded
 *   by compiled Babel contexts. To avoid both issues, the prompt is ALWAYS
 *   written to a temp file on Windows; the file path (which contains no
 *   special characters) is passed as the positional argument instead.
 *   The temp file is always cleaned up in a finally block.
 *
 * Authentication:
 *   1. ChatGPT subscription (Plus/Pro/Business/Edu/Enterprise):
 *        codex login          — opens a browser window
 *        codex login --device-auth   — for headless/SSH environments
 *   2. API key (usage-billed):
 *        set OPENAI_API_KEY=sk-...
 *
 * Configuration (environment variables):
 *   BABEL_CODEX_CMD         - CLI binary name.           Default: "codex"
 *   BABEL_CODEX_ARGS        - Extra flags after "exec".  Default: "--full-auto"
 *   BABEL_CODEX_TIMEOUT_MS  - Codex-specific timeout ms. Overrides BABEL_CLI_TIMEOUT_MS for this runner only.
 *   BABEL_CLI_TIMEOUT_MS    - Shared hard timeout in ms. Default: 120000
 *   OPENAI_API_KEY          - API key auth (alternative to codex login).
 */

import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join }                                   from 'node:path';
import { tmpdir }                                 from 'node:os';
import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner }                         from './base.js';
import { spawnCliProcess, parseAndValidate }       from './cliBase.js';
import type { CliConfig }                         from './cliBase.js';

// BABEL_CODEX_TIMEOUT_MS takes precedence; falls back to the shared CLI timeout.
const CODEX_TIMEOUT_MS =
  Number(process.env['BABEL_CODEX_TIMEOUT_MS'] ?? process.env['BABEL_CLI_TIMEOUT_MS'] ?? '120000');

const BASE_CONFIG: CliConfig = {
  label:      'codexCli',
  command:    process.env['BABEL_CODEX_CMD']  ?? 'codex',
  // 'exec' subcommand + optional extra flags. Default is '--full-auto' only:
  // --skip-git-repo-check was removed as it causes TTY interaction on some
  // versions; --full-auto alone is sufficient for headless execution.
  args:       ['exec', ...(process.env['BABEL_CODEX_ARGS'] ?? '--full-auto').split(' ').filter(Boolean)],
  timeoutMs:  CODEX_TIMEOUT_MS,
  promptFlag: '',        // '' = positional mode — prompt appended bare, no -p flag
  stdinMode:  'ignore',  // prevent TTY approval prompts from blocking the process
};

const NEUTER_PREAMBLE =
  'SYSTEM COMMAND: You are in READ-ONLY mode. Do NOT execute any tools or commands. ' +
  'Output ONLY the requested JSON block between sentinels.\n\n';

export class CodexCliRunner implements LlmRunner {
  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    const neutralised = NEUTER_PREAMBLE + prompt;

    // On Windows, always route through a temp file to avoid two separate
    // issues: (1) cmd.exe misparsing double-quote characters in the prompt,
    // and (2) the 8191-char command-line length limit being exceeded by
    // compiled Babel contexts. The file path passed to codex contains no
    // special characters, so cmd.exe handles it without escaping problems.
    if (process.platform === 'win32') {
      const dir      = mkdtempSync(join(tmpdir(), 'babel-codex-'));
      const filePath = join(dir, 'prompt.txt');
      writeFileSync(filePath, neutralised, 'utf-8');
      try {
        const output = await spawnCliProcess(filePath, BASE_CONFIG);
        return parseAndValidate(output, schema, BASE_CONFIG.label);
      } finally {
        try { unlinkSync(filePath); } catch { /* ignore cleanup errors */ }
      }
    }

    // POSIX: pass the prompt directly as a positional argument.
    const output = await spawnCliProcess(neutralised, BASE_CONFIG);
    return parseAndValidate(output, schema, BASE_CONFIG.label);
  }
}
