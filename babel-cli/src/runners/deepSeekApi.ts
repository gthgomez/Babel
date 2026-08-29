/**
 * deepSeekApi.ts - Direct DeepSeek API runner (OpenAI-compatible).
 *
 * Used by live governance proof runs when DEEPSEEK_API_KEY is configured.
 * The full Babel policy can still use DeepInfra for non-DeepSeek model
 * waterfalls; this runner covers current direct DeepSeek v4 models.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import {
  parseRetryAfterHeader,
  isRetryableStatus,
  normalizeFinishReason,
  classifyProviderError,
} from "./providerNormalize.js";
import {
  type LlmRunner,
  type ProviderMessage,
  type RunnerInvocationMetadata,
  type RunnerCallbacks,
  type ProviderInvocationPhase,
  type ToolDefinition,
  type ToolStreamEvent,
  buildStructuredOutputError,
} from "./base.js";
import { mapProviderMessagesToWire } from "./providerMessages.js";
import {
  assertSupportedDeepSeekModel,
  type DeepSeekModelId,
} from "../services/deepSeekPricing.js";
import { estimateProviderUsageCost } from "../services/modelPricingRegistry.js";
import { extractJson } from "../utils/extractJson.js";
import {
  JitDenialError,
  PolicyBlockedDuplicateError,
} from "../ui/incrementalToolDetector.js";
import {
  createVcrRecorder,
  createVcrPlayer,
  type VcrRecorder,
} from "../services/streamingVcr.js";
import { parseRateLimitHeaders } from "../ui/rateLimitWidget.js";
import { resolveProviderCredential } from "./credentialHub.js";
import {
  buildProviderFailureReceipt,
  isSafeProviderRetry,
  normalizeProviderFailureClass,
  type ProviderFailureStage,
} from "./providerFailureReceipt.js";

const MAX_TOKENS = readPositiveIntEnv("BABEL_DEEPSEEK_TOKENS", 32000);
const REQUEST_TIMEOUT_MS = readPositiveIntEnv(
  "BABEL_DEEPSEEK_REQUEST_TIMEOUT_MS",
  120_000,
);
const REQUEST_MAX_RETRIES = readPositiveIntEnv(
  "BABEL_DEEPSEEK_REQUEST_MAX_RETRIES",
  3,
  10,
);
const STREAM_IDLE_TIMEOUT_MS = readPositiveIntEnv(
  "BABEL_DEEPSEEK_STREAM_IDLE_TIMEOUT_MS",
  120_000,
);
const RETRY_BASE_DELAY_MS = 200;
const API_URL = "https://api.deepseek.com/v1/chat/completions";

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "max"]);

function resolveReasoningEffort(): string | undefined {
  const raw = process.env["BABEL_REASONING_EFFORT"]?.trim().toLowerCase();
  return raw && VALID_REASONING_EFFORTS.has(raw) ? raw : undefined;
}

const SYSTEM_PROMPT =
  "You are executing a Babel pipeline agent. " +
  "Follow all instructions in the user message exactly. " +
  "Your response MUST be a single valid JSON object only - " +
  "no markdown, no explanation, no code fences. " +
  "Output only raw JSON.";

const CHAT_SYSTEM_PROMPT =
  "You are an expert software engineer in a terminal chat session. " +
  "Answer the user conversationally in natural language. " +
  "Use tools to read files and gather context as needed. " +
  "Be concise but thorough. Use markdown for formatting. " +
  "Do NOT output JSON — respond in plain natural language.";

interface ChatChoice {
  message?: { content?: string | null };
}

interface ChatResponse {
  id?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

function providerRequestId(
  response: Response | null,
  body?: ChatResponse | null,
): string | null {
  const header = response?.headers.get("x-request-id");
  if (header && header.trim()) return header.trim().slice(0, 200);
  return typeof body?.id === "string" && body.id.length > 0
    ? body.id.slice(0, 200)
    : null;
}

function providerApiErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown } | unknown;
      code?: unknown;
    };
    const code =
      typeof parsed.error === "object" && parsed.error !== null
        ? (parsed.error as { code?: unknown }).code
        : parsed.code;
    return typeof code === "string" && code.length > 0
      ? code.slice(0, 120)
      : null;
  } catch {
    return null;
  }
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildInvocationMetadata(
  model: string,
  latencyMs: number,
  usage?: ChatResponse["usage"],
  ttftMs?: number | null,
  generationMs?: number | null,
  validationMs?: number | null,
): RunnerInvocationMetadata {
  const promptTokens = normalizeTokenCount(usage?.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage?.completion_tokens);
  const promptCacheHitTokens = normalizeTokenCount(
    usage?.prompt_cache_hit_tokens,
  );
  const promptCacheMissTokens = normalizeTokenCount(
    usage?.prompt_cache_miss_tokens,
  );
  const totalTokens =
    normalizeTokenCount(usage?.total_tokens) ??
    (promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null);
  const estimate = estimateProviderUsageCost({
    provider: "deepseek",
    modelId: model,
    promptTokens,
    completionTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
  });

  return {
    provider: "deepseek",
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("Request cancelled", "AbortError"));
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readPositiveIntEnv(
  name: string,
  fallback: number,
  max?: number,
): number {
  const parsed = Number(process.env[name] ?? "");
  const value =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return max ? Math.min(value, max) : value;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = parseRetryAfterHeader(
    response?.headers.get("retry-after"),
  );
  if (retryAfter !== null) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0);
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  return Math.min(exponential + jitter, 5_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readErrorBody(response: Response): Promise<string> {
  return (await response.text().catch(() => "")).slice(0, 200);
}

async function readStreamingResponse(
  response: Response,
  callbacks: RunnerCallbacks | undefined,
  startedAt: number,
  state: {
    ttftMs: number | null;
    generationMs: number | null;
    usage: ChatResponse["usage"] | null;
  },
  vcrRecorder?: VcrRecorder,
  onFirstByte?: () => void,
  onStreamProgress?: (bytes: number) => void,
): Promise<string> {
  if (!response.body) {
    throw new Error("[deepSeekApi] Streaming response had no body.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let buffer = "";
  let firstChunkReceived = false;
  let totalBytes = 0;
  let lastContentChunkAt = Date.now();
  let terminalMarkerSeen = false;

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

    totalBytes += value?.byteLength ?? 0;
    onStreamProgress?.(totalBytes);

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
      onFirstByte?.();
      if (callbacks?.onProgress) {
        callbacks.onProgress({ state: "Receiving response" });
      }
    }

    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;

    // Some OpenAI-compatible gateways (and deterministic test doubles) may
    // return a complete JSON response even when `stream: true` was requested.
    // Treat that as a valid normalized completion instead of silently
    // discarding it as a non-SSE line.  Genuine SSE always starts with
    // `data:` (or a keepalive comment), so this branch is unambiguous.
    const nonSseProbe = buffer.trimStart();
    if (nonSseProbe.startsWith("{")) {
      let rawJson = buffer;
      while (true) {
        const remainder = await reader.read();
        if (remainder.done) break;
        totalBytes += remainder.value?.byteLength ?? 0;
        onStreamProgress?.(totalBytes);
        rawJson += decoder.decode(remainder.value, { stream: true });
      }
      rawJson += decoder.decode();
      try {
        const json = JSON.parse(rawJson) as {
          choices?: Array<{
            message?: { content?: unknown };
            delta?: { content?: unknown; reasoning_content?: unknown };
          }>;
          usage?: ChatResponse["usage"];
        };
        const choice = json.choices?.[0];
        const content =
          typeof choice?.message?.content === "string"
            ? choice.message.content
            : typeof choice?.delta?.content === "string"
              ? choice.delta.content
              : "";
        const reasoning =
          typeof choice?.delta?.reasoning_content === "string"
            ? choice.delta.reasoning_content
            : "";
        if (reasoning && callbacks?.onThought) {
          callbacks.onThought(reasoning);
        }
        if (content) {
          lastContentChunkAt = Date.now();
          text += content;
          if (callbacks?.onChunk) {
            await callbacks.onChunk(content);
          }
        }
        if (json.usage) state.usage = json.usage;
        state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
        return text;
      } catch (err) {
        if (
          err instanceof JitDenialError ||
          err instanceof PolicyBlockedDuplicateError
        ) {
          reader.cancel().catch(() => {});
          throw err;
        }
        // Fall through to the normal SSE parser so malformed data still
        // produces the existing structured-output failure path.
      }
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("data: ")) {
        vcrRecorder?.record(trimmed);
        const data = trimmed.slice(6).trim();
        if (data === "[DONE]") {
          terminalMarkerSeen = true;
          continue;
        }
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
            }>;
            usage?: ChatResponse["usage"];
          };
          const delta = json.choices?.[0]?.delta?.content || "";
          const reasoning = json.choices?.[0]?.delta?.reasoning_content || "";
          if (reasoning || delta) {
            lastContentChunkAt = Date.now();
          }
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
          if (
            err instanceof JitDenialError ||
            err instanceof PolicyBlockedDuplicateError
          ) {
            reader.cancel().catch(() => {});
            throw err;
          }
          // Ignore partial/invalid chunks.
        }
      }
    }
  }

  if (buffer.startsWith("data: ")) {
    vcrRecorder?.record(buffer);
    const data = buffer.slice(6).trim();
    if (data === "[DONE]") {
      terminalMarkerSeen = true;
    } else {
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string };
          }>;
          usage?: ChatResponse["usage"];
        };
        const delta = json.choices?.[0]?.delta?.content || "";
        const reasoning = json.choices?.[0]?.delta?.reasoning_content || "";
        if (reasoning || delta) {
          lastContentChunkAt = Date.now();
        }
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
        if (
          err instanceof JitDenialError ||
          err instanceof PolicyBlockedDuplicateError
        ) {
          reader.cancel().catch(() => {});
          throw err;
        }
        // Ignore
      }
    }
  }

  if (!terminalMarkerSeen) {
    throw new Error(
      "[deepSeekApi] incomplete stream: terminal marker was not received",
    );
  }
  state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
  return text;
}

export class DeepSeekApiRunner implements LlmRunner {
  private readonly apiKey: string;
  private readonly model: DeepSeekModelId;
  private lastInvocationMetadata: RunnerInvocationMetadata | null = null;

  constructor(
    model = "deepseek-v4-flash",
    credential: { explicitCredential?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    const key = resolveProviderCredential("deepseek", credential);
    if (key === null)
      throw new Error("[deepSeekApi] credential resolution failed");
    // Validate expected provider shape without including any secret fragment.
    if (!key.startsWith("sk-")) {
      throw new Error(
        "[deepSeekApi] DEEPSEEK_API_KEY has an invalid format. " +
          "Check the host environment and babel-cli/.env precedence.",
      );
    }
    this.apiKey = key;
    this.model = assertSupportedDeepSeekModel(model);
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
    streamState: {
      ttftMs: number | null;
      generationMs: number | null;
      usage: ChatResponse["usage"] | null;
    };
  }> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;
    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: "Contacting model" });
    }

    const isStreaming = !!callbacks?.onChunk;

    const buildBody = () => {
      const effort = resolveReasoningEffort();
      const thinkingEnabled =
        process.env["BABEL_DEEPSEEK_THINKING"] !== "disabled";
      return JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        ...(raw ? {} : { response_format: { type: "json_object" as const } }),
        stream: isStreaming,
        ...(isStreaming ? { stream_options: { include_usage: true } } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
        thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      });
    };
    const inferenceId = randomUUID();
    const requestBody = buildBody();
    let failureNotified = false;
    let lastAttempt = 1;
    let lastHttpStatus: number | null = null;
    let lastApiErrorCode: string | null = null;
    let lastFailureMessage = "provider invocation failed";
    let lastFailureStage: ProviderFailureStage = "request";
    let lastResponse: Response | null = null;
    let lastResponseBody: ChatResponse | null = null;
    callbacks?.onInvocationStarted?.({
      inference_id: inferenceId,
      provider: "deepseek",
      requested_model_id: this.model,
      normalized_model_id: this.model,
      sent_model_id: this.model,
      input_digest: createHash("sha256").update(requestBody).digest("hex"),
      input_message_count: 2,
    });
    const notifyCompleted = (
      status: "delivered" | "failed",
      outputText: string,
    ): void => {
      if (status === "failed" && !failureNotified) {
        failureNotified = true;
        const failureClass = normalizeProviderFailureClass({
          httpStatus: lastHttpStatus,
          message: lastFailureMessage,
          stage: lastFailureStage,
          stream: isStreaming,
        });
        callbacks?.onProviderFailure?.(
          buildProviderFailureReceipt({
            provider: "deepseek",
            exactModelId: this.model,
            localRequestId: inferenceId,
            openrouterRequestId: providerRequestId(
              lastResponse,
              lastResponseBody,
            ),
            httpStatus: lastHttpStatus,
            apiErrorCode: lastApiErrorCode,
            normalizedFailureClass: failureClass,
            message: lastFailureMessage,
            retryable: isSafeProviderRetry({
              httpStatus: lastHttpStatus,
              failureClass,
              attempt: lastAttempt,
              maximumAttempts: REQUEST_MAX_RETRIES,
              partialModelOutput: outputText.length > 0,
            }),
            retryAttempt: lastAttempt,
            maximumAttempts: REQUEST_MAX_RETRIES,
            stream: isStreaming,
            failureStage: lastFailureStage,
            inferenceStarted: true,
            partialModelOutput: outputText.length > 0,
            toolCallsEmitted: 0,
          }),
        );
      }
      callbacks?.onInvocationCompleted?.({
        inference_id: inferenceId,
        provider: "deepseek",
        model: this.model,
        status,
        observed_model_id: null,
        output_digest: createHash("sha256").update(outputText).digest("hex"),
      });
    };
    const notifyPhase = (
      phase: ProviderInvocationPhase,
      statusCode?: number,
      detail?: string,
    ): void => {
      callbacks?.onInvocationPhase?.({
        inference_id: inferenceId,
        provider: "deepseek",
        model: this.model,
        phase,
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    };
    notifyPhase("request_created");

    // ── VCR playback mode ──────────────────────────────────────────────────────
    const vcrPlayer = createVcrPlayer();
    if (vcrPlayer) {
      const lines = await vcrPlayer.readAllLines();
      let text = "";
      const streamState = {
        ttftMs: null as number | null,
        generationMs: null as number | null,
        usage: null as ChatResponse["usage"] | null,
      };
      let firstChunkReceived = false;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            streamState.generationMs =
              Date.now() - startedAt - (streamState.ttftMs ?? 0);
            break;
          }
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                delta?: { content?: string; reasoning_content?: string };
              }>;
              usage?: ChatResponse["usage"];
            };
            if (
              !firstChunkReceived &&
              (json.choices?.[0]?.delta?.content ||
                json.choices?.[0]?.delta?.reasoning_content)
            ) {
              firstChunkReceived = true;
              streamState.ttftMs = Date.now() - startedAt;
              if (callbacks?.onProgress) {
                callbacks.onProgress({ state: "Receiving response" });
              }
            }
            const delta = json.choices?.[0]?.delta?.content || "";
            const reasoning = json.choices?.[0]?.delta?.reasoning_content || "";
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

    // ── HTTP request loop ────────────────────────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    let retryAttempt: number | null = null;
    const settleRetry = (
      outcome: "succeeded" | "failed" | "cancelled",
    ): void => {
      if (retryAttempt === null) return;
      callbacks?.onRetrySettled?.({
        provider: "deepseek",
        model: this.model,
        attempt: retryAttempt,
        outcome,
      });
      retryAttempt = null;
    };

    for (let attempt = 1; attempt <= REQUEST_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        lastAttempt = attempt;
        notifyPhase("request_dispatched", undefined, `attempt ${attempt}`);
        response = await fetch(API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
        });
      } catch (err) {
        lastFailureStage = "request";
        lastFailureMessage = isAbortError(err)
          ? `request timeout after ${REQUEST_TIMEOUT_MS}ms`
          : `network error: ${err instanceof Error ? err.message : String(err)}`;
        this.lastInvocationMetadata = buildInvocationMetadata(
          this.model,
          Date.now() - startedAt,
        );
        lastError = new Error(
          isAbortError(err)
            ? `[deepSeekApi] request timeout after ${REQUEST_TIMEOUT_MS}ms (${this.model})`
            : `[deepSeekApi] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < REQUEST_MAX_RETRIES) {
          if (callbacks?.onProgress) {
            callbacks.onProgress({
              state: "Retrying response",
              details: `attempt ${attempt} failed`,
            });
          }
          const retryDelay = retryDelayMs(attempt);
          settleRetry("failed");
          retryAttempt = attempt + 1;
          callbacks?.onRetry?.({
            provider: "deepseek",
            model: this.model,
            attempt: retryAttempt,
            reason: isAbortError(err) ? "timeout" : "transport",
            backoff_ms: retryDelay,
          });
          await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry("cancelled");
            throw error;
          });
          continue;
        }
        settleRetry("failed");
        notifyPhase(
          "provider_error",
          undefined,
          isAbortError(lastError) ? "timeout" : "transport",
        );
        notifyCompleted("failed", "");
        throw lastError;
      } finally {
        clearTimeout(timeout);
      }

      notifyPhase("response_started", response.status);
      lastResponse = response;
      lastHttpStatus = response.status;
      if (
        response.ok ||
        !isRetryableStatus(response.status) ||
        attempt === REQUEST_MAX_RETRIES
      ) {
        break;
      }
      if (callbacks?.onProgress) {
        callbacks.onProgress({
          state: "Retrying response",
          details: `HTTP ${response.status}`,
        });
      }
      const retryDelay = retryDelayMs(attempt, response);
      settleRetry("failed");
      retryAttempt = attempt + 1;
      callbacks?.onRetry?.({
        provider: "deepseek",
        model: this.model,
        attempt: retryAttempt,
        reason:
          response.status === 429
            ? "rate_limit"
            : response.status === 408
              ? "timeout"
              : "server_error",
        backoff_ms: retryDelay,
      });
      await sleep(retryDelay, signal).catch((error: unknown) => {
        if (isAbortError(error)) settleRetry("cancelled");
        throw error;
      });
    }

    if (!response) {
      lastFailureStage = "request";
      lastFailureMessage = lastError?.message ?? "no response received";
      notifyCompleted("failed", "");
      throw (
        lastError ??
        new Error(
          `[deepSeekApi] request failed before receiving a response (${this.model})`,
        )
      );
    }

    if (!response.ok) {
      settleRetry("failed");
      const body = await readErrorBody(response);
      lastResponse = response;
      lastHttpStatus = response.status;
      lastApiErrorCode = providerApiErrorCode(body);
      lastFailureStage = "http_response";
      lastFailureMessage = body || `HTTP ${response.status}`;
      this.lastInvocationMetadata = buildInvocationMetadata(
        this.model,
        Date.now() - startedAt,
      );
      notifyPhase("provider_error", response.status, "http_error");
      notifyCompleted("failed", body);
      const retryNote = isRetryableStatus(response.status)
        ? ` after ${REQUEST_MAX_RETRIES} attempt(s)`
        : "";
      throw new Error(
        `[deepSeekApi] HTTP ${response.status}${retryNote} (${this.model}): ${body}`,
      );
    }

    settleRetry("succeeded");

    parseRateLimitHeaders(response.headers, "deepseek");

    // ── Read response (streaming or non-streaming) ────────────────────────────
    let text = "";
    const streamState = {
      ttftMs: null as number | null,
      generationMs: null as number | null,
      usage: null as ChatResponse["usage"] | null,
    };

    if (isStreaming) {
      const vcrRecorder = createVcrRecorder();
      let progressPhaseCount = 0;
      try {
        text = await readStreamingResponse(
          response,
          callbacks,
          startedAt,
          streamState,
          vcrRecorder ?? undefined,
          () => notifyPhase("first_byte"),
          (bytes) => {
            if (progressPhaseCount < 32) {
              progressPhaseCount += 1;
              notifyPhase("stream_progress", undefined, `bytes=${bytes}`);
            }
          },
        );
      } catch (err) {
        lastFailureStage = "stream";
        lastFailureMessage = err instanceof Error ? err.message : String(err);
        this.lastInvocationMetadata = buildInvocationMetadata(
          this.model,
          Date.now() - startedAt,
        );
        notifyPhase("provider_error", undefined, "stream");
        notifyCompleted("failed", text);
        throw buildStructuredOutputError({
          failure_kind: "failed_to_parse_api_json",
          provider: "deepseek",
          model: this.model,
          message: `[deepSeekApi] Streaming reading failed: ${String(err)}`,
          raw_output: text,
          cause: err instanceof Error ? err : undefined,
        });
      } finally {
        vcrRecorder?.close();
      }
    } else {
      let rawDataText = "";
      let data: ChatResponse;
      try {
        rawDataText = await response.text();
        if (rawDataText.length > 0) notifyPhase("first_byte");
        data = JSON.parse(rawDataText) as ChatResponse;
        lastResponseBody = data;
        streamState.usage = data.usage;
        text = data?.choices?.[0]?.message?.content ?? "";
      } catch (err) {
        lastFailureStage = "normalization";
        lastFailureMessage = err instanceof Error ? err.message : String(err);
        this.lastInvocationMetadata = buildInvocationMetadata(
          this.model,
          Date.now() - startedAt,
        );
        notifyPhase("provider_error", undefined, "response_parse");
        notifyPhase(
          "response_normalization_failed",
          undefined,
          "response_parse",
        );
        notifyCompleted("failed", rawDataText);
        throw buildStructuredOutputError({
          failure_kind: "failed_to_parse_api_json",
          provider: "deepseek",
          model: this.model,
          message: `[deepSeekApi] Failed to parse API response as JSON: ${String(err)}`,
          raw_output: rawDataText,
          cause: err instanceof Error ? err : undefined,
        });
      }
    }

    if (isStreaming) notifyPhase("stream_completed");
    notifyPhase("response_normalized");
    notifyCompleted("delivered", text);
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
      callbacks.onProgress({ state: "Validating response" });
    }
    const validationStartedAt = Date.now();

    if (!text.trim()) {
      throw buildStructuredOutputError({
        failure_kind: "empty_response",
        provider: "deepseek",
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
        failure_kind: "invalid_json",
        provider: "deepseek",
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
        failure_kind: "zod_validation_failed",
        provider: "deepseek",
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
        failure_kind: "empty_response",
        provider: "deepseek",
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
    );

    return text;
  }

  /** #1 Async generator: yields text chunks as they arrive from the SSE stream. */
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
    toolChoice?: "auto" | "required",
    callbacks?: RunnerCallbacks,
  ): AsyncGenerator<ToolStreamEvent, void, undefined> {
    const startedAt = Date.now();
    this.lastInvocationMetadata = null;

    // Track thinking routing for lastInvocationMetadata (P0-B honesty).
    let thinkingDisabledReason: string | null = null;

    const buildBody = () => {
      const effort = resolveReasoningEffort();
      // DeepSeek API: "Thinking mode does not support this tool_choice" (HTTP 400).
      // Capability matrix says thinkingWithTools is 'unsupported' for DeepSeek.
      // Override: BABEL_DEEPSEEK_THINKING_WITH_TOOLS=1 (experimental; may 400).
      const wantThinking =
        process.env["BABEL_DEEPSEEK_THINKING"] !== "disabled";
      const allowThinkingWithTools =
        process.env["BABEL_DEEPSEEK_THINKING_WITH_TOOLS"] === "1";
      // resolveProviderCapabilities('deepseek-*').thinkingWithTools === 'unsupported'
      // unless experimental env forces the interleaved path.
      const thinkingEnabled = wantThinking && allowThinkingWithTools;
      if (wantThinking && !allowThinkingWithTools) {
        thinkingDisabledReason =
          "thinkingWithTools=unsupported: DeepSeek rejects tool_choice with thinking; set BABEL_DEEPSEEK_THINKING_WITH_TOOLS=1 to force experimental path";
      } else if (!wantThinking) {
        thinkingDisabledReason = "BABEL_DEEPSEEK_THINKING=disabled";
      } else {
        thinkingDisabledReason = null;
      }
      const choice = (toolChoice ?? "auto") as "auto" | "required";
      return JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        stream: true,
        ...{ stream_options: { include_usage: true } },
        tools,
        // When thinking is forced on with tools, omit tool_choice (API rejects it).
        ...(thinkingEnabled ? {} : { tool_choice: choice }),
        ...(effort ? { reasoning_effort: effort } : {}),
        thinking: {
          type: thinkingEnabled ? ("enabled" as const) : ("disabled" as const),
        },
        messages: mapProviderMessagesToWire(
          messages,
          CHAT_SYSTEM_PROMPT,
          systemPrompt,
        ),
      });
    };

    const inferenceId = randomUUID();
    const requestBody = buildBody();
    let failureNotified = false;
    let lastAttempt = 1;
    let lastHttpStatus: number | null = null;
    let lastApiErrorCode: string | null = null;
    let lastFailureMessage = "provider invocation failed";
    let lastFailureStage: ProviderFailureStage = "request";
    let lastResponse: Response | null = null;
    let lastResponseBody: ChatResponse | null = null;
    callbacks?.onInvocationStarted?.({
      inference_id: inferenceId,
      provider: "deepseek",
      requested_model_id: this.model,
      normalized_model_id: this.model,
      sent_model_id: this.model,
      input_digest: createHash("sha256").update(requestBody).digest("hex"),
      input_message_count: messages.length + 1,
      capability_bindings: tools.map((tool) => ({
        capability: tool.function.name,
        advertised: true,
        authorized: null,
        effective: null,
      })),
      delivered_tool_call_ids: messages.flatMap((message) =>
        message.role === "tool" && message.tool_call_id
          ? [message.tool_call_id]
          : [],
      ),
    });
    const notifyCompleted = (
      status: "delivered" | "failed",
      outputText: string,
    ): void => {
      if (status === "failed" && !failureNotified) {
        failureNotified = true;
        const failureClass = normalizeProviderFailureClass({
          httpStatus: lastHttpStatus,
          message: lastFailureMessage,
          stage: lastFailureStage,
          stream: true,
        });
        callbacks?.onProviderFailure?.(
          buildProviderFailureReceipt({
            provider: "deepseek",
            exactModelId: this.model,
            localRequestId: inferenceId,
            openrouterRequestId: providerRequestId(
              lastResponse,
              lastResponseBody,
            ),
            httpStatus: lastHttpStatus,
            apiErrorCode: lastApiErrorCode,
            normalizedFailureClass: failureClass,
            message: lastFailureMessage,
            retryable: isSafeProviderRetry({
              httpStatus: lastHttpStatus,
              failureClass,
              attempt: lastAttempt,
              maximumAttempts: REQUEST_MAX_RETRIES,
              partialModelOutput: outputText.length > 0,
            }),
            retryAttempt: lastAttempt,
            maximumAttempts: REQUEST_MAX_RETRIES,
            stream: true,
            failureStage: lastFailureStage,
            inferenceStarted: true,
            partialModelOutput: outputText.length > 0,
            toolCallsEmitted: 0,
          }),
        );
      }
      callbacks?.onInvocationCompleted?.({
        inference_id: inferenceId,
        provider: "deepseek",
        model: this.model,
        status,
        observed_model_id: null,
        output_digest: createHash("sha256").update(outputText).digest("hex"),
      });
    };
    const notifyPhase = (
      phase: ProviderInvocationPhase,
      statusCode?: number,
      detail?: string,
    ): void => {
      callbacks?.onInvocationPhase?.({
        inference_id: inferenceId,
        provider: "deepseek",
        model: this.model,
        phase,
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    };
    notifyPhase("request_created");

    // ── HTTP request loop (with retries) ─────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    let retryAttempt: number | null = null;
    const settleRetry = (
      outcome: "succeeded" | "failed" | "cancelled",
    ): void => {
      if (retryAttempt === null) return;
      callbacks?.onRetrySettled?.({
        provider: "deepseek",
        model: this.model,
        attempt: retryAttempt,
        outcome,
      });
      retryAttempt = null;
    };

    for (let attempt = 1; attempt <= REQUEST_MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        lastAttempt = attempt;
        notifyPhase("request_dispatched", undefined, `attempt ${attempt}`);
        response = await fetch(API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
        });
      } catch (err) {
        lastFailureStage = "request";
        lastFailureMessage = isAbortError(err)
          ? `request timeout after ${REQUEST_TIMEOUT_MS}ms`
          : `network error: ${err instanceof Error ? err.message : String(err)}`;
        this.lastInvocationMetadata = buildInvocationMetadata(
          this.model,
          Date.now() - startedAt,
        );
        lastError = new Error(
          isAbortError(err)
            ? `[deepSeekApi] request timeout after ${REQUEST_TIMEOUT_MS}ms (${this.model})`
            : `[deepSeekApi] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < REQUEST_MAX_RETRIES) {
          const retryDelay = retryDelayMs(attempt);
          settleRetry("failed");
          retryAttempt = attempt + 1;
          callbacks?.onRetry?.({
            provider: "deepseek",
            model: this.model,
            attempt: retryAttempt,
            reason: isAbortError(err) ? "timeout" : "transport",
            backoff_ms: retryDelay,
          });
          await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry("cancelled");
            throw error;
          });
          continue;
        }
        settleRetry("failed");
        notifyPhase(
          "provider_error",
          undefined,
          isAbortError(lastError) ? "timeout" : "transport",
        );
        notifyCompleted("failed", "");
        yield { type: "error", message: lastError.message };
        return;
      } finally {
        clearTimeout(timeout);
      }

      notifyPhase("response_started", response.status);
      lastResponse = response;
      lastHttpStatus = response.status;
      if (
        response.ok ||
        !isRetryableStatus(response.status) ||
        attempt === REQUEST_MAX_RETRIES
      ) {
        break;
      }
      const retryDelay = retryDelayMs(attempt, response);
      settleRetry("failed");
      retryAttempt = attempt + 1;
      callbacks?.onRetry?.({
        provider: "deepseek",
        model: this.model,
        attempt: retryAttempt,
        reason:
          response.status === 429
            ? "rate_limit"
            : response.status === 408
              ? "timeout"
              : "server_error",
        backoff_ms: retryDelay,
      });
      await sleep(retryDelay, signal).catch((error: unknown) => {
        if (isAbortError(error)) settleRetry("cancelled");
        throw error;
      });
    }

    if (!response) {
      lastFailureStage = "request";
      lastFailureMessage = lastError?.message ?? "no response received";
      notifyPhase("provider_error", undefined, "no_response");
      notifyCompleted("failed", "");
      yield {
        type: "error",
        message: lastError?.message ?? "[deepSeekApi] No response received",
      };
      return;
    }

    if (!response.ok) {
      settleRetry("failed");
      const body = await readErrorBody(response);
      lastResponse = response;
      lastHttpStatus = response.status;
      lastApiErrorCode = providerApiErrorCode(body);
      lastFailureStage = "http_response";
      lastFailureMessage = body || `HTTP ${response.status}`;
      this.lastInvocationMetadata = buildInvocationMetadata(
        this.model,
        Date.now() - startedAt,
      );
      notifyPhase("provider_error", response.status, "http_error");
      notifyCompleted("failed", body);
      yield {
        type: "error",
        message: `[deepSeekApi] HTTP ${response.status} (${this.model}): ${body}`,
      };
      return;
    }

    settleRetry("succeeded");

    parseRateLimitHeaders(response.headers, "deepseek");

    // ── SSE streaming with tool call accumulation ────────────────────────
    if (!response.body) {
      notifyPhase("provider_error", undefined, "missing_stream_body");
      notifyCompleted("failed", "");
      yield {
        type: "error",
        message: "[deepSeekApi] Streaming response had no body.",
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstChunkReceived = false;
    let totalBytes = 0;
    let progressPhaseCount = 0;

    // Accumulate tool call arguments that arrive incrementally across SSE chunks
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let outputReceipt = "";
    let invocationFailed = false;
    let terminalMarkerSeen = false;

    const streamState: {
      ttftMs: number | null;
      generationMs: number | null;
      usage: ChatResponse["usage"] | null;
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
              new Error(
                `[deepSeekApi] stream read timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`,
              ),
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
          invocationFailed = true;
          lastFailureStage = "stream";
          lastFailureMessage = err instanceof Error ? err.message : String(err);
          notifyPhase("provider_error", undefined, "stream");
          notifyCompleted("failed", outputReceipt);
          yield {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          };
          return;
        }

        if (done) break;

        totalBytes += value?.byteLength ?? 0;
        if (progressPhaseCount < 32) {
          progressPhaseCount += 1;
          notifyPhase("stream_progress", undefined, `bytes=${totalBytes}`);
        }

        if (!firstChunkReceived) {
          firstChunkReceived = true;
          streamState.ttftMs = Date.now() - startedAt;
          notifyPhase("first_byte");
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (!trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6).trim();
          if (data === "[DONE]") {
            terminalMarkerSeen = true;
            continue;
          }

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
              usage?: ChatResponse["usage"];
            };

            const choice = json.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // Reasoning content (e.g. DeepSeek's thinking tokens)
            if (delta?.reasoning_content) {
              yield { type: "thought_delta", text: delta.reasoning_content };
            }

            // Text content
            if (delta?.content) {
              outputReceipt += delta.content;
              yield { type: "text_delta", text: delta.content };
            }

            // Native tool call deltas — accumulate arguments incrementally
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, {
                    id: "",
                    name: "",
                    arguments: "",
                  });
                }
                const acc = pendingToolCalls.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) {
                  acc.arguments += tc.function.arguments;
                  outputReceipt += tc.function.arguments;
                }
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
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6).trim();
        if (data === "[DONE]") {
          terminalMarkerSeen = true;
        } else {
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ finish_reason?: string | null }>;
              usage?: ChatResponse["usage"];
            };
            if (json.usage) {
              streamState.usage = json.usage;
            }
            if (json.choices?.[0]?.finish_reason) {
              finishReason = normalizeFinishReason(
                json.choices[0].finish_reason,
              );
            }
          } catch {
            /* ignore */
          }
        }
      }

      if (!terminalMarkerSeen) {
        invocationFailed = true;
        lastFailureStage = "stream";
        lastFailureMessage =
          "incomplete stream: terminal marker was not received";
        notifyPhase("provider_error", undefined, "incomplete_stream");
        notifyCompleted("failed", outputReceipt);
        yield { type: "error", message: `[deepSeekApi] ${lastFailureMessage}` };
        return;
      }

      streamState.generationMs =
        Date.now() - startedAt - (streamState.ttftMs ?? 0);

      // ── Yield accumulated tool calls ──────────────────────────────────
      if (
        (finishReason === "tool_calls" || pendingToolCalls.size > 0) &&
        pendingToolCalls.size > 0
      ) {
        for (const [, acc] of pendingToolCalls) {
          let input: Record<string, unknown> = {};
          if (acc.arguments) {
            try {
              const parsed = JSON.parse(acc.arguments) as unknown;
              if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
              ) {
                throw new Error("tool arguments must be a JSON object");
              }
              input = parsed as Record<string, unknown>;
            } catch (error) {
              invocationFailed = true;
              lastFailureStage = "normalization";
              lastFailureMessage =
                error instanceof Error ? error.message : String(error);
              notifyPhase(
                "response_normalization_failed",
                undefined,
                "tool_arguments",
              );
              notifyCompleted("failed", outputReceipt);
              yield {
                type: "error",
                message: `[deepSeekApi] Malformed arguments for tool ${acc.name || "<unknown>"}: ${error instanceof Error ? error.message : String(error)}`,
              };
              return;
            }
          }
          yield { type: "tool_use", id: acc.id, name: acc.name, input };
        }
        yield { type: "done", finishReason: finishReason ?? "tool_calls" };
      } else {
        yield { type: "done", finishReason: finishReason ?? "stop" };
      }
    } catch (err) {
      invocationFailed = true;
      lastFailureStage = "stream";
      lastFailureMessage = err instanceof Error ? err.message : String(err);
      notifyPhase("provider_error", undefined, "stream");
      notifyCompleted("failed", outputReceipt);
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const meta = buildInvocationMetadata(
      this.model,
      Date.now() - startedAt,
      streamState.usage ?? undefined,
      streamState.ttftMs,
      streamState.generationMs,
    );
    if (thinkingDisabledReason) {
      meta.thinking_disabled_reason = thinkingDisabledReason;
    }
    this.lastInvocationMetadata = meta;
    if (!invocationFailed) {
      notifyPhase("stream_completed");
      notifyPhase("response_normalized");
      notifyCompleted("delivered", outputReceipt);
    }
  }
}
