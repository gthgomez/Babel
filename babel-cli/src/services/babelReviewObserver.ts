import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { OpenCodeGoModel, OpenCodeGoRunnerOptions } from '../runners/openCodeGoApi.js';
import type { ProviderMessage, ToolDefinition, ToolStreamEvent, RunnerCallbacks, RunnerInvocationMetadata } from '../runners/base.js';
import type { ZodType } from 'zod';

export type BabelReviewCall = { path: string; status: 'completed' | 'failed'; elapsed_ms: number; metadata: RunnerInvocationMetadata | null };

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
    const started = Date.now(); let completed = false; let failedEvent = false;
    try {
      for await (const event of super.executeWithToolsStream(messages, tools, system, signal, choice, callbacks)) { if (event.type === 'error') failedEvent = true; yield event; }
      completed = !failedEvent;
    } finally { this.finish('native_tools', started, completed); }
  }
}
