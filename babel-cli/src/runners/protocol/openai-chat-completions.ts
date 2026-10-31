import { CompatibleConfiguration } from './compatible-configuration.js';
/** Shared OpenAI Chat Completions protocol; vendor configuration belongs in adapters. */
import { dispatchRunOperation, RunStoppedError, type RunControl } from '../../runtime/run-control.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { isRetryableStatus, normalizeFinishReason } from '../providerNormalize.js';
import {
  type LlmRunner,
  type ProviderMessage,
  type RunnerInvocationMetadata,
  type RunnerCallbacks,
  type ProviderInvocationPhase,
  type ToolDefinition,
  type ToolStreamEvent,
  buildStructuredOutputError,
} from '../base.js';
import { hardProviderProtocolIssues } from '../providerMessages.js';
import {
  assertPreparedProviderRequestAdmissible,
  prepareProviderRequest,
} from '../preparedProviderRequest.js';
import { extractJson } from '../../utils/extractJson.js';
import { createVcrRecorder, createVcrPlayer } from '../../services/streamingVcr.js';
import { parseRateLimitHeaders } from '../../ui/rateLimitWidget.js';
import { buildWireRequestFromEnvelope, hashWirePolicy, type WireRequest } from '../../intelligence/wire.js';
import { normalizeBabelFinishReason } from '../../intelligence/attribution.js';
import {
  buildProviderFailureReceipt,
  providerErrorCodeFromBody,
  providerRequestIdFromResponse,
  type ProviderFailureDetails,
} from '../providerFailureReceipt.js';
import {
  REQUEST_MAX_RETRIES,
  getRequestMaxRetries,
  getRequestTimeoutMs,
  isAbortError,
  isCallerCancelError,
  linkExternalAbortSignal,
  retryDelayMs,
  sleep,
  type FetchRedirectPolicy,
} from '../providerResponsePolicy.js';
import { notifyProviderRetryOrFinalizeOnCallbackError } from '../providerRetryCallback.js';
import {
  buildOpenAiCompatibleNativeWireBody,
  CHAT_NATIVE_DEFAULT_SYSTEM_PROMPT,
} from '../openAiCompatibleNativeWire.js';
import {
  getStreamIdleTimeoutMs,
  getStreamMaxRetries,
  isStreamIdleTimeoutError,
  mapProviderMessages,
  parseSseLine,
  readErrorBody,
  readStreamWithLimits,
  readStreamingResponse,
  recordStreamingOutput,
  buildStreamingInvocationMetadata,
  type StreamingState,
} from '../providerResponseStream.js';
import {
  buildInvocationMetadata,
  routerMetadataProvenance,
  type ChatResponse,
  type OpenRouterResponseMetadata,
  upstreamProviderFromResponse,
} from '../providerResponseMetadata.js';
import {
  CampaignBudgetDeniedError,
  CampaignRouteUnsupportedError,
} from '../campaignDispatchGate.js';
import type { PreparedProviderRequest } from '../preparedProviderRequest.js';
import { CampaignPhysicalFetchSession } from '../providerCampaignPhysicalFetch.js';
import type { ProviderInvocationCompleted } from '../base.js';
export type { OpenRouterResponseMetadata } from '../providerResponseMetadata.js';
export type { FetchRedirectPolicy } from '../providerResponsePolicy.js';

// ─── Configuration ────────────────────────────────────────────────────────────

// Base URL is now per-instance via `this.apiUrl` getter (supports subclasses like OpenRouter).

const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only — ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

const CHAT_SYSTEM_PROMPT = CHAT_NATIVE_DEFAULT_SYSTEM_PROMPT;

// ─── Runner implementation ────────────────────────────────────────────────────

export class OpenAiCompatibleRunner extends CompatibleConfiguration implements LlmRunner {
  private lastInvocationMetadata: RunnerInvocationMetadata | null = null;
  private lastWirePolicyHash: string | null = null;

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

  /** Campaign OpenRouter caps must be on the object before serialize/prepare/hash. */
  protected sealCampaignWireBody(
    body: Record<string, unknown>,
    callbacks?: RunnerCallbacks,
  ): Record<string, unknown> {
    return body;
  }

  /**
   * Exact native tool-stream JSON body (shared with compaction admission).
   * Matches `executeWithToolsStream` before transport.
   */
  /** Output budget reserved on the wire (matches `prepareProviderRequest`). */
  getNativeRequestReservedCompletionTokens(): number | null {
    return this.executionEnvelope?.output.effective ?? this.maxTokens;
  }

  buildNativeToolsWireBody(
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    systemPrompt?: string,
    options: { stream?: boolean; toolChoice?: 'auto' | 'required' } = {},
  ): string {
    return buildOpenAiCompatibleNativeWireBody({
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      ...(this.executionEnvelope ? { executionEnvelope: this.executionEnvelope } : {}),
      messages,
      tools,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      stream: options.stream ?? true,
      toolChoice: options.toolChoice ?? 'auto',
      requestBodyExtras: this.getRequestBodyExtras(),
      mapMessages: (msgs, defaultSystem, override) =>
        mapProviderMessages(msgs, defaultSystem, override),
    });
  }

  protected getAuthenticationHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` }
  }

  /** Provider-specific request headers, empty for generic APIs. */
  protected getRequestHeadersExtras(): Record<string, string> {
    return {};
  }

  /** Per-transport request timeout policy. */
  protected getRequestTimeoutMs(): number {
    return getRequestTimeoutMs();
  }

  /** Per-transport HTTP retry policy. */
  protected getRequestMaxRetries(): number {
    return getRequestMaxRetries();
  }

  /** Per-transport stream retry policy. */
  protected getStreamMaxRetries(): number {
    return getStreamMaxRetries();
  }

  /** Desktop requests stay on the admitted endpoint; ordinary CLI keeps legacy defaults. */
  protected getRequestRedirect(): FetchRedirectPolicy {
    return process.env['BABEL_DESKTOP_PROVIDER'] ? 'error' : 'follow';
  }

  protected async campaignPhysicalFetch(
    session: CampaignPhysicalFetchSession,
    callbacks: RunnerCallbacks | undefined,
    basePrepared: PreparedProviderRequest,
    physicalAttemptId: string,
    url: string,
    init: RequestInit,
    control?: RunControl,
    operationId = 'provider_fetch',
  ): Promise<Response> {
    const runControl = control ?? callbacks?.runControl;
    return await session.dispatchAdmittedFetch({
      basePrepared,
      physicalAttemptId,
      operationId,
      ...(runControl ? { runControl } : {}),
      fetch: () => this.dispatchFetch(url, init, control, operationId),
    });
  }

  /** Dispatch unchanged by default; specialized transports may gate every request. */
  protected dispatchFetch(url: string, init: RequestInit, control?: RunControl, operationId = 'provider_fetch'): Promise<Response> {
    return dispatchRunOperation(control, 'model', operationId, () => fetch(url, init));
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
    const stopped = callbacks?.runControl?.stop();
    if (stopped) throw new RunStoppedError(stopped);
    if (callbacks?.onProgress) {
      callbacks.onProgress({ state: 'Contacting model' });
    }

    const isStreaming = !!callbacks?.onChunk;
    const requestMaxRetries = Math.max(1, this.getRequestMaxRetries());
    const requestTimeoutMs = this.getRequestTimeoutMs();
    const streamMaxRetries = isStreaming ? this.getStreamMaxRetries() : 0;
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
      const bodyObject = this.sealCampaignWireBody({
        ...envelopeBody,
        stream: isStreaming,
        ...(callbacks?.campaignMeter ? {} : this.getRequestBodyExtras()),
        messages: ('messages' in envelopeBody ? envelopeBody.messages : undefined) ?? [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }, callbacks);
      return JSON.stringify(bodyObject);
    };
    const inferenceId = randomUUID();
    const preparedRequest = prepareProviderRequest({
      body: buildBody(),
      mode: 'text',
      provider: this.providerId,
      ...(this.contextWindowTokens ? { contextLimitTokens: this.contextWindowTokens, contextLimitSource: 'explicit' as const } : {}),
      requestedModelId: this.model,
      requestId: inferenceId,
      ...(callbacks?.parentRequestId !== undefined
        ? { parentRequestId: callbacks.parentRequestId }
        : {}),
      reservedCompletionTokens: this.executionEnvelope?.output.effective ?? this.maxTokens,
    });
    assertPreparedProviderRequestAdmissible(preparedRequest);
    const requestBody = preparedRequest.body;
    const requestAccounting = preparedRequest.accounting;
    this.lastWirePolicyHash = this.executionEnvelope
      ? hashWirePolicy(JSON.parse(requestBody) as WireRequest)
      : null;
    const inputDigest = requestAccounting.request_digest;
    const campaignSession = new CampaignPhysicalFetchSession(callbacks);
    callbacks?.onInvocationStarted?.({
      inference_id: inferenceId,
      request_id: preparedRequest.request_id,
      attempt_id: preparedRequest.attempt_id,
      ...(preparedRequest.parent_request_id !== null
        ? { parent_request_id: preparedRequest.parent_request_id }
        : {}),
      provider: this.providerId,
      requested_model_id: this.model,
      normalized_model_id: this.model,
      sent_model_id: this.model,
      input_digest: inputDigest,
      input_bytes: preparedRequest.body_bytes,
      accounting_kind: preparedRequest.accounting_kind,
      context_limit_tokens: preparedRequest.context_limit_tokens,
      context_limit_source: preparedRequest.context_limit_source,
      ...(requestAccounting.input_message_count === null
        ? {}
        : { input_message_count: requestAccounting.input_message_count }),
      requested_output_budget: this.executionEnvelope?.output.requested ?? this.maxTokens,
      effective_output_budget: this.executionEnvelope?.output.effective ?? this.maxTokens,
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
        failureStage?: import('../base.js').ProviderFailureStage;
        partialModelOutput?: boolean;
        toolCallCount?: number;
        inferenceStarted?: boolean;
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
              inferenceStarted: options.inferenceStarted ?? true,
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
        ...(status === 'delivered' ? { usage_metadata: this.getLastInvocationMetadata() } : {}),
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
        ...(callbacks?.campaignMeter ? { campaign_ledger_settled_by_transport: true } : {}),
      };
      campaignSession.finalizeInvocation(status, completion as ProviderInvocationCompleted);
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
          if (parsed.malformed) throw new Error(parsed.malformed);
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
      this.lastInvocationMetadata = buildInvocationMetadata(
        this.providerId, this.model, Date.now() - startedAt,
        streamState.usage ?? undefined, streamState.ttftMs, streamState.generationMs,
        undefined, streamState.observedModelId, streamState.upstreamProvider,
        streamState.routerMetadata, streamState.finishReason, this.maxTokens,
      );
      notifyCompleted('delivered', streamState.observedModelId, text, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens);
      return { text, startedAt, streamState };
    }

    // ── HTTP request loop ────────────────────────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    let retryAttempt: number | null = null;
    let retryAttemptId: string | null = null;
    let physicalAttemptId = preparedRequest.attempt_id;
    const settleRetry = (outcome: 'succeeded' | 'failed' | 'cancelled'): void => {
      if (retryAttempt === null) return;
      callbacks?.onRetrySettled?.({
        provider: this.providerId, model: this.model, attempt: retryAttempt, outcome,
        request_id: preparedRequest.request_id,
        ...(retryAttemptId ? { attempt_id: retryAttemptId } : {}),
        body_digest: preparedRequest.body_digest,
      });
      retryAttempt = null;
      retryAttemptId = null;
    };
    for (let attempt = 1; attempt <= requestMaxRetries; attempt += 1) {
      lastAttempt = attempt;
      const controller = new AbortController();
      // Link external abort signal so Esc/Ctrl+C cancels in-flight HTTP requests
      const onExternalAbort = linkExternalAbortSignal(controller, signal);
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        notifyPhase('request_dispatched', undefined, `attempt ${attempt}`);
        response = await this.campaignPhysicalFetch(
          campaignSession,
          callbacks,
          preparedRequest,
          physicalAttemptId,
          this.apiUrl,
          {
            method: 'POST',
            redirect: this.getRequestRedirect(),
            signal: controller.signal,
            headers: {
              ...this.getAuthenticationHeaders(),
              'Content-Type': 'application/json',
              ...this.getRequestHeadersExtras(),
            },
            body: requestBody,
          },
          callbacks?.runControl,
          inferenceId,
        );
      } catch (err) {
        if (err instanceof RunStoppedError) {
          settleRetry('cancelled');
          notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
            actualAttempt: attempt, details: { message: err.message }, failureStage: 'request', inferenceStarted: false,
          });
          throw err;
        }
        if (err instanceof CampaignBudgetDeniedError || err instanceof CampaignRouteUnsupportedError) {
          throw err;
        }
        campaignSession.settleUnknownOnOpenAdmission();
        this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
        lastError = new Error(
          isAbortError(err)
            ? `[${this.providerId}] request timeout after ${requestTimeoutMs}ms (${this.model})`
            : `[${this.providerId}] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
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
          retryAttemptId = randomUUID();
          physicalAttemptId = retryAttemptId;
          await notifyProviderRetryOrFinalizeOnCallbackError({
            notifyRetry: () => callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt!, reason: (isAbortError(err) ? 'timeout' : 'transport') as 'timeout' | 'transport', backoff_ms: retryDelay, request_id: preparedRequest.request_id, attempt_id: retryAttemptId!, body_digest: preparedRequest.body_digest }),
            settleRetry, notifyPhase, notifyCompleted, actualAttempt: attempt, outputBudget: this.maxTokens,
            failure: { kind: 'transport', transportErrorMessage: lastError.message, transportPhase: isAbortError(err) ? 'timeout' : 'transport' },
          });
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
      campaignSession.settleUnknownOnOpenAdmission();
      retryAttempt = attempt + 1;
      retryAttemptId = randomUUID();
      physicalAttemptId = retryAttemptId;
      await notifyProviderRetryOrFinalizeOnCallbackError({
        notifyRetry: () => callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt!, reason: (response!.status === 429 ? 'rate_limit' : response!.status === 408 ? 'timeout' : 'server_error') as 'rate_limit' | 'timeout' | 'server_error', backoff_ms: retryDelay, request_id: preparedRequest.request_id, attempt_id: retryAttemptId!, body_digest: preparedRequest.body_digest }),
        settleRetry, notifyPhase, notifyCompleted, actualAttempt: attempt, outputBudget: this.maxTokens,
        failure: { kind: 'http', response: response! },
      });
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
        new Error(`[${this.providerId}] request failed before receiving a response (${this.model})`)
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
        `[${this.providerId}] HTTP ${response.status}${retryNote} (${this.model}): ${body}`,
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
      const error = new Error(`[${this.providerId}] Streaming response had no body.`);
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
            signal,
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
          campaignSession.settleUnknownOnOpenAdmission();
          retryAttempt = streamAttempt + 2;
          retryAttemptId = randomUUID();
          physicalAttemptId = retryAttemptId;
          callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt!, reason: 'stream_idle', backoff_ms: retryDelay, request_id: preparedRequest.request_id, attempt_id: retryAttemptId!, body_digest: preparedRequest.body_digest });
          await sleep(retryDelay, signal).catch((error: unknown) => {
            if (isAbortError(error)) settleRetry('cancelled');
            throw error;
          });
          const controller = new AbortController();
          const onStreamRetryAbort = linkExternalAbortSignal(controller, signal);
          const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
          lastAttempt += 1;
          try {
            notifyPhase('request_dispatched', undefined, `stream retry ${lastAttempt}`);
            response = await this.campaignPhysicalFetch(
              campaignSession,
              callbacks,
              preparedRequest,
              physicalAttemptId,
              this.apiUrl,
              {
                method: 'POST',
                redirect: this.getRequestRedirect(),
                signal: controller.signal,
                headers: {
                  ...this.getAuthenticationHeaders(),
                  'Content-Type': 'application/json',
                  ...this.getRequestHeadersExtras(),
                },
                body: requestBody,
              },
              callbacks?.runControl,
              inferenceId,
            );
          } catch (error) {
            if (!(error instanceof RunStoppedError)) {
              campaignSession.settleUnknownOnOpenAdmission();
            }
            settleRetry(signal?.aborted ? 'cancelled' : 'failed');
            notifyPhase('provider_error', undefined, signal?.aborted ? 'timeout' : 'transport');
            notifyCompleted('failed', streamState.observedModelId, text, streamState.upstreamProvider, null, null, this.maxTokens, {
              actualAttempt: lastAttempt,
              details: { message: error instanceof Error ? error.message : String(error) },
              failureStage: 'request',
              inferenceStarted: !(error instanceof RunStoppedError),
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
              `[${this.providerId}] HTTP ${response.status} during stream retry (${this.model}): ${body}`,
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
        streamState.usage = data.usage ?? null;
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
          message: `[${this.providerId}] Failed to parse API response as JSON: ${String(err)}`,
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
        message: `[${this.providerId}] Empty response from model "${this.model}".`,
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
          `[${this.providerId}] invalid json (${this.model}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        raw_output: text,
        cause: err instanceof Error ? err : undefined,
      });
    }

    const result = schema.safeParse(parsed);
    const validationMs = Date.now() - validationStartedAt;

    this.lastInvocationMetadata = buildInvocationMetadata(
      this.providerId,
      this.model,
      Date.now() - startedAt,
      streamState.usage ?? undefined,
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
        message: `[${this.providerId}] Zod validation failed (${this.model}):\n${result.error.toString()}`,
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
        message: `[${this.providerId}] Empty response from model "${this.model}".`,
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
    const stopped = callbacks?.runControl?.stop();
    if (stopped) throw new RunStoppedError(stopped);
    const requestTimeoutMs = this.getRequestTimeoutMs();
    const requestMaxRetries = Math.max(1, this.getRequestMaxRetries());
    const streamIdleTimeoutMs = getStreamIdleTimeoutMs();
    const maxAttempts = requestMaxRetries;

    const buildBody = () => {
      const parsed = JSON.parse(this.buildNativeToolsWireBody(messages, tools, systemPrompt, {
        stream: true,
        toolChoice: toolChoice ?? 'auto',
      })) as Record<string, unknown>;
      return JSON.stringify(this.sealCampaignWireBody(parsed, callbacks));
    };
    const inferenceId = randomUUID();
    const preparedRequest = prepareProviderRequest({
      body: buildBody(),
      mode: 'native',
      provider: this.providerId,
      ...(this.contextWindowTokens ? { contextLimitTokens: this.contextWindowTokens, contextLimitSource: 'explicit' as const } : {}),
      requestedModelId: this.model,
      requestId: inferenceId,
      ...(callbacks?.parentRequestId !== undefined
        ? { parentRequestId: callbacks.parentRequestId }
        : {}),
      reservedCompletionTokens: this.executionEnvelope?.output.effective ?? this.maxTokens,
    });
    assertPreparedProviderRequestAdmissible(preparedRequest);
    const requestBody = preparedRequest.body;
    const requestAccounting = preparedRequest.accounting;
    this.lastWirePolicyHash = this.executionEnvelope
      ? hashWirePolicy(JSON.parse(requestBody) as WireRequest)
      : null;
    const inputDigest = requestAccounting.request_digest;
    const campaignSession = new CampaignPhysicalFetchSession(callbacks);
    callbacks?.onInvocationStarted?.({
      inference_id: inferenceId,
      request_id: preparedRequest.request_id,
      attempt_id: preparedRequest.attempt_id,
      ...(preparedRequest.parent_request_id !== null
        ? { parent_request_id: preparedRequest.parent_request_id }
        : {}),
      provider: this.providerId,
      requested_model_id: this.model,
      normalized_model_id: this.model,
      sent_model_id: this.model,
      input_digest: inputDigest,
      input_bytes: preparedRequest.body_bytes,
      accounting_kind: preparedRequest.accounting_kind,
      context_limit_tokens: preparedRequest.context_limit_tokens,
      context_limit_source: preparedRequest.context_limit_source,
      ...(requestAccounting.input_message_count === null
        ? {}
        : { input_message_count: requestAccounting.input_message_count }),
      requested_output_budget: this.executionEnvelope?.output.requested ?? this.maxTokens,
      effective_output_budget: this.executionEnvelope?.output.effective ?? this.maxTokens,
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
        failureStage?: import('../base.js').ProviderFailureStage;
        partialModelOutput?: boolean;
        toolCallCount?: number;
        inferenceStarted?: boolean;
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
              inferenceStarted: options.inferenceStarted ?? true,
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
        ...((status === 'delivered' || options.failureStage === 'response_normalization')
          ? { usage_metadata: this.getLastInvocationMetadata() } : {}),
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
        ...(callbacks?.campaignMeter ? { campaign_ledger_settled_by_transport: true } : {}),
      };
      campaignSession.finalizeInvocation(status, completion as ProviderInvocationCompleted);
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

    const protocolIssues = hardProviderProtocolIssues(messages);
    if (protocolIssues.length > 0) {
      const errMessage = `[${this.providerId}] Invalid provider protocol: ${protocolIssues
        .map((issue) => `${issue.code} (${issue.message})`)
        .join('; ')}`;
      notifyPhase('provider_error', undefined, 'invalid_protocol');
      notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
        actualAttempt: 0,
        details: { message: errMessage },
        failureStage: 'request',
      });
      yield { type: 'error', message: errMessage };
      return;
    }

    // ── HTTP request loop (with retries) ─────────────────────────────────
    let response: Response | null = null;
    let lastError: Error | null = null;
    let retryAttempt: number | null = null;
    let retryAttemptId: string | null = null;
    let physicalAttemptId = preparedRequest.attempt_id;
    let attemptDeadlineAt = Date.now() + requestTimeoutMs;
    const settleRetry = (outcome: 'succeeded' | 'failed' | 'cancelled'): void => {
      if (retryAttempt === null) return;
      callbacks?.onRetrySettled?.({
        provider: this.providerId, model: this.model, attempt: retryAttempt, outcome,
        request_id: preparedRequest.request_id,
        ...(retryAttemptId ? { attempt_id: retryAttemptId } : {}),
        body_digest: preparedRequest.body_digest,
      });
      retryAttempt = null;
      retryAttemptId = null;
    };

    for (let attempt = 1; attempt <= requestMaxRetries; attempt += 1) {
      lastAttempt = attempt;
      attemptDeadlineAt = Date.now() + requestTimeoutMs;
      const controller = new AbortController();
      const onExternalAbort = linkExternalAbortSignal(controller, signal);
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        notifyPhase('request_dispatched', undefined, `attempt ${attempt}`);
        response = await this.campaignPhysicalFetch(
          campaignSession,
          callbacks,
          preparedRequest,
          physicalAttemptId,
          this.apiUrl,
          {
            method: 'POST',
            redirect: this.getRequestRedirect(),
            signal: controller.signal,
            headers: {
              ...this.getAuthenticationHeaders(),
              'Content-Type': 'application/json',
              ...this.getRequestHeadersExtras(),
            },
            body: requestBody,
          },
          callbacks?.runControl,
          inferenceId,
        );
      } catch (err) {
        if (err instanceof RunStoppedError) {
          settleRetry('cancelled');
          notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
            actualAttempt: attempt, details: { message: err.message }, failureStage: 'request', inferenceStarted: false,
          });
          throw err;
        }
        if (err instanceof CampaignBudgetDeniedError || err instanceof CampaignRouteUnsupportedError) {
          throw err;
        }
        campaignSession.settleUnknownOnOpenAdmission();
        this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
        if (isCallerCancelError(err, signal)) {
          lastError = new Error(`[${this.providerId}] Request cancelled`);
          settleRetry('cancelled');
          notifyPhase('provider_error', undefined, 'cancelled');
          notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
            actualAttempt: attempt,
            details: { message: lastError.message },
            failureStage: 'request',
          });
          yield { type: 'error', message: lastError.message };
          return;
        }
        lastError = new Error(
          isAbortError(err)
            ? `[${this.providerId}] request timeout after ${requestTimeoutMs}ms (${this.model})`
            : `[${this.providerId}] Network error (${this.model}): ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < requestMaxRetries) {
          const retryDelay = retryDelayMs(attempt);
          settleRetry('failed');
          retryAttempt = attempt + 1;
          retryAttemptId = randomUUID();
          physicalAttemptId = retryAttemptId;
          await notifyProviderRetryOrFinalizeOnCallbackError({
            notifyRetry: () => callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt!, reason: (isAbortError(err) ? 'timeout' : 'transport') as 'timeout' | 'transport', backoff_ms: retryDelay, request_id: preparedRequest.request_id, attempt_id: retryAttemptId!, body_digest: preparedRequest.body_digest }),
            settleRetry, notifyPhase, notifyCompleted, actualAttempt: attempt, outputBudget: this.maxTokens,
            failure: { kind: 'transport', transportErrorMessage: lastError.message, transportPhase: isAbortError(err) ? 'timeout' : 'transport' },
          });
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
      campaignSession.settleUnknownOnOpenAdmission();
      retryAttempt = attempt + 1;
      retryAttemptId = randomUUID();
      physicalAttemptId = retryAttemptId;
      await notifyProviderRetryOrFinalizeOnCallbackError({
        notifyRetry: () => callbacks?.onRetry?.({ provider: this.providerId, model: this.model, attempt: retryAttempt!, reason: (response!.status === 429 ? 'rate_limit' : response!.status === 408 ? 'timeout' : 'server_error') as 'rate_limit' | 'timeout' | 'server_error', backoff_ms: retryDelay, request_id: preparedRequest.request_id, attempt_id: retryAttemptId!, body_digest: preparedRequest.body_digest }),
        settleRetry, notifyPhase, notifyCompleted, actualAttempt: attempt, outputBudget: this.maxTokens,
        failure: { kind: 'http', response: response! },
      });
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
      yield { type: 'error', message: lastError?.message ?? `[${this.providerId}] No response received` };
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
      yield { type: 'error', message: `[${this.providerId}] HTTP ${response.status} (${this.model}): ${body}` };
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
      yield { type: 'error', message: `[${this.providerId}] Streaming response had no body.` };
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
        let done: boolean;
        let value: Uint8Array | undefined;
        try {
          const result = await readStreamWithLimits(reader, {
            idleTimeoutMs: streamIdleTimeoutMs,
            deadlineAt: attemptDeadlineAt,
            requestTimeoutMs,
            ...(signal ? { signal } : {}),
            idleMessage: `[${this.providerId}] stream idle timeout after ${streamIdleTimeoutMs}ms`,
            deadlineMessage: `[${this.providerId}] request timeout after ${requestTimeoutMs}ms (${this.model})`,
          });
          done = result.done;
          value = result.value;
        } catch (err) {
          invocationFailed = true;
          const cancelled = isCallerCancelError(err, signal);
          const errMessage = cancelled
            ? `[${this.providerId}] Request cancelled`
            : err instanceof Error
              ? err.message
              : String(err);
          notifyPhase('provider_error', undefined, cancelled ? 'cancelled' : 'stream');
          // Every invocation must have a durable terminal receipt, including
          // reader stalls/cancellation that exit before the outer stream
          // finalizer runs.
          notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
            actualAttempt: lastAttempt,
            details: {
              message: errMessage,
              providerRequestId: providerRequestIdFromResponse(response),
            },
            failureStage: 'stream',
            partialModelOutput,
            toolCallCount,
            outputMaterial: outputReceipt,
          });
          yield { type: 'error', message: errMessage };
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

          let json: {
            error?: { message?: string; code?: unknown; type?: string };
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
          try {
            json = JSON.parse(data) as typeof json;
          } catch {
            invocationFailed = true;
            const errMessage = `[${this.providerId}] Malformed SSE event chunk: ${data.slice(0, 100)}`;
            notifyPhase('provider_error', undefined, 'malformed_sse');
            notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
              actualAttempt: lastAttempt,
              details: { message: errMessage },
              failureStage: 'stream',
              partialModelOutput,
              toolCallCount,
              outputMaterial: outputReceipt,
            });
            yield { type: 'error', message: errMessage };
            return;
          }

          if (json.error) {
            invocationFailed = true;
            const errMessage = `[${this.providerId}] Provider stream error: ${json.error.message || JSON.stringify(json.error)}`;
            notifyPhase('provider_error', undefined, 'provider_error_payload');
            notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
              actualAttempt: lastAttempt,
              details: { message: errMessage },
              failureStage: 'stream',
              partialModelOutput,
              toolCallCount,
              outputMaterial: outputReceipt,
            });
            yield { type: 'error', message: errMessage };
            return;
          }

          if (json.model) streamState.observedModelId = json.model;
          const upstreamProvider = upstreamProviderFromResponse(json);
          if (upstreamProvider) streamState.upstreamProvider = upstreamProvider;
          if (json.openrouter_metadata) streamState.routerMetadata = json.openrouter_metadata;
          if (json.usage) streamState.usage = json.usage;

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

          if (choice.finish_reason === 'error') {
            finishReason = 'error';
            streamState.finishReason = 'error';
            invocationFailed = true;
            const errMessage = `[${this.providerId}] Provider error during generation (finish_reason: error)`;
            notifyPhase('provider_error', undefined, 'finish_reason_error');
            notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, 'error', this.maxTokens, {
              actualAttempt: lastAttempt,
              details: { message: errMessage },
              failureStage: 'stream',
              partialModelOutput,
              toolCallCount,
              outputMaterial: outputReceipt,
            });
            yield { type: 'error', message: errMessage };
            return;
          } else if (choice.finish_reason) {
            finishReason = normalizeFinishReason(choice.finish_reason);
            streamState.finishReason = finishReason;
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
            if (json.choices?.[0]?.finish_reason === 'error') {
              invocationFailed = true;
              const errMessage = `[${this.providerId}] Provider error during generation (finish_reason: error)`;
              notifyPhase('provider_error', undefined, 'finish_reason_error');
              notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, 'error', this.maxTokens, {
                actualAttempt: lastAttempt,
                details: { message: errMessage },
                failureStage: 'stream',
                partialModelOutput,
                toolCallCount,
                outputMaterial: outputReceipt,
              });
              yield { type: 'error', message: errMessage };
              return;
            }
            if (json.choices?.[0]?.finish_reason) {
              finishReason = normalizeFinishReason(json.choices[0].finish_reason);
              streamState.finishReason = finishReason;
            }
          } catch (err) {
            throw new Error(
              `[${this.providerId}] Malformed SSE event chunk: ${data.slice(0, 100)}`,
              { cause: err },
            );
          }
        }
      }

      if (!sawDone) {
        throw new Error(`[${this.providerId}] stream closed before terminal [DONE] marker`);
      }

      streamState.generationMs = Date.now() - startedAt - (streamState.ttftMs ?? 0);

      streamState.finishReason = finishReason ?? (pendingToolCalls.size > 0 ? 'tool_calls' : 'stop');
      if (finishReason === 'length') {
        if (pendingToolCalls.size > 0) {
          invocationFailed = true;
          const errMessage = 'Incomplete tool call: truncated by provider token limit (finish_reason: length)';
          notifyPhase('response_normalization_failed', undefined, 'length_truncated_tool_call');
          notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, 'length', this.maxTokens, {
            actualAttempt: lastAttempt,
            details: { message: errMessage },
            failureStage: 'response_normalization',
            partialModelOutput,
            toolCallCount,
            outputMaterial: outputReceipt,
          });
          yield { type: 'error', message: errMessage };
          return;
        }
        invocationFailed = true;
        this.lastInvocationMetadata = buildStreamingInvocationMetadata(
          this.providerId, this.model, Date.now() - startedAt, streamState, this.maxTokens,
        );
        notifyPhase('response_normalization_failed', undefined, 'output_budget_exhausted');
        notifyCompleted(
          'failed',
          streamState.observedModelId,
          outputReceipt,
          streamState.upstreamProvider,
          streamState.routerMetadata,
          finishReason,
          this.maxTokens,
          {
            actualAttempt: lastAttempt,
            details: { message: `[${this.providerId}] Provider output budget exhausted.` },
            failureStage: 'response_normalization',
            partialModelOutput,
            toolCallCount,
            outputMaterial: outputReceipt,
          },
        );
        yield { type: 'done', finishReason: 'length' };
        return;
      }

      // ── Yield accumulated tool calls ──────────────────────────────────
      if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && pendingToolCalls.size > 0) {
        const seenToolIds = new Set<string>();
        for (const [callIndex, acc] of pendingToolCalls) {
          let callId = acc.id.trim();
          const idWasNormalized = callId !== acc.id || !callId || seenToolIds.has(callId);
          if (!callId || seenToolIds.has(callId)) {
            const baseId = `tool_call_${callIndex}`;
            let suffix = 0;
            callId = baseId;
            while (seenToolIds.has(callId)) {
              suffix += 1;
              callId = `${baseId}_${suffix}`;
            }
          }
          seenToolIds.add(callId);
          if (!acc.name || !acc.name.trim()) {
            invocationFailed = true;
            const errMessage = `[${this.providerId}] Incomplete tool call: missing name for tool call ${callId}`;
            notifyPhase('response_normalization_failed', undefined, 'missing_tool_name');
            notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
              actualAttempt: lastAttempt,
              details: { message: errMessage },
              failureStage: 'response_normalization',
              partialModelOutput,
              toolCallCount,
              outputMaterial: outputReceipt,
            });
            yield { type: 'error', message: errMessage };
            return;
          }
          if (!acc.arguments || !acc.arguments.trim()) {
            invocationFailed = true;
            const errMessage = `[${this.providerId}] Incomplete tool call: missing arguments for tool ${acc.name} (${callId})`;
            notifyPhase('response_normalization_failed', undefined, 'missing_tool_arguments');
            notifyCompleted('failed', streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata, streamState.finishReason, this.maxTokens, {
              actualAttempt: lastAttempt,
              details: { message: errMessage },
              failureStage: 'response_normalization',
              partialModelOutput,
              toolCallCount,
              outputMaterial: outputReceipt,
            });
            yield { type: 'error', message: errMessage };
            return;
          }
          let input: Record<string, unknown>;
          try {
            const parsed = JSON.parse(acc.arguments) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('tool arguments must be a JSON object');
            }
            input = parsed as Record<string, unknown>;
          } catch (error) {
            invocationFailed = true;
            this.lastInvocationMetadata = buildStreamingInvocationMetadata(
              this.providerId, this.model, Date.now() - startedAt, streamState, this.maxTokens,
            );
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
              message: `[${this.providerId}] Malformed arguments for tool ${acc.name || '<unknown>'}: ${error instanceof Error ? error.message : String(error)}`,
              malformedToolArguments: {
                callId, name: acc.name, finishReason: streamState.finishReason,
                idWasNormalized,
              },
            };
            return;
          }
          yield { type: 'tool_use', id: callId, name: acc.name, input, ...(idWasNormalized ? {idWasNormalized:true as const} : {}) };
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

    this.lastInvocationMetadata = buildStreamingInvocationMetadata(
      this.providerId, this.model, Date.now() - startedAt, streamState, this.maxTokens,
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
