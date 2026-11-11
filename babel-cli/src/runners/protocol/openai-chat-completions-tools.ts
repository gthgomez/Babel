import { RunStoppedError, type RunControl } from '../../runtime/run-control.js';
import { createHash, randomUUID } from 'node:crypto';
import { isRetryableStatus, normalizeFinishReason } from '../providerNormalize.js';
import { ProviderHttpError } from '../providerHttpError.js';
import {
  type ProviderMessage,
  type RunnerCallbacks,
  type ProviderInvocationPhase,
  type ToolDefinition,
  type ToolStreamEvent,
  type ProviderInvocationCompleted,
} from '../base.js';
import { hardProviderProtocolIssues } from '../providerMessages.js';
import {
  assertPreparedProviderRequestAdmissible,
  prepareProviderRequest,
} from '../preparedProviderRequest.js';
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
  canDispatchPhysicalRequest,
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
import { CampaignPhysicalFetchSession } from '../providerCampaignPhysicalFetch.js';
import { ssePayloadFromTrimmedLine } from './openai-chat-completions-sse.js';
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
    const invocationDeadlineAt = startedAt + requestTimeoutMs;
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
    let toolCallCount = 0;
    let invocationFailed = false;
    let responseValidationFailed = false;
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
            deadlineAt: invocationDeadlineAt,
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
          if (sawDone) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          const data = ssePayloadFromTrimmedLine(trimmed);
          if (data === null) continue;
          if (data === '[DONE]') {
            sawDone = true;
            streamState.sawDone = true;
            break;
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
        if (sawDone) {
          await reader.cancel().catch(() => {});
          break;
        }
      }

      // Process remaining buffered SSE line
      buffer += decoder.decode();
      if (!sawDone) {
        const tailPayload = buffer.trim() ? ssePayloadFromTrimmedLine(buffer.trim()) : null;
        if (tailPayload === '[DONE]') {
          sawDone = true;
          streamState.sawDone = true;
        } else if (tailPayload !== null && tailPayload !== '[DONE]') {
          const data = tailPayload;
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
      // Admit the observed route before exposing executable tools or terminal success.
      try {
        this.validateObservedModelId(streamState.observedModelId);
        this.validateObservedUpstream(streamState.upstreamProvider);
        this.validateObservedRouterMetadata(streamState.routerMetadata, streamState.observedModelId, streamState.upstreamProvider);
      } catch (error) {
        responseValidationFailed = true;
        this.lastInvocationMetadata = buildStreamingInvocationMetadata(
          this.providerId, this.model, Date.now() - startedAt, streamState, this.maxTokens,
        );
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
      if (responseValidationFailed) throw err;
      invocationFailed = true;
      notifyPhase('provider_error', undefined, 'stream');
      this.lastInvocationMetadata = buildStreamingInvocationMetadata(
        this.providerId, this.model, Date.now() - startedAt, streamState, this.maxTokens,
      );
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
    } finally {
      await releaseStreamReader(reader);
    }

    if (!this.lastInvocationMetadata) {
      this.lastInvocationMetadata = buildStreamingInvocationMetadata(
        this.providerId, this.model, Date.now() - startedAt, streamState, this.maxTokens,
      );
    };
    if (invocationFailed) {
      this.validateObservedModelId(streamState.observedModelId);
      this.validateObservedUpstream(streamState.upstreamProvider);
      this.validateObservedRouterMetadata(streamState.routerMetadata, streamState.observedModelId, streamState.upstreamProvider);
    } else {
      notifyPhase('stream_completed');
      notifyPhase('response_normalized');
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
