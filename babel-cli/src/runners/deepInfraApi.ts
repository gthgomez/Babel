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

import { createHash, randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { parseRetryAfterHeader, isRetryableStatus, normalizeFinishReason } from './providerNormalize.js';
import {
  type LlmRunner,
  type ProviderMessage,
  type RunnerInvocationMetadata,
  type RunnerCallbacks,
  type ProviderInvocationPhase,
  type ToolDefinition,
  type ToolStreamEvent,
  buildStructuredOutputError,
} from './base.js';
import { mapProviderMessagesToWire } from './providerMessages.js';
import { estimateProviderUsageCost } from '../services/modelPricingRegistry.js';
import { extractJson } from '../utils/extractJson.js';
import { createVcrRecorder, createVcrPlayer, type VcrRecorder } from '../services/streamingVcr.js';
import { parseRateLimitHeaders } from '../ui/rateLimitWidget.js';
import { resolveProviderCredential } from './credentialHub.js';
import type { ProviderId } from './providerRegistry.js';
import { buildWireRequestFromEnvelope, hashWirePolicy, type WireRequest } from '../intelligence/wire.js';
import { hashCanonical } from '../intelligence/hash.js';
import { normalizeBabelFinishReason } from '../intelligence/attribution.js';
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js';
import {
  buildProviderFailureReceipt,
  providerErrorCodeFromBody,
  providerRequestIdFromResponse,
  type ProviderFailureDetails,
} from './providerFailureReceipt.js';

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
  finish_reason?: string | null;
}

interface ChatResponse {
  model?: string;
  /** OpenRouter may expose the concrete upstream provider in this field. */
  provider?: string;
  openrouter_metadata?: OpenRouterResponseMetadata;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface OpenRouterResponseMetadata {
  endpoints?: {
    available?: Array<{
      provider?: string;
      model?: string;
      selected?: boolean;
      endpoint?: string;
    }>;
  };
  attempts?: Array<{ provider?: string; model?: string; status?: number; endpoint?: string }>;
  context_transformation?: boolean;
  route?: unknown;
  pipeline?: unknown;
}

interface RouterMetadataProvenance {
  hash: string;
  attemptCount: number;
  fallbackOccurred: boolean;
  selectedEndpoint: string | null;
  contextTransformationOccurred: boolean;
}

function routerMetadataProvenance(metadata: OpenRouterResponseMetadata | null | undefined): RouterMetadataProvenance | null {
  if (!metadata) return null;
  const attempts = metadata.attempts ?? [];
  const selected = metadata.endpoints?.available?.find((endpoint) => endpoint.selected === true);
  return {
    hash: hashCanonical({
      endpoints: metadata.endpoints?.available ?? [],
      attempts,
      context_transformation: metadata.context_transformation ?? false,
      route: metadata.route,
      pipeline: metadata.pipeline,
    }),
    attemptCount: attempts.length,
    fallbackOccurred: attempts.length > 1 || attempts.some((attempt) => attempt.status !== undefined && attempt.status !== 200),
    selectedEndpoint: selected?.endpoint ?? null,
    contextTransformationOccurred: metadata.context_transformation === true,
  };
}

function upstreamProviderFromResponse(value: {
  provider?: string;
  openrouter_metadata?: OpenRouterResponseMetadata;
}): string | null {
  if (typeof value.provider === 'string' && value.provider.length > 0) return value.provider;
  const selected = value.openrouter_metadata?.endpoints?.available?.find(
    (endpoint) => endpoint.selected === true && typeof endpoint.provider === 'string',
  );
  if (selected?.provider) return selected.provider;
  const successful = value.openrouter_metadata?.attempts?.find(
    (attempt) => attempt.status === 200 && typeof attempt.provider === 'string',
  );
  return successful?.provider ?? null;
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildInvocationMetadata(
  provider: ProviderId,
  model: string,
  latencyMs: number,
  usage?: ChatResponse['usage'],
  ttftMs?: number | null,
  generationMs?: number | null,
  validationMs?: number | null,
  observedModelId?: string | null,
  upstreamProvider?: string | null,
  routerMetadata?: OpenRouterResponseMetadata | null,
  finishReason?: string | null,
  configuredOutputBudget?: number | null,
): RunnerInvocationMetadata {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens);
  const totalTokens =
    normalizeTokenCount(usage?.total_tokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  const estimate = estimateProviderUsageCost({
    provider,
    modelId: model,
    promptTokens,
    completionTokens,
  });
  const router = routerMetadataProvenance(routerMetadata);
  const reasoningTokens =
    normalizeTokenCount(usage?.reasoning_tokens) ??
    normalizeTokenCount(usage?.completion_tokens_details?.reasoning_tokens);
  const finish =
    finishReason === undefined
      ? null
      : normalizeBabelFinishReason({
          raw: finishReason,
          ...(configuredOutputBudget === undefined ? {} : { configuredOutputBudget }),
          actualCompletionTokens: completionTokens,
        });

  return {
    provider,
    provider_model_id: model,
    requested_model_id: model,
    normalized_model_id: model,
    sent_model_id: model,
    observed_model_id: observedModelId ?? null,
    upstream_provider: upstreamProvider ?? null,
    ...(finish === null
      ? {}
      : {
          normalized_finish_reason: finish.normalized,
          failure_attribution: finish.attribution.kind,
        }),
    ...(router === null ? {} : {
      router_metadata_hash: router.hash,
      openrouter_router_attempt: router.attemptCount,
      actual_endpoint_id: router.selectedEndpoint,
      fallback_status: router.fallbackOccurred ? 'occurred' as const : 'none' as const,
      context_transformation_occurred: router.contextTransformationOccurred,
    }),
    latency_ms: latencyMs,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    actual_reasoning_tokens: reasoningTokens,
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'));
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

function isStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && /stream idle timeout/i.test(error.message);
}

async function readErrorBody(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 200);
}

/** Map ProviderMessage[] to the OpenAI-compatible wire format (shared P0-B mapper). */
function mapProviderMessages(
  messages: ProviderMessage[],
  defaultSystemPrompt: string,
  systemPromptOverride?: string,
) {
  return mapProviderMessagesToWire(messages, defaultSystemPrompt, systemPromptOverride);
}

interface SseLineResult {
  delta: string;
  reasoning: string;
  usage: ChatResponse['usage'] | null;
  observedModelId: string | null;
  upstreamProvider: string | null;
  routerMetadata: OpenRouterResponseMetadata | null;
  finishReason: string | null;
  isDone: boolean;
}

interface StreamingState {
  ttftMs: number | null;
  generationMs: number | null;
  usage: ChatResponse['usage'] | null;
  observedModelId: string | null;
  upstreamProvider: string | null;
  routerMetadata: OpenRouterResponseMetadata | null;
  finishReason: string | null;
  /** True after any model-generated material becomes observable to the caller. */
  partialModelOutput: boolean;
  /** Local, non-durable material used to produce a truthful failure digest. */
  outputReceipt: string;
  sawDone: boolean;
}

function recordStreamingOutput(state: StreamingState, kind: string, value: string): void {
  if (!value) return;
  state.partialModelOutput = true;
  state.outputReceipt += `${kind}:${value}\n`;
}

function parseSseLine(line: string): SseLineResult {
  if (!line.startsWith('data: ')) {
    return { delta: '', reasoning: '', usage: null, observedModelId: null, upstreamProvider: null, routerMetadata: null, finishReason: null, isDone: false };
  }
  const data = line.slice(6).trim();
  if (data === '[DONE]') {
    return { delta: '', reasoning: '', usage: null, observedModelId: null, upstreamProvider: null, routerMetadata: null, finishReason: null, isDone: true };
  }
  try {
    const json = JSON.parse(data) as {
      model?: string;
      provider?: string;
      openrouter_metadata?: OpenRouterResponseMetadata;
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }>;
      usage?: ChatResponse['usage'];
    };
    const delta = json.choices?.[0]?.delta?.content || '';
    const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
    return {
      delta,
      reasoning,
      usage: json.usage ?? null,
      observedModelId: json.model ?? null,
      upstreamProvider: upstreamProviderFromResponse(json),
      routerMetadata: json.openrouter_metadata ?? null,
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      isDone: false,
    };
  } catch {
    return { delta: '', reasoning: '', usage: null, observedModelId: null, upstreamProvider: null, routerMetadata: null, finishReason: null, isDone: false };
  }
}

async function readStreamingResponse(
  response: Response,
  callbacks: RunnerCallbacks | undefined,
  idleTimeoutMs: number,
  startedAt: number,
  state: StreamingState,
  vcrRecorder?: VcrRecorder,
  onFirstByte?: () => void,
  onStreamProgress?: (bytes: number) => void,
): Promise<string> {
  if (!response.body) {
    throw new Error('[deepInfraApi] Streaming response had no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let raw = '';
  let buffer = '';
  let firstChunkReceived = false;
  let totalBytes = 0;
  const processLine = async (line: string): Promise<boolean> => {
    const normalizedLine = line.replace(/\r$/, '').trim();
    if (!normalizedLine.startsWith('data:')) return false;
    vcrRecorder?.record(normalizedLine);
    const parsed = parseSseLine(`data: ${normalizedLine.slice(5).trimStart()}`);
    if (parsed.observedModelId) state.observedModelId = parsed.observedModelId;
    if (parsed.upstreamProvider) state.upstreamProvider = parsed.upstreamProvider;
    if (parsed.routerMetadata) state.routerMetadata = parsed.routerMetadata;
    if (parsed.finishReason) state.finishReason = parsed.finishReason;
    if (parsed.isDone) {
      state.sawDone = true;
      state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
      return true;
    }
    if (parsed.delta) {
      text += parsed.delta;
      recordStreamingOutput(state, 'text', parsed.delta);
      if (callbacks?.onChunk) await callbacks.onChunk(parsed.delta);
    }
    if (parsed.reasoning) {
      recordStreamingOutput(state, 'reasoning', parsed.reasoning);
      callbacks?.onThought?.(parsed.reasoning);
    }
    if (parsed.usage) state.usage = parsed.usage;
    return false;
  };

  while (true) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const read = reader.read();
    const idle = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        // Reject before cancelling. Some ReadableStream implementations
        // resolve the pending read as `done` synchronously during cancel;
        // that must not turn an idle timeout into a misleading clean EOF.
        reject(new Error(`[deepInfraApi] stream idle timeout after ${idleTimeoutMs}ms`));
        reader.cancel().catch(() => {});
      }, idleTimeoutMs);
    });
    const { done, value } = await Promise.race([read, idle]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
    if (done) {
      const flushed = decoder.decode();
      raw += flushed;
      buffer += flushed;
      if (buffer.length > 0 && await processLine(buffer)) return text;
      break;
    }

    totalBytes += value?.byteLength ?? 0;
    onStreamProgress?.(totalBytes);

    if (!firstChunkReceived) {
      firstChunkReceived = true;
      state.ttftMs = Date.now() - startedAt;
      onFirstByte?.();
      if (callbacks?.onProgress) {
        callbacks.onProgress({ state: 'Receiving response' });
      }
    }

    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (await processLine(line)) return text;
    }
  }

  // A few OpenAI-compatible gateways return one ordinary JSON response even
  // when stream=true. Accept that only as a complete response; an SSE stream
  // that closes without [DONE] is a truthful truncated-stream failure.
  const rawTrimmed = raw.trim();
  if (!state.sawDone && rawTrimmed.startsWith('{')) {
    try {
      const json = JSON.parse(rawTrimmed) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      if (content) {
        text += content;
        recordStreamingOutput(state, 'text', content);
        if (callbacks?.onChunk) await callbacks.onChunk(content);
      }
      const reasoning = (json as ChatResponse & { reasoning_content?: string }).reasoning_content;
      if (reasoning) {
        recordStreamingOutput(state, 'reasoning', reasoning);
        callbacks?.onThought?.(reasoning);
      }
      state.observedModelId = json.model ?? state.observedModelId;
      state.upstreamProvider = upstreamProviderFromResponse(json) ?? state.upstreamProvider;
      state.routerMetadata = json.openrouter_metadata ?? state.routerMetadata;
      state.finishReason = json.choices?.[0]?.finish_reason ?? state.finishReason;
      state.usage = json.usage ?? state.usage;
      state.sawDone = true;
      state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
      return text;
    } catch {
      // Fall through to the truncated-stream error below.
    }
  }
  if (state.generationMs === null && state.ttftMs !== null) {
    state.generationMs = Date.now() - startedAt - state.ttftMs;
  }
  if (!state.sawDone) {
    throw new Error('[deepInfraApi] stream closed before terminal [DONE] marker');
  }
  return text;
}

// ─── Runner implementation ────────────────────────────────────────────────────

export class DeepInfraApiRunner implements LlmRunner {
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly providerId: ProviderId;
  protected readonly executionEnvelope: ResolvedExecutionEnvelope | undefined;
  private readonly maxTokens: number | null;
  private readonly temperature: number;
  private lastInvocationMetadata: RunnerInvocationMetadata | null = null;
  private lastWirePolicyHash: string | null = null;

  /** Override in subclasses for alternate OpenAI-compatible providers. */
  protected get apiUrl(): string {
    return 'https://api.deepinfra.com/v1/openai/chat/completions';
  }

  /**
   * @param model           Model ID.
   * @param apiKeyEnvVar    Env-var name for the API key (default: DEEPINFRA_API_KEY).
   */
  constructor(
    model: string,
    apiKeyEnvVar = 'DEEPINFRA_API_KEY',
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      provider?: ProviderId;
      explicitCredential?: string;
      env?: NodeJS.ProcessEnv;
      executionEnvelope?: ResolvedExecutionEnvelope;
    } = {},
  ) {
    const provider = credential.provider ?? 'deepinfra';
    this.providerId = provider;
    this.executionEnvelope = credential.executionEnvelope;
    if (this.executionEnvelope && this.executionEnvelope.provider.gateway !== provider) {
      throw new Error(
        `[deepInfraApi] execution envelope gateway ${this.executionEnvelope.provider.gateway} does not match ${provider}.`,
      );
    }
    if (this.executionEnvelope && this.executionEnvelope.model.resolved !== model) {
      throw new Error(
        `[deepInfraApi] execution envelope model ${this.executionEnvelope.model.resolved} does not match ${model}.`,
      );
    }
    this.apiKey = credential.explicitCredential ?? resolveProviderCredential(provider, {
      envVarOverride: apiKeyEnvVar,
      ...(credential.env ? { env: credential.env } : {}),
    }) ?? '';
    this.model = model;
    this.maxTokens = this.executionEnvelope
      ? this.executionEnvelope.output.effective ?? null
      : typeof sampling.maxTokens === 'number' && Number.isFinite(sampling.maxTokens) && sampling.maxTokens > 0
        ? Math.floor(sampling.maxTokens)
        : MAX_TOKENS;
    this.temperature =
      typeof sampling.temperature === 'number' && Number.isFinite(sampling.temperature)
        ? sampling.temperature
        : 0;
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    if (!this.lastInvocationMetadata) return null;
    return this.executionEnvelope
      ? {
          ...this.lastInvocationMetadata,
          execution_envelope_hash: this.executionEnvelope.configurationHash,
          wire_policy_hash: this.lastWirePolicyHash,
          requested_output_budget: this.executionEnvelope.output.requested ?? null,
          effective_output_budget: this.executionEnvelope.output.effective ?? null,
        }
      : this.lastInvocationMetadata;
  }

  /** Provider-specific exact-route checks run after response identity is captured. */
  protected validateObservedModelId(_observedModelId: string | null): void {
    // Providers that do not guarantee response model identity remain UNKNOWN;
    // callers must not infer model blame from a missing observation.
  }

  /** Provider-specific route validation runs after the gateway response is observed. */
  protected validateObservedUpstream(_upstreamProvider: string | null): void {
    // Generic providers do not expose an upstream identity.
  }

  /** Provider-specific router metadata validation runs after routing evidence is captured. */
  protected validateObservedRouterMetadata(
    _routerMetadata: unknown,
    _observedModelId: string | null,
    _upstreamProvider: string | null,
  ): void {
    // Generic providers do not expose gateway routing metadata.
  }

  /** Provider-specific request fields, empty for generic OpenAI-compatible APIs. */
  protected getRequestBodyExtras(): Record<string, unknown> {
    return {};
  }

  /** Provider-specific request headers, empty for generic APIs. */
  protected getRequestHeadersExtras(): Record<string, string> {
    return {};
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
    streamState: StreamingState;
  }> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;
    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: 'Contacting model' });
    }

    const isStreaming = !!callbacks?.onChunk;
    const requestMaxRetries = getRequestMaxRetries();
    const requestTimeoutMs = getRequestTimeoutMs();
    const streamMaxRetries = isStreaming ? getStreamMaxRetries() : 0;
    const maxAttempts = requestMaxRetries + streamMaxRetries;

    const buildBody = () => {
      const envelopeBody = this.executionEnvelope
        ? buildWireRequestFromEnvelope(this.executionEnvelope, {
            stream: isStreaming,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          })
          : {
            model: this.model,
            ...(this.maxTokens === null ? {} : { max_tokens: this.maxTokens }),
            temperature: this.temperature,
          };
      return JSON.stringify({
        ...envelopeBody,
        stream: isStreaming,
        ...this.getRequestBodyExtras(),
        messages: ('messages' in envelopeBody ? envelopeBody.messages : undefined) ?? [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      });
    };
    const inferenceId = randomUUID();
    const requestBody = buildBody();
    this.lastWirePolicyHash = this.executionEnvelope
      ? hashWirePolicy(JSON.parse(requestBody) as WireRequest)
      : null;
    const inputDigest = createHash('sha256').update(requestBody).digest('hex');
    callbacks?.onInvocationStarted?.({
      inference_id: inferenceId,
      provider: this.providerId,
      requested_model_id: this.model,
      normalized_model_id: this.model,
      sent_model_id: this.model,
      input_digest: inputDigest,
      input_message_count: 2,
      ...(this.executionEnvelope
        ? {
            execution_envelope_hash: this.executionEnvelope.configurationHash,
            ...(this.lastWirePolicyHash === null ? {} : { wire_policy_hash: this.lastWirePolicyHash }),
            requested_output_budget: this.executionEnvelope.output.requested ?? null,
            effective_output_budget: this.executionEnvelope.output.effective ?? null,
          }
        : {}),
    });
    let completionSent = false;
    let lastAttempt = 0;
    const notifyCompleted = (
      status: 'delivered' | 'failed',
      observedModelId: string | null,
      outputText: string,
      upstreamProvider: string | null = null,
      routerMetadata: OpenRouterResponseMetadata | null = null,
      finishReason: string | null = null,
      configuredOutputBudget: number | null = null,
      options: {
        actualAttempt?: number;
        details?: ProviderFailureDetails;
        failureStage?: import('./base.js').ProviderFailureStage;
        partialModelOutput?: boolean;
        toolCallCount?: number;
        outputMaterial?: string;
      } = {},
    ): void => {
      if (completionSent) return;
      completionSent = true;
      const router = routerMetadataProvenance(routerMetadata);
      const finish = normalizeBabelFinishReason({
        raw: finishReason,
        configuredOutputBudget,
        ...(status === 'failed'
          ? options.failureStage === 'response_normalization'
            ? { protocolError: true }
            : { providerError: true }
          : {}),
      });
      const failureReceipt =
        status === 'failed'
          ? buildProviderFailureReceipt({
              inferenceId,
              provider: this.providerId,
              model: this.model,
              details: options.details ?? {},
              observedUpstream: upstreamProvider,
              actualAttempt: options.actualAttempt ?? lastAttempt,
              maxAttempts,
              stream: isStreaming,
              failureStage: options.failureStage ?? 'unknown',
              inferenceStarted: true,
              partialModelOutput: options.partialModelOutput ?? false,
              toolCallCount: options.toolCallCount,
              requestedOutputBudget: this.executionEnvelope?.output.requested,
              effectiveOutputBudget: this.executionEnvelope?.output.effective,
              wirePolicyHash: this.lastWirePolicyHash,
              executionEnvelopeHash: this.executionEnvelope?.configurationHash,
              outputMaterial: options.outputMaterial ?? outputText,
            })
          : undefined;
      const completion = {
        inference_id: inferenceId,
        provider: this.providerId,
        model: this.model,
        status,
        observed_model_id: observedModelId,
        upstream_provider: upstreamProvider,
        output_digest: createHash('sha256').update(outputText).digest('hex'),
        ...(router === null ? {} : {
          actual_endpoint_id: router.selectedEndpoint,
          fallback_status: router.fallbackOccurred ? 'occurred' as const : 'none' as const,
          router_metadata_hash: router.hash,
          openrouter_router_attempt: router.attemptCount,
        }),
        normalized_finish_reason: finish.normalized,
        failure_attribution: finish.attribution.kind,
        ...(this.executionEnvelope
          ? {
              requested_output_budget: this.executionEnvelope.output.requested ?? null,
              effective_output_budget: this.executionEnvelope.output.effective ?? null,
              wire_policy_hash: this.lastWirePolicyHash,
              execution_envelope_hash: this.executionEnvelope.configurationHash,
            }
          : {}),
        ...(failureReceipt === undefined
          ? {}
          : {
              failure_receipt: failureReceipt,
              failure_class: failureReceipt.failure_class,
              failure_stage: failureReceipt.failure_stage,
              provider_request_id: failureReceipt.provider_request_id,
              api_error_code: failureReceipt.api_error_code,
              http_status: failureReceipt.http_status,
              actual_attempt: failureReceipt.actual_attempt,
              max_attempts: failureReceipt.max_attempts,
              stream: failureReceipt.stream,
              inference_started: failureReceipt.inference_started,
              partial_model_output: failureReceipt.partial_model_output,
              retryable: failureReceipt.retryable,
              tool_call_count: failureReceipt.tool_call_count,
            }),
      };
      callbacks?.onInvocationCompleted?.(completion);
    };
    const notifyPhase = (
      phase: ProviderInvocationPhase,
      statusCode?: number,
      detail?: string,
    ): void => {
      callbacks?.onInvocationPhase?.({
        inference_id: inferenceId,
        provider: this.providerId,
        model: this.model,
        phase,
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    };
    notifyPhase('request_created');

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
        upstreamProvider: null as string | null,
        routerMetadata: null as OpenRouterResponseMetadata | null,
        finishReason: null as string | null,
        partialModelOutput: false,
        outputReceipt: '',
        sawDone: false,
      };
      let firstChunkReceived = false;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const parsed = parseSseLine(line);
          if (parsed.observedModelId) {
            streamState.observedModelId = parsed.observedModelId;
          }
          if (parsed.upstreamProvider) {
            streamState.upstreamProvider = parsed.upstreamProvider;
          }
          if (parsed.routerMetadata) {
            streamState.routerMetadata = parsed.routerMetadata;
          }
          if (parsed.finishReason) {
            streamState.finishReason = parsed.finishReason;
          }
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
            recordStreamingOutput(streamState, 'text', parsed.delta);
            if (callbacks?.onChunk) {
              await callbacks.onChunk(parsed.delta);
            }
          }
          if (parsed.reasoning) {
            recordStreamingOutput(streamState, 'reasoning', parsed.reasoning);
            callbacks?.onThought?.(parsed.reasoning);
          }
          if (parsed.usage) {
            streamState.usage = parsed.usage;
          }
        }
      }
      if (streamState.generationMs === null && streamState.ttftMs !== null) {
        streamState.generationMs = Date.now() - startedAt - streamState.ttftMs;
      }
      this.validateObservedModelId(streamState.observedModelId);
      this.validateObservedUpstream(streamState.upstreamProvider);
      this.validateObservedRouterMetadata(streamState.routerMetadata, streamState.observedModelId, streamState.upstreamProvider);
      notifyCompleted('delivered', streamState.observedModelId, text, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens);
      return { text, startedAt, streamState };
    }

    // ── HTTP request loop ────────────────────────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    let retryAttempt: number | null = null;
    const settleRetry = (outcome: 'succeeded' | 'failed' | 'cancelled'): void => {
      if (retryAttempt === null) return;
      callbacks?.onRetrySettled?.({
        provider: this.providerId, model: this.model, attempt: retryAttempt, outcome,
      });
      retryAttempt = null;
    };
    for (let attempt = 1; attempt <= requestMaxRetries; attempt += 1) {
      lastAttempt = attempt;
      const controller = new AbortController();
      // Link external abort signal so Esc/Ctrl+C cancels in-flight HTTP requests
      let onExternalAbort: (() => void) | undefined;
      if (signal) {
        onExternalAbort = () => controller.abort();
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        notifyPhase('request_dispatched', undefined, `attempt ${attempt}`);
        response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...this.getRequestHeadersExtras(),
          },
          body: requestBody,
        });
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
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
          const retryDelay = retryDelayMs(attempt);
          settleRetry('failed');
          retryAttempt = attempt + 1;
          callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt, reason: isAbortError(err) ? 'timeout' : 'transport', backoff_ms: retryDelay });
          await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry('cancelled');
            throw error;
          });
          continue;
        }
        settleRetry('failed');
        notifyPhase('provider_error', undefined, isAbortError(err) ? 'timeout' : 'transport');
        notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
          actualAttempt: attempt,
          details: { message: lastError.message },
          failureStage: 'request',
        });
        throw lastError;
      } finally {
        clearTimeout(timeout);
        if (signal && onExternalAbort) {
          signal.removeEventListener('abort', onExternalAbort);
        }
      }

      notifyPhase('response_started', response.status);

      if (response.ok || !isRetryableStatus(response.status) || attempt === requestMaxRetries) {
        break;
      }
      if (callbacks?.onProgress) {
        callbacks.onProgress({ state: 'Retrying response', details: `HTTP ${response.status}` });
      }
      const retryDelay = retryDelayMs(attempt, response);
      settleRetry('failed');
          retryAttempt = attempt + 1;
      callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt, reason: response.status === 429 ? 'rate_limit' : response.status === 408 ? 'timeout' : 'server_error', backoff_ms: retryDelay });
      await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry('cancelled');
            throw error;
          });
    }

    if (!response) {
      notifyPhase('provider_error', undefined, 'no_response');
      notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: { message: lastError?.message ?? 'no response' },
        failureStage: 'request',
      });
      throw (
        lastError ??
        new Error(`[deepInfraApi] request failed before receiving a response (${this.model})`)
      );
    }

    if (!response.ok) {
      settleRetry('failed');
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
      notifyPhase('provider_error', response.status, 'http_error');
      notifyCompleted('failed', null, body, null, null, null, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: {
          status: response.status,
          message: body,
          apiErrorCode: providerErrorCodeFromBody(body),
          providerRequestId: providerRequestIdFromResponse(response),
        },
        failureStage: 'response',
      });
      const retryNote = isRetryableStatus(response.status)
        ? ` after ${REQUEST_MAX_RETRIES} attempt(s)`
        : '';
      throw new Error(
        `[deepInfraApi] HTTP ${response.status}${retryNote} (${this.model}): ${body}`,
      );
    }

    settleRetry('succeeded');

    parseRateLimitHeaders(response.headers, this.providerId);

    // ── Read response (streaming or non-streaming) ────────────────────────────
    let text = '';
    const streamState = {
      ttftMs: null as number | null,
      generationMs: null as number | null,
      usage: null as ChatResponse['usage'] | null,
      observedModelId: null as string | null,
      upstreamProvider: null as string | null,
      routerMetadata: null as OpenRouterResponseMetadata | null,
      finishReason: null as string | null,
      partialModelOutput: false,
      outputReceipt: '',
      sawDone: false,
    };

    if (isStreaming && !response.body) {
      const error = new Error('[deepInfraApi] Streaming response had no body.');
      notifyPhase('provider_error', response.status, 'missing_stream_body');
      notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: { status: response.status, message: error.message },
        failureStage: 'stream',
      });
      throw error;
    }

    if (isStreaming) {
      const streamIdleTimeoutMs = getStreamIdleTimeoutMs();
      for (let streamAttempt = 0; streamAttempt <= streamMaxRetries; streamAttempt += 1) {
        const vcrRecorder = createVcrRecorder();
        let progressPhaseCount = 0;
        try {
          text = await readStreamingResponse(
            response,
            callbacks,
            streamIdleTimeoutMs,
            startedAt,
            streamState,
            vcrRecorder ?? undefined,
            () => notifyPhase('first_byte'),
            (bytes) => {
              if (progressPhaseCount < 32) {
                progressPhaseCount += 1;
                notifyPhase('stream_progress', undefined, `bytes=${bytes}`);
              }
            },
          );
          vcrRecorder?.close();
          break;
        } catch (error: unknown) {
          vcrRecorder?.close();
          if (
            !isStreamIdleTimeoutError(error) ||
            streamState.partialModelOutput ||
            streamAttempt >= streamMaxRetries
          ) {
            settleRetry(isAbortError(error) ? 'cancelled' : 'failed');
            notifyPhase('provider_error', undefined, isAbortError(error) ? 'timeout' : 'stream');
            notifyCompleted(
              'failed',
              streamState.observedModelId,
              text,
              streamState.upstreamProvider,
              streamState.routerMetadata,
              streamState.finishReason,
              this.maxTokens,
              {
                actualAttempt: lastAttempt,
                details: {
                  message: error instanceof Error ? error.message : String(error),
                  providerRequestId: providerRequestIdFromResponse(response),
                },
                failureStage: isStreamIdleTimeoutError(error) ? 'stream' : 'stream',
                partialModelOutput: streamState.partialModelOutput,
                outputMaterial: streamState.outputReceipt,
              },
            );
            throw error;
          }
          if (callbacks?.onProgress) {
            callbacks.onProgress({ state: 'Retrying response', details: 'Stream idle timeout' });
          }
          const retryDelay = retryDelayMs(streamAttempt + 1);
          settleRetry('failed');
          retryAttempt = streamAttempt + 2;
          callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt, reason: 'stream_idle', backoff_ms: retryDelay });
          await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry('cancelled');
            throw error;
          });
          const controller = new AbortController();
          let onStreamRetryAbort: (() => void) | undefined;
          if (signal) {
            onStreamRetryAbort = () => controller.abort();
            signal.addEventListener('abort', onStreamRetryAbort, { once: true });
          }
          const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
          lastAttempt += 1;
          try {
            response = await fetch(this.apiUrl, {
              method: 'POST',
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                ...this.getRequestHeadersExtras(),
              },
              body: requestBody,
            });
          } catch (error) {
            settleRetry(signal?.aborted ? 'cancelled' : 'failed');
            notifyPhase('provider_error', undefined, signal?.aborted ? 'timeout' : 'transport');
            notifyCompleted('failed', streamState.observedModelId, text, streamState.upstreamProvider, null, null, this.maxTokens, {
              actualAttempt: lastAttempt,
              details: { message: error instanceof Error ? error.message : String(error) },
              failureStage: 'request',
              partialModelOutput: streamState.partialModelOutput,
              outputMaterial: streamState.outputReceipt,
            });
            throw error;
          } finally {
            clearTimeout(timeout);
            if (signal && onStreamRetryAbort) {
              signal.removeEventListener('abort', onStreamRetryAbort);
            }
          }
          // Parse rate-limit headers on the retry response too — the widget needs fresh quota data.
          parseRateLimitHeaders(response.headers, this.providerId);
          if (!response.ok) {
            settleRetry('failed');
            const body = await readErrorBody(response);
            notifyPhase('provider_error', response.status, 'stream_retry_http_error');
            notifyCompleted('failed', streamState.observedModelId, body, streamState.upstreamProvider, null, null, this.maxTokens, {
              actualAttempt: lastAttempt,
              details: {
                status: response.status,
                message: body,
                apiErrorCode: providerErrorCodeFromBody(body),
                providerRequestId: providerRequestIdFromResponse(response),
              },
              failureStage: 'response',
              partialModelOutput: streamState.partialModelOutput,
              outputMaterial: streamState.outputReceipt,
            });
            throw new Error(
              `[deepInfraApi] HTTP ${response.status} during stream retry (${this.model}): ${body}`,
            );
          }
          settleRetry('succeeded');
        }
      }
      this.lastInvocationMetadata = buildInvocationMetadata(
        this.providerId,
        this.model,
        Date.now() - startedAt,
        streamState.usage ?? undefined,
        streamState.ttftMs,
        streamState.generationMs,
        undefined,
        streamState.observedModelId,
        streamState.upstreamProvider,
        streamState.routerMetadata,
        streamState.finishReason,
        this.maxTokens,
      );
    } else {
      let data: ChatResponse;
      let rawDataText = '';
      try {
        rawDataText = await response.text();
        if (rawDataText.length > 0) notifyPhase('first_byte');
        data = JSON.parse(rawDataText) as ChatResponse;
        this.lastInvocationMetadata = buildInvocationMetadata(
          this.providerId,
          this.model,
          Date.now() - startedAt,
          data.usage,
          undefined,
          undefined,
          undefined,
          data.model,
          upstreamProviderFromResponse(data),
          data.openrouter_metadata ?? null,
          data.choices?.[0]?.finish_reason ?? null,
          this.maxTokens,
        );
        streamState.observedModelId = data.model ?? null;
        streamState.upstreamProvider = upstreamProviderFromResponse(data);
        streamState.routerMetadata = data.openrouter_metadata ?? null;
        streamState.finishReason = data.choices?.[0]?.finish_reason ?? null;
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
        notifyPhase('provider_error', undefined, 'response_parse');
        notifyPhase('response_normalization_failed', undefined, 'response_parse');
        notifyCompleted('failed', null, rawDataText, null, null, null, this.maxTokens, {
          actualAttempt: lastAttempt,
          details: { message: err instanceof Error ? err.message : String(err) },
          failureStage: 'response_normalization',
          outputMaterial: rawDataText,
        });
        throw buildStructuredOutputError({
          failure_kind: 'failed_to_parse_api_json',
          provider: this.providerId,
          model: this.model,
          message: `[deepInfraApi] Failed to parse API response as JSON: ${String(err)}`,
          raw_output: rawDataText,
          cause: err instanceof Error ? err : undefined,
        });
      }
      text = data?.choices?.[0]?.message?.content ?? '';
    }

    if (isStreaming) notifyPhase('stream_completed');
    try {
      this.validateObservedModelId(streamState.observedModelId);
      this.validateObservedUpstream(streamState.upstreamProvider);
      this.validateObservedRouterMetadata(streamState.routerMetadata, streamState.observedModelId, streamState.upstreamProvider);
      notifyPhase('response_normalized');
      notifyCompleted('delivered', streamState.observedModelId, text, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens);
    } catch (error) {
      notifyCompleted('failed', streamState.observedModelId, text, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: { message: error instanceof Error ? error.message : String(error) },
        failureStage: 'response_normalization',
        partialModelOutput: streamState.partialModelOutput,
        outputMaterial: streamState.outputReceipt,
      });
      throw error;
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
        provider: this.providerId,
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
        provider: this.providerId,
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
      this.providerId,
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
      streamState.observedModelId ?? this.lastInvocationMetadata?.observed_model_id ?? null,
      streamState.upstreamProvider ?? this.lastInvocationMetadata?.upstream_provider ?? null,
      streamState.routerMetadata,
      streamState.finishReason,
      this.maxTokens,
    );

    if (!result.success) {
      throw buildStructuredOutputError({
        failure_kind: 'zod_validation_failed',
        provider: this.providerId,
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
        provider: this.providerId,
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
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<string, void, undefined> {
    const chunks: string[] = [];
    let pending: (() => void) | null = null;
    let finished = false;
    let error: Error | null = null;

    const execPromise = this._executeRequest(
      prompt,
      {
        ...callbacks,
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
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<ToolStreamEvent, void, undefined> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;
    const requestTimeoutMs = getRequestTimeoutMs();
    const requestMaxRetries = getRequestMaxRetries();
    const streamIdleTimeoutMs = getStreamIdleTimeoutMs();
    const maxAttempts = requestMaxRetries;

    if (this.executionEnvelope && !this.executionEnvelope.tools.effective) {
      throw new Error('[deepInfraApi] tools were requested but the resolved envelope disabled tools.');
    }
    const buildBody = () => {
      const envelopeBody = this.executionEnvelope
        ? buildWireRequestFromEnvelope(this.executionEnvelope, {
            stream: true,
            messages,
            tools,
            toolChoice: toolChoice ?? 'auto',
          })
        : {
            model: this.model,
            ...(this.maxTokens === null ? {} : { max_tokens: this.maxTokens }),
            temperature: this.temperature,
            tools,
            tool_choice: (toolChoice ?? 'auto') as 'auto' | 'required',
            messages: mapProviderMessages(messages, CHAT_SYSTEM_PROMPT, systemPrompt),
          };
      return JSON.stringify({
        ...envelopeBody,
        stream: true,
        ...this.getRequestBodyExtras(),
        messages: this.executionEnvelope
          ? envelopeBody.messages
          : mapProviderMessages(messages, CHAT_SYSTEM_PROMPT, systemPrompt),
      });
    };
    const inferenceId = randomUUID();
    const requestBody = buildBody();
    this.lastWirePolicyHash = this.executionEnvelope
      ? hashWirePolicy(JSON.parse(requestBody) as WireRequest)
      : null;
    const inputDigest = createHash('sha256').update(requestBody).digest('hex');
    callbacks?.onInvocationStarted?.({
      inference_id: inferenceId,
      provider: this.providerId,
      requested_model_id: this.model,
      normalized_model_id: this.model,
      sent_model_id: this.model,
      input_digest: inputDigest,
      input_message_count: messages.length + 1,
      ...(this.executionEnvelope
        ? {
            execution_envelope_hash: this.executionEnvelope.configurationHash,
            ...(this.lastWirePolicyHash === null ? {} : { wire_policy_hash: this.lastWirePolicyHash }),
            requested_output_budget: this.executionEnvelope.output.requested ?? null,
            effective_output_budget: this.executionEnvelope.output.effective ?? null,
          }
        : {}),
      capability_bindings: tools.map((tool) => ({
        capability: tool.function.name,
        advertised: true,
        authorized: null,
        effective: null,
      })),
      delivered_tool_call_ids: messages.flatMap((message) =>
        message.role === 'tool' && message.tool_call_id ? [message.tool_call_id] : [],
      ),
    });
    let completionSent = false;
    let lastAttempt = 0;
    const notifyCompleted = (
      status: 'delivered' | 'failed',
      observedModelId: string | null,
      outputText: string,
      upstreamProvider: string | null = null,
      routerMetadata: OpenRouterResponseMetadata | null = null,
      finishReason: string | null = null,
      configuredOutputBudget: number | null = null,
      options: {
        actualAttempt?: number;
        details?: ProviderFailureDetails;
        failureStage?: import('./base.js').ProviderFailureStage;
        partialModelOutput?: boolean;
        toolCallCount?: number;
        outputMaterial?: string;
      } = {},
    ): void => {
      if (completionSent) return;
      completionSent = true;
      const router = routerMetadataProvenance(routerMetadata);
      const finish = normalizeBabelFinishReason({
        raw: finishReason,
        configuredOutputBudget,
        ...(status === 'failed'
          ? options.failureStage === 'response_normalization'
            ? { protocolError: true }
            : { providerError: true }
          : {}),
      });
      const failureReceipt =
        status === 'failed'
          ? buildProviderFailureReceipt({
              inferenceId,
              provider: this.providerId,
              model: this.model,
              details: options.details ?? {},
              observedUpstream: upstreamProvider,
              actualAttempt: options.actualAttempt ?? lastAttempt,
              maxAttempts,
              stream: true,
              failureStage: options.failureStage ?? 'unknown',
              inferenceStarted: true,
              partialModelOutput: options.partialModelOutput ?? false,
              toolCallCount: options.toolCallCount,
              requestedOutputBudget: this.executionEnvelope?.output.requested,
              effectiveOutputBudget: this.executionEnvelope?.output.effective,
              wirePolicyHash: this.lastWirePolicyHash,
              executionEnvelopeHash: this.executionEnvelope?.configurationHash,
              outputMaterial: options.outputMaterial ?? outputText,
            })
          : undefined;
      const completion = {
        inference_id: inferenceId,
        provider: this.providerId,
        model: this.model,
        status,
        observed_model_id: observedModelId,
        upstream_provider: upstreamProvider,
        output_digest: createHash('sha256').update(outputText).digest('hex'),
        ...(router === null ? {} : {
          actual_endpoint_id: router.selectedEndpoint,
          fallback_status: router.fallbackOccurred ? 'occurred' as const : 'none' as const,
          router_metadata_hash: router.hash,
          openrouter_router_attempt: router.attemptCount,
        }),
        normalized_finish_reason: finish.normalized,
        failure_attribution: finish.attribution.kind,
        ...(this.executionEnvelope
          ? {
              requested_output_budget: this.executionEnvelope.output.requested ?? null,
              effective_output_budget: this.executionEnvelope.output.effective ?? null,
              wire_policy_hash: this.lastWirePolicyHash,
              execution_envelope_hash: this.executionEnvelope.configurationHash,
            }
          : {}),
        ...(failureReceipt === undefined
          ? {}
          : {
              failure_receipt: failureReceipt,
              failure_class: failureReceipt.failure_class,
              failure_stage: failureReceipt.failure_stage,
              provider_request_id: failureReceipt.provider_request_id,
              api_error_code: failureReceipt.api_error_code,
              http_status: failureReceipt.http_status,
              actual_attempt: failureReceipt.actual_attempt,
              max_attempts: failureReceipt.max_attempts,
              stream: failureReceipt.stream,
              inference_started: failureReceipt.inference_started,
              partial_model_output: failureReceipt.partial_model_output,
              retryable: failureReceipt.retryable,
              tool_call_count: failureReceipt.tool_call_count,
            }),
      };
      callbacks?.onInvocationCompleted?.(completion);
    };
    const notifyPhase = (
      phase: ProviderInvocationPhase,
      statusCode?: number,
      detail?: string,
    ): void => {
      callbacks?.onInvocationPhase?.({
        inference_id: inferenceId,
        provider: this.providerId,
        model: this.model,
        phase,
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    };
    notifyPhase('request_created');

    // ── HTTP request loop (with retries) ─────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    let retryAttempt: number | null = null;
    const settleRetry = (outcome: 'succeeded' | 'failed' | 'cancelled'): void => {
      if (retryAttempt === null) return;
      callbacks?.onRetrySettled?.({
        provider: this.providerId, model: this.model, attempt: retryAttempt, outcome,
      });
      retryAttempt = null;
    };

    for (let attempt = 1; attempt <= requestMaxRetries; attempt += 1) {
      lastAttempt = attempt;
      const controller = new AbortController();
      let onExternalAbort: (() => void) | undefined;
      if (signal) {
        onExternalAbort = () => controller.abort();
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        notifyPhase('request_dispatched', undefined, `attempt ${attempt}`);
        response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            ...this.getRequestHeadersExtras(),
          },
          body: requestBody,
        });
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
        lastError = new Error(
          isAbortError(err)
            ? `[deepInfraApi] request timeout after ${requestTimeoutMs}ms (${this.model})`
            : `[deepInfraApi] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < requestMaxRetries) {
          const retryDelay = retryDelayMs(attempt);
          settleRetry('failed');
          retryAttempt = attempt + 1;
          callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt, reason: isAbortError(err) ? 'timeout' : 'transport', backoff_ms: retryDelay });
          await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry('cancelled');
            throw error;
          });
          continue;
        }
        settleRetry('failed');
        notifyPhase('provider_error', undefined, isAbortError(err) ? 'timeout' : 'transport');
        notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
          actualAttempt: attempt,
          details: { message: lastError.message },
          failureStage: 'request',
        });
        yield { type: 'error', message: lastError.message };
        return;
      } finally {
        clearTimeout(timeout);
        if (signal && onExternalAbort) {
          signal.removeEventListener('abort', onExternalAbort);
        }
      }

      notifyPhase('response_started', response.status);
      if (response.ok || !isRetryableStatus(response.status) || attempt === requestMaxRetries) {
        break;
      }
      const retryDelay = retryDelayMs(attempt, response);
      settleRetry('failed');
          retryAttempt = attempt + 1;
      callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt, reason: response.status === 429 ? 'rate_limit' : response.status === 408 ? 'timeout' : 'server_error', backoff_ms: retryDelay });
      await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry('cancelled');
            throw error;
          });
    }

    if (!response) {
      notifyPhase('provider_error', undefined, 'no_response');
      notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: { message: lastError?.message ?? 'no response' },
        failureStage: 'request',
      });
      yield { type: 'error', message: lastError?.message ?? '[deepInfraApi] No response received' };
      return;
    }

    if (!response.ok) {
      settleRetry('failed');
      const body = await readErrorBody(response);
      this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
      notifyPhase('provider_error', response.status, 'http_error');
      notifyCompleted('failed', null, body, null, null, null, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: {
          status: response.status,
          message: body,
          apiErrorCode: providerErrorCodeFromBody(body),
          providerRequestId: providerRequestIdFromResponse(response),
        },
        failureStage: 'response',
      });
      yield { type: 'error', message: `[deepInfraApi] HTTP ${response.status} (${this.model}): ${body}` };
      return;
    }

    settleRetry('succeeded');

    parseRateLimitHeaders(response.headers, this.providerId);

    // ── SSE streaming with tool call accumulation ────────────────────────
    if (!response.body) {
      notifyPhase('provider_error', undefined, 'missing_stream_body');
      notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: { status: response.status, message: 'missing streaming response body' },
        failureStage: 'stream',
      });
      yield { type: 'error', message: '[deepInfraApi] Streaming response had no body.' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunkReceived = false;
    let totalBytes = 0;
    let progressPhaseCount = 0;
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let outputReceipt = '';
    let partialModelOutput = false;
    let toolCallCount = 0;
    let invocationFailed = false;
    let sawDone = false;

    const streamState: StreamingState = {
      ttftMs: null,
      generationMs: null,
      usage: null,
      observedModelId: null,
      upstreamProvider: null,
      routerMetadata: null,
      finishReason: null,
      partialModelOutput: false,
      outputReceipt: '',
      sawDone: false,
    };

    try {
      let finishReason: string | null = null;

      while (true) {
        let readTimeout: ReturnType<typeof setTimeout> | null = null;
        const read = reader.read();
        const idle = new Promise<never>((_, reject) => {
          readTimeout = setTimeout(() => {
            reject(
              new Error(`[deepInfraApi] stream idle timeout after ${streamIdleTimeoutMs}ms`),
            );
            reader.cancel().catch(() => {});
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
          invocationFailed = true;
          notifyPhase('provider_error', undefined, 'stream');
          // Every invocation must have a durable terminal receipt, including
          // reader stalls/cancellation that exit before the outer stream
          // finalizer runs.
          notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
            actualAttempt: lastAttempt,
            details: {
              message: err instanceof Error ? err.message : String(err),
              providerRequestId: providerRequestIdFromResponse(response),
            },
            failureStage: 'stream',
            partialModelOutput,
            toolCallCount,
            outputMaterial: outputReceipt,
          });
          yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
          return;
        }

        if (done) break;

        totalBytes += value?.byteLength ?? 0;
        if (progressPhaseCount < 32) {
          progressPhaseCount += 1;
          notifyPhase('stream_progress', undefined, `bytes=${totalBytes}`);
        }

        if (!firstChunkReceived) {
          firstChunkReceived = true;
          streamState.ttftMs = Date.now() - startedAt;
          notifyPhase('first_byte');
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
          if (data === '[DONE]') {
            sawDone = true;
            streamState.sawDone = true;
            continue;
          }

          try {
            const json = JSON.parse(data) as {
              model?: string;
              provider?: string;
              openrouter_metadata?: OpenRouterResponseMetadata;
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
            const upstreamProvider = upstreamProviderFromResponse(json);
            if (upstreamProvider) streamState.upstreamProvider = upstreamProvider;
            if (json.openrouter_metadata) streamState.routerMetadata = json.openrouter_metadata;

            const choice = json.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta;

            if (delta?.reasoning_content) {
              partialModelOutput = true;
              streamState.partialModelOutput = true;
              outputReceipt += `reasoning:${delta.reasoning_content}\n`;
              streamState.outputReceipt = outputReceipt;
              yield { type: 'thought_delta', text: delta.reasoning_content };
            }

            if (delta?.content) {
              partialModelOutput = true;
              streamState.partialModelOutput = true;
              outputReceipt += delta.content;
              streamState.outputReceipt = outputReceipt;
              yield { type: 'text_delta', text: delta.content };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, { id: '', name: '', arguments: '' });
                  toolCallCount += 1;
                }
                const acc = pendingToolCalls.get(idx)!;
                if (tc.id) {
                  acc.id = tc.id;
                  partialModelOutput = true;
                  streamState.partialModelOutput = true;
                  outputReceipt += `tool_id:${tc.id}\n`;
                }
                if (tc.function?.name) {
                  acc.name = tc.function.name;
                  partialModelOutput = true;
                  streamState.partialModelOutput = true;
                  outputReceipt += `tool_name:${tc.function.name}\n`;
                }
                if (tc.function?.arguments) {
                  partialModelOutput = true;
                  streamState.partialModelOutput = true;
                  acc.arguments += tc.function.arguments;
                  outputReceipt += `tool_arguments:${tc.function.arguments}\n`;
                }
                streamState.outputReceipt = outputReceipt;
              }
            }

            if (normalizeFinishReason(choice.finish_reason)) {
              finishReason = normalizeFinishReason(choice.finish_reason);
              streamState.finishReason = finishReason;
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
      buffer += decoder.decode();
      if (buffer.trim().startsWith('data:')) {
        const trimmed = buffer.trim().replace(/\r$/, '');
        if (trimmed === 'data: [DONE]') {
          sawDone = true;
          streamState.sawDone = true;
        }
      }
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data !== '[DONE]') {
          try {
            const json = JSON.parse(data) as {
              model?: string;
              provider?: string;
              openrouter_metadata?: OpenRouterResponseMetadata;
              choices?: Array<{ finish_reason?: string | null }>;
              usage?: ChatResponse['usage'];
            };
            if (json.model) streamState.observedModelId = json.model;
            const upstreamProvider = upstreamProviderFromResponse(json);
            if (upstreamProvider) streamState.upstreamProvider = upstreamProvider;
            if (json.openrouter_metadata) streamState.routerMetadata = json.openrouter_metadata;
            if (json.usage) {
              streamState.usage = json.usage;
            }
            if (json.choices?.[0]?.finish_reason) {
              finishReason = normalizeFinishReason(json.choices[0].finish_reason);
              streamState.finishReason = finishReason;
            }
          } catch { /* ignore */ }
        }
      }

      if (!sawDone) {
        throw new Error('[deepInfraApi] stream closed before terminal [DONE] marker');
      }

      streamState.generationMs = Date.now() - startedAt - (streamState.ttftMs ?? 0);

      // ── Yield accumulated tool calls ──────────────────────────────────
      streamState.finishReason = finishReason ?? (pendingToolCalls.size > 0 ? 'tool_calls' : 'stop');
      if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && pendingToolCalls.size > 0) {
        for (const [, acc] of pendingToolCalls) {
          let input: Record<string, unknown> = {};
          if (acc.arguments) {
            try {
              const parsed = JSON.parse(acc.arguments) as unknown;
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('tool arguments must be a JSON object');
              }
              input = parsed as Record<string, unknown>;
            } catch (error) {
              invocationFailed = true;
              notifyPhase('response_normalization_failed', undefined, 'tool_arguments');
              notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
                actualAttempt: lastAttempt,
                details: { message: error instanceof Error ? error.message : String(error) },
                failureStage: 'response_normalization',
                partialModelOutput,
                toolCallCount,
                outputMaterial: outputReceipt,
              });
              yield {
                type: 'error',
                message: `[deepInfraApi] Malformed arguments for tool ${acc.name || '<unknown>'}: ${error instanceof Error ? error.message : String(error)}`,
              };
              return;
            }
          }
          yield { type: 'tool_use', id: acc.id, name: acc.name, input };
        }
        yield { type: 'done', finishReason: finishReason ?? 'tool_calls' };
      } else {
        yield { type: 'done', finishReason: finishReason ?? 'stop' };
      }
    } catch (err) {
      invocationFailed = true;
      notifyPhase('provider_error', undefined, 'stream');
      notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: {
          message: err instanceof Error ? err.message : String(err),
          providerRequestId: providerRequestIdFromResponse(response),
        },
        failureStage: 'stream',
        partialModelOutput,
        toolCallCount,
        outputMaterial: outputReceipt,
      });
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    }

    this.lastInvocationMetadata = buildInvocationMetadata(
      this.providerId,
      this.model,
      Date.now() - startedAt,
      streamState.usage ?? undefined,
      streamState.ttftMs,
      streamState.generationMs,
      undefined,
      streamState.observedModelId,
      streamState.upstreamProvider,
      streamState.routerMetadata,
      streamState.finishReason,
      this.maxTokens,
    );
    if (!invocationFailed) {
      notifyPhase('stream_completed');
      notifyPhase('response_normalized');
    }
    try {
      this.validateObservedModelId(streamState.observedModelId);
      this.validateObservedUpstream(streamState.upstreamProvider);
      this.validateObservedRouterMetadata(streamState.routerMetadata, streamState.observedModelId, streamState.upstreamProvider);
    } catch (error) {
      invocationFailed = true;
      notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
        actualAttempt: lastAttempt,
        details: { message: error instanceof Error ? error.message : String(error) },
        failureStage: 'response_normalization',
        partialModelOutput,
        toolCallCount,
        outputMaterial: outputReceipt,
      });
      throw error;
    }
    notifyCompleted(invocationFailed ? 'failed' : 'delivered', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, invocationFailed ? {
      actualAttempt: lastAttempt,
      details: { message: 'stream invocation failed' },
      failureStage: 'stream',
      partialModelOutput,
      toolCallCount,
      outputMaterial: outputReceipt,
    } : {});
  }
}
