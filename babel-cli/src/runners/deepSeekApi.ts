/**
 * deepSeekApi.ts - Direct DeepSeek API runner (OpenAI-compatible).
 *
 * Used by live governance proof runs when DEEPSEEK_API_KEY is configured.
 * The full Babel policy can still use DeepInfra for non-DeepSeek model
 * waterfalls; this runner covers current direct DeepSeek v4 models.
 */

import type { ZodType } from 'zod';
import { parseRetryAfterHeader, isRetryableStatus, normalizeFinishReason, classifyProviderError } from './providerNormalize.js';
import {
  type LlmRunner,
  type ProviderMessage,
  type RunnerInvocationMetadata,
  type RunnerCallbacks,
  type ToolDefinition,
  type ToolStreamEvent,
  buildStructuredOutputError,
} from './base.js';
import { mapProviderMessagesToWire } from './providerMessages.js';
import { assertSupportedDeepSeekModel, type DeepSeekModelId } from '../services/deepSeekPricing.js';
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js';
import { extractJson } from '../utils/extractJson.js';
import { JitDenialError, PolicyBlockedDuplicateError } from '../ui/incrementalToolDetector.js';
import { createVcrRecorder, createVcrPlayer, type VcrRecorder } from '../services/streamingVcr.js';
import { parseRateLimitHeaders } from '../ui/rateLimitWidget.js';
import {
  resolveReasoningEffort,
  toDeepSeekReasoningEffort,
  type ReasoningEffort,
} from '../config/executionProfiles.js';

const MAX_TOKENS = readPositiveIntEnv('BABEL_DEEPSEEK_TOKENS', 32000);
const REQUEST_TIMEOUT_MS = readPositiveIntEnv('BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS', 120_000);
const REQUEST_MAX_RETRIES = readPositiveIntEnv('BABEL_DEEPSEEK_REQUEST_MAX_RETRIES', 3, 10);
const STREAM_IDLE_TIMEOUT_MS = readPositiveIntEnv('BABEL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS', 120_000);
const RETRY_BASE_DELAY_MS = 200;
const API_URL = 'https://api.deepseek.com/v1/chat/completions';

const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only - ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

const CHAT_SYSTEM_PROMPT =
  'You are an expert software engineer in a terminal chat session. ' +
  'Answer the user conversationally in natural language. ' +
  'Use tools to read files and gather context as needed. ' +
  'Be concise but thorough. Use markdown for formatting. ' +
  'Do NOT output JSON — respond in plain natural language.';

interface ChatChoice {
  message?: { content?: string | null; reasoning_content?: string | null };
}

interface ChatResponse {
  model?: string;
  reasoning_effort?: string;
  thinking?: { type?: string } | string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

type DeepSeekReasoningEffort = 'high' | 'max';

interface DeepSeekStreamState {
  ttftMs: number | null;
  generationMs: number | null;
  usage: ChatResponse['usage'] | null;
  observedModelId: string | null;
  observedReasoningEffort: string | null;
  thinkingObserved: boolean | null;
}

interface DeepSeekRoutingMetadata {
  requestedModelId: string;
  normalizedModelId: DeepSeekModelId;
  sentModelId: DeepSeekModelId;
  requestedReasoningEffort: ReasoningEffort;
  normalizedReasoningEffort: DeepSeekReasoningEffort;
  sentReasoningEffort: DeepSeekReasoningEffort;
  observedModelId: string | null;
  observedReasoningEffort: string | null;
  thinkingRequested: boolean;
  thinkingSent: 'enabled' | 'disabled';
  thinkingObserved: boolean | null;
  toolChoiceSent: 'auto' | 'required' | null;
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
  routing?: DeepSeekRoutingMetadata,
): RunnerInvocationMetadata {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens);
  const promptCacheHitTokens = normalizeTokenCount(usage?.prompt_cache_hit_tokens);
  const promptCacheMissTokens = normalizeTokenCount(usage?.prompt_cache_miss_tokens);
  const totalTokens =
    normalizeTokenCount(usage?.total_tokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
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
    ...(routing
      ? {
          requested_model_id: routing.requestedModelId,
          normalized_model_id: routing.normalizedModelId,
          sent_model_id: routing.sentModelId,
          observed_model_id: routing.observedModelId,
          requested_reasoning_effort: routing.requestedReasoningEffort,
          normalized_reasoning_effort: routing.normalizedReasoningEffort,
          sent_reasoning_effort: routing.sentReasoningEffort,
          observed_reasoning_effort: routing.observedReasoningEffort,
          thinking_requested: routing.thinkingRequested,
          thinking_sent: routing.thinkingSent,
          thinking_observed: routing.thinkingObserved,
          tool_choice_sent: routing.toolChoiceSent,
        }
      : {}),
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

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = parseRetryAfterHeader(response?.headers.get('retry-after'));
  if (retryAfter !== null) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0);
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  return Math.min(exponential + jitter, 5_000);
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
  state: DeepSeekStreamState,
  vcrRecorder?: VcrRecorder,
): Promise<string> {
  if (!response.body) {
    throw new Error('[deepSeekApi] Streaming response had no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let buffer = '';
  let firstChunkReceived = false;
  let lastContentChunkAt = Date.now();

  while (true) {
    // Wrap reader.read() with a timeout so a silent network stall
    // (no bytes, no TCP FIN/RST) doesn't hang the reader forever.
    let readTimeout: ReturnType<typeof setTimeout> | null = null;
    const read = reader.read();
    const idle = new Promise<never>((_, reject) => {
      readTimeout = setTimeout(() => {
        reader.cancel().catch(() => {});
        reject(
          new Error(
            `[deepSeekApi] stream read timeout after ${STREAM_IDLE_TIMEOUT_MS}ms ` +
              `(no bytes received)`,
          ),
        );
      }, STREAM_IDLE_TIMEOUT_MS);
    });
    const { done, value } = await Promise.race([read, idle]).finally(() => {
      if (readTimeout) clearTimeout(readTimeout);
    });
    if (done) break;

    // Content-level idle timeout: DeepSeek sends SSE keepalive comments
    // during long reasoning, but bytes arriving don't mean progress is being
    // made. Track the last time actual content (or reasoning) arrived, and
    // abort if the stream has been idle for too long.
    if (Date.now() - lastContentChunkAt > STREAM_IDLE_TIMEOUT_MS) {
      reader.cancel().catch(() => {});
      throw new Error(
        `[deepSeekApi] stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms ` +
          `(last content chunk at ${new Date(lastContentChunkAt).toISOString()})`,
      );
    }

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
        vcrRecorder?.record(trimmed);
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') {
          continue;
        }
        try {
          const json = JSON.parse(data) as {
            model?: string;
            reasoning_effort?: string;
            thinking?: { type?: string } | string;
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            usage?: ChatResponse['usage'];
          };
          if (json.model) state.observedModelId = json.model;
          if (json.reasoning_effort) state.observedReasoningEffort = json.reasoning_effort;
          if (json.thinking !== undefined) {
            state.thinkingObserved =
              typeof json.thinking === 'string'
                ? json.thinking !== 'disabled'
                : json.thinking.type !== 'disabled';
          }
          const delta = json.choices?.[0]?.delta?.content || '';
          const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
          if (reasoning || delta) {
            lastContentChunkAt = Date.now();
          }
          if (reasoning) state.thinkingObserved = true;
          if (reasoning && callbacks?.onThought) {
            callbacks.onThought(reasoning);
          }
          if (delta) {
            text += delta;
            if (callbacks?.onChunk) {
              await callbacks.onChunk(delta);
            }
          }
          if (json.usage) {
            state.usage = json.usage;
          }
        } catch (err) {
          if (err instanceof JitDenialError || err instanceof PolicyBlockedDuplicateError) {
            reader.cancel().catch(() => {});
            throw err;
          }
          // Ignore partial/invalid chunks.
        }
      }
    }
  }

  if (buffer.startsWith('data: ')) {
    vcrRecorder?.record(buffer);
    const data = buffer.slice(6).trim();
    if (data !== '[DONE]') {
      try {
        const json = JSON.parse(data) as {
          model?: string;
          reasoning_effort?: string;
          thinking?: { type?: string } | string;
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
          usage?: ChatResponse['usage'];
        };
        if (json.model) state.observedModelId = json.model;
        if (json.reasoning_effort) state.observedReasoningEffort = json.reasoning_effort;
        if (json.thinking !== undefined) {
          state.thinkingObserved =
            typeof json.thinking === 'string'
              ? json.thinking !== 'disabled'
              : json.thinking.type !== 'disabled';
        }
        const delta = json.choices?.[0]?.delta?.content || '';
        const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
        if (reasoning || delta) {
          lastContentChunkAt = Date.now();
        }
        if (reasoning) state.thinkingObserved = true;
        if (reasoning && callbacks?.onThought) {
          callbacks.onThought(reasoning);
        }
        if (delta) {
          text += delta;
          if (callbacks?.onChunk) {
            await callbacks.onChunk(delta);
          }
        }
        if (json.usage) {
          state.usage = json.usage;
        }
      } catch (err) {
        if (err instanceof JitDenialError || err instanceof PolicyBlockedDuplicateError) {
          reader.cancel().catch(() => {});
          throw err;
        }
        // Ignore
      }
    }
  }

  state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
  return text;
}

export class DeepSeekApiRunner implements LlmRunner {
  private readonly apiKey: string;
  private readonly requestedModel: string;
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
    // Guard against malformed keys (e.g. truncated "k-" prefix missing the leading "s")
    if (!key.startsWith('sk-')) {
      throw new Error(
        `[deepSeekApi] DEEPSEEK_API_KEY does not start with "sk-" (got prefix "${key.slice(0, 4)}…"). ` +
          'The key may be truncated or invalid. Check your environment — ' +
          'a stale env var may be shadowing the correct key in babel-cli/.env.',
      );
    }
    this.apiKey = key;
    this.requestedModel = model;
    this.model = assertSupportedDeepSeekModel(model);
  }

  private buildRoutingMetadata(input: {
    thinkingRequested: boolean;
    thinkingSent: 'enabled' | 'disabled';
    thinkingObserved: boolean | null;
    observedModelId: string | null;
    observedReasoningEffort: string | null;
    toolChoiceSent: 'auto' | 'required' | null;
  }): DeepSeekRoutingMetadata {
    const requestedReasoningEffort = resolveReasoningEffort();
    const normalizedReasoningEffort = toDeepSeekReasoningEffort(requestedReasoningEffort);
    return {
      requestedModelId: this.requestedModel,
      normalizedModelId: this.model,
      sentModelId: this.model,
      requestedReasoningEffort,
      normalizedReasoningEffort,
      sentReasoningEffort: normalizedReasoningEffort,
      ...input,
    };
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    return this.lastInvocationMetadata;
  }

  // ── Shared request/response logic ──────────────────────────────────────────
  /**
   * Sends the prompt to the API, handles retries, and reads the response
   * (streaming or non-streaming). Returns the raw model output text.
   *
   * @param raw  When true, omit {@code response_format: json_object} so the
   *             model is free to output natural language instead of JSON.
   */
  private async _executeRequest(
    prompt: string,
    callbacks: RunnerCallbacks | undefined,
    systemPrompt: string,
    raw: boolean,
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    startedAt: number;
    streamState: DeepSeekStreamState;
  }> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;
    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: 'Contacting model' });
    }

    const isStreaming = !!callbacks?.onChunk;

    // ── VCR playback mode ──────────────────────────────────────────────────────
    const vcrPlayer = createVcrPlayer();
    if (vcrPlayer) {
      const lines = await vcrPlayer.readAllLines();
      let text = '';
      const streamState = {
        ttftMs: null as number | null,
        generationMs: null as number | null,
        usage: null as ChatResponse['usage'] | null,
        observedModelId: null as string | null,
        observedReasoningEffort: null as string | null,
        thinkingObserved: null as boolean | null,
      };
      let firstChunkReceived = false;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            streamState.generationMs = Date.now() - startedAt - (streamState.ttftMs ?? 0);
            break;
          }
          try {
            const json = JSON.parse(data) as {
              model?: string;
              reasoning_effort?: string;
              thinking?: { type?: string } | string;
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
              usage?: ChatResponse['usage'];
            };
            if (json.model) streamState.observedModelId = json.model;
            if (json.reasoning_effort) {
              streamState.observedReasoningEffort = json.reasoning_effort;
            }
            if (json.thinking !== undefined) {
              streamState.thinkingObserved =
                typeof json.thinking === 'string'
                  ? json.thinking !== 'disabled'
                  : json.thinking.type !== 'disabled';
            }
            if (
              !firstChunkReceived &&
              (json.choices?.[0]?.delta?.content || json.choices?.[0]?.delta?.reasoning_content)
            ) {
              firstChunkReceived = true;
              streamState.ttftMs = Date.now() - startedAt;
              if (callbacks?.onProgress) {
                callbacks.onProgress({ state: 'Receiving response' });
              }
            }
            const delta = json.choices?.[0]?.delta?.content || '';
            const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
            if (reasoning) streamState.thinkingObserved = true;
            if (reasoning && callbacks?.onThought) {
              callbacks.onThought(reasoning);
            }
            if (delta) {
              text += delta;
              if (callbacks?.onChunk) {
                await callbacks.onChunk(delta);
              }
            }
            if (json.usage) {
              streamState.usage = json.usage;
            }
          } catch {
            // Ignore partial/invalid chunks.
          }
        }
      }
      if (streamState.generationMs === null && streamState.ttftMs !== null) {
        streamState.generationMs = Date.now() - startedAt - streamState.ttftMs;
      }
      return { text, startedAt, streamState };
    }

    const buildBody = () => {
      const effort = toDeepSeekReasoningEffort(resolveReasoningEffort());
      const thinkingEnabled = process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled';
      return JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        ...(raw ? {} : { response_format: { type: 'json_object' as const } }),
        stream: isStreaming,
        ...(isStreaming ? { stream_options: { include_usage: true } } : {}),
        reasoning_effort: effort,
        thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      });
    };

    // ── HTTP request loop ────────────────────────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= REQUEST_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      if (signal) {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
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
      throw (
        lastError ??
        new Error(`[deepSeekApi] request failed before receiving a response (${this.model})`)
      );
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
      const retryNote = isRetryableStatus(response.status)
        ? ` after ${REQUEST_MAX_RETRIES} attempt(s)`
        : '';
      throw new Error(`[deepSeekApi] HTTP ${response.status}${retryNote} (${this.model}): ${body}`);
    }

    parseRateLimitHeaders(response.headers, 'deepseek');

    // ── Read response (streaming or non-streaming) ────────────────────────────
    let text = '';
    const streamState = {
      ttftMs: null as number | null,
      generationMs: null as number | null,
      usage: null as ChatResponse['usage'] | null,
      observedModelId: null as string | null,
      observedReasoningEffort: null as string | null,
      thinkingObserved: null as boolean | null,
    };

    if (isStreaming) {
      const vcrRecorder = createVcrRecorder();
      try {
        text = await readStreamingResponse(
          response,
          callbacks,
          startedAt,
          streamState,
          vcrRecorder ?? undefined,
        );
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
      } finally {
        vcrRecorder?.close();
      }
    } else {
      let rawDataText = '';
      let data: ChatResponse;
      try {
        rawDataText = await response.text();
        data = JSON.parse(rawDataText) as ChatResponse;
        streamState.usage = data.usage;
        streamState.observedModelId = data.model ?? null;
        streamState.observedReasoningEffort = data.reasoning_effort ?? null;
        streamState.thinkingObserved =
          data.thinking !== undefined
            ? typeof data.thinking === 'string'
              ? data.thinking !== 'disabled'
              : data.thinking.type !== 'disabled'
            : data.choices?.[0]?.message?.reasoning_content
              ? true
              : null;
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
      false, // structured JSON mode
      signal,
    );

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
      this.buildRoutingMetadata({
        thinkingRequested: process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled',
        thinkingSent: process.env['BABEL_DEEPSEEK_THINKING'] === 'disabled' ? 'disabled' : 'enabled',
        thinkingObserved: streamState.thinkingObserved,
        observedModelId: streamState.observedModelId,
        observedReasoningEffort: streamState.observedReasoningEffort,
        toolChoiceSent: null,
      }),
    );

    if (!result.success) {
      throw buildStructuredOutputError({
        failure_kind: 'zod_validation_failed',
        provider: 'deepseek',
        model: this.model,
        message: `[deepSeekApi] Zod validation failed (${this.model}):\n${result.error.toString()}`,
        raw_output: text,
        parsed_json: parsed,
        zod_issues: result.error,
      });
    }

    return result.data;
  }

  /**
   * Execute with raw text output — no JSON extraction, no Zod validation.
   * Omits {@code response_format: json_object} so the model outputs natural
   * language instead of JSON.
   *
   * Used by chat mode (conversational answers) where structured JSON
   * output is neither needed nor appropriate.
   */
  async executeRaw(
    prompt: string,
    callbacks?: RunnerCallbacks,
    systemPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const { text, startedAt, streamState } = await this._executeRequest(
      prompt,
      callbacks,
      systemPrompt ?? CHAT_SYSTEM_PROMPT,
      true, // raw mode — skip response_format: json_object
      signal,
    );

    if (!text.trim()) {
      throw buildStructuredOutputError({
        failure_kind: 'empty_response',
        provider: 'deepseek',
        model: this.model,
        message: `[deepSeekApi] Empty response from model "${this.model}".`,
        raw_output: text,
      });
    }

    // Build metadata for cost tracking (no validation step in raw mode)
    this.lastInvocationMetadata = buildInvocationMetadata(
      this.model,
      Date.now() - startedAt,
      streamState.usage ?? undefined,
      streamState.ttftMs,
      streamState.generationMs,
      undefined,
      this.buildRoutingMetadata({
        thinkingRequested: process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled',
        thinkingSent: process.env['BABEL_DEEPSEEK_THINKING'] === 'disabled' ? 'disabled' : 'enabled',
        thinkingObserved: streamState.thinkingObserved,
        observedModelId: streamState.observedModelId,
        observedReasoningEffort: streamState.observedReasoningEffort,
        toolChoiceSent: null,
      }),
    );

    return text;
  }

  /** #1 Async generator: yields text chunks as they arrive from the SSE stream. */
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
      true, // raw mode
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

    while (chunks.length > 0) {
      yield chunks.shift()!;
    }

    if (error) throw error;
    await execPromise; // ensure metadata populated
  }

  /**
   * Execute a prompt with native tool definitions, streaming results via SSE.
   * Uses the OpenAI-compatible `tools` API parameter for native function calling
   * with the DeepSeek API. Yields typed ToolStreamEvent values as SSE chunks
   * arrive, accumulating tool call arguments across incremental deltas.
   *
   * When the finish_reason is 'tool_calls', accumulated tool calls are yielded
   * as `tool_use` events followed by a `done` event. When it is 'stop', only
   * a `done` event is yielded (text content arrived via `text_delta`).
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

    // Track thinking routing for lastInvocationMetadata (P0-B honesty).
    let thinkingDisabledReason: string | null = null;
    const thinkingRequested = process.env['BABEL_DEEPSEEK_THINKING'] !== 'disabled';
    const thinkingSent: 'enabled' | 'disabled' = thinkingRequested ? 'enabled' : 'disabled';
    let toolChoiceSent: 'auto' | 'required' | null = null;

    const buildBody = () => {
      const effort = toDeepSeekReasoningEffort(resolveReasoningEffort());
      // DeepSeek rejects tool_choice while thinking is enabled. Keep thinking
      // on by default and omit tool_choice; explicit BABEL_DEEPSEEK_THINKING=
      // disabled remains the opt-out for conformance/debug runs.
      const thinkingEnabled = thinkingRequested;
      if (!thinkingRequested) {
        thinkingDisabledReason = 'BABEL_DEEPSEEK_THINKING=disabled';
      } else {
        thinkingDisabledReason = null;
      }
      const choice = (toolChoice ?? 'auto') as 'auto' | 'required';
      toolChoiceSent = thinkingEnabled ? null : choice;
      return JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stream: true,
        ...{ stream_options: { include_usage: true } },
        tools,
        // When thinking is enabled with tools, omit tool_choice (API rejects it).
        ...(thinkingEnabled ? {} : { tool_choice: choice }),
        reasoning_effort: effort,
        thinking: { type: thinkingEnabled ? 'enabled' as const : 'disabled' as const },
        messages: mapProviderMessagesToWire(messages, CHAT_SYSTEM_PROMPT, systemPrompt),
      });
    };

    // ── HTTP request loop (with retries) ─────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= REQUEST_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      if (signal) {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
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
          await sleep(retryDelayMs(attempt));
          continue;
        }
        yield { type: 'error', message: lastError.message };
        return;
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok || !isRetryableStatus(response.status) || attempt === REQUEST_MAX_RETRIES) {
        break;
      }
      await sleep(retryDelayMs(attempt, response));
    }

    if (!response) {
      yield { type: 'error', message: lastError?.message ?? '[deepSeekApi] No response received' };
      return;
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.model, Date.now() - startedAt);
      yield { type: 'error', message: `[deepSeekApi] HTTP ${response.status} (${this.model}): ${body}` };
      return;
    }

    parseRateLimitHeaders(response.headers, 'deepseek');

    // ── SSE streaming with tool call accumulation ────────────────────────
    if (!response.body) {
      yield { type: 'error', message: '[deepSeekApi] Streaming response had no body.' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunkReceived = false;

    // Accumulate tool call arguments that arrive incrementally across SSE chunks
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    const streamState: DeepSeekStreamState = {
      ttftMs: null,
      generationMs: null,
      usage: null,
      observedModelId: null,
      observedReasoningEffort: null,
      thinkingObserved: null,
    };

    try {
      let finishReason: string | null = null;

      while (true) {
        let readTimeout: ReturnType<typeof setTimeout> | null = null;
        const read = reader.read();
        const idle = new Promise<never>((_, reject) => {
          readTimeout = setTimeout(() => {
            reader.cancel().catch(() => {});
            reject(
              new Error(`[deepSeekApi] stream read timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`),
            );
          }, STREAM_IDLE_TIMEOUT_MS);
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
              model?: string;
              reasoning_effort?: string;
              thinking?: { type?: string } | string;
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

            if (json.model) streamState.observedModelId = json.model;
            if (json.reasoning_effort) {
              streamState.observedReasoningEffort = json.reasoning_effort;
            }
            if (json.thinking !== undefined) {
              streamState.thinkingObserved =
                typeof json.thinking === 'string'
                  ? json.thinking !== 'disabled'
                  : json.thinking.type !== 'disabled';
            }

            const choice = json.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // Reasoning content (e.g. DeepSeek's thinking tokens)
            if (delta?.reasoning_content) {
              streamState.thinkingObserved = true;
              yield { type: 'thought_delta', text: delta.reasoning_content };
            }

            // Text content
            if (delta?.content) {
              yield { type: 'text_delta', text: delta.content };
            }

            // Native tool call deltas — accumulate arguments incrementally
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

            // Track finish reason (set in the final delta chunk)
            if (normalizeFinishReason(choice.finish_reason)) {
              finishReason = normalizeFinishReason(choice.finish_reason);
            }

            // Track usage info (arrives in a non-delta chunk before [DONE])
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
              model?: string;
              reasoning_effort?: string;
              thinking?: { type?: string } | string;
              choices?: Array<{ finish_reason?: string | null }>;
              usage?: ChatResponse['usage'];
            };
            if (json.model) streamState.observedModelId = json.model;
            if (json.reasoning_effort) {
              streamState.observedReasoningEffort = json.reasoning_effort;
            }
            if (json.thinking !== undefined) {
              streamState.thinkingObserved =
                typeof json.thinking === 'string'
                  ? json.thinking !== 'disabled'
                  : json.thinking.type !== 'disabled';
            }
            if (json.usage) {
              streamState.usage = json.usage;
            }
            if (json.choices?.[0]?.finish_reason) {
              finishReason = normalizeFinishReason(json.choices[0].finish_reason);
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
            } catch { /* leave empty — model may have sent partial JSON */ }
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

    const meta = buildInvocationMetadata(
      this.model,
      Date.now() - startedAt,
      streamState.usage ?? undefined,
      streamState.ttftMs,
      streamState.generationMs,
      undefined,
      this.buildRoutingMetadata({
        thinkingRequested,
        thinkingSent,
        thinkingObserved: streamState.thinkingObserved,
        observedModelId: streamState.observedModelId,
        observedReasoningEffort: streamState.observedReasoningEffort,
        toolChoiceSent,
      }),
    );
    if (thinkingDisabledReason) {
      meta.thinking_disabled_reason = thinkingDisabledReason;
    }
    this.lastInvocationMetadata = meta;
  }
}
