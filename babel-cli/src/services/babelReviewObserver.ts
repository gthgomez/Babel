import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { OpenCodeGoModel, OpenCodeGoRunnerOptions } from '../runners/openCodeGoApi.js';
import type { ProviderMessage, ToolDefinition, ToolStreamEvent, RunnerCallbacks, RunnerInvocationMetadata } from '../runners/base.js';
import type { ZodType } from 'zod';
import { randomUUID } from 'node:crypto';

type ReviewInvocationMetadata = RunnerInvocationMetadata & {
  requested_thinking?: { type: 'disabled' };
  thinking_mode_evidence?: 'request_only_not_upstream_confirmed';
};
export type BabelReviewCall = { path: string; status: 'completed' | 'failed'; elapsed_ms: number; metadata: ReviewInvocationMetadata | null; request_id?: string; attempt?: number; retry_reason?: 'transient_before_output' };

/** A recovered request is evidence only when its immediately following attempt succeeded. */
export function validateBabelReviewCalls(calls: unknown, model: string): void {
  if (!Array.isArray(calls) || !calls.length) throw new Error('CHAT_REVIEW_ATTRIBUTION_INCOMPLETE');
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i] as BabelReviewCall;
    if (call?.status === 'completed' && call.metadata?.provider === 'opencode-go' && call.metadata.observed_model_id === model) continue;
    const next = calls[i + 1] as BabelReviewCall | undefined;
    if (call?.status === 'failed' && call.path === 'native_tools' && call.retry_reason === 'transient_before_output' && call.attempt === 1 && typeof call.request_id === 'string' && call.request_id.length > 0 &&
        call.metadata?.provider === 'opencode-go' && (call.metadata.observed_model_id === null || call.metadata.observed_model_id === model) && next?.path === 'native_tools' && next.request_id === call.request_id && next.attempt === 2 && next.status === 'completed' && next.metadata?.observed_model_id === model && next.metadata.provider === 'opencode-go') continue;
    throw new Error('CHAT_REVIEW_ATTRIBUTION_INCOMPLETE');
  }
}

/** A failed inference must not become a syntax-only repair request. */
export function parseObservedBabelReviewAnswer<T>(calls: unknown, model: string, parse: () => T): T {
  validateBabelReviewCalls(calls, model);
  return parse();
}

/** Observe every inference entrypoint, including failed and non-native calls. */
export class ObservedBabelReviewRunner extends OpenCodeGoApiRunner {
  constructor(private readonly reviewModel: OpenCodeGoModel, private readonly record: (call: BabelReviewCall) => void, options: OpenCodeGoRunnerOptions = {}) {
    super(reviewModel, { maxTokens: 8192, temperature: 0 }, options);
  }
  protected override getRequestBodyExtras(): Record<string, unknown> {
    const extras = super.getRequestBodyExtras();
    // Explicit review/repair compatibility profile, not a general model default.
    // MiMo/DeepSeek document reasoning replay that our history cannot represent;
    // LongCat has measured reasoning-only output exhaustion (replay requirement unknown).
    // Provider-specific references and qualification limits: docs/BABEL_PR_REVIEW.md.
    return { ...extras, thinking: { type: 'disabled' } };
  }
  override getLastInvocationMetadata(): ReviewInvocationMetadata | null {
    const metadata = super.getLastInvocationMetadata();
    if (!metadata) return metadata;
    return { ...metadata, requested_thinking: { type: 'disabled' }, thinking_disabled_reason: this.reviewModel === 'longcat-2.0' ? 'reviewer_observed_reasoning_only_output_exhaustion' : 'reviewer_missing_reasoning_content_replay', thinking_mode_evidence: 'request_only_not_upstream_confirmed' };
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
    signal?.throwIfAborted();
    const requestId = randomUUID();
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      const started = Date.now(); let completed = false;
      const buffered: ToolStreamEvent[] = [];
      let bufferedBytes = 0;
      let failure: Extract<ToolStreamEvent, { type: 'error' }> | undefined;
      let retry = false;
      try {
        // Review-only adapter: never expose text or tool calls until the
        // provider has checked DONE and model identity for the entire request.
        for await (const event of super.executeWithToolsStream(messages, tools, system, signal, choice, callbacks)) {
          if (event.type === 'error') { failure ??= event; continue; }
          signal?.throwIfAborted();
          if (failure) continue;
          bufferedBytes += Buffer.byteLength(JSON.stringify(event));
          if (bufferedBytes > 4 * 1024 * 1024 || buffered.length >= 32768) throw new Error('CHAT_REVIEW_NATIVE_BUFFER_LIMIT');
          buffered.push(event);
        }
        // Drain error events instead of breaking: provider metadata and model
        // attribution are finalized after its error yield. Any throw stays failed.
        signal?.throwIfAborted();
        if (!failure && !buffered.some(event => event.type === 'done')) failure = { type: 'error', message: 'CHAT_REVIEW_NATIVE_COMPLETION_MISSING' };
        const metadata = this.getLastInvocationMetadata();
        // Transport completion is not usable model completion. In particular,
        // never deliver even valid-looking JSON or tool calls from a length stop.
        if (!failure && !['NATURAL_COMPLETION', 'TOOL_CALL'].includes(metadata?.normalized_finish_reason ?? '')) {
          failure = { type: 'error', message: 'CHAT_REVIEW_NATIVE_TERMINATION_INVALID' };
        }
        if (!failure && metadata?.normalized_finish_reason === 'TOOL_CALL' && !buffered.some(event => event.type === 'tool_use')) {
          failure = { type: 'error', message: 'CHAT_REVIEW_NATIVE_TERMINATION_INVALID' };
        }
        if (!failure && !buffered.some(event => event.type === 'tool_use' || (event.type === 'text_delta' && event.text.trim().length > 0))) {
          failure = { type: 'error', message: 'CHAT_REVIEW_NATIVE_OUTPUT_EMPTY' };
        }
        retry = !!failure && attempt === 1 && metadata?.provider === 'opencode-go' &&
          (metadata.observed_model_id === null || metadata.observed_model_id === this.reviewModel) && (
          /^\[deepInfraApi\] (Network error|request timeout|HTTP 50[234]\b)/i.test(failure.message) ||
          failure.message === '[deepInfraApi] stream closed before terminal [DONE] marker'
        );
        if (!retry) {
          if (failure) yield failure;
          else {
            for (const event of buffered) { signal?.throwIfAborted(); yield event; }
            signal?.throwIfAborted();
            // Match the original adapter contract: completion includes full
            // consumer delivery; cancellation/early return never retries.
            completed = true;
          }
        }
      } finally {
        this.record({ path: 'native_tools', request_id: requestId, attempt, status: completed ? 'completed' : 'failed', elapsed_ms: Date.now() - started, metadata: this.getLastInvocationMetadata(), ...(retry ? { retry_reason: 'transient_before_output' as const } : {}) });
      }
      if (retry) continue;
      return;
    }
  }
}
