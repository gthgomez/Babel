/**
 * deepInfraApi.ts — DeepInfra API Runner (OpenAI-compatible)
 *
 * Provides low-cost access to large open-weight models via DeepInfra's
 * OpenAI-compatible endpoint. Used in the per-stage waterfalls for:
 *
 *   Nemotron 3 Super 120B   — strong validator/fallback across all stages
 *   Qwen3-32B               — ultra-cheap structured JSON for executor turns
 *
 * Configuration (environment variables):
 *   DEEPINFRA_API_KEY          - Required. Get from https://deepinfra.com/dashboard
 *   BABEL_DEEPINFRA_TOKENS     - max_tokens for responses. Default: 8096
 *   BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS - per-request abort timeout. Default: 120000
 *   BABEL_DEEPINFRA_REQUEST_MAX_RETRIES - transport/5xx retry attempts. Default: 4
 *
 * The model is passed at construction time so a single runner class serves
 * multiple model IDs without extra env vars.
 *
 * Error policy:
 *   Transport timeouts, HTTP 408, HTTP 429, and HTTP 5xx retry with bounded
 *   jittered backoff. Schema and JSON failures are not retried here because
 *   they need prompt/schema repair, not another identical provider call.
 */

import type { ZodType } from 'zod';
import {
  type LlmRunner,
  type ProviderMessage,
  type ProviderToolCall,
  type RunnerInvocationMetadata,
  type RunnerCallbacks,
  type ToolDefinition,
  type ToolStreamEvent,
  buildStructuredOutputError,
} from './base.js';
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js';
import { extractJson } from '../utils/extractJson.js';
import { JitDenialError, PolicyBlockedDuplicateError } from '../ui/incrementalToolDetector.js';
import { createVcrRecorder, createVcrPlayer, type VcrRecorder } from '../services/streamingVcr.js';
import { parseRateLimitHeaders } from '../ui/rateLimitWidget.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const _rawTokens = Number(process.env['BABEL_DEEPINFRA_TOKENS'] ?? '32000');
const MAX_TOKENS = Number.isFinite(_rawTokens) && _rawTokens > 0 ? _rawTokens : 32000;
const _rawRequestTimeoutMs = Number(process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] ?? '120000');
const REQUEST_TIMEOUT_MS =
  Number.isFinite(_rawRequestTimeoutMs) && _rawRequestTimeoutMs > 0 ? _rawRequestTimeoutMs : 120000;
const _rawRequestMaxRetries = Number(process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] ?? '4');
const REQUEST_MAX_RETRIES =
  Number.isFinite(_rawRequestMaxRetries) && _rawRequestMaxRetries > 0
    ? Math.min(Math.floor(_rawRequestMaxRetries), 10)
    : 4;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 200;
// Base URL is now per-instance via `this.apiUrl` getter (supports subclasses like OpenRouter).

const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only — ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

const CHAT_SYSTEM_PROMPT =
  'You are an expert software engineer in a terminal chat session. ' +
  'Answer the user conversationally in natural language. ' +
  'Use tools to read files and gather context as needed. ' +
  'Be concise but thorough. Use markdown for formatting. ' +
  'Do NOT output JSON — respond in plain natural language.';

// ─── Response shape (OpenAI-compatible subset) ────────────────────────────────

interface ChatChoice {
  message?: { content?: string | null };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildInvocationMetadata(
  model: string,
  latencyMs: number,
  usage?: ChatResponse['usage'],
  ttftMs?: number | null,
  generationMs?: number | null,
  validationMs?: number | null,
): RunnerInvocationMetadata {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens);
  const totalTokens =
    normalizeTokenCount(usage?.total_tokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const estimate = estimateProviderUsageCost({
    provider: 'deepinfra',
    modelId: model,
    promptTokens,
    completionTokens,
  });

  return {
    provider: 'deepinfra',
    provider_model_id: model,
    latency_ms: latencyMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    estimated_cost_usd: estimate.estimatedCostUsd,
    cost_precision: estimate.precision,
    pricing_source_url: estimate.pricingSourceUrl,
    pricing_verified_at: estimate.pricingVerifiedAt,
    input_cost_per_1m: estimate.inputCostPer1M,
    output_cost_per_1m: estimate.outputCostPer1M,
    input_cache_hit_cost_per_1m: estimate.inputCacheHitCostPer1M,
    input_cache_miss_cost_per_1m: estimate.inputCacheMissCostPer1M,
    ttft_ms: ttftMs ?? null,
    generation_ms: generationMs ?? null,
    validation_ms: validationMs ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readPositiveIntEnv(name: string, fallback: number, max?: number): number {
  const parsed = Number(process.env[name] ?? '');
  const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return max ? Math.min(value, max) : value;
}

function getRequestTimeoutMs(): number {
  return readPositiveIntEnv('BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS);
}

function getRequestMaxRetries(): number {
  return readPositiveIntEnv('BABEL_DEEPINFRA_REQUEST_MAX_RETRIES', REQUEST_MAX_RETRIES, 10);
}

function getStreamIdleTimeoutMs(): number {
  return readPositiveIntEnv(
    'BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS',
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );
}

function getStreamMaxRetries(): number {
  const parsed = Number(process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] ?? '');
  const value =
    Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_STREAM_MAX_RETRIES;
  return Math.min(value, 5);
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.min(retryAfterSeconds * 1000, 30_000);
    }
    const retryAfterDate = Date.parse(retryAfter);
    if (Number.isFinite(retryAfterDate)) {
      return Math.min(Math.max(retryAfterDate - Date.now(), 0), 30_000);
    }
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0);
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  return Math.min(exponential + jitter, 5_000);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && /stream idle timeout/i.test(error.message);
}

async function readErrorBody(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 200);
}

/** Map ProviderMessage[] to the OpenAI-compatible wire format. */
function mapProviderMessages(
  messages: ProviderMessage[],
  defaultSystemPrompt: string,
  systemPromptOverride?: string,
): Array<{ role: string; content: string; tool_calls?: ProviderToolCall[]; tool_call_id?: string }> {
  const result: Array<{ role: string; content: string; tool_calls?: ProviderToolCall[]; tool_call_id?: string }> = [];

  const hasSystem = messages.length > 0 && messages[0]!.role === 'system';
  if (systemPromptOverride) {
    result.push({ role: 'system', content: systemPromptOverride });
  } else if (!hasSystem) {
    result.push({ role: 'system', content: defaultSystemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'system' && result.some(r => r.role === 'system')) continue;
    const wire: { role: string; content: string; tool_calls?: ProviderToolCall[]; tool_call_id?: string } = { role: msg.role, content: msg.content };
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      wire.tool_calls = msg.tool_calls;
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      wire.tool_call_id = msg.tool_call_id;
    }
    result.push(wire);
  }

  return result;
}

interface SseLineResult {
  delta: string;
  reasoning: string;
  usage: ChatResponse['usage'] | null;
  isDone: boolean;
}

function parseSseLine(line: string): SseLineResult {
  if (!line.startsWith('data: ')) {
    return { delta: '', reasoning: '', usage: null, isDone: false };
  }
  const data = line.slice(6).trim();
  if (data === '[DONE]') {
    return { delta: '', reasoning: '', usage: null, isDone: true };
  }
  try {
    const json = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
      usage?: ChatResponse['usage'];
    };
    const delta = json.choices?.[0]?.delta?.content || '';
    const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
    return { delta, reasoning, usage: json.usage ?? null, isDone: false };
  } catch {
    return { delta: '', reasoning: '', usage: null, isDone: false };
  }
}

async function readStreamingResponse(
  response: Response,
  callbacks: RunnerCallbacks | undefined,
  idleTimeoutMs: number,
  startedAt: number,
  state: {
    ttftMs: number | null;
    generationMs: number | null;
    usage: ChatResponse['usage'] | null;
  },
  vcrRecorder?: VcrRecorder,
): Promise<string> {
  if (!response.body) {
    throw new Error('[deepInfraApi] Streaming response had no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let raw = '';
  let firstChunkReceived = false;
  while (true) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const read = reader.read();
    const idle = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reader.cancel().catch(() => {});
        reject(new Error(`[deepInfraApi] stream idle timeout after ${idleTimeoutMs}ms`));
      }, idleTimeoutMs);
    });
    const { done, value } = await Promise.race([read, idle]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
    if (done) break;

    if (!firstChunkReceived) {
      firstChunkReceived = true;
      state.ttftMs = Date.now() - startedAt;
      if (callbacks?.onProgress) {
        callbacks.onProgress({ state: 'Receiving response' });
      }
    }

    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        vcrRecorder?.record(line);
        const parsed = parseSseLine(line);
        if (parsed.isDone) {
          state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
          return text;
        }
        if (parsed.delta) {
          text += parsed.delta;
          if (callbacks?.onChunk) {
            await callbacks.onChunk(parsed.delta);
          }
        }
        if (parsed.reasoning && callbacks?.onThought) {
          callbacks.onThought(parsed.reasoning);
        }
        if (parsed.usage) {
          state.usage = parsed.usage;
        }
      }
    }
  }
  if (state.generationMs === null && state.ttftMs !== null) {
    state.generationMs = Date.now() - startedAt - state.ttftMs;
  }
  if (!text.trim() && raw.trim().startsWith('{')) {
    try {
      const json = JSON.parse(raw) as ChatResponse;
      return json.choices?.[0]?.message?.content ?? '';
    } catch {
      return text;
    }
  }
  return text;
}

// ─── Runner implementation ────────────────────────────────────────────────────

export class DeepInfraApiRunner implements LlmRunner {
  protected readonly apiKey: string;
  protected readonly model: string;
  private lastInvocationMetadata: RunnerInvocationMetadata | null = null;

  /** Override in subclasses for alternate OpenAI-compatible providers. */
  protected get apiUrl(): string {
    return 'https://api.deepinfra.com/v1/openai/chat/completions';
  }

  /**
   * @param model           Model ID.
   * @param apiKeyEnvVar    Env-var name for the API key (default: DEEPINFRA_API_KEY).
   */
  constructor(model: string, apiKeyEnvVar = 'DEEPINFRA_API_KEY') {
    const key = process.env[apiKeyEnvVar];
    if (!key) {
      throw new Error(
        `[deepInfraApi] ${apiKeyEnvVar} is not set. ` +
          'Add it to your .env file to enable this runner.',
      );
    }
    this.apiKey = key;
    this.model = model;
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    return this.lastInvocationMetadata;
  }

  // ── Shared request/response logic ──────────────────────────────────────────
  /**
   * Sends the prompt to the API, handles retries, and reads the response
   * (streaming or non-streaming). Returns the raw model output text.
   * Used by both {@link execute} (structured JSON) and {@link executeRaw} (chat).
   */
  private async _executeRequest(
    prompt: string,
    callbacks: RunnerCallbacks | undefined,
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    startedAt: number;
    streamState: { ttftMs: number | null; generationMs: number | null };
  }> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;
    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: 'Contacting model' });
    }

    const isStreaming = !!callbacks?.onChunk;
    const requestMaxRetries = getRequestMaxRetries();
    const requestTimeoutMs = getRequestTimeoutMs();

    const buildBody = () =>
      JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stream: isStreaming,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      });

    // ── VCR playback mode ──────────────────────────────────────────────────────
    const vcrPlayer = createVcrPlayer();
    if (vcrPlayer) {
      const lines = await vcrPlayer.readAllLines();
      let text = '';
      const streamState = {
        ttftMs: null as number | null,
        generationMs: null as number | null,
        usage: null as ChatResponse['usage'] | null,
      };
      let firstChunkReceived = false;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const parsed = parseSseLine(line);
          if (parsed.isDone) {
            streamState.generationMs = Date.now() - startedAt - (streamState.ttftMs ?? 0);
            break;
          }
          if (parsed.delta) {
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              streamState.ttftMs = Date.now() - startedAt;
              if (callbacks?.onProgress) {
                callbacks.onProgress({ state: 'Receiving response' });
              }
            }
            text += parsed.delta;
            if (callbacks?.onChunk) {
              await callbacks.onChunk(parsed.delta);
            }
          }
          if (parsed.usage) {
            streamState.usage = parsed.usage;
          }
        }
      }
      if (streamState.generationMs === null && streamState.ttftMs !== null) {
        streamState.generationMs = Date.now() - startedAt - streamState.ttftMs;
      }
      return { text, startedAt, streamState };
    }

    // ── HTTP request loop ────────────────────────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= requestMaxRetries; attempt += 1) {
      const controller = new AbortController();
      // Link external abort signal so Esc/Ctrl+C cancels in-flight HTTP requests
      let onExternalAbort: (() => void) | undefined;
      if (signal) {
        onExternalAbort = () => controller.abort();
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: buildBody(),
        });
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
        lastError = new Error(
          isAbortError(err)
            ? `[deepInfraApi] request timeout after ${requestTimeoutMs}ms (${this.model})`
            : `[deepInfraApi] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < requestMaxRetries) {
          if (callbacks?.onProgress) {
            callbacks.onProgress({
              state: 'Retrying response',
              details: `attempt ${attempt} failed`,
            });
          }
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeout);
        if (signal && onExternalAbort) {
          signal.removeEventListener('abort', onExternalAbort);
        }
      }

      if (response.ok || !isRetryableStatus(response.status) || attempt === requestMaxRetries) {
        break;
      }
      if (callbacks?.onProgress) {
        callbacks.onProgress({ state: 'Retrying response', details: `HTTP ${response.status}` });
      }
      await sleep(retryDelayMs(attempt, response));
    }

    if (!response) {
      throw (
        lastError ??
        new Error(`[deepInfraApi] request failed before receiving a response (${this.model})`)
      );
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
      const retryNote = isRetryableStatus(response.status)
        ? ` after ${REQUEST_MAX_RETRIES} attempt(s)`
        : '';
      throw new Error(
        `[deepInfraApi] HTTP ${response.status}${retryNote} (${this.model}): ${body}`,
      );
    }

    parseRateLimitHeaders(response.headers, 'deepinfra');

    // ── Read response (streaming or non-streaming) ────────────────────────────
    let text = '';
    const streamState = {
      ttftMs: null as number | null,
      generationMs: null as number | null,
      usage: null as ChatResponse['usage'] | null,
    };

    if (isStreaming && response.body) {
      const streamIdleTimeoutMs = getStreamIdleTimeoutMs();
      const streamMaxRetries = getStreamMaxRetries();
      for (let streamAttempt = 0; streamAttempt <= streamMaxRetries; streamAttempt += 1) {
        const vcrRecorder = createVcrRecorder();
        try {
          text = await readStreamingResponse(
            response,
            callbacks,
            streamIdleTimeoutMs,
            startedAt,
            streamState,
            vcrRecorder ?? undefined,
          );
          vcrRecorder?.close();
          break;
        } catch (error: unknown) {
          vcrRecorder?.close();
          if (!isStreamIdleTimeoutError(error) || streamAttempt >= streamMaxRetries) {
            throw error;
          }
          if (callbacks?.onProgress) {
            callbacks.onProgress({ state: 'Retrying response', details: 'Stream idle timeout' });
          }
          await sleep(retryDelayMs(streamAttempt + 1));
          const controller = new AbortController();
          let onStreamRetryAbort: (() => void) | undefined;
          if (signal) {
            onStreamRetryAbort = () => controller.abort();
            signal.addEventListener('abort', onStreamRetryAbort, { once: true });
          }
          const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
          try {
            response = await fetch(this.apiUrl, {
              method: 'POST',
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: buildBody(),
            });
          } finally {
            clearTimeout(timeout);
            if (signal && onStreamRetryAbort) {
              signal.removeEventListener('abort', onStreamRetryAbort);
            }
          }
          // Parse rate-limit headers on the retry response too — the widget needs fresh quota data
          parseRateLimitHeaders(response.headers, 'deepinfra');
          if (!response.ok) {
            const body = await readErrorBody(response);
            throw new Error(
              `[deepInfraApi] HTTP ${response.status} during stream retry (${this.model}): ${body}`,
            );
          }
        }
      }
      this.lastInvocationMetadata = buildInvocationMetadata(
        this.model,
        Date.now() - startedAt,
        streamState.usage ?? undefined,
        streamState.ttftMs,
        streamState.generationMs,
      );
    } else {
      let data: ChatResponse;
      let rawDataText = '';
      try {
        rawDataText = await response.text();
        data = JSON.parse(rawDataText) as ChatResponse;
        this.lastInvocationMetadata = buildInvocationMetadata(
          this.model,
          Date.now() - startedAt,
          data.usage,
        );
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
        throw buildStructuredOutputError({
          failure_kind: 'failed_to_parse_api_json',
          provider: 'deepinfra',
          model: this.model,
          message: `[deepInfraApi] Failed to parse API response as JSON: ${String(err)}`,
          raw_output: rawDataText,
          cause: err instanceof Error ? err : undefined,
        });
      }
      text = data?.choices?.[0]?.message?.content ?? '';
    }

    return { text, startedAt, streamState };
  }

  async execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const { text, startedAt, streamState } = await this._executeRequest(
      prompt,
      callbacks,
      systemPrompt ?? SYSTEM_PROMPT,
      signal,
    );

    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: 'Validating response' });
    }
    const validationStartedAt = Date.now();

    if (!text.trim()) {
      throw buildStructuredOutputError({
        failure_kind: 'empty_response',
        provider: 'deepinfra',
        model: this.model,
        message: `[deepInfraApi] Empty response from model "${this.model}".`,
        raw_output: text,
      });
    }

    // ── JSON extraction + Zod validation ─────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw buildStructuredOutputError({
        failure_kind: 'invalid_json',
        provider: 'deepinfra',
        model: this.model,
        message:
          `[deepInfraApi] invalid json (${this.model}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        raw_output: text,
        cause: err instanceof Error ? err : undefined,
      });
    }

    const result = schema.safeParse(parsed);
    const validationMs = Date.now() - validationStartedAt;

    const isStreaming = !!callbacks?.onChunk;
    this.lastInvocationMetadata = buildInvocationMetadata(
      this.model,
      Date.now() - startedAt,
      isStreaming
        ? undefined
        : this.lastInvocationMetadata?.total_tokens
          ? {
              ...(this.lastInvocationMetadata.prompt_tokens !== null &&
              this.lastInvocationMetadata.prompt_tokens !== undefined
                ? { prompt_tokens: this.lastInvocationMetadata.prompt_tokens }
                : {}),
              ...(this.lastInvocationMetadata.completion_tokens !== null &&
              this.lastInvocationMetadata.completion_tokens !== undefined
                ? { completion_tokens: this.lastInvocationMetadata.completion_tokens }
                : {}),
              ...(this.lastInvocationMetadata.total_tokens !== null &&
              this.lastInvocationMetadata.total_tokens !== undefined
                ? { total_tokens: this.lastInvocationMetadata.total_tokens }
                : {}),
            }
          : undefined,
      streamState.ttftMs,
      streamState.generationMs,
      validationMs,
    );

    if (!result.success) {
      throw buildStructuredOutputError({
        failure_kind: 'zod_validation_failed',
        provider: 'deepinfra',
        model: this.model,
        message: `[deepInfraApi] Zod validation failed (${this.model}):\n${result.error.toString()}`,
        raw_output: text,
        parsed_json: parsed,
        zod_issues: result.error,
      });
    }

    return result.data;
  }

  /**
   * Execute with raw text output — no JSON extraction, no Zod validation.
   * Returns the model's natural-language response as a plain string.
   *
   * Used by chat mode (conversational answers) where structured JSON
   * output is neither needed nor appropriate for smaller models that
   * don't reliably produce JSON matching {@link AskAnswerSchema}.
   *
   * Still tracks token usage via {@link getLastInvocationMetadata} for
   * cost display.
   */
  async executeRaw(
    prompt: string,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { text } = await this._executeRequest(
      prompt,
      callbacks,
      systemPrompt ?? CHAT_SYSTEM_PROMPT,
      signal,
    );

    if (!text.trim()) {
      throw buildStructuredOutputError({
        failure_kind: 'empty_response',
        provider: 'deepinfra',
        model: this.model,
        message: `[deepInfraApi] Empty response from model "${this.model}".`,
        raw_output: text,
      });
    }

    return text;
  }

  /** #1 Async generator: yields text chunks as they arrive from the SSE stream.
   *  Wraps the existing callback infrastructure through a push-based queue. */
  async *executeRawStream(
    prompt: string,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, undefined> {
    const chunks: string[] = [];
    let pending: (() => void) | null = null;
    let finished = false;
    let error: Error | null = null;

    const execPromise = this._executeRequest(
      prompt,
      {
        onChunk: (chunk: string) => {
          chunks.push(chunk);
          pending?.();
        },
      },
      systemPrompt ?? CHAT_SYSTEM_PROMPT,
      signal,
    );

    execPromise
      .then(
        () => {
          finished = true;
          pending?.();
        },
        (err: unknown) => {
          error = err instanceof Error ? err : new Error(String(err));
          finished = true;
          pending?.();
        },
      )
      .catch(() => {});

    while (!finished) {
      while (chunks.length > 0) {
        yield chunks.shift()!;
      }
      if (!finished) {
        await new Promise<void>((r) => {
          pending = r;
        });
      }
    }

    // Drain remaining chunks
    while (chunks.length > 0) {
      yield chunks.shift()!;
    }

    if (error) throw error;
    // Track usage from the completed request
    await execPromise; // ensure metadata is populated
  }

  /**
   * Execute a prompt with native tool definitions, streaming results via SSE.
   * Uses the OpenAI-compatible `tools` API parameter for native function calling.
   * Yields typed ToolStreamEvent values as SSE chunks arrive, accumulating
   * tool call arguments across incremental deltas.
   */
  async *executeWithToolsStream(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    signal?: AbortSignal,
    toolChoice?: 'auto' | 'required',
  ): AsyncGenerator<ToolStreamEvent, void, undefined> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;
    const requestTimeoutMs = getRequestTimeoutMs();
    const requestMaxRetries = getRequestMaxRetries();
    const streamIdleTimeoutMs = getStreamIdleTimeoutMs();

    const buildBody = () =>
      JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stream: true,
        tools,
        tool_choice: (toolChoice ?? 'auto') as 'auto' | 'required',
        messages: mapProviderMessages(messages, CHAT_SYSTEM_PROMPT, systemPrompt),
      });

    // ── HTTP request loop (with retries) ─────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= requestMaxRetries; attempt += 1) {
      const controller = new AbortController();
      let onExternalAbort: (() => void) | undefined;
      if (signal) {
        onExternalAbort = () => controller.abort();
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: buildBody(),
        });
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
        lastError = new Error(
          isAbortError(err)
            ? `[deepInfraApi] request timeout after ${requestTimeoutMs}ms (${this.model})`
            : `[deepInfraApi] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < requestMaxRetries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        yield { type: 'error', message: lastError.message };
        return;
      } finally {
        clearTimeout(timeout);
        if (signal && onExternalAbort) {
          signal.removeEventListener('abort', onExternalAbort);
        }
      }

      if (response.ok || !isRetryableStatus(response.status) || attempt === requestMaxRetries) {
        break;
      }
      await sleep(retryDelayMs(attempt, response));
    }

    if (!response) {
      yield { type: 'error', message: lastError?.message ?? '[deepInfraApi] No response received' };
      return;
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
      yield { type: 'error', message: `[deepInfraApi] HTTP ${response.status} (${this.model}): ${body}` };
      return;
    }

    parseRateLimitHeaders(response.headers, 'deepinfra');

    // ── SSE streaming with tool call accumulation ────────────────────────
    if (!response.body) {
      yield { type: 'error', message: '[deepInfraApi] Streaming response had no body.' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunkReceived = false;
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    const streamState: {
      ttftMs: number | null;
      generationMs: number | null;
      usage: ChatResponse['usage'] | null;
    } = { ttftMs: null, generationMs: null, usage: null };

    try {
      let finishReason: string | null = null;

      while (true) {
        let readTimeout: ReturnType<typeof setTimeout> | null = null;
        const read = reader.read();
        const idle = new Promise<never>((_, reject) => {
          readTimeout = setTimeout(() => {
            reader.cancel().catch(() => {});
            reject(
              new Error(`[deepInfraApi] stream idle timeout after ${streamIdleTimeoutMs}ms`),
            );
          }, streamIdleTimeoutMs);
        });

        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          const result = await Promise.race([read, idle]).finally(() => {
            if (readTimeout) clearTimeout(readTimeout);
          });
          done = result.done;
          value = result.value;
        } catch (err) {
          yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
          return;
        }

        if (done) break;

        if (!firstChunkReceived) {
          firstChunkReceived = true;
          streamState.ttftMs = Date.now() - startedAt;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  reasoning_content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
              usage?: ChatResponse['usage'];
            };

            const choice = json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta;

            if (delta?.reasoning_content) {
              yield { type: 'thought_delta', text: delta.reasoning_content };
            }

            if (delta?.content) {
              yield { type: 'text_delta', text: delta.content };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, { id: '', name: '', arguments: '' });
                }
                const acc = pendingToolCalls.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.arguments += tc.function.arguments;
              }
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            if (json.usage) {
              streamState.usage = json.usage;
            }
          } catch {
            // Ignore partial/invalid JSON chunks
          }
        }
      }

      // Process remaining buffered SSE line
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data !== '[DONE]') {
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ finish_reason?: string | null }>;
              usage?: ChatResponse['usage'];
            };
            if (json.usage) {
              streamState.usage = json.usage;
            }
            if (json.choices?.[0]?.finish_reason) {
              finishReason = json.choices[0].finish_reason;
            }
          } catch { /* ignore */ }
        }
      }

      streamState.generationMs = Date.now() - startedAt - (streamState.ttftMs ?? 0);

      // ── Yield accumulated tool calls ──────────────────────────────────
      if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && pendingToolCalls.size > 0) {
        for (const [, acc] of pendingToolCalls) {
          let input: Record<string, unknown> = {};
          if (acc.arguments) {
            try {
              input = JSON.parse(acc.arguments) as Record<string, unknown>;
            } catch { /* leave empty */ }
          }
          yield { type: 'tool_use', id: acc.id, name: acc.name, input };
        }
        yield { type: 'done', finishReason: finishReason ?? 'tool_calls' };
      } else {
        yield { type: 'done', finishReason: finishReason ?? 'stop' };
      }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    }

    this.lastInvocationMetadata = buildInvocationMetadata(
      this.model,
      Date.now() - startedAt,
      streamState.usage ?? undefined,
      streamState.ttftMs,
      streamState.generationMs,
    );
  }
}
