/**
 * deepSeekApi.ts - Direct DeepSeek API runner (OpenAI-compatible).
 *
 * Used by live governance proof runs when DEEPSEEK_API_KEY is configured.
 * The full Babel policy can still use DeepInfra for non-DeepSeek model
 * waterfalls; this runner covers current direct DeepSeek v4 models.
 */

import type { ZodType } from 'zod';
import { type LlmRunner, type RunnerInvocationMetadata, type RunnerCallbacks, buildStructuredOutputError } from './base.js';
import {
  assertSupportedDeepSeekModel,
  type DeepSeekModelId,
} from '../services/deepSeekPricing.js';
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js';
import { extractJson } from '../utils/extractJson.js';

const MAX_TOKENS = readPositiveIntEnv('BABEL_DEEPSEEK_TOKENS', 4096);
const REQUEST_TIMEOUT_MS = readPositiveIntEnv('BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS', 120_000);
const REQUEST_MAX_RETRIES = readPositiveIntEnv('BABEL_DEEPSEEK_REQUEST_MAX_RETRIES', 3, 10);
const RETRY_BASE_DELAY_MS = 200;
const API_URL = 'https://api.deepseek.com/v1/chat/completions';

const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only - ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

interface ChatChoice {
  message?: { content?: string | null };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
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
  const promptCacheHitTokens = normalizeTokenCount(usage?.prompt_cache_hit_tokens);
  const promptCacheMissTokens = normalizeTokenCount(usage?.prompt_cache_miss_tokens);
  const totalTokens = normalizeTokenCount(usage?.total_tokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const estimate = estimateProviderUsageCost({
    provider: 'deepseek',
    modelId: model,
    promptTokens,
    completionTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
  });

  return {
    provider: 'deepseek',
    provider_model_id: model,
    latency_ms: latencyMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_cache_hit_tokens: promptCacheHitTokens,
    prompt_cache_miss_tokens: promptCacheMissTokens,
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

async function readErrorBody(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 200);
}

async function readStreamingResponse(
  response: Response,
  callbacks: RunnerCallbacks | undefined,
  startedAt: number,
  state: {
    ttftMs: number | null;
    generationMs: number | null;
    usage: ChatResponse['usage'] | null;
  }
): Promise<string> {
  if (!response.body) {
    throw new Error('[deepSeekApi] Streaming response had no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let buffer = '';
  let firstChunkReceived = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (!firstChunkReceived) {
      firstChunkReceived = true;
      state.ttftMs = Date.now() - startedAt;
      if (callbacks?.onProgress) {
        callbacks.onProgress({ state: 'Receiving response' });
      }
    }

    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') {
          continue;
        }
        try {
          const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>, usage?: ChatResponse['usage'] };
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            text += delta;
            if (callbacks?.onChunk) {
              callbacks.onChunk(delta);
            }
          }
          if (json.usage) {
            state.usage = json.usage;
          }
        } catch {
          // Ignore partial/invalid chunks.
        }
      }
    }
  }

  if (buffer.startsWith('data: ')) {
    const data = buffer.slice(6).trim();
    if (data !== '[DONE]') {
      try {
        const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }>, usage?: ChatResponse['usage'] };
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) {
          text += delta;
          if (callbacks?.onChunk) {
            callbacks.onChunk(delta);
          }
        }
        if (json.usage) {
          state.usage = json.usage;
        }
      } catch {
        // Ignore
      }
    }
  }

  state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
  return text;
}

export class DeepSeekApiRunner implements LlmRunner {
  private readonly apiKey: string;
  private readonly model: DeepSeekModelId;
  private lastInvocationMetadata: RunnerInvocationMetadata | null = null;

  constructor(model = 'deepseek-v4-flash') {
    const key = process.env['DEEPSEEK_API_KEY'];
    if (!key) {
      throw new Error(
        '[deepSeekApi] DEEPSEEK_API_KEY is not set. ' +
        'Add it to your environment to enable the direct DeepSeek runner.',
      );
    }
    this.apiKey = key;
    this.model = assertSupportedDeepSeekModel(model);
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

    let response: Response | null = null;
    let lastError: Error | null = null;
    const isStreaming = !!callbacks?.onChunk;

    const buildBody = () => JSON.stringify({
      model: this.model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      response_format: { type: 'json_object' },
      stream: isStreaming,
      ...(isStreaming ? { stream_options: { include_usage: true } } : {}),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    });

    for (let attempt = 1; attempt <= REQUEST_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(API_URL, {
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
            ? `[deepSeekApi] request timeout after ${REQUEST_TIMEOUT_MS}ms (${this.model})`
            : `[deepSeekApi] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < REQUEST_MAX_RETRIES) {
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

      if (response.ok || !isRetryableStatus(response.status) || attempt === REQUEST_MAX_RETRIES) {
        break;
      }
      if (callbacks?.onProgress) {
        callbacks.onProgress({ state: 'Retrying response', details: `HTTP ${response.status}` });
      }
      await sleep(retryDelayMs(attempt, response));
    }

    if (!response) {
      throw lastError ?? new Error(`[deepSeekApi] request failed before receiving a response (${this.model})`);
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
      const retryNote = isRetryableStatus(response.status) ? ` after ${REQUEST_MAX_RETRIES} attempt(s)` : '';
      throw new Error(`[deepSeekApi] HTTP ${response.status}${retryNote} (${this.model}): ${body}`);
    }

    let text = '';
    const streamState = {
      ttftMs: null as number | null,
      generationMs: null as number | null,
      usage: null as ChatResponse['usage'] | null,
    };

    if (isStreaming) {
      try {
        text = await readStreamingResponse(response, callbacks, startedAt, streamState);
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
        throw buildStructuredOutputError({
          failure_kind: 'failed_to_parse_api_json',
          provider: 'deepseek',
          model: this.model,
          message: `[deepSeekApi] Streaming reading failed: ${String(err)}`,
          raw_output: text,
          cause: err instanceof Error ? err : undefined,
        });
      }
    } else {
      let rawDataText = '';
      let data: ChatResponse;
      try {
        rawDataText = await response.text();
        data = JSON.parse(rawDataText) as ChatResponse;
        streamState.usage = data.usage;
        text = data?.choices?.[0]?.message?.content ?? '';
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
        throw buildStructuredOutputError({
          failure_kind: 'failed_to_parse_api_json',
          provider: 'deepseek',
          model: this.model,
          message: `[deepSeekApi] Failed to parse API response as JSON: ${String(err)}`,
          raw_output: rawDataText,
          cause: err instanceof Error ? err : undefined,
        });
      }
    }

    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: 'Validating response' });
    }
    const validationStartedAt = Date.now();

    if (!text.trim()) {
      throw buildStructuredOutputError({
        failure_kind: 'empty_response',
        provider: 'deepseek',
        model: this.model,
        message: `[deepSeekApi] Empty response from model "${this.model}".`,
        raw_output: text,
      });
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw buildStructuredOutputError({
        failure_kind: 'invalid_json',
        provider: 'deepseek',
        model: this.model,
        message:
          `[deepSeekApi] invalid json (${this.model}): ` +
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
      streamState.usage ?? undefined,
      streamState.ttftMs,
      streamState.generationMs,
      validationMs,
    );

    if (!result.success) {
      throw buildStructuredOutputError({
        failure_kind: 'zod_validation_failed',
        provider: 'deepseek',
        model: this.model,
        message:
          `[deepSeekApi] Zod validation failed (${this.model}):\n${result.error.toString()}`,
        raw_output: text,
        parsed_json: parsed,
        zod_issues: result.error,
      });
    }

    return result.data;
  }
}
