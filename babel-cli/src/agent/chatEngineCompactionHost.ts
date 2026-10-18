/**
 * ChatEngine compaction host wiring (H1). Extracted to keep chatEngine.ts
 * under the architectural size ratchet.
 */

import { realpathSync } from 'node:fs';

import {
  DEFAULT_COMPACTION_CONFIG,
  estimateTokens,
  resolveCompactionModelId,
  resolveCompactionSummarizationProvider,
} from './chatCompaction.js';
import type {
  ChatCallbacks,
  ChatEngineOptions,
  ContextCompactedInfo,
} from './chatEngineContracts.js';
import { checkpointParityEventLogStrict } from './chatEngineParityBridge.js';
import { parityShouldCompact } from './chatEngineParityBridge.js';
import {
  runChatEngineCompaction,
  type ChatEngineCompactionHost,
} from './compactionCommit.js';
import { captureUsageAttribution } from './chatEngineProviderAccounting.js';
import { globalCostTracker } from '../services/costTracker.js';

/** Minimal ChatEngine surface required to run H1 compaction. */
export interface ChatEngineCompactionBinding {
  conversation: import('./chatCompaction.js').ChatMessage[];
  options: ChatEngineOptions;
  modelPolicy?: import('../modelPolicy.js').ResolvedModelPolicy;
  limits: import('../config/chatEngineLimits.js').ChatEngineLimits;
  abortController: AbortController;
  writeCount: number;
  readonly _turnIndex: number;
  toolCallLog: Array<{ tool: string; target: string }>;
  lastVerifierReceipt?: { command: string; exit_code: number } | null;
  parity: import('./chatEngineParityBridge.js').ParityRuntime;
  engineRunDir: string;
  taskAllowance?: { taskOwnerId: string | null };
  activeSubmissionGeneration: number;
  compactionManager?: import('./chatCompaction.js').CompactionManager;
  condensationFacts?: import('../services/condensationFacts.js').CondensationFactChannel;
  lastLogicalRequestId: string | null;
  pendingParentRequestId: string | null;
  apiTokenCount: number;
  isSubmissionCurrent(generation: number): boolean;
  shouldUseTextTools(): boolean;
  compactConversation(): void;
  getOrBuildSystemPrompt(mode: 'native' | 'legacy' | 'text'): string;
  services: {
    tools: {
      buildDefinitions(): import('../runners/base.js').ToolDefinition[];
      buildRestrictedDefinitions(
        mode: 'act_or_verify' | 'inspect' | 'full',
      ): import('../runners/base.js').ToolDefinition[];
    };
  };
  providerRetryCallbacks(input: {
    deliveryMode: 'text' | 'native';
    executionStage: string;
    usageScope: Record<string, unknown>;
    isOwnerCurrent: () => boolean;
  }): import('../runners/base.js').RunnerCallbacks;
  recordOwnerAccountingFault(
    scope: Record<string, unknown>,
    kind: string,
    reason: string,
    ownerCurrent: boolean,
  ): void;
  persistOwnerCharges(ownerId: string, runDir: string): void;
  persistTaskCostBaseline(): void;
  resetReadInjectionContext(): void;
  isolationBrokerFlags(): { hostFallbackAllowed: boolean };
  getResolvedRequiredVerifiers(): readonly string[];
  /** Exact native POST JSON for compaction admission (live deliberation runner). */
  buildNativeCompactionAdmissionWireBody(): string;
  resolveDeliberationRunnerForCompaction(): unknown;
}

export async function runChatEngineCompactionFor(
  engine: ChatEngineCompactionBinding,
  input: {
    callbacks?: ChatCallbacks;
    forceCompaction?: boolean;
    ownerGeneration?: number;
  },
): Promise<ContextCompactedInfo | null> {
  const callbacks = input.callbacks;
  const forceCompaction = input.forceCompaction === true;
  const ownerGeneration = input.ownerGeneration ?? engine.activeSubmissionGeneration;
  const compactionParity = engine.parity;
  const compactionRunDir = engine.engineRunDir;
  const compactionOwnerId = engine.taskAllowance?.taskOwnerId ?? null;
  const compactionEpoch = globalCostTracker.getAccountingEpoch();
  const compactionTurnId = engine.parity.turnId;
  const usageScope: {
    taskOwnerId: string | null;
    projectRoot: string;
    accountingEpoch: string;
    turnId: string | null;
    chargeId: string | null;
    provider?: string | null;
    requestId?: string;
    attemptId?: string;
    runDir?: string;
    ownerGeneration: number;
  } = {
    taskOwnerId: compactionOwnerId,
    projectRoot: realpathSync(engine.options.projectRoot),
    accountingEpoch: compactionEpoch,
    turnId: compactionTurnId,
    chargeId: null as string | null,
    ownerGeneration,
  };
  const compactionModelId = resolveCompactionModelId({
    pinSelection: engine.options.model !== undefined || engine.options.providerPolicy !== undefined,
    ...(engine.modelPolicy?.providerModelId
      ? { providerModelId: engine.modelPolicy.providerModelId }
      : {}),
    ...(engine.modelPolicy?.family ? { family: engine.modelPolicy.family } : {}),
  });
  const summarizationProvider = resolveCompactionSummarizationProvider({
    pinSelection: engine.options.model !== undefined || engine.options.providerPolicy !== undefined,
    chatProvider: engine.modelPolicy?.provider ?? null,
    compactionModel: compactionModelId,
  });
  const deliberationRunner = engine.resolveDeliberationRunnerForCompaction();
  const runnerReserved = (
    deliberationRunner as { getNativeRequestReservedCompletionTokens?: () => number | null }
  ).getNativeRequestReservedCompletionTokens?.() ?? null;
  const host: ChatEngineCompactionHost = {
    conversation: engine.conversation,
    options: engine.options,
    ...(engine.modelPolicy ? { modelPolicy: engine.modelPolicy } : {}),
    compactionProviderId: engine.modelPolicy?.provider ?? 'deepinfra',
    ...(runnerReserved !== null ? { providerReservedCompletionTokens: runnerReserved } : {}),
    ...(summarizationProvider ? { summarizationProvider } : {}),
    limits: engine.limits,
    abortSignal: engine.abortController.signal,
    writeCount: engine.writeCount,
    turnIndex: engine._turnIndex,
    toolCallLog: engine.toolCallLog,
    ...(engine.lastVerifierReceipt
      ? { lastVerifierReceipt: engine.lastVerifierReceipt }
      : {}),
    progress: engine.parity.progress,
    threadLog: engine.parity.eventLog,
    sessionLog: engine.parity.sessionEvents,
    turnId: engine.parity.turnId,
    providerCallbacks: engine.providerRetryCallbacks({
      deliveryMode: engine.shouldUseTextTools() ? 'text' : 'native',
      executionStage: 'compaction',
      usageScope,
      isOwnerCurrent: () => engine.isSubmissionCurrent(ownerGeneration),
    }),
    onCompactionUsage: (usage) => {
      const attribution = compactionOwnerId
        ? captureUsageAttribution(
            usageScope,
            usage.inferenceId,
            usageScope.chargeId === usage.inferenceId
              ? usageScope.requestId
              : undefined,
            usageScope.chargeId === usage.inferenceId
              ? usageScope.attemptId
              : undefined,
          )
        : undefined;
      const update = globalCostTracker.settleUsage(
        usage.modelId,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        null,
        null,
        attribution,
        usage.inputTokens !== null && usage.outputTokens !== null,
        usageScope.provider ?? null,
      );
      if (update.kind === 'conflict') {
        engine.recordOwnerAccountingFault(
          { ...usageScope, chargeId: usage.inferenceId },
          'settlement-conflict',
          update.reason,
          compactionOwnerId === engine.taskAllowance?.taskOwnerId &&
            engine.isSubmissionCurrent(ownerGeneration),
        );
        try {
          if (compactionOwnerId) engine.persistOwnerCharges(compactionOwnerId, compactionRunDir);
        } catch (error) {
          engine.recordOwnerAccountingFault(
            { ...usageScope, chargeId: usage.inferenceId },
            'persistence-failure',
            error instanceof Error ? error.message : String(error),
            compactionOwnerId === engine.taskAllowance?.taskOwnerId &&
              engine.isSubmissionCurrent(ownerGeneration),
          );
        }
        return;
      }
      if (compactionOwnerId && update.kind !== 'duplicate') {
        try {
          engine.persistOwnerCharges(compactionOwnerId, compactionRunDir);
        } catch (error) {
          engine.recordOwnerAccountingFault(
            { ...usageScope, chargeId: usage.inferenceId },
            'persistence-failure',
            error instanceof Error ? error.message : String(error),
            compactionOwnerId === engine.taskAllowance?.taskOwnerId &&
              engine.isSubmissionCurrent(ownerGeneration),
          );
        }
      }
      if (engine.isSubmissionCurrent(ownerGeneration)) engine.persistTaskCostBaseline();
    },
    shouldUseTextTools: () => engine.shouldUseTextTools(),
    compactHeuristic: () => {
      if (!engine.isSubmissionCurrent(ownerGeneration)) return;
      engine.compactConversation();
      host.conversation = engine.conversation;
    },
    checkpoint: async () => {
      if (!engine.isSubmissionCurrent(ownerGeneration)) return;
      const receipt = await checkpointParityEventLogStrict(
        compactionParity,
        compactionRunDir,
      );
      if (receipt.status !== 'committed') {
        throw new Error(receipt.error ?? 'checkpoint persistence blocked');
      }
    },
    reserveTokens: DEFAULT_COMPACTION_CONFIG.reserveTokens,
    textToolsReserve: 1024,
    forceCompaction,
    isOwnerCurrent: () => engine.isSubmissionCurrent(ownerGeneration),
    resolveModel: input => resolveCompactionModelId({ ...input,
      pinSelection: engine.options.model !== undefined || engine.options.providerPolicy !== undefined }),
    shouldCompactByTokens: parityShouldCompact,
    estimateTokens,
    serializeNativeProviderRequestBody: () =>
      engine.buildNativeCompactionAdmissionWireBody(),
  };
  if (engine.compactionManager) host.compactionManager = engine.compactionManager;
  if (engine.condensationFacts) host.condensationFacts = engine.condensationFacts;
  const result = await runChatEngineCompaction(host);
  if (!engine.isSubmissionCurrent(ownerGeneration)) return null;
  engine.conversation = host.conversation;
  if (!result) return null;
  if (engine.lastLogicalRequestId !== null) {
    engine.pendingParentRequestId = engine.lastLogicalRequestId;
  }
  engine.resetReadInjectionContext();
  const info: ContextCompactedInfo = {
    mode: result.mode,
    beforeMessages: result.beforeMessages,
    afterMessages: result.afterMessages,
    message: result.message,
  };
  if (engine.shouldUseTextTools()) {
    console.error(
      `[compaction] text-tools: ${info.beforeMessages}→${info.afterMessages} msgs (${info.mode}), token estimate was ~${engine.apiTokenCount}`,
    );
  }
  callbacks?.onContextCompacted?.(info);
  return info;
}
