import { type ProviderMessage, type RunnerCallbacks } from './base.js';
import { mapProviderMessagesToWire } from './providerMessages.js';
import { type VcrRecorder } from '../services/streamingVcr.js';
import { readPositiveIntEnv } from './providerResponsePolicy.js';
import {
  type ChatResponse,
  type OpenRouterResponseMetadata,
  upstreamProviderFromResponse,
} from './providerResponseMetadata.js';

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

const DEFAULT_STREAM_MAX_RETRIES = 1;


export function getStreamIdleTimeoutMs(): number {
  return readPositiveIntEnv(
    'BABEL_DEEPINFRA_STREAM_IDLE_TIMEOUT_MS',
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );
}


export function getStreamMaxRetries(): number {
  const parsed = Number(process.env['BABEL_DEEPINFRA_STREAM_MAX_RETRIES'] ?? '');
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


export function recordStreamingOutput(state: StreamingState, kind: string, value: string): void {
  if (!value) return;
  state.partialModelOutput = true;
  state.outputReceipt += `${kind}:${value}\n`;
}


export function parseSseLine(line: string): SseLineResult {
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
    return {
      delta: '',
      reasoning: '',
      usage: null,
      observedModelId: null,
      upstreamProvider: null,
      routerMetadata: null,
      finishReason: null,
      isDone: false,
      malformed: `[deepInfraApi] Malformed SSE event chunk: ${data.slice(0, 100)}`,
    };
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
