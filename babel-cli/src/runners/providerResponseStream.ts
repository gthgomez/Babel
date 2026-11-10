import { type ProviderMessage, type RunnerCallbacks, type RunnerInvocationMetadata } from './base.js';
import { mapProviderMessagesToWire } from './providerMessages.js';
import { type VcrRecorder } from '../services/streamingVcr.js';
import { readPositiveIntEnv } from './providerResponsePolicy.js';
import { normalizeFinishReason } from './providerNormalize.js';
import type { ProviderId } from './providerRegistry.js';
import {
  type ChatResponse,
  type OpenRouterResponseMetadata,
  buildInvocationMetadata,
  upstreamProviderFromResponse,
} from './providerResponseMetadata.js';

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
    const remainingDeadline = opts.deadlineAt - Date.now();
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


export async function readErrorBody(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 200);
}

/** Map ProviderMessage[] to the OpenAI-compatible wire format (shared P0-B mapper). */
export function mapProviderMessages(
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
  malformed?: string;
}


export interface StreamingState {
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

/** Build accounting metadata from the state shared by compatible stream adapters. */
export function buildStreamingInvocationMetadata(
  provider: ProviderId,
  model: string,
  latencyMs: number,
  state: StreamingState,
  configuredOutputBudget?: number | null,
): RunnerInvocationMetadata {
  return buildInvocationMetadata(
    provider, model, latencyMs, state.usage ?? undefined, state.ttftMs, state.generationMs,
    undefined, state.observedModelId, state.upstreamProvider,
    state.routerMetadata, state.finishReason,
    configuredOutputBudget,
  );
}


export function recordStreamingOutput(state: StreamingState, kind: string, value: string): void {
  if (!value) return;
  state.partialModelOutput = true;
  state.outputReceipt += `${kind}:${value}\n`;
}


export function parseSseLine(line: string): SseLineResult {
  const normalized = line.replace(/\r$/, '').trim();
  if (!normalized.startsWith('data:')) {
    return { delta: '', reasoning: '', usage: null, observedModelId: null, upstreamProvider: null, routerMetadata: null, finishReason: null, isDone: false };
  }
  const data = normalized.slice(5).trimStart();
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
    return {
      delta: '',
      reasoning: '',
      usage: null,
      observedModelId: null,
      upstreamProvider: null,
      routerMetadata: null,
      finishReason: null,
      isDone: false,
      malformed: `[provider stream] Malformed SSE event chunk: ${data.slice(0, 100)}`,
    };
  }
}


function assertExecuteRawStreamTerminal(state: StreamingState): void {
  const rawReason = (state.finishReason ?? '').trim().toLowerCase();
  if (rawReason === 'error') {
    throw new Error('[provider stream] Provider error during generation (finish_reason: error)');
  }
  const reason = normalizeFinishReason(state.finishReason ?? '');
  if (reason === 'length' && state.partialModelOutput) {
    throw new Error('[provider stream] Provider output budget exhausted (finish_reason: length)');
  }
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
  const deadlineAt = invocationDeadlineAt ?? startedAt + (requestTimeoutMs ?? 60_000);
  const deadlineBudgetMs = requestTimeoutMs ?? Math.max(0, deadlineAt - startedAt);

  const completeStreamingRead = async (): Promise<string> => {
    assertExecuteRawStreamTerminal(state);
    return text;
  };

  const processLine = async (line: string): Promise<boolean> => {
    if (state.sawDone) return true;
    const normalizedLine = line.replace(/\r$/, '').trim();
    if (!normalizedLine.startsWith('data:')) return false;
    vcrRecorder?.record(normalizedLine);
    const payload = normalizedLine.slice(5).trimStart();
    if (payload === '[DONE]') {
      state.sawDone = true;
      state.generationMs = Date.now() - startedAt - (state.ttftMs ?? 0);
      return true;
    }
    try {
      const envelope = JSON.parse(payload) as { error?: { message?: string } };
      if (envelope.error) {
        throw new Error(
          `[provider stream] Provider stream error: ${envelope.error.message || JSON.stringify(envelope.error)}`,
        );
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const parsed = parseSseLine(`data: ${payload}`);
    if (parsed.malformed) throw new Error(parsed.malformed);
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
      return await completeStreamingRead();
    } catch {
      // Fall through to the truncated-stream error below.
    }
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
    /** Absolute wall-clock deadline for the whole invocation (not reset after headers). */
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
