import { type ProviderMessage, type RunnerCallbacks, type RunnerInvocationMetadata } from './base.js';
import { mapProviderMessagesToWire } from './providerMessages.js';
import { type VcrRecorder } from '../services/streamingVcr.js';
import { createInvocationDeadline, invocationNowMs, readPositiveIntEnv } from './providerResponsePolicy.js';
import { safeProviderErrorCode } from './providerHttpError.js';
import { accumulateStreamFinish, classifyStreamFinish, type StreamFinishDisposition } from './providerNormalize.js';
import type { ProviderId } from './providerRegistry.js';
import {
  type ChatResponse,
  type OpenRouterResponseMetadata,
  buildInvocationMetadata,
  safeProviderFinishReason,
  upstreamProviderFromResponse,
} from './providerResponseMetadata.js';
import {
  parseChatCompletionsStreamFrame,
  readChatCompletionsEnvelope,
  readChatCompletionsStreamChoice,
  readSingleChatCompletionsChoice,
  ssePayloadFromTrimmedLine,
} from './protocol/openai-chat-completions-sse.js';

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

export const DEFAULT_STREAM_MAX_RETRIES = 1;


export function getStreamIdleTimeoutMs(): number {
  return readPositiveIntEnv(
    process.env['BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS'] === undefined ? 'BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS' : 'BABEL_PROVIDER_STREAM_IDLE_TIMEOUT_MS',
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );
}


export function getStreamMaxRetries(): number {
  const raw = process.env['BABEL_PROVIDER_STREAM_MAX_RETRIES'] ?? process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'];
  if (raw === undefined || raw === '') return DEFAULT_STREAM_MAX_RETRIES;
  const parsed = Number(raw);
  const value =
    Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_STREAM_MAX_RETRIES;
  return Math.min(value, 5);
}


export function readStreamWithLimits(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: {
    idleTimeoutMs: number;
    deadlineAt: number;
    requestTimeoutMs: number;
    signal?: AbortSignal;
    idleMessage: string;
    deadlineMessage: string;
  },
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onAbort = () => {
      finish(() => {
        reader.cancel().catch(() => {});
        reject(new DOMException('Request cancelled', 'AbortError'));
      });
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      action();
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const remainingDeadline = opts.deadlineAt - invocationNowMs();
    if (remainingDeadline <= 0) {
      finish(() => {
        reader.cancel().catch(() => {});
        reject(new Error(opts.deadlineMessage));
      });
      return;
    }
    timers.push(
      setTimeout(() => {
        finish(() => {
          reader.cancel().catch(() => {});
          reject(new Error(opts.idleMessage));
        });
      }, opts.idleTimeoutMs),
    );
    timers.push(
      setTimeout(() => {
        finish(() => {
          reader.cancel().catch(() => {});
          reject(new Error(opts.deadlineMessage));
        });
      }, remainingDeadline),
    );
    reader.read().then(
      (result) => finish(() => resolve({ done: result.done, value: result.value })),
      (err: unknown) => finish(() => reject(err)),
    );
  });
}


export function isStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && /stream idle timeout/i.test(error.message);
}

export function isProviderRequestDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /request timeout after|response body (read )?timeout|response body idle timeout/i.test(error.message)
  );
}

export async function releaseStreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  await reader.cancel().catch(() => {});
  try {
    reader.releaseLock();
  } catch {
    // Lock may already be released by the platform after cancel/close.
  }
}


export async function readErrorBody(
  response: Response,
  opts?: {
    idleTimeoutMs: number;
    deadlineAt: number;
    requestTimeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  if (!opts) {
    return (await response.text().catch(() => '')).slice(0, 200);
  }
  if (!response.body) {
    return '';
  }
  const text = await readResponseBodyText(response, {
    idleTimeoutMs: opts.idleTimeoutMs,
    deadlineAt: opts.deadlineAt,
    requestTimeoutMs: opts.requestTimeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return text.slice(0, 200);
}

/** Map ProviderMessage[] to the OpenAI-compatible wire format (shared P0-B mapper). */
export function mapProviderMessages(
  messages: ProviderMessage[],
  defaultSystemPrompt: string,
  systemPromptOverride?: string,
) {
  return mapProviderMessagesToWire(messages, defaultSystemPrompt, systemPromptOverride);
}

export interface StreamingState {
  ttftMs: number | null;
  generationMs: number | null;
  usage: ChatResponse['usage'] | null;
  observedModelId: string | null;
  upstreamProvider: string | null;
  routerMetadata: OpenRouterResponseMetadata | null;
  finishReason: string | null;
  providerFinishReason?: string | null;
  /** True after any model-generated material becomes observable to the caller. */
  partialModelOutput: boolean;
  /** Local, non-durable material used to produce a truthful failure digest. */
  outputReceipt: string;
  sawDone: boolean;
}

/** A response declared two different model identities in one invocation. */
export class ProviderModelIdentityConflictError extends Error {
  constructor(first: string, next: string) {
    super(`[provider response] response model mismatch: conflicting model identity observed ${first} then ${next}`);
    this.name = 'ProviderModelIdentityConflictError';
  }
}

/**
 * Record response identity without allowing a later frame to erase evidence
 * of a contradiction.  A provider stream is one logical response: observing
 * two model ids is a protocol failure, even if a subsequent frame happens to
 * repeat the first id.
 */
export function recordObservedModelId(state: Pick<StreamingState, 'observedModelId'>, value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0) return;
  const model = value.trim();
  if (state.observedModelId === null) {
    state.observedModelId = model;
    return;
  }
  if (state.observedModelId !== model) {
    throw new ProviderModelIdentityConflictError(state.observedModelId, model);
  }
}

/** Build accounting metadata from the state shared by compatible stream adapters. */
export function buildStreamingInvocationMetadata(
  provider: ProviderId,
  model: string,
  latencyMs: number,
  state: StreamingState,
  configuredOutputBudget?: number | null,
): RunnerInvocationMetadata {
  return {
    ...buildInvocationMetadata(
      provider, model, latencyMs, state.usage ?? undefined, state.ttftMs, state.generationMs,
      undefined, state.observedModelId, state.upstreamProvider,
      state.routerMetadata, state.finishReason,
      configuredOutputBudget,
    ),
    provider_finish_reason: safeProviderFinishReason(state.providerFinishReason ?? state.finishReason),
  };
}


export function recordStreamingOutput(state: StreamingState, kind: string, value: string): void {
  if (!value) return;
  state.partialModelOutput = true;
  state.outputReceipt += `${kind}:${value}\n`;
}


/** An explicit provider error outranks malformed choice data in the same envelope. */
export class TextProviderResponseError extends Error {
  readonly apiErrorCode: string | null;

  constructor(error: unknown, source: string) {
    const fields = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
    const detail = typeof error === 'string' ? error : typeof fields['message'] === 'string' ? fields['message'] : null;
    super(`${source}${detail ? `: ${detail}` : ''}`);
    const code = fields['code'] ?? fields['type'];
    this.apiErrorCode = safeProviderErrorCode(typeof code === 'string' ? code : null);
  }
}

function recordTextEnvelope(
  frame: ReturnType<typeof readChatCompletionsEnvelope>,
  state: StreamingState,
  providerErrorSource: string,
): void {
  recordObservedModelId(state, frame.model);
  const router = frame.openrouter_metadata as OpenRouterResponseMetadata | null | undefined;
  const upstream = upstreamProviderFromResponse({
    ...(frame.provider ? { provider: frame.provider } : {}),
    ...(router ? { openrouter_metadata: router } : {}),
  });
  if (upstream) state.upstreamProvider = upstream;
  if (router) state.routerMetadata = router;
  if (frame.usage) state.usage = frame.usage;
  if (frame.error != null) throw new TextProviderResponseError(frame.error, providerErrorSource);
}

/** Retain envelope evidence even when the frame cannot contribute answer text. */
export function readTextSseFrame(payload: string, state: StreamingState): { delta: string; reasoning: string } {
  const frame = parseChatCompletionsStreamFrame(payload);
  recordTextEnvelope(frame, state, '[provider stream] Provider stream error');
  const choice = readChatCompletionsStreamChoice(frame.choices, state.finishReason);
  if (choice?.finish_reason?.trim()) {
    state.finishReason = accumulateStreamFinish(state.finishReason, choice.finish_reason);
    state.providerFinishReason ??= choice.finish_reason;
  }
  return { delta: choice?.delta?.content ?? '', reasoning: choice?.delta?.reasoning_content ?? '' };
}

/** Complete JSON uses the same choice identity contract as streamed deltas. */
export function readBufferedTextResponse(value: unknown, state: StreamingState): { text: string; reasoning: string } {
  const source = 'Malformed Chat Completions JSON response';
  const envelope = readChatCompletionsEnvelope(value, source);
  recordTextEnvelope(envelope, state, '[provider response] Provider error');
  const choice = readSingleChatCompletionsChoice(envelope.choices, source);
  state.finishReason = choice?.finish_reason ?? null;
  state.providerFinishReason = state.finishReason;
  return {
    text: choice?.message?.content ?? '',
    reasoning: typeof envelope['reasoning_content'] === 'string' ? envelope['reasoning_content'] : '',
  };
}


/** A complete transport body carried a failed text finish, not a read failure. */
export class TextResponseFinishError extends Error {
  constructor(readonly disposition: Extract<StreamFinishDisposition, { status: 'failed' }>, source: string) {
    super(`${source} ${disposition.message}`);
    this.name = 'TextResponseFinishError';
  }
}

/** Text is actionable only after a reported finish; buffered JSON is not itself a finish. */
export function assertTextResponseFinish(reported: string | null, source: string): void {
  const disposition = classifyStreamFinish({
    reported,
    sawDone: true,
    hasToolCalls: false,
  });
  if (disposition.status === 'failed') throw new TextResponseFinishError(disposition, source);
}

export async function readStreamingResponse(
  response: Response,
  callbacks: RunnerCallbacks | undefined,
  idleTimeoutMs: number,
  startedAt: number,
  state: StreamingState,
  vcrRecorder?: VcrRecorder,
  onFirstByte?: () => void,
  onStreamProgress?: (bytes: number) => void,
  signal?: AbortSignal,
  invocationDeadlineAt?: number,
  requestTimeoutMs?: number,
): Promise<string> {
  if (!response.body) {
    throw new Error('[provider stream] Streaming response had no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let raw = '';
  let buffer = '';
  let firstChunkReceived = false;
  let totalBytes = 0;
  const deadlineAt = invocationDeadlineAt ?? createInvocationDeadline(requestTimeoutMs ?? 60_000);
  const deadlineBudgetMs = requestTimeoutMs ?? Math.max(0, deadlineAt - invocationNowMs());

  const completeStreamingRead = async (): Promise<string> => {
    signal?.throwIfAborted();
    assertTextResponseFinish(state.finishReason, '[provider stream]');
    return text;
  };

  const processLine = async (line: string): Promise<boolean> => {
    signal?.throwIfAborted();
    if (state.sawDone) return true;
    const normalizedLine = line.replace(/\r$/, '').trim();
    const payload = ssePayloadFromTrimmedLine(normalizedLine);
    if (payload === null) return false;
    vcrRecorder?.record(normalizedLine);
    if (payload === '[DONE]') {
      state.sawDone = true;
      state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
      return true;
    }
    const parsed = readTextSseFrame(payload, state);
    if (parsed.delta) {
      text += parsed.delta;
      recordStreamingOutput(state, 'text', parsed.delta);
      if (callbacks?.onChunk) await callbacks.onChunk(parsed.delta);
    }
    if (parsed.reasoning) {
      recordStreamingOutput(state, 'reasoning', parsed.reasoning);
      callbacks?.onThought?.(parsed.reasoning);
    }
    return false;
  };

  try {
  while (true) {
    const { done, value } = await readStreamWithLimits(reader, {
      idleTimeoutMs,
      deadlineAt,
      requestTimeoutMs: deadlineBudgetMs,
      ...(signal ? { signal } : {}),
      idleMessage: `[provider stream] stream idle timeout after ${idleTimeoutMs}ms`,
      deadlineMessage: `[provider stream] request timeout after ${deadlineBudgetMs}ms`,
    });
    if (done) {
      const flushed = decoder.decode();
      raw += flushed;
      buffer += flushed;
      if (buffer.length > 0 && await processLine(buffer)) return await completeStreamingRead();
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
      if (state.sawDone) break;
      if (await processLine(line)) return await completeStreamingRead();
    }
    if (state.sawDone) return await completeStreamingRead();
  }

  // A few OpenAI-compatible gateways return one ordinary JSON response even
  // when stream=true. Accept that only as a complete response; an SSE stream
  // that closes without [DONE] is a truthful truncated-stream failure.
  const rawTrimmed = raw.trim();
  let json: unknown;
  if (!state.sawDone && rawTrimmed.startsWith('{')) {
    try {
      json = JSON.parse(rawTrimmed) as unknown;
    } catch {
      // Malformed JSON falls through to the truncated-stream error below.
    }
  }
  if (json !== undefined) {
    signal?.throwIfAborted();
    const { text: content, reasoning } = readBufferedTextResponse(json, state);
    if (content) {
      text += content;
      recordStreamingOutput(state, 'text', content);
      if (callbacks?.onChunk) await callbacks.onChunk(content);
    }
    if (reasoning) {
      recordStreamingOutput(state, 'reasoning', reasoning);
      callbacks?.onThought?.(reasoning);
    }
    state.sawDone = true;
    state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
    return await completeStreamingRead();
  }
  if (state.generationMs === null && state.ttftMs !== null) {
    state.generationMs = Date.now() - startedAt - state.ttftMs;
  }
  if (!state.sawDone) {
    throw new Error('[provider stream] stream closed before terminal [DONE] marker');
  }
  return await completeStreamingRead();
  } finally {
    await releaseStreamReader(reader);
  }
}

/** Read a non-streaming response body with the same abort/idle/deadline guards as SSE. */
export async function readResponseBodyText(
  response: Response,
  opts: {
    idleTimeoutMs: number;
    /** Absolute monotonic deadline for the whole invocation (not reset after headers). */
    deadlineAt: number;
    requestTimeoutMs: number;
    signal?: AbortSignal;
    onFirstByte?: () => void;
  },
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let firstByte = false;
  const deadlineAt = opts.deadlineAt;
  try {
  while (true) {
    const { done, value } = await readStreamWithLimits(reader, {
      idleTimeoutMs: opts.idleTimeoutMs,
      deadlineAt,
      requestTimeoutMs: opts.requestTimeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      idleMessage: `[provider stream] response body idle timeout after ${opts.idleTimeoutMs}ms`,
      deadlineMessage: `[provider stream] response body read timeout after ${opts.requestTimeoutMs}ms`,
    });
    if (done) break;
    if (value?.byteLength) {
      if (!firstByte) {
        firstByte = true;
        opts.onFirstByte?.();
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  text += decoder.decode();
  return text;
  } finally {
    await releaseStreamReader(reader);
  }
}
