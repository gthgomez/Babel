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
 *   BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS - per-request abort timeout. Default: 120000
 *   BABEL_DEEPINFRA_REQUEST_MAX_RETRIES - transport/5xx retry attempts. Default: 4
 *   DEEPSEEK_API_KEY          Required for direct DeepSeek tiers.
 *   BABEL_DEEPSEEK_TOKENS     max_tokens for DeepSeek responses. Default: 4096
 *   BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS - per-request abort timeout. Default: 120000
 *   BABEL_DEEPSEEK_REQUEST_MAX_RETRIES - transport/5xx retry attempts. Default: 3
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

import type { ZodType } from 'zod';
import type { CostPrecision } from '../services/modelPricingRegistry.js';

export type StructuredOutputFailureKind =
  | 'invalid_json'
  | 'zod_validation_failed'
  | 'empty_response'
  | 'failed_to_parse_api_json';

export interface StructuredOutputErrorParams {
  failure_kind: StructuredOutputFailureKind;
  provider: string | null;
  model: string | null;
  message: string;
  raw_output?: string;
  raw_stdout?: string;
  raw_stderr?: string;
  parsed_json?: unknown;
  zod_issues?: unknown;
  cause?: Error | undefined;
}

export class StructuredOutputError extends Error {
  readonly failure_kind: StructuredOutputFailureKind;
  readonly provider: string | null;
  readonly model: string | null;
  readonly raw_output: string;
  readonly raw_stdout: string;
  readonly raw_stderr: string;
  readonly parsed_json: unknown | null;
  readonly zod_issues: unknown | null;
  readonly original_message: string;

  constructor(params: StructuredOutputErrorParams) {
    super(params.message, params.cause ? { cause: params.cause } : undefined);
    this.name = 'StructuredOutputError';
    this.failure_kind = params.failure_kind;
    this.provider = params.provider;
    this.model = params.model;
    this.raw_output = params.raw_output ?? '';
    this.raw_stdout = params.raw_stdout ?? '';
    this.raw_stderr = params.raw_stderr ?? '';
    this.parsed_json = params.parsed_json ?? null;
    this.zod_issues = params.zod_issues ?? null;
    this.original_message = params.message;
  }
}

export function isStructuredOutputError(error: unknown): error is StructuredOutputError {
  return error instanceof StructuredOutputError;
}

export function buildStructuredOutputError(params: StructuredOutputErrorParams): StructuredOutputError {
  return new StructuredOutputError(params);
}

export interface RunnerInvocationMetadata {
  provider: string | null;
  provider_model_id: string | null;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  estimated_cost_usd: number | null;
  cost_precision?: CostPrecision | null;
  pricing_source_url?: string | null;
  pricing_verified_at?: string | null;
  input_cost_per_1m?: number | null;
  output_cost_per_1m?: number | null;
  input_cache_hit_cost_per_1m?: number | null;
  input_cache_miss_cost_per_1m?: number | null;
  ttft_ms?: number | null;
  generation_ms?: number | null;
  validation_ms?: number | null;
}

export type RunnerProgressState =
  | 'Contacting model'
  | 'Receiving response'
  | 'Validating response'
  | 'Retrying response'
  | 'Using backup route';

export interface RunnerProgressEvent {
  state: RunnerProgressState;
  details?: string;
}

export interface RunnerCallbacks {
  onChunk?: (chunk: string) => void;
  onProgress?: (event: RunnerProgressEvent) => void;
}

export interface LlmRunner {
  /**
   * Submit a compiled prompt to the underlying LLM and return a validated
   * typed result.
   *
   * @param prompt    - The fully compiled context string from `compileContext()`.
   * @param schema    - Zod schema used to parse and type the raw JSON output.
   * @param callbacks - Optional callbacks for streaming chunks and reporting progress events.
   * @returns         Promise resolving to the validated result `T`.
   * @throws          An `Error` with a descriptive message on any failure.
   */
  execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
  ): Promise<T>;

  /**
   * Best-effort telemetry about the most recent invocation. Runners that can
   * surface provider usage and latency should return it here so the pipeline
   * can persist cost and token metrics alongside waterfall telemetry.
   */
  getLastInvocationMetadata?(): RunnerInvocationMetadata | null;
}

export class StreamedAnswerExtractor {
  private inString = false;
  private escaped = false;
  private currentKey = '';
  private isKey = true;
  private lastKey = '';
  private captureValue = false;
  private braceDepth = 0;
  private onAnswerChunk: (chunk: string) => void;

  constructor(onAnswerChunk: (chunk: string) => void) {
    this.onAnswerChunk = onAnswerChunk;
  }

  feed(char: string): void {
    if (this.escaped) {
      this.escaped = false;
      if (this.captureValue) {
        if (char === 'n') this.onAnswerChunk('\n');
        else if (char === 't') this.onAnswerChunk('\t');
        else if (char === 'r') this.onAnswerChunk('\r');
        else if (char === 'b') this.onAnswerChunk('\b');
        else if (char === 'f') this.onAnswerChunk('\f');
        else this.onAnswerChunk(char);
      }
      return;
    }

    if (char === '\\') {
      this.escaped = true;
      return;
    }

    if (char === '"') {
      this.inString = !this.inString;
      if (!this.inString) {
        if (this.isKey) {
          this.lastKey = this.currentKey;
          this.currentKey = '';
        } else {
          if (this.captureValue) {
            this.captureValue = false;
          }
        }
      }
      return;
    }

    if (this.inString) {
      if (this.isKey) {
        this.currentKey += char;
      } else if (this.captureValue) {
        this.onAnswerChunk(char);
      }
      return;
    }

    if (char === ':') {
      this.isKey = false;
      if (this.braceDepth === 1 && this.lastKey === 'answer') {
        this.captureValue = true;
      }
    } else if (char === ',' || char === '}') {
      this.isKey = true;
      this.lastKey = '';
    } else if (char === '{') {
      this.braceDepth++;
      this.isKey = true;
    } else if (char === '}') {
      this.braceDepth--;
      this.isKey = true;
    }
  }

  feedText(text: string): void {
    for (let i = 0; i < text.length; i++) {
      this.feed(text[i]!);
    }
  }
}
