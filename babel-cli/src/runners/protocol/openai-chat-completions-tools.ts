import { RunStoppedError, type RunControl } from '../../runtime/run-control.js';
import { createHash, randomUUID } from 'node:crypto';
import { accumulateStreamFinish, classifyStreamFinish, ConflictingStreamFinishError, isRetryableStatus } from '../providerNormalize.js';
import { ProviderHttpError } from '../providerHttpError.js';
import {
  type ProviderMessage,
  type RunnerCallbacks,
  type ProviderFailureStage,
  type ProviderInvocationPhase,
  type ToolDefinition,
  type ToolStreamEvent,
  type ProviderInvocationCompleted,
} from '../base.js';
import { hardProviderProtocolIssues } from '../providerMessages.js';
import {
  assertPreparedProviderRequestAdmissible,
} from '../preparedProviderRequest.js';
import { parseRateLimitHeaders } from '../../ui/rateLimitWidget.js';
import { normalizeBabelFinishReason } from '../../intelligence/attribution.js';
import {
  buildProviderFailureReceipt,
  providerErrorCodeFromBody,
  providerRequestIdFromResponse,
  type ProviderFailureDetails,
} from '../providerFailureReceipt.js';
import {
  canDispatchPhysicalRequest,
  createInvocationDeadline,
  invocationTimeoutMessage,
  isAbortError,
  isCallerCancelError,
  isInvocationTimeoutError,
  linkExternalAbortSignal,
  remainingInvocationBudgetMs,
  retryDelayMs,
  sleepInvocationRetryBackoff,
} from '../providerResponsePolicy.js';
import { notifyProviderRetryOrFinalizeOnCallbackError } from '../providerRetryCallback.js';
import {
  getStreamIdleTimeoutMs,
  isProviderRequestDeadlineError,
  isStreamIdleTimeoutError,
  releaseStreamReader,
  readErrorBody,
  readStreamWithLimits,
  buildStreamingInvocationMetadata,
  recordObservedModelId,
  ProviderModelIdentityConflictError,
  type StreamingState,
} from '../providerResponseStream.js';
import {
  buildInvocationMetadata,
  routerMetadataProvenance,
  safeProviderFinishReason,
  type OpenRouterResponseMetadata,
  upstreamProviderFromResponse,
} from '../providerResponseMetadata.js';
import {
  CampaignBudgetDeniedError,
  CampaignRouteUnsupportedError,
} from '../campaignDispatchGate.js';
import { CampaignPhysicalFetchSession } from '../providerCampaignPhysicalFetch.js';
import {
  MalformedChatCompletionsResponseError,
  parseChatCompletionsStreamFrame,
  readChatCompletionsStreamChoice,
  ssePayloadFromTrimmedLine,
} from './openai-chat-completions-sse.js';
import { OpenAiCompatibleRunnerBase } from './openai-chat-completions-base.js';

export class OpenAiCompatibleRunner extends OpenAiCompatibleRunnerBase {
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
    signal?.throwIfAborted();
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
    const { request: preparedRequest, sentOutputBudget } = this.prepareCompatibleRequest(
      buildBody(), 'native', inferenceId, callbacks?.parentRequestId,
    );
    assertPreparedProviderRequestAdmissible(preparedRequest);
    const requestBody = preparedRequest.body;
    const requestAccounting = preparedRequest.accounting;
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
      requested_model_id: preparedRequest.requested_model_id,
      normalized_model_id: preparedRequest.normalized_model_id,
      sent_model_id: preparedRequest.sent_model_id,
      input_digest: inputDigest,
      input_bytes: preparedRequest.body_bytes,
      accounting_kind: preparedRequest.accounting_kind,
      context_limit_tokens: preparedRequest.context_limit_tokens,
      context_limit_source: preparedRequest.context_limit_source,
      ...(requestAccounting.input_message_count === null
        ? {}
        : { input_message_count: requestAccounting.input_message_count }),
      requested_output_budget: this.requestedOutputBudget,
      effective_output_budget: this.maxTokens,
      sent_output_budget: sentOutputBudget,
      ...(this.executionEnvelope
        ? {
            execution_envelope_hash: this.executionEnvelope.configurationHash,
            ...(this.lastWirePolicyHash === null ? {} : { wire_policy_hash: this.lastWirePolicyHash }),
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
    let reportedProviderFinish: string | null = null;
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
        errorKind?: 'protocol' | 'provider' | 'none';
        interrupted?: boolean;
      } = {},
    ): void => {
      if (completionSent) return;
      completionSent = true;
      const router = routerMetadataProvenance(routerMetadata);
      const usage = this.getLastInvocationMetadata();
      const finish = normalizeBabelFinishReason({
        raw: finishReason,
        configuredOutputBudget: configuredOutputBudget !== null && usage?.completion_tokens != null ? sentOutputBudget : null,
        actualCompletionTokens: usage?.completion_tokens ?? null,
        ...(options.interrupted ? { interrupted: true } : status === 'failed'
          ? options.failureStage === 'response_normalization'
            ? options.errorKind === 'provider'
              ? { providerError: true }
              : options.errorKind === 'none'
                ? {}
                : { protocolError: true }
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
               requestedOutputBudget: this.requestedOutputBudget,
               effectiveOutputBudget: this.maxTokens,
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
        usage_metadata: usage,
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
        provider_finish_reason: safeProviderFinishReason(reportedProviderFinish),
        requested_output_budget: this.requestedOutputBudget,
        effective_output_budget: this.maxTokens,
        sent_output_budget: options.inferenceStarted === false ? null : sentOutputBudget,
        provider_effective_output_budget: null,
        ...(this.executionEnvelope
          ? {
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
        inferenceStarted: false,
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
    const invocationDeadlineAt = createInvocationDeadline(requestTimeoutMs);
    const errorBodyReadOpts = {
      idleTimeoutMs: streamIdleTimeoutMs,
      deadlineAt: invocationDeadlineAt,
      requestTimeoutMs,
      ...(signal ? { signal } : {}),
    };
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
      if (!canDispatchPhysicalRequest(invocationDeadlineAt)) {
        const timeoutError = new Error(
          invocationTimeoutMessage(this.providerId, this.model, requestTimeoutMs),
        );
        lastError = timeoutError;
        settleRetry('failed');
        notifyPhase('provider_error', undefined, 'timeout');
        notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
          actualAttempt: attempt,
          details: { message: timeoutError.message },
          failureStage: 'request',
        });
        yield { type: 'error', message: timeoutError.message };
        return;
      }
      const attemptBudgetMs = remainingInvocationBudgetMs(invocationDeadlineAt);
      const controller = new AbortController();
      const onExternalAbort = linkExternalAbortSignal(controller, signal);
      const timeout = setTimeout(() => controller.abort(), attemptBudgetMs);
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
            interrupted: true,
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
          try {
            await sleepInvocationRetryBackoff(
              retryDelay,
              invocationDeadlineAt,
              this.providerId,
              this.model,
              requestTimeoutMs,
              signal,
            );
          } catch (sleepErr) {
            if (isCallerCancelError(sleepErr, signal)) {
              settleRetry('cancelled');
              const errMessage = `[${this.providerId}] Request cancelled`;
              notifyPhase('provider_error', undefined, 'cancelled');
              notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
                actualAttempt: lastAttempt,
                details: { message: errMessage },
                failureStage: 'request',
              });
              yield { type: 'error', message: errMessage };
              return;
            }
            if (isInvocationTimeoutError(sleepErr) || isAbortError(sleepErr)) {
              settleRetry('failed');
              const errMessage = sleepErr instanceof Error ? sleepErr.message : String(sleepErr);
              notifyPhase('provider_error', undefined, 'timeout');
              notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
                actualAttempt: lastAttempt,
                details: { message: errMessage },
                failureStage: 'request',
              });
              yield { type: 'error', message: errMessage };
              return;
            }
            throw sleepErr;
          }
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
      try {
        await sleepInvocationRetryBackoff(
          retryDelay,
          invocationDeadlineAt,
          this.providerId,
          this.model,
          requestTimeoutMs,
          signal,
        );
      } catch (sleepErr) {
        if (isCallerCancelError(sleepErr, signal)) {
          settleRetry('cancelled');
          const errMessage = `[${this.providerId}] Request cancelled`;
          notifyPhase('provider_error', undefined, 'cancelled');
          notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
            actualAttempt: lastAttempt,
            details: { message: errMessage },
            failureStage: 'request',
          });
          yield { type: 'error', message: errMessage };
          return;
        }
        if (isInvocationTimeoutError(sleepErr) || isAbortError(sleepErr)) {
          settleRetry('failed');
          const errMessage = sleepErr instanceof Error ? sleepErr.message : String(sleepErr);
          notifyPhase('provider_error', undefined, 'timeout');
          notifyCompleted('failed', null, '', null, null, null, this.maxTokens, {
            actualAttempt: lastAttempt,
            details: { message: errMessage },
            failureStage: 'request',
          });
          yield { type: 'error', message: errMessage };
          return;
        }
        throw sleepErr;
      }
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
      let body = '';
      try {
        body = await readErrorBody(response, errorBodyReadOpts);
      } catch (err) {
        this.lastInvocationMetadata = buildInvocationMetadata(this.providerId, this.model, Date.now() - startedAt);
        const errMessage = err instanceof Error ? err.message : String(err);
        const timedOut = isStreamIdleTimeoutError(err) || isProviderRequestDeadlineError(err)
          || isInvocationTimeoutError(err) || isAbortError(err);
        notifyPhase('provider_error', response.status, timedOut ? 'timeout' : 'http_error');
        notifyCompleted('failed', null, body, null, null, null, this.maxTokens, {
          actualAttempt: lastAttempt,
          details: {
            status: response.status,
            message: errMessage,
            providerRequestId: providerRequestIdFromResponse(response),
          },
          failureStage: 'response',
        });
        yield { type: 'error', message: errMessage };
        return;
      }
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
      const failure = new ProviderHttpError(this.providerId, this.model, response.status, 'response', providerRequestIdFromResponse(response),
        `[${this.providerId}] HTTP ${response.status} (${this.model})`, providerErrorCodeFromBody(body));
      yield { type: 'error', message: failure.message, failure };
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
    let responseValidationFailed = false;
    let hasText = false;

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
    const settleStream = (failure?: {
      stage: ProviderFailureStage;
      message: string;
      apiErrorCode?: string | null;
      errorKind?: 'protocol' | 'provider' | 'none';
      interrupted?: boolean;
    }): void => {
      this.lastInvocationMetadata = buildStreamingInvocationMetadata(
        this.providerId, this.model, Date.now() - startedAt, streamState, sentOutputBudget,
      );
      notifyCompleted(
        failure ? 'failed' : 'delivered',
        streamState.observedModelId, outputReceipt, streamState.upstreamProvider, streamState.routerMetadata,
        streamState.finishReason, this.maxTokens,
        failure ? {
          details: {
            message: failure.message,
            providerRequestId: providerRequestIdFromResponse(response),
            ...(failure.apiErrorCode !== undefined ? { apiErrorCode: failure.apiErrorCode } : {}),
          },
          failureStage: failure.stage,
          partialModelOutput,
          toolCallCount: pendingToolCalls.size,
          ...(failure.errorKind ? { errorKind: failure.errorKind } : {}),
          ...(failure.interrupted ? { interrupted: true } : {}),
        } : {},
      );
    };

    try {
      let finishReason: string | null = null;

      while (true) {
        const { done, value } = await readStreamWithLimits(reader, {
          idleTimeoutMs: streamIdleTimeoutMs,
          deadlineAt: invocationDeadlineAt,
          requestTimeoutMs,
          ...(signal ? { signal } : {}),
          idleMessage: `[${this.providerId}] stream idle timeout after ${streamIdleTimeoutMs}ms`,
          deadlineMessage: `[${this.providerId}] request timeout after ${requestTimeoutMs}ms (${this.model})`,
        });
        if (!done) {
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
        }

        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop() ?? '';

        for (const line of lines) {
          signal?.throwIfAborted();
          const trimmed = line.trim();
          if (!trimmed) continue;
          const data = ssePayloadFromTrimmedLine(trimmed);
          if (data === null) continue;
          if (data === '[DONE]') {
            streamState.sawDone = true;
            break;
          }
          const json = parseChatCompletionsStreamFrame(data);
          recordObservedModelId(streamState, json.model);
          const router = json.openrouter_metadata as OpenRouterResponseMetadata | null | undefined;
          const upstreamProvider = upstreamProviderFromResponse({
            ...(json.provider ? { provider: json.provider } : {}),
            ...(router ? { openrouter_metadata: router } : {}),
          });
          if (upstreamProvider) streamState.upstreamProvider = upstreamProvider;
          if (router) streamState.routerMetadata = router;
          if (json.usage) streamState.usage = json.usage;
          if (json.error) {
            const apiErrorCode = providerErrorCodeFromBody(data);
            const errMessage = `[${this.providerId}] Provider stream error${apiErrorCode ? ` [${apiErrorCode}]` : ''}`;
            notifyPhase('provider_error', undefined, 'provider_error_payload');
            settleStream({ stage: 'stream', message: errMessage, apiErrorCode });
            yield { type: 'error', message: errMessage };
            return;
          }

          const choice = readChatCompletionsStreamChoice(json.choices, finishReason);
          if (!choice) continue;
          const delta = choice.delta;
          if (choice.finish_reason?.trim()) {
            finishReason = accumulateStreamFinish(finishReason, choice.finish_reason);
            reportedProviderFinish ??= choice.finish_reason;
            streamState.providerFinishReason = reportedProviderFinish;
            streamState.finishReason = finishReason;
          }

          if (delta?.reasoning_content) {
            partialModelOutput = true;
            streamState.partialModelOutput = true;
            outputReceipt += `reasoning:${delta.reasoning_content}\n`;
            streamState.outputReceipt = outputReceipt;
            yield { type: 'thought_delta', text: delta.reasoning_content };
          }

          if (delta?.content) {
            hasText ||= delta.content.trim().length > 0;
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
              }
              const acc = pendingToolCalls.get(idx)!;
              if ((tc.id && acc.id && tc.id !== acc.id) ||
                  (tc.function?.name && acc.name && tc.function.name !== acc.name)) {
                throw new MalformedChatCompletionsResponseError('Malformed SSE event chunk (conflicting tool identity)');
              }
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

          if (finishReason === 'error') {
            const errMessage = `[${this.providerId}] Provider error during generation (finish_reason: error)`;
            notifyPhase('provider_error', undefined, 'finish_reason_error');
            settleStream({ stage: 'stream', message: errMessage });
            yield { type: 'error', message: errMessage };
            return;
          }
        }
        if (streamState.sawDone) await reader.cancel().catch(() => {});
        if (done || streamState.sawDone) break;
      }

      // One explicit terminal disposition. Missing, filtered, truncated or
      // unrecognized finishes fail the invocation; accumulated output remains
      // diagnostic evidence and never becomes actionable tool input.
      const disposition = streamState.sawDone ? classifyStreamFinish({
        reported: finishReason,
        sawDone: true,
        hasToolCalls: pendingToolCalls.size > 0,
      }) : null;
      if (disposition) {
        streamState.generationMs = Date.now() - startedAt - (streamState.ttftMs ?? 0);
        streamState.finishReason = disposition.finishReason;
      } else {
        signal?.throwIfAborted();
        if (!partialModelOutput && !streamState.observedModelId &&
            !streamState.upstreamProvider && !streamState.routerMetadata) {
          throw new Error(`[${this.providerId}] stream closed before terminal [DONE] marker`);
        }
      }
      // Preserve route attribution even at premature EOF, before reporting a transport failure.
      try {
        this.validateObservedModelId(streamState.observedModelId);
        this.validateObservedUpstream(streamState.upstreamProvider);
        this.validateObservedRouterMetadata(streamState.routerMetadata, streamState.observedModelId, streamState.upstreamProvider);
      } catch (error) {
        responseValidationFailed = true;
        settleStream({
          stage: disposition ? 'response_normalization' : 'stream',
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (!disposition) {
        throw new Error(`[${this.providerId}] stream closed before terminal [DONE] marker`);
      }
      if (disposition.status === 'failed') {
        const errMessage = `[${this.providerId}] ${
          disposition.finishReason === 'length' && pendingToolCalls.size > 0
            ? 'Incomplete tool call: truncated by provider token limit (finish_reason: length)'
            : disposition.message
        }`;
        notifyPhase('response_normalization_failed', undefined, disposition.finishReason);
        settleStream({ stage: 'response_normalization', message: errMessage, errorKind: disposition.errorKind });
        yield {
          type: 'error', message: errMessage,
          ...(disposition.finishReason === 'tool_calls' ? { terminalFailure: 'tool_completion_without_call' } : {}),
        };
        return;
      }

      signal?.throwIfAborted();
      if (!disposition.executeTools && !hasText) {
        throw new MalformedChatCompletionsResponseError('Empty provider response: no answer text or actionable tool calls');
      }

      // ── Yield accumulated tool calls ──────────────────────────────────
      if (disposition.executeTools && pendingToolCalls.size > 0) {
        const seenToolIds = new Set<string>();
        const validatedToolCalls: Extract<ToolStreamEvent, { type: 'tool_use' }>[] = [];
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
            const errMessage = `[${this.providerId}] Incomplete tool call: missing name for tool call ${callId}`;
            notifyPhase('response_normalization_failed', undefined, 'missing_tool_name');
            settleStream({ stage: 'response_normalization', message: errMessage });
            yield { type: 'error', message: errMessage };
            return;
          }
          if (!acc.arguments || !acc.arguments.trim()) {
            const errMessage = `[${this.providerId}] Incomplete tool call: missing arguments for tool ${acc.name} (${callId})`;
            notifyPhase('response_normalization_failed', undefined, 'missing_tool_arguments');
            settleStream({ stage: 'response_normalization', message: errMessage });
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
          } catch {
            const errMessage = `[${this.providerId}] Malformed arguments for tool ${acc.name}: expected a JSON object`;
            notifyPhase('response_normalization_failed', undefined, 'tool_arguments');
            settleStream({ stage: 'response_normalization', message: errMessage });
            yield {
              type: 'error',
              message: errMessage,
              malformedToolArguments: {
                callId, name: acc.name, finishReason: disposition.finishReason,
                idWasNormalized,
              },
            };
            return;
          }
          validatedToolCalls.push({ type: 'tool_use', id: callId, name: acc.name, input, ...(idWasNormalized ? {idWasNormalized:true as const} : {}) });
        }
        for (const call of validatedToolCalls) {
          signal?.throwIfAborted();
          yield call;
        }
        signal?.throwIfAborted();
      }
      notifyPhase('stream_completed');
      notifyPhase('response_normalized');
      settleStream();
      yield { type: 'done', finishReason: disposition.finishReason };
    } catch (err) {
      if (responseValidationFailed) throw err;
      if (err instanceof ProviderModelIdentityConflictError) {
        responseValidationFailed = true;
        const message = err.message;
        settleStream({ stage: 'response_normalization', message });
        throw err;
      }
      const cancelled = isCallerCancelError(err, signal);
      const protocolError = err instanceof ConflictingStreamFinishError || err instanceof MalformedChatCompletionsResponseError;
      const errMessage = cancelled ? `[${this.providerId}] Request cancelled` : err instanceof Error ? err.message : String(err);
      notifyPhase('provider_error', undefined, cancelled ? 'cancelled' : 'stream');
      settleStream({ stage: protocolError ? 'response_normalization' : 'stream', message: errMessage, interrupted: cancelled });
      yield { type: 'error', message: errMessage };
    } finally {
      await releaseStreamReader(reader);
      if (!completionSent) {
        notifyPhase('provider_error', undefined, 'consumer_stopped');
        settleStream({ stage: 'stream', message: 'Provider stream consumption interrupted', interrupted: true });
      }
    }
  }
}
