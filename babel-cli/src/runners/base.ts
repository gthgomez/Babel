/**
 * base.ts — LlmRunner interface
 *
 * Every runner in the Babel five-tier waterfall implements this contract.
 * The generic `execute<T>` method ensures callers always get a validated,
 * typed result — runners are responsible for JSON extraction and Zod parsing
 * internally. If a runner cannot produce a valid result it MUST throw, so the
 * waterfall in `execute.ts` can catch and cascade to the next tier.
 *
 * ─── Environment Variable Reference ──────────────────────────────────────────
 *
 * CLI Runners:
 *   BABEL_CODEX_CMD           Codex binary name.              Default: "codex"
 *   BABEL_CODEX_ARGS          Flags after "exec" subcommand.  Default: "--skip-git-repo-check --full-auto"
 *   BABEL_CLAUDE_CMD          Claude binary name.             Default: "claude"
 *   BABEL_CLAUDE_ARGS         Claude CLI flags.               Default: "--print"
 *   BABEL_GEMINI_CMD          Gemini binary name.             Default: "gemini"
 *   BABEL_GEMINI_ARGS         Gemini CLI flags.               Default: "--print"
 *   BABEL_CLI_TIMEOUT_MS      Hard timeout for all CLIs (ms). Default: 120000
 *
 * API Runners:
 *   DEEPINFRA_API_KEY         Required for DeepInfra tiers (Nemotron, Qwen3).
 *   BABEL_DEEPINFRA_TOKENS    max_tokens for DeepInfra responses.  Default: 8096
 *   GEMINI_API_KEY            Required for Gemini API repair runner (structuredRunner).
 *   BABEL_GEMINI_MODEL        Gemini API model ID.            Default: "gemini-2.5-flash-lite"
 *   BABEL_GEMINI_TOKENS       maxOutputTokens for Gemini API. Default: 8192
 *   ANTHROPIC_API_KEY         Required for the Anthropic repair-loop last resort.
 *   BABEL_API_MODEL           Anthropic model ID.             Default: "claude-sonnet-4-6"
 *   BABEL_API_TOKENS          max_tokens for API responses.   Default: 8096
 *
 * Waterfall Control:
 *   BABEL_DISABLE_API_FALLBACK  Set to "true" to skip all API tiers (DeepInfra, Anthropic).
 */

import type { ZodType, ZodTypeDef } from 'zod';

export interface LlmRunner {
  /**
   * Submit a compiled prompt to the underlying LLM and return a validated
   * typed result.
   *
   * @param prompt - The fully compiled context string from `compileContext()`.
   * @param schema - Zod schema used to parse and type the raw JSON output.
   * @returns      Promise resolving to the validated result `T`.
   * @throws       An `Error` with a descriptive message on any failure:
   *               spawn errors, non-zero exit codes, missing JSON, Zod
   *               validation errors. The message text is used by
   *               `runWithFallback` to decide whether to retry or cascade.
   */
  execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T>;
}
