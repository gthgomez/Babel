import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { OllamaApiRunner } from '../runners/ollamaApi.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
import { getGlobalTokenTracker } from '../ui/tokenHistory.js';
import { pushRoutingReceiptFromMetadata } from './chatEngineObservability.js';
import type { ChatPhase } from './chatPhaseNudge.js';
import type { TurnRoutingReceiptLog } from './turnRoutingReceipt.js';
import type { ProviderInvocationStarted, RunnerCallbacks, RunnerInvocationMetadata } from '../runners/base.js';
import { globalCostTracker, type UsageAttribution } from '../services/costTracker.js';
import { buildContextManifest, type ContextDeliveryMode } from './contextManifest.js';
import { buildModelRouteReceipt, hashRouteReference, type ModelRouteStage } from './modelRouteReceipt.js';
import {
  recordCapabilityBindingReceipt,
  recordModelInputReceipt,
  recordModelInvocationPhase,
  recordModelResultDelivery,
} from './sessionEvents.js';
import {
  checkpointParityEventLog,
  parityRecordProviderRetry,
  paritySettleProviderRetry,
  type ParityRuntime,
} from './chatEngineParityBridge.js';

export type ChatUsageScope = {
  taskOwnerId: string | null;
  projectRoot?: string;
  accountingEpoch: string;
  turnId: string | null;
  chargeId: string | null;
  requestId?: string;
  attemptId?: string;
  runDir?: string;
  modelId?: string;
  usageMetadata?: RunnerInvocationMetadata | null;
  ownerGeneration?: number;
  isOwnerCurrent?: () => boolean;
};

export interface ChatProviderRetryHost {
  readonly conversation: unknown[];
  readonly engineRunDir: string;
  readonly options: { projectRoot: string; task: string };
  readonly parity: ParityRuntime;
  readonly taskAllowance: { taskOwnerId: string } | null;
  readonly _turnIndex: number;
  readonly _lastPhase: ChatPhase | null;
  readonly routingReceiptLog: TurnRoutingReceiptLog;
  apiTokenCount: number;
  lastRequestCompletionTokens: number | null;
  lastRequestModelId: string | null;
  lastRequestPromptTokens: number | null;
  lastLogicalRequestId: string | null;
  pendingParentRequestId: string | null;
  pendingUsageChargeId: string | null;
  checkBudgets(skipTurnLimit?: boolean): { ok: boolean; reason?: string };
  persistOwnerCharges(ownerId: string, runDir?: string): void;
  persistTaskCostBaseline(): void;
  recordOwnerAccountingFault(
    scope: ChatUsageScope,
    kind: 'settlement-conflict' | 'persistence-failure',
    reason: string,
    appliesToCurrent: boolean,
  ): void;
}

export function captureUsageAttribution(
  scope: ChatUsageScope,
  chargeId = scope.chargeId,
  requestId?: string,
  attemptId?: string,
): UsageAttribution | undefined {
  if (!scope.taskOwnerId || !chargeId) return undefined;
  const capturedRequestId = arguments.length < 3 ? scope.requestId : requestId;
  const capturedAttemptId = arguments.length < 4 ? scope.attemptId : attemptId;
  return Object.freeze({
    taskOwnerId: scope.taskOwnerId,
    chargeId,
    accountingEpoch: scope.accountingEpoch,
    ...(scope.turnId ? { turnId: scope.turnId } : {}),
    ...(capturedRequestId ? { requestId: capturedRequestId } : {}),
    ...(capturedAttemptId ? { attemptId: capturedAttemptId } : {}),
    ...(scope.projectRoot
      ? { projectRoot: scope.projectRoot, projectRootVersion: 1 as const }
      : {}),
  });
}

export function buildProviderRetryCallbacks(host: ChatProviderRetryHost, context: {
  deliveryMode?: ContextDeliveryMode;
  conversationState?: unknown;
  systemPolicyPrompt?: unknown;
  userTaskPrompt?: unknown;
  toolSchema?: unknown;
  promptInputTokenCount?: number | null;
  contextTruncated?: boolean | null;
  expectedPriorEventIds?: readonly string[];
  deliveredPriorEventIds?: readonly string[];
  executionStage?: ModelRouteStage;
  contractRef?: string;
  substitutionOrFallback?: boolean;
  isOwnerCurrent?: () => boolean;
  usageScope?: ChatUsageScope;
} = {}): RunnerCallbacks {
    let startedInvocation: ProviderInvocationStarted | null = null;
    let retryCount = 0;
    const seenRetryAttemptIds = new Set<string>();
    const ownerRunDir = host.engineRunDir;
    const isOwnerCurrent = context.isOwnerCurrent ?? (() => true);
    const parentRequestId =
      host.pendingParentRequestId ??
      (context.substitutionOrFallback && host.lastLogicalRequestId !== null
        ? host.lastLogicalRequestId
        : null);
    return {
      parentRequestId,
      onInvocationStarted: (event) => {
        if (context.usageScope) {
          context.usageScope.chargeId = event.inference_id;
          delete context.usageScope.usageMetadata;
          Object.assign(context.usageScope, {
            requestId: event.request_id,
            attemptId: event.attempt_id,
            runDir: ownerRunDir,
            modelId: event.sent_model_id,
          });
          if (context.usageScope.taskOwnerId) {
            const scope = context.usageScope;
            const ownerId = scope.taskOwnerId!;
            const attribution = captureUsageAttribution(
              scope, event.inference_id, event.request_id, event.attempt_id,
            );
            const update = globalCostTracker.settleUsage(
              event.sent_model_id, 0, 0, null, null, attribution, false,
            );
            if (update.kind === 'conflict') {
              const appliesToCurrent = ownerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent();
              host.recordOwnerAccountingFault(scope, 'settlement-conflict', update.reason, appliesToCurrent);
              try {
                host.persistOwnerCharges(ownerId, ownerRunDir);
              } catch (error) {
                host.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  appliesToCurrent,
                );
              }
              throw new Error(`Provider dispatch blocked by charge conflict: ${update.reason}`);
            }
            if (update.kind === 'inserted') {
              try {
                host.persistOwnerCharges(ownerId, ownerRunDir);
              } catch (error) {
                host.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  ownerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
                );
                throw new Error('Provider dispatch blocked because its charge receipt could not be saved');
              }
            }
          }
        }
        startedInvocation = event;
        if (!isOwnerCurrent()) return;
        if (!host.parity.turnId) return;
        host.pendingUsageChargeId = event.inference_id;
        retryCount = 0;
        const recordedParentRequestId = event.parent_request_id ?? parentRequestId;
        const derivedExpectedPriorEventIds = host.parity.sessionEvents.events
          .filter(
            (prior) =>
              prior.kind === 'tool_completed' ||
              prior.kind === 'tool_failed' ||
              prior.kind === 'tool_cancelled',
          )
          .map((prior) => prior.tool_call_id);
        const compactionEvents = host.parity.sessionEvents.events.filter(
          (prior) =>
            prior.kind === 'compaction_summary' ||
            prior.kind === 'compaction_committed',
        );
        const expectedPriorEventIds = context.expectedPriorEventIds ?? derivedExpectedPriorEventIds;
        const deliveredPriorEventIds =
          context.deliveredPriorEventIds ??
          event.delivered_tool_call_ids ??
          (context.deliveryMode === 'text' ? expectedPriorEventIds : undefined);
        const contextManifest = buildContextManifest({
          inferenceId: event.inference_id,
          conversationState: context.conversationState ?? host.conversation,
          systemPolicyPrompt: context.systemPolicyPrompt,
          userTaskPrompt: context.userTaskPrompt ?? host.options.task,
          toolSchema: context.toolSchema,
          expectedPriorEventIds,
          ...(deliveredPriorEventIds !== undefined
            ? { deliveredPriorEventIds }
            : {}),
          deliveryMode:
            context.deliveryMode ??
            (event.delivered_tool_call_ids !== undefined ? 'native' : 'unknown'),
          compactionOccurred: compactionEvents.length > 0,
          compactionInputState: compactionEvents.map((compaction) => ({
            operation_id: compaction.operation_id,
            kind: compaction.kind,
          })),
          preservedEventIds: compactionEvents.flatMap(
            (compaction) => compaction.preserved_tool_call_ids,
          ),
          promptInputTokenCount: context.promptInputTokenCount ?? null,
          contextTruncated: context.contextTruncated ?? null,
        });
        const routeReceipt = buildModelRouteReceipt({
          projectRef: hashRouteReference(host.options.projectRoot),
          taskRef: hashRouteReference(host.options.task),
          runRef: host.engineRunDir,
          contractRef: context.contractRef ?? 'chat',
          inferenceId: event.inference_id,
          executionStage: context.executionStage ?? 'chat',
          requestedModelSelector: event.requested_model_id,
          normalizedBabelModel: event.normalized_model_id,
          provider: event.provider,
          exactModelIdSent: event.sent_model_id,
          observedModelId: null,
          upstreamProvider: null,
          substitutionOrFallback: context.substitutionOrFallback ?? false,
        });
        recordModelInputReceipt(host.parity.sessionEvents, {
          turn_id: host.parity.turnId,
          inference_id: event.inference_id,
          provider: event.provider,
          requested_model_id: event.requested_model_id,
          normalized_model_id: event.normalized_model_id,
          sent_model_id: event.sent_model_id,
          input_digest: event.input_digest,
          ...(event.request_id !== undefined ? { request_id: event.request_id } : {}),
          ...(event.attempt_id !== undefined ? { attempt_id: event.attempt_id } : {}),
          ...(recordedParentRequestId !== null && recordedParentRequestId !== undefined
            ? { parent_request_id: recordedParentRequestId }
            : {}),
          body_digest: event.input_digest,
          ...(event.input_bytes !== undefined ? { body_bytes: event.input_bytes } : {}),
          ...(event.accounting_kind !== undefined ? { accounting_kind: event.accounting_kind } : {}),
          ...(event.context_limit_tokens !== undefined ? { context_limit_tokens: event.context_limit_tokens } : {}),
          ...(event.context_limit_source !== undefined ? { context_limit_source: event.context_limit_source } : {}),
          input_ref: join(host.engineRunDir, 'thread_events.json'),
          ...(event.input_message_count !== undefined
            ? { input_message_count: event.input_message_count }
            : {}),
          ...(event.delivered_tool_call_ids !== undefined
            ? { delivered_tool_call_ids: [...event.delivered_tool_call_ids] }
            : {}),
          context_manifest: contextManifest,
          route_receipt: routeReceipt,
        });
        host.lastLogicalRequestId = event.request_id ?? event.inference_id;
        host.pendingParentRequestId = null;
        for (const capability of event.capability_bindings ?? []) {
          recordCapabilityBindingReceipt(host.parity.sessionEvents, {
            turn_id: host.parity.turnId,
            inference_id: event.inference_id,
            provider: event.provider,
            capability: capability.capability,
            advertised: capability.advertised,
            authorized: capability.authorized,
            effective: capability.effective,
            ...(capability.evidence_ref !== undefined
              ? { evidence_ref: capability.evidence_ref }
              : {}),
          });
        }
        checkpointParityEventLog(host.parity, host.engineRunDir);
      },
      onInvocationCompleted: (event) => {
        if (event.status === 'failed' && context.usageScope?.chargeId === event.inference_id) {
          context.usageScope.usageMetadata = null;
          context.usageScope.modelId = event.model;
          if (event.inference_started === false) {
            const scope = context.usageScope;
            const attribution = captureUsageAttribution(
              scope, event.inference_id, scope.requestId, scope.attemptId,
            );
            const chargeStillPending = scope.taskOwnerId &&
              globalCostTracker.getTaskChargeIds(scope.taskOwnerId).includes(event.inference_id);
            const cleared = !!attribution && globalCostTracker.clearUnstartedCharge(attribution);
            if (cleared && scope.taskOwnerId) {
              try {
                host.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
              } catch (error) {
                host.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
                );
              }
            } else if (chargeStillPending) {
              host.recordOwnerAccountingFault(
                scope, 'settlement-conflict', 'Unstarted provider charge could not be cleared safely',
                scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
            if (!chargeStillPending || cleared) context.usageScope.chargeId = null;
          }
        }
        if (event.status === 'delivered' && context.usageScope &&
            context.usageScope.chargeId === event.inference_id) {
          context.usageScope.usageMetadata = event.usage_metadata
            ? { ...event.usage_metadata } : null;
          if (!isOwnerCurrent() && context.usageScope.taskOwnerId) {
            const scope = context.usageScope;
            const metadata = scope.usageMetadata;
            const known = metadata?.prompt_tokens != null &&
              metadata.completion_tokens != null;
            const attribution = captureUsageAttribution(
              scope, event.inference_id, scope.requestId, scope.attemptId,
            );
            const update = globalCostTracker.settleUsage(
              metadata?.provider_model_id ?? event.model,
              known ? metadata!.prompt_tokens! : 0,
              known ? metadata!.completion_tokens! : 0,
              metadata?.prompt_cache_hit_tokens ?? null,
              metadata?.prompt_cache_miss_tokens ?? null,
              attribution,
              known,
            );
            if (update.kind === 'conflict') {
              const scope = context.usageScope;
              const appliesToCurrent = scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent();
              host.recordOwnerAccountingFault(scope, 'settlement-conflict', update.reason, appliesToCurrent);
              try {
                host.persistOwnerCharges(scope.taskOwnerId!, ownerRunDir);
              } catch (error) {
                host.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  appliesToCurrent,
                );
              }
            }
            if (update.kind === 'inserted' || update.kind === 'refined') {
              try {
                host.persistOwnerCharges(context.usageScope.taskOwnerId, ownerRunDir);
              } catch (error) {
                host.recordOwnerAccountingFault(
                  context.usageScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  context.usageScope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
                );
              }
            }
          }
        }
        // An inference that started and failed may still be billed. Settle its
        // attempt under the captured owner even if a successor now owns the
        // engine; authority checks below govern live state, not old billing.
        if (event.status === 'failed' && event.inference_started === true &&
            context.usageScope?.taskOwnerId &&
            globalCostTracker.getTaskChargeIds(context.usageScope.taskOwnerId).includes(event.inference_id)) {
          const scope = context.usageScope;
          const attribution = captureUsageAttribution(scope, event.inference_id, scope.requestId, scope.attemptId);
          const update = globalCostTracker.settleUsage(
            event.model, 0, 0, null, null, attribution,
            false,
          );
          if (update.kind === 'conflict') {
            const appliesToCurrent = scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent();
            host.recordOwnerAccountingFault(scope, 'settlement-conflict', update.reason, appliesToCurrent);
            try {
              host.persistOwnerCharges(scope.taskOwnerId!, ownerRunDir);
            } catch (error) {
              host.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                appliesToCurrent,
              );
            }
          }
          if (update.kind === 'inserted' || update.kind === 'refined') {
            try {
              host.persistOwnerCharges(scope.taskOwnerId!, ownerRunDir);
            } catch (error) {
              host.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
            if (isOwnerCurrent()) host.persistTaskCostBaseline();
          }
        }
        if (!isOwnerCurrent()) return;
        if (!host.parity.turnId) return;
        const observedRouteReceipt = startedInvocation
          ? buildModelRouteReceipt({
              projectRef: hashRouteReference(host.options.projectRoot),
              taskRef: hashRouteReference(host.options.task),
              runRef: host.engineRunDir,
              contractRef: context.contractRef ?? 'chat',
              inferenceId: event.inference_id,
              executionStage: context.executionStage ?? 'chat',
              requestedModelSelector: startedInvocation.requested_model_id,
              normalizedBabelModel: startedInvocation.normalized_model_id,
              provider: startedInvocation.provider,
              exactModelIdSent: startedInvocation.sent_model_id,
              observedModelId: event.observed_model_id ?? null,
              upstreamProvider: event.upstream_provider ?? null,
              retryCount,
              substitutionOrFallback: context.substitutionOrFallback ?? false,
            })
          : undefined;
        recordModelResultDelivery(host.parity.sessionEvents, {
          turn_id: host.parity.turnId,
          inference_id: event.inference_id,
          provider: event.provider,
          model: event.model,
          status: event.status,
          ...(event.observed_model_id !== undefined
            ? { observed_model_id: event.observed_model_id }
            : {}),
          ...(event.upstream_provider !== undefined
            ? { upstream_provider: event.upstream_provider }
            : {}),
          ...(event.output_digest !== undefined ? { output_digest: event.output_digest } : {}),
          ...(event.failure_receipt !== undefined
            ? { failure_receipt: event.failure_receipt }
            : {}),
          ...(event.failure_class !== undefined ? { failure_class: event.failure_class } : {}),
          ...(event.failure_stage !== undefined ? { failure_stage: event.failure_stage } : {}),
          ...(event.provider_request_id !== undefined
            ? { provider_request_id: event.provider_request_id }
            : {}),
          ...(event.api_error_code !== undefined
            ? { api_error_code: event.api_error_code }
            : {}),
          ...(event.http_status !== undefined ? { http_status: event.http_status } : {}),
          ...(event.actual_attempt !== undefined
            ? { actual_attempt: event.actual_attempt }
            : {}),
          ...(event.max_attempts !== undefined ? { max_attempts: event.max_attempts } : {}),
          ...(event.stream !== undefined ? { stream: event.stream } : {}),
          ...(event.inference_started !== undefined
            ? { inference_started: event.inference_started }
            : {}),
          ...(event.partial_model_output !== undefined
            ? { partial_model_output: event.partial_model_output }
            : {}),
          ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
          ...(event.tool_call_count !== undefined
            ? { tool_call_count: event.tool_call_count }
            : {}),
          ...(event.requested_output_budget !== undefined
            ? { requested_output_budget: event.requested_output_budget }
            : {}),
          ...(event.effective_output_budget !== undefined
            ? { effective_output_budget: event.effective_output_budget }
            : {}),
          ...(event.wire_policy_hash !== undefined
            ? { wire_policy_hash: event.wire_policy_hash }
            : {}),
          ...(event.execution_envelope_hash !== undefined
            ? { execution_envelope_hash: event.execution_envelope_hash }
            : {}),
          ...(observedRouteReceipt ? { route_receipt: observedRouteReceipt } : {}),
        });
        checkpointParityEventLog(host.parity, host.engineRunDir);
      },
      onInvocationPhase: (event) => {
        if (event.phase === 'request_dispatched' && context.usageScope?.taskOwnerId && startedInvocation) {
          const scope = context.usageScope;
          const ownerId = scope.taskOwnerId!;
          if (!globalCostTracker.getTaskChargeIds(ownerId).includes(event.inference_id)) {
            const attribution = captureUsageAttribution(
              scope, event.inference_id, scope.requestId, scope.attemptId,
            );
            const update = globalCostTracker.settleUsage(
              startedInvocation.sent_model_id, 0, 0, null, null, attribution, false,
            );
            if (update.kind !== 'inserted') {
              const appliesToCurrent = ownerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent();
              host.recordOwnerAccountingFault(
                scope, 'settlement-conflict', update.kind === 'conflict'
                  ? update.reason : 'Pending provider charge was not newly admitted', appliesToCurrent,
              );
              try {
                host.persistOwnerCharges(ownerId, ownerRunDir);
              } catch (error) {
                host.recordOwnerAccountingFault(
                  scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                  appliesToCurrent,
                );
              }
              throw new Error('Provider dispatch blocked by a pending charge conflict');
            }
            try {
              host.persistOwnerCharges(ownerId, ownerRunDir);
            } catch (error) {
              host.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                ownerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
              throw new Error('Provider dispatch blocked because its charge receipt could not be saved');
            }
          }
        }
        if (!isOwnerCurrent()) return;
        if (!host.parity.turnId) return;
        recordModelInvocationPhase(host.parity.sessionEvents, {
          turn_id: host.parity.turnId,
          inference_id: event.inference_id,
          provider: event.provider,
          model: event.model,
          phase: event.phase,
          ...(event.status_code !== undefined ? { status_code: event.status_code } : {}),
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        });
        checkpointParityEventLog(host.parity, host.engineRunDir);
      },
      onRetry: (event) => {
        // A retry schedules the next transport attempt only after the prior
        // attempt was dispatched. Preserve possible prior billing separately
        // from the final response's logical inference charge.
        const retryKey = event.attempt_id ?? `${event.request_id ?? startedInvocation?.inference_id}:${event.attempt}`;
        if (seenRetryAttemptIds.has(retryKey)) return;
        seenRetryAttemptIds.add(retryKey);
        const scope = context.usageScope;
        if (scope?.taskOwnerId && startedInvocation) {
          const priorAttemptId = scope.attemptId ?? `attempt-${event.attempt - 1}`;
          const priorAttemptScope = {
            ...scope,
            attemptId: priorAttemptId,
            chargeId: `${startedInvocation.inference_id}:${priorAttemptId}`,
          };
          const attribution = captureUsageAttribution(priorAttemptScope, priorAttemptScope.chargeId);
          const update = globalCostTracker.settleUsage(
            startedInvocation.sent_model_id, 0, 0, null, null,
            attribution,
            false,
          );
          if (update.kind === 'conflict') {
            const appliesToCurrent = scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent();
            host.recordOwnerAccountingFault(priorAttemptScope, 'settlement-conflict', update.reason, appliesToCurrent);
            try {
              host.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
            } catch (error) {
              host.recordOwnerAccountingFault(
                priorAttemptScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                appliesToCurrent,
              );
            }
          }
          if (update.kind === 'inserted' || update.kind === 'refined') {
            try {
              host.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
            } catch (error) {
              host.recordOwnerAccountingFault(
                priorAttemptScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
            if (isOwnerCurrent()) host.persistTaskCostBaseline();
          }
          const pendingExists = globalCostTracker.getTaskChargeIds(scope.taskOwnerId)
            .includes(startedInvocation.inference_id);
          const currentAttemptAttribution = captureUsageAttribution(
            scope, startedInvocation.inference_id, scope.requestId, scope.attemptId,
          );
          if (pendingExists && (!currentAttemptAttribution ||
              !globalCostTracker.clearUnstartedCharge(currentAttemptAttribution))) {
            host.recordOwnerAccountingFault(
              scope, 'settlement-conflict', 'Unstarted retry charge could not be cleared safely',
              scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
            );
          } else if (pendingExists) {
            try {
              host.persistOwnerCharges(scope.taskOwnerId, ownerRunDir);
            } catch (error) {
              host.recordOwnerAccountingFault(
                scope, 'persistence-failure', error instanceof Error ? error.message : String(error),
                scope.taskOwnerId === host.taskAllowance?.taskOwnerId && isOwnerCurrent(),
              );
            }
          }
        }
        if (!isOwnerCurrent()) throw new Error('Provider retry blocked by retired task owner');
        retryCount += 1;
        const retryRequestId = event.request_id ?? startedInvocation?.inference_id;
        const retryBodyDigest = event.body_digest ?? startedInvocation?.input_digest;
        parityRecordProviderRetry(
          host.parity,
          {
            provider: event.provider,
            model: event.model,
            ...(retryRequestId ? { requestId: retryRequestId } : {}),
            ...(event.attempt_id !== undefined ? { attemptId: event.attempt_id } : {}),
            ...(retryBodyDigest ? { bodyDigest: retryBodyDigest } : {}),
            attempt: event.attempt,
            reason: event.reason,
            backoffMs: event.backoff_ms,
          },
          host.engineRunDir,
        );
        if (scope?.taskOwnerId) {
          const budget = host.checkBudgets(true);
          if (!budget.ok) {
            throw new Error(`Provider retry blocked by task allowance: ${budget.reason ?? 'unavailable'}`);
          }
          scope.attemptId = event.attempt_id ?? `attempt-${event.attempt}`;
        }
      },
      onRetrySettled: (event) => {
        if (!isOwnerCurrent()) return;
        const retryRequestId = event.request_id ?? startedInvocation?.inference_id;
        const retryBodyDigest = event.body_digest ?? startedInvocation?.input_digest;
        paritySettleProviderRetry(
          host.parity,
          {
            provider: event.provider,
            model: event.model,
            ...(retryRequestId ? { requestId: retryRequestId } : {}),
            ...(event.attempt_id !== undefined ? { attemptId: event.attempt_id } : {}),
            ...(retryBodyDigest ? { bodyDigest: retryBodyDigest } : {}),
            attempt: event.attempt,
            outcome: event.outcome,
          },
          host.engineRunDir,
        );
      },
    };
}

export function trackRunnerUsage(
  host: ChatProviderRetryHost,
  runner: DeepInfraApiRunner | DeepSeekApiRunner | OllamaApiRunner | OpenRouterApiRunner,
  usageScope?: ChatUsageScope,
): void {
    // A task charge must be tied to an observed invocation start. Test/offline
    // runners can return placeholder metadata without starting a paid request.
    if (usageScope && usageScope.chargeId === null) return;
    const metadata = usageScope && 'usageMetadata' in usageScope
      ? usageScope.usageMetadata
      : runner.getLastInvocationMetadata?.();
    const appliesToCurrent = !usageScope ||
      (usageScope.taskOwnerId === host.taskAllowance?.taskOwnerId &&
        (usageScope.isOwnerCurrent?.() ?? true));
    if (
      metadata?.provider_model_id &&
      metadata.prompt_tokens !== null &&
      metadata.completion_tokens !== null
    ) {
      const chargeUpdate = globalCostTracker.settleUsage(
        metadata.provider_model_id,
        metadata.prompt_tokens,
        metadata.completion_tokens,
        metadata.prompt_cache_hit_tokens,
        metadata.prompt_cache_miss_tokens,
        usageScope
          ? captureUsageAttribution(usageScope)
          : host.taskAllowance
          ? {
              taskOwnerId: host.taskAllowance.taskOwnerId,
              projectRoot: realpathSync(host.options.projectRoot),
              projectRootVersion: 1,
              chargeId: host.pendingUsageChargeId ?? randomUUID(),
            }
          : undefined,
      );
      if (chargeUpdate.kind === 'duplicate') return;
      if (chargeUpdate.kind === 'conflict') {
        const faultScope: ChatUsageScope = usageScope ?? {
          taskOwnerId: host.taskAllowance?.taskOwnerId ?? null,
          accountingEpoch: globalCostTracker.getAccountingEpoch(),
          turnId: host.parity.turnId,
          chargeId: host.pendingUsageChargeId,
        };
        host.recordOwnerAccountingFault(
          faultScope, 'settlement-conflict', chargeUpdate.reason, appliesToCurrent,
        );
        if (faultScope.taskOwnerId) {
          try {
            host.persistOwnerCharges(faultScope.taskOwnerId, usageScope?.runDir);
          } catch (error) {
            host.recordOwnerAccountingFault(
              faultScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
              appliesToCurrent,
            );
          }
        }
        return;
      }
      if (usageScope?.taskOwnerId) {
        try {
          host.persistOwnerCharges(usageScope.taskOwnerId, usageScope.runDir);
        } catch (error) {
          host.recordOwnerAccountingFault(
            usageScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
            appliesToCurrent,
          );
          return;
        }
      }
      if (!usageScope || (appliesToCurrent && host.pendingUsageChargeId === usageScope.chargeId)) {
        host.pendingUsageChargeId = null;
      }
      // Checkpoint usage immediately after accounting so a crash before the
      // enclosing turn result is persisted cannot mint a fresh continuation
      // allowance on resume.
      if (appliesToCurrent) {
        host.persistTaskCostBaseline();
      }

      // Feed token history tracker
      const tokenTracker = getGlobalTokenTracker();
      if (metadata.estimated_cost_usd !== null) tokenTracker.record({
        inputTokens: metadata.prompt_tokens,
        outputTokens: metadata.completion_tokens,
        cost: metadata.estimated_cost_usd,
        modelId: metadata.provider_model_id,
      });

      if (!appliesToCurrent) return;
      host.lastRequestPromptTokens = metadata.prompt_tokens;
      host.lastRequestCompletionTokens = metadata.completion_tokens;
      host.lastRequestModelId = metadata.provider_model_id;

      // #12: Track cumulative API-reported tokens for accurate compaction estimates
      host.apiTokenCount += metadata.prompt_tokens + metadata.completion_tokens;

      // Tier A3: Push per-turn routing receipt
      pushRoutingReceiptFromMetadata(
        host.routingReceiptLog,
        host._turnIndex,
        host._lastPhase,
        metadata,
      );
    } else {
      const chargeId = usageScope?.chargeId ?? host.pendingUsageChargeId;
      const ownerId = usageScope ? usageScope.taskOwnerId : host.taskAllowance?.taskOwnerId;
      if (chargeId && ownerId) {
        const attribution = usageScope
          ? captureUsageAttribution(usageScope, chargeId)
          : {
              taskOwnerId: ownerId,
              chargeId,
              accountingEpoch: globalCostTracker.getAccountingEpoch(),
            };
        if (!attribution) throw new Error('Missing captured provider charge attribution');
        const update = globalCostTracker.settleUsage(
          usageScope?.modelId ?? metadata?.provider_model_id ?? 'unknown-provider-model',
          0, 0, null, null, attribution, false,
        );
        if (update.kind === 'conflict') {
          const faultScope: ChatUsageScope = usageScope ?? {
            taskOwnerId: ownerId,
            accountingEpoch: globalCostTracker.getAccountingEpoch(),
            turnId: null,
            chargeId,
          };
          host.recordOwnerAccountingFault(
            faultScope, 'settlement-conflict', update.reason, appliesToCurrent,
          );
          try {
            host.persistOwnerCharges(ownerId, usageScope?.runDir);
          } catch (error) {
            host.recordOwnerAccountingFault(
              faultScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
              appliesToCurrent,
            );
          }
        }
        if (usageScope && update.kind !== 'duplicate' && update.kind !== 'conflict') {
          try {
            host.persistOwnerCharges(ownerId, usageScope.runDir);
          } catch (error) {
            host.recordOwnerAccountingFault(
              usageScope, 'persistence-failure', error instanceof Error ? error.message : String(error),
              appliesToCurrent,
            );
          }
        }
        if (appliesToCurrent) host.persistTaskCostBaseline();
      }
    }
}
