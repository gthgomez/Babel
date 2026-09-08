import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { OpenCodeGoModel, OpenCodeGoRunnerOptions } from '../runners/openCodeGoApi.js';
import type { ProviderMessage, ToolDefinition, ToolStreamEvent, RunnerCallbacks, RunnerInvocationMetadata } from '../runners/base.js';
import type { ZodType } from 'zod';
import { randomUUID } from 'node:crypto';

export type BabelReviewCall = { path: string; status: 'completed' | 'failed'; elapsed_ms: number; metadata: RunnerInvocationMetadata | null; request_id?: string; attempt?: number; retry_reason?: 'transient_before_output' };

/** A recovered request is evidence only when its immediately following attempt succeeded. */
export function validateBabelReviewCalls(calls: unknown, model: string): void {
  if (!Array.isArray(calls) || !calls.length) throw new Error('CHAT_REVIEW_ATTRIBUTION_INCOMPLETE');
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] as BabelReviewCall;
    if (call?.status === 'completed' && call.metadata?.provider === 'opencode-go' && call.metadata.observed_model_id === model) continue;
    const next = calls[i + 1] as BabelReviewCall | undefined;
    if (call?.status === 'failed' && call.path === 'native_tools' && call.retry_reason === 'transient_before_output' && call.attempt === 1 && typeof call.request_id === 'string' && call.request_id.length > 0 &&
        call.metadata?.provider === 'opencode-go' && call.metadata.observed_model_id === null && next?.path === 'native_tools' && next.request_id === call.request_id && next.attempt === 2 && next.status === 'completed' && next.metadata?.observed_model_id === model && next.metadata.provider === 'opencode-go') continue;
    throw new Error('CHAT_REVIEW_ATTRIBUTION_INCOMPLETE');
  }
}

/** Observe every inference entrypoint, including failed and non-native calls. */
export class ObservedBabelReviewRunner extends OpenCodeGoApiRunner {
  constructor(model: OpenCodeGoModel, private readonly record: (call: BabelReviewCall) => void, options: OpenCodeGoRunnerOptions = {}) {
    super(model, { maxTokens: 8192, temperature: 0 }, options);
  }
  private finish(path: string, started: number, completed: boolean) {
    this.record({ path, status: completed ? 'completed' : 'failed', elapsed_ms: Date.now() - started, metadata: this.getLastInvocationMetadata() });
  }
  override async execute<T>(prompt: string, schema: ZodType<T, unknown>, callbacks?: RunnerCallbacks, system?: string, signal?: AbortSignal): Promise<T> {
    const started = Date.now(); let completed = false;
    try { const value = await super.execute(prompt, schema, callbacks, system, signal); completed = true; return value; }
    finally { this.finish('structured', started, completed); }
  }
  override async executeRaw(prompt: string, callbacks?: RunnerCallbacks, system?: string, signal?: AbortSignal): Promise<string> {
    const started = Date.now(); let completed = false;
    try { const value = await super.executeRaw(prompt, callbacks, system, signal); completed = true; return value; }
    finally { this.finish('raw', started, completed); }
  }
  override async *executeRawStream(prompt: string, system?: string, signal?: AbortSignal, callbacks?: RunnerCallbacks): AsyncGenerator<string, void, undefined> {
    const started = Date.now(); let completed = false;
    try { yield* super.executeRawStream(prompt, system, signal, callbacks); completed = true; }
    finally { this.finish('raw_stream', started, completed); }
  }
  override async *executeWithToolsStream(messages: ProviderMessage[], tools: ToolDefinition[], system?: string, signal?: AbortSignal, choice?: 'auto' | 'required', callbacks?: RunnerCallbacks): AsyncGenerator<ToolStreamEvent, void, undefined> {
    const requestId = randomUUID();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now(); let completed = false; let delivered = false;
      let failure: Extract<ToolStreamEvent, { type: 'error' }> | undefined;
      let retry = false;
      try {
        for await (const event of super.executeWithToolsStream(messages, tools, system, signal, choice, callbacks)) {
          if (event.type === 'error') { failure = event; break; }
          delivered = true; yield event;
        }
        completed = !failure;
        retry = !!failure && attempt === 1 && !delivered && !signal?.aborted && /^\[deepInfraApi\] (Network error|request timeout|HTTP 50[234]\b)/i.test(failure.message);
      } finally {
        this.record({ path: 'native_tools', request_id: requestId, attempt, status: completed ? 'completed' : 'failed', elapsed_ms: Date.now() - started, metadata: this.getLastInvocationMetadata(), ...(retry ? { retry_reason: 'transient_before_output' as const } : {}) });
      }
      if (retry) continue;
      if (failure) yield failure;
      return;
    }
  }
}
