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
import { type LlmRunner, type RunnerInvocationMetadata, type RunnerCallbacks, buildStructuredOutputError } from './base.js';
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js';
import { extractJson }    from '../utils/extractJson.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const _rawTokens = Number(process.env['BABEL_DEEPINFRA_TOKENS'] ?? '8096');
const MAX_TOKENS = Number.isFinite(_rawTokens) && _rawTokens > 0 ? _rawTokens : 8096;
const _rawRequestTimeoutMs = Number(process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] ?? '120000');
const REQUEST_TIMEOUT_MS =
  Number.isFinite(_rawRequestTimeoutMs) && _rawRequestTimeoutMs > 0 ? _rawRequestTimeoutMs : 120000;
const _rawRequestMaxRetries = Number(process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] ?? '4');
const REQUEST_MAX_RETRIES =
  Number.isFinite(_rawRequestMaxRetries) && _rawRequestMaxRetries > 0 ? Math.min(Math.floor(_rawRequestMaxRetries), 10) : 4;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 200;
const API_URL    = 'https://api.deepinfra.com/v1/openai/chat/completions';

const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only — ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

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
  const totalTokens = normalizeTokenCount(usage?.total_tokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
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
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
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
  return readPositiveIntEnv('BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS', DEFAULT_STREAM_IDLE_TIMEOUT_MS);
}

function getStreamMaxRetries(): number {
  const parsed = Number(process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] ?? '');
  const value = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_STREAM_MAX_RETRIES;
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
  const exponential = RETRY_BASE_DELAY_MS * (2 ** Math.max(attempt - 1, 0));
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

async function readStreamingResponse(
  response: Response,
  callbacks: RunnerCallbacks | undefined,
  idleTimeoutMs: number,
  startedAt: number,
  state: {
    ttftMs: number | null;
    generationMs: number | null;
  }
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
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
          return text;
        }
        try {
          const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            text += delta;
            if (callbacks?.onChunk) {
              callbacks.onChunk(delta);
            }
          }
        } catch {
          // Ignore partial/invalid chunks.
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
  private readonly apiKey: string;
  private readonly model: string;
  private lastInvocationMetadata: RunnerInvocationMetadata | null = null;

  /**
   * @param model  DeepInfra model ID, e.g.
   *               "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"
   *               "Qwen/Qwen3-32B-Instruct"
   */
  constructor(model: string) {
    const key = process.env['DEEPINFRA_API_KEY'];
    if (!key) {
      throw new Error(
        '[deepInfraApi] DEEPINFRA_API_KEY is not set. ' +
        'Add it to your .env file to enable the DeepInfra runner.',
      );
    }
    this.apiKey = key;
    this.model  = model;
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    return this.lastInvocationMetadata;
  }

  async execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
  ): Promise<T> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;
    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: 'Contacting model' });
    }

    const isStreaming = !!callbacks?.onChunk;

    // ── HTTP request ──────────────────────────────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    const requestMaxRetries = getRequestMaxRetries();
    const requestTimeoutMs = getRequestTimeoutMs();
    const buildBody = () => JSON.stringify({
      model:       this.model,
      max_tokens:  MAX_TOKENS,
      temperature: 0,
      stream:      isStreaming,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: prompt },
      ],
    });
    for (let attempt = 1; attempt <= requestMaxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        response = await fetch(API_URL, {
          method:  'POST',
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type':  'application/json',
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
            callbacks.onProgress({ state: 'Retrying response', details: `attempt ${attempt} failed` });
          }
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeout);
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
      throw lastError ?? new Error(`[deepInfraApi] request failed before receiving a response (${this.model})`);
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
      const retryNote = isRetryableStatus(response.status) ? ` after ${REQUEST_MAX_RETRIES} attempt(s)` : '';
      throw new Error(
        `[deepInfraApi] HTTP ${response.status}${retryNote} (${this.model}): ${body}`,
      );
    }

    let text = '';
    const streamState = {
      ttftMs: null as number | null,
      generationMs: null as number | null,
    };

    if (isStreaming && response.body) {
      const streamIdleTimeoutMs = getStreamIdleTimeoutMs();
      const streamMaxRetries = getStreamMaxRetries();
      for (let streamAttempt = 0; streamAttempt <= streamMaxRetries; streamAttempt += 1) {
        try {
          text = await readStreamingResponse(response, callbacks, streamIdleTimeoutMs, startedAt, streamState);
          break;
        } catch (error: unknown) {
          if (!isStreamIdleTimeoutError(error) || streamAttempt >= streamMaxRetries) {
            throw error;
          }
          if (callbacks?.onProgress) {
            callbacks.onProgress({ state: 'Retrying response', details: 'Stream idle timeout' });
          }
          await sleep(retryDelayMs(streamAttempt + 1));
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
          try {
            response = await fetch(API_URL, {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: buildBody(),
            });
          } finally {
            clearTimeout(timeout);
          }
          if (!response.ok) {
            const body = await readErrorBody(response);
            throw new Error(`[deepInfraApi] HTTP ${response.status} during stream retry (${this.model}): ${body}`);
          }
        }
      }
      this.lastInvocationMetadata = buildInvocationMetadata(
        this.model,
        Date.now() - startedAt,
        undefined,
        streamState.ttftMs,
        streamState.generationMs,
      );
    } else {
      // ── Extract text content (Non-streaming) ──────────────────────────────────
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

    this.lastInvocationMetadata = buildInvocationMetadata(
      this.model,
      Date.now() - startedAt,
      isStreaming ? undefined : (this.lastInvocationMetadata?.total_tokens ? {
        ...(this.lastInvocationMetadata.prompt_tokens !== null && this.lastInvocationMetadata.prompt_tokens !== undefined ? { prompt_tokens: this.lastInvocationMetadata.prompt_tokens } : {}),
        ...(this.lastInvocationMetadata.completion_tokens !== null && this.lastInvocationMetadata.completion_tokens !== undefined ? { completion_tokens: this.lastInvocationMetadata.completion_tokens } : {}),
        ...(this.lastInvocationMetadata.total_tokens !== null && this.lastInvocationMetadata.total_tokens !== undefined ? { total_tokens: this.lastInvocationMetadata.total_tokens } : {}),
      } : undefined),
      streamState.ttftMs,
      streamState.generationMs,
      validationMs,
    );

    if (!result.success) {
      throw buildStructuredOutputError({
        failure_kind: 'zod_validation_failed',
        provider: 'deepinfra',
        model: this.model,
        message:
          `[deepInfraApi] Zod validation failed (${this.model}):\n${result.error.toString()}`,
        raw_output: text,
        parsed_json: parsed,
        zod_issues: result.error,
      });
    }

    return result.data;
  }
}
