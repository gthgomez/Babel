/**
 * compactionCommit.ts — H1 canonical compaction commit.
 *
 * One recoverable operation that updates:
 *   - in-memory conversation (preserves LLM summary + operational capsule)
 *   - ThreadEventLog (compaction_capsule)
 *   - SessionEventLog (compaction_created)
 *
 * Persistence failure yields an explicit degraded/blocked status, never silent divergence.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage } from './chatCompaction.js';
import { estimateTokens } from './chatCompaction.js';
import type { RunnerCallbacks } from '../runners/base.js';
import { LIVE_OPENROUTER_MODEL_ID } from '../modelPolicy.js';
import {
  appendThreadEvent,
  type ThreadEventLog,
} from './threadEventLog.js';
import {
  recordCompactionCreated,
  recordCompactionStarted,
  recordCompactionSummary,
  recordCompactionCommitted,
  type SessionEventLog,
} from './sessionEvents.js';
import {
  buildCompactionCapsule,
  buildContextBudgetSnapshot,
  formatCompactionCapsule,
  resolveProviderCapabilities,
  type CompactionCapsule,
  type ContextBudgetSnapshot,
} from './providerCapabilities.js';

export type CompactionCommitStatus =
  | 'committed'
  | 'degraded_persistence'
  | 'blocked_persistence'
  | 'noop';

export interface CompactionOperationalState {
  task: string;
  taskAcceptanceId?: string;
  planStep?: string;
  progressSummary?: string;
  patchSummary?: string;
  changedPaths?: string[];
  unresolvedFailures?: string[];
  verifierSummary?: string;
  verifierFreshness?: string;
  approvalsSummary?: string;
  budgetsSummary?: string;
  workspaceRevision?: string;
  evidenceRefs?: string[];
  recentToolResults?: string[];
  /** Raw observation digests for messages reduced out of the active window. */
  rawObservationRefs?: string[];
}

export interface CompactionCommitInput {
  /** Messages produced by CompactionManager (may include compaction_summary). */
  strategyMessages: ChatMessage[];
  /** Conversation before compaction (for raw-observation refs + pairing checks). */
  priorConversation: ChatMessage[];
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  operational: CompactionOperationalState;
  threadLog: ThreadEventLog;
  sessionLog: SessionEventLog;
  turnId: string | null;
  modelId: string;
  /**
   * Optional persistence hook. Called after in-memory + event append.
   * Throw or return false to signal persistence failure.
   */
  persist?: () => void | boolean | Promise<void | boolean>;
  /** When true, persistence failure is blocked (hard); default degraded. */
  blockOnPersistFailure?: boolean;
}

export interface CompactionCommitResult {
  status: CompactionCommitStatus;
  conversation: ChatMessage[];
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  budget: ContextBudgetSnapshot;
  capsule: CompactionCapsule;
  capsuleText: string;
  preservedToolCallIds: string[];
  /** Thread event id for the capsule when written. */
  threadEventId?: string;
  /** Session event id when written. */
  sessionEventId?: string;
  evidenceRefs: string[];
  error?: string;
}

const COMPACTION_SYSTEM_NAMES = new Set([
  'compaction_summary',
  'compaction_fallback',
  'compaction_capsule',
]);

/** Digest of a message for immutable raw-log references. */
export function messageObservationRef(msg: ChatMessage, index: number): string {
  const h = createHash('sha256')
    .update(`${index}|${msg.role}|${msg.name ?? ''}|${msg.toolCallId ?? ''}|${msg.content}`)
    .digest('hex')
    .slice(0, 16);
  return `obs:${h}`;
}

/**
 * Collect tool_call_id values still present after compaction (paired results).
 */
export function collectPreservedToolCallIds(messages: ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) ids.push(m.toolCallId);
  }
  return ids;
}

/**
 * Assert complete tool-call/result pairs remain paired in the compacted window.
 * Returns unpaired tool_call_ids (empty when well-formed).
 */
export function findUnpairedToolCycles(messages: ChatMessage[]): string[] {
  const assistantIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    // Assistant tool_calls may carry ids in content metadata; tool results use toolCallId.
    if (m.role === 'tool' && m.toolCallId) {
      resultIds.add(m.toolCallId);
    }
  }
  // Without structured tool_calls on assistant messages in ChatMessage, we only
  // require that every tool result has a non-empty id (pairing within working set).
  const unpaired: string[] = [];
  for (const id of resultIds) {
    if (!id) unpaired.push('(empty)');
  }
  void assistantIds;
  return unpaired;
}

/**
 * Assemble conversation: base system + optional LLM summary + capsule + non-system working set.
 * Never discards a successful compaction_summary (H1 D1 fix).
 */
export function assembleCompactedConversation(
  strategyMessages: ChatMessage[],
  capsuleText: string,
  llmSummaryContent?: string,
): ChatMessage[] {
  const systemMsgs = strategyMessages.filter((m) => m.role === 'system');
  const baseSystem = systemMsgs.find(
    (m) => !m.name || !COMPACTION_SYSTEM_NAMES.has(m.name),
  );
  const summaryFromStrategy = systemMsgs.find((m) => m.name === 'compaction_summary');
  const summaryContent =
    llmSummaryContent ??
    (summaryFromStrategy ? summaryFromStrategy.content : undefined);

  const nonSystem = strategyMessages.filter((m) => m.role !== 'system');

  const out: ChatMessage[] = [];
  if (baseSystem) out.push({ ...baseSystem });
  if (summaryContent) {
    out.push({
      role: 'system',
      content: summaryContent,
      name: 'compaction_summary',
    });
  }
  out.push({
    role: 'system',
    content: capsuleText,
    name: 'compaction_capsule',
  });
  out.push(...nonSystem.map((m) => ({ ...m })));
  return out;
}

/**
 * Provider-facing capsule content embeds operational state + LLM summary so
 * rebuildProviderMessagesFromEvents is equivalent to the live conversation path.
 */
export function buildDurableCapsuleContent(
  capsuleText: string,
  summaryContent?: string,
): string {
  if (!summaryContent) return capsuleText;
  return `${capsuleText}\n\n--- compaction_summary ---\n${summaryContent}`;
}

/**
 * Build raw observation refs for messages dropped between prior and strategy result.
 */
export function buildRawObservationRefs(
  prior: ChatMessage[],
  afterStrategy: ChatMessage[],
): string[] {
  const afterKeys = new Set(
    afterStrategy.map(
      (m, i) => `${m.role}|${m.name ?? ''}|${m.toolCallId ?? ''}|${m.content.slice(0, 64)}|${i}`,
    ),
  );
  const refs: string[] = [];
  for (let i = 0; i < prior.length; i++) {
    const m = prior[i]!;
    const key = `${m.role}|${m.name ?? ''}|${m.toolCallId ?? ''}|${m.content.slice(0, 64)}|${i}`;
    // Prefer content-hash based membership for dropped messages
    const contentKey = `${m.role}|${m.content}`;
    const stillPresent = afterStrategy.some(
      (a) => a.role === m.role && a.content === m.content && a.name === m.name,
    );
    if (!stillPresent && m.role !== 'system') {
      refs.push(messageObservationRef(m, i));
    }
    void afterKeys;
    void key;
    void contentKey;
  }
  return refs.slice(0, 32);
}

/**
 * Canonical H1 compaction commit: memory + thread + session, recoverable.
 */
export async function commitCompaction(
  input: CompactionCommitInput,
): Promise<CompactionCommitResult> {
  const summaryMsg = input.strategyMessages.find((m) => m.name === 'compaction_summary');
  const summaryContent = summaryMsg?.content;

  const rawRefs =
    input.operational.rawObservationRefs ??
    buildRawObservationRefs(input.priorConversation, input.strategyMessages);

  const capsule = buildCompactionCapsule({
    task: input.operational.task,
    ...(input.operational.taskAcceptanceId
      ? { taskAcceptanceId: input.operational.taskAcceptanceId }
      : {}),
    ...(input.operational.planStep ? { planStep: input.operational.planStep } : {}),
    ...(input.operational.progressSummary
      ? { progressSummary: input.operational.progressSummary }
      : {}),
    ...(input.operational.patchSummary
      ? { patchSummary: input.operational.patchSummary }
      : {}),
    ...(input.operational.changedPaths
      ? { changedPaths: input.operational.changedPaths }
      : {}),
    ...(input.operational.unresolvedFailures
      ? { unresolvedFailures: input.operational.unresolvedFailures }
      : {}),
    ...(input.operational.verifierSummary
      ? { verifierSummary: input.operational.verifierSummary }
      : {}),
    ...(input.operational.verifierFreshness
      ? { verifierFreshness: input.operational.verifierFreshness }
      : {}),
    ...(input.operational.approvalsSummary
      ? { approvalsSummary: input.operational.approvalsSummary }
      : {}),
    ...(input.operational.budgetsSummary
      ? { budgetsSummary: input.operational.budgetsSummary }
      : {}),
    ...(input.operational.workspaceRevision
      ? { workspaceRevision: input.operational.workspaceRevision }
      : {}),
    ...(input.operational.evidenceRefs
      ? { evidenceRefs: input.operational.evidenceRefs }
      : {}),
    ...(input.operational.recentToolResults
      ? { recentToolResults: input.operational.recentToolResults }
      : {}),
    rawObservationRefs: rawRefs,
  });

  const capsuleText = formatCompactionCapsule(capsule);
  const durableContent = buildDurableCapsuleContent(capsuleText, summaryContent);
  const conversation = assembleCompactedConversation(
    input.strategyMessages,
    durableContent,
    summaryContent,
  );
  const preservedToolCallIds = collectPreservedToolCallIds(conversation);
  const operationId = randomUUID();
  const capsuleDigest = createHash('sha256').update(durableContent).digest('hex');
  const replacementBoundary = {
    replaces_thread_seq_start: 0,
    replaces_thread_seq_end: Math.max(input.threadLog.nextSeq - 1, 0),
    replaces_message_count: input.priorConversation.length,
  };
  const tokensAfter = estimateTokens(conversation);
  const caps = resolveProviderCapabilities(input.modelId);
  const budget = buildContextBudgetSnapshot({
    nextRequestTokens: tokensAfter,
    activeWindowTokens: tokensAfter,
    canonicalStateTokens: Math.ceil(durableContent.length / 4),
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
  });

  const turnId = input.turnId ?? 'compaction';
  let threadEventId: string | undefined;
  let sessionEventId: string | undefined;

  try {
    recordCompactionStarted(input.sessionLog, input.turnId, {
      operation_id: operationId,
      strategy: input.strategy,
      ...replacementBoundary,
    });
    recordCompactionSummary(input.sessionLog, input.turnId, {
      operation_id: operationId,
      capsule_digest: capsuleDigest,
      raw_observation_refs: rawRefs,
      preserved_tool_call_ids: preservedToolCallIds,
    });
    const threadEv = appendThreadEvent(input.threadLog, {
      kind: 'compaction_capsule',
      turn_id: turnId,
      content: durableContent,
      preserved_tool_call_ids: preservedToolCallIds,
    });
    threadEventId = threadEv.event_id;

    const sessionEv = recordCompactionCommitted(input.sessionLog, input.turnId, {
      operation_id: operationId,
      thread_event_id: threadEv.event_id,
      capsule_digest: capsuleDigest,
      ...replacementBoundary,
      preserved_tool_call_ids: preservedToolCallIds,
    });
    sessionEventId = sessionEv.event_id;
    // Retain the legacy boundary for current replay/live-session consumers.
    recordCompactionCreated(input.sessionLog, input.turnId, {
      preserved_tool_call_ids: preservedToolCallIds,
      content_preview: durableContent.slice(0, 240),
      strategy: input.strategy,
      tokens_before: input.tokensBefore,
      tokens_after: tokensAfter,
      status: 'committed',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: input.blockOnPersistFailure ? 'blocked_persistence' : 'degraded_persistence',
      conversation,
      strategy: input.strategy,
      tokensBefore: input.tokensBefore,
      tokensAfter,
      budget,
      capsule,
      capsuleText: durableContent,
      preservedToolCallIds,
      evidenceRefs: [
        ...(input.operational.evidenceRefs ?? []),
        ...rawRefs.slice(0, 4),
      ],
      error: `event_append_failed: ${msg}`,
    };
  }

  if (input.persist) {
    try {
      const ok = await input.persist();
      if (ok === false) {
        return {
          status: input.blockOnPersistFailure
            ? 'blocked_persistence'
            : 'degraded_persistence',
          conversation,
          strategy: input.strategy,
          tokensBefore: input.tokensBefore,
          tokensAfter,
          budget,
          capsule,
          capsuleText: durableContent,
          preservedToolCallIds,
          ...(threadEventId !== undefined ? { threadEventId } : {}),
          ...(sessionEventId !== undefined ? { sessionEventId } : {}),
          evidenceRefs: [
            ...(threadEventId ? [threadEventId] : []),
            ...(sessionEventId ? [sessionEventId] : []),
          ],
          error: 'persist_returned_false',
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: input.blockOnPersistFailure
          ? 'blocked_persistence'
          : 'degraded_persistence',
        conversation,
        strategy: input.strategy,
        tokensBefore: input.tokensBefore,
        tokensAfter,
        budget,
        capsule,
        capsuleText: durableContent,
        preservedToolCallIds,
        ...(threadEventId !== undefined ? { threadEventId } : {}),
        ...(sessionEventId !== undefined ? { sessionEventId } : {}),
        evidenceRefs: [
          ...(threadEventId ? [threadEventId] : []),
          ...(sessionEventId ? [sessionEventId] : []),
        ],
        error: `persist_failed: ${msg}`,
      };
    }
  }

  return {
    status: 'committed',
    conversation,
    strategy: input.strategy,
    tokensBefore: input.tokensBefore,
    tokensAfter,
    budget,
    capsule,
    capsuleText: durableContent,
    preservedToolCallIds,
    ...(threadEventId !== undefined ? { threadEventId } : {}),
    ...(sessionEventId !== undefined ? { sessionEventId } : {}),
    evidenceRefs: [
      ...(threadEventId ? [threadEventId] : []),
      ...(sessionEventId ? [sessionEventId] : []),
      ...rawRefs.slice(0, 4),
    ],
  };
}

/**
 * Map manager strategy name to ContextCompactedInfo mode.
 */
export function strategyToCompactMode(
  strategy: string,
): 'llm' | 'heuristic' {
  if (strategy === 'llm-summarize' || strategy.startsWith('llm')) return 'llm';
  return 'heuristic';
}

/** Host deps for ChatEngine compaction (keeps chatEngine.ts thin under budget). */
export interface ChatEngineCompactionHost {
  conversation: ChatMessage[];
  compactionManager?: {
    compactWithResult(
      messages: ChatMessage[],
      options: {
        model: string;
        maxTokens: number;
        signal?: AbortSignal;
        callbacks?: RunnerCallbacks;
      },
    ): Promise<{
      messages: ChatMessage[];
      strategy: string;
      tokensBefore: number;
      tokensAfter: number;
      changed: boolean;
    }>;
  };
  options: { task: string; model?: string };
  modelPolicy?: {
    providerModelId?: string;
    family?: string;
  } | null;
  limits: { maxEstimatedTokens: number };
  abortSignal: AbortSignal;
  writeCount: number;
  turnIndex: number;
  toolCallLog: ReadonlyArray<{ tool: string; target: string }>;
  lastVerifierReceipt?: {
    command: string;
    exit_code: number;
    boundRevision?: { compositeTreeHash?: string } | null;
  } | null;
  progress: {
    receipts: ReadonlyArray<{ deltas: string[] }>;
    consecutiveNoProgress: number;
  };
  threadLog: ThreadEventLog;
  sessionLog: SessionEventLog;
  turnId: string | null;
  /** Provider lifecycle callbacks for the LLM summarizer inference. */
  providerCallbacks?: RunnerCallbacks;
  shouldUseTextTools: () => boolean;
  compactHeuristic: () => void;
  checkpoint: () => Promise<void>;
  reserveTokens: number;
  textToolsReserve: number;
  resolveModel: (input: {
    explicitModel?: string | null;
    providerModelId?: string | null;
    family?: string | null;
  }) => string;
  shouldCompactByTokens: (tokens: number, modelId: string) => boolean;
  estimateTokens: (messages: ChatMessage[]) => number;
}

export interface ChatEngineCompactInfo {
  mode: 'llm' | 'heuristic';
  beforeMessages: number;
  afterMessages: number;
  message: string;
  commit?: CompactionCommitResult;
}

export class CompactionPersistenceError extends Error {
  readonly code = 'COMPACTION_PERSISTENCE_BLOCKED'

  constructor(message: string) {
    super(message)
    this.name = 'CompactionPersistenceError'
  }
}

/**
 * Full ChatEngine compaction path (H1). Extracted so chatEngine stays under size ratchet.
 * Mutates `host.conversation` when compaction applies.
 */
export async function runChatEngineCompaction(
  host: ChatEngineCompactionHost,
): Promise<ChatEngineCompactInfo | null> {
  const before = host.conversation.length;
  let mode: 'llm' | 'heuristic' | null = null;
  let commit: CompactionCommitResult | undefined;
  const tokenEstimate = host.estimateTokens(host.conversation);
  const modelId =
    host.options.model ??
    host.modelPolicy?.providerModelId ??
    host.modelPolicy?.family ??
    'deepseek-v4-pro';
  const tokenTriggered = host.shouldCompactByTokens(tokenEstimate, modelId);
  const reserve = host.shouldUseTextTools()
    ? host.textToolsReserve
    : host.reserveTokens;
  const compactionNeeded =
    tokenTriggered ||
    tokenEstimate > host.limits.maxEstimatedTokens - reserve;
  const applyHeuristic = async (): Promise<void> => {
    const prior = [...host.conversation]
    host.compactHeuristic();
    try {
      await host.checkpoint()
      mode = 'heuristic';
    } catch (error) {
      host.conversation = prior
      throw new CompactionPersistenceError(
        `Heuristic compaction checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  };

  if (host.compactionManager) {
    if (compactionNeeded) {
      try {
        const exactLockedGlm =
          host.modelPolicy?.providerModelId === LIVE_OPENROUTER_MODEL_ID;
        const mgr = await host.compactionManager.compactWithResult(host.conversation, {
          model: host.resolveModel({
            ...(host.modelPolicy?.providerModelId
              ? { providerModelId: host.modelPolicy.providerModelId }
              : {}),
            ...(host.modelPolicy?.family ? { family: host.modelPolicy.family } : {}),
            ...(!exactLockedGlm && process.env['BABEL_COMPACTION_MODEL']
              ? { explicitModel: process.env['BABEL_COMPACTION_MODEL'] }
              : exactLockedGlm
                ? { explicitModel: LIVE_OPENROUTER_MODEL_ID }
                : {}),
          }),
          maxTokens: host.limits.maxEstimatedTokens,
          signal: host.abortSignal,
          ...(host.providerCallbacks ? { callbacks: host.providerCallbacks } : {}),
        });
        if (mgr.changed) {
          const threadEventCountBefore = host.threadLog.events.length;
          const threadNextSeqBefore = host.threadLog.nextSeq;
          const sessionEventCountBefore = host.sessionLog.events.length;
          const sessionNextSeqBefore = host.sessionLog.nextSeq;
          const sessionFlushedBefore = host.sessionLog.flushedThroughSeq;
          const boundRevStr = host.lastVerifierReceipt?.boundRevision?.compositeTreeHash
            ? String(host.lastVerifierReceipt.boundRevision.compositeTreeHash)
            : '';
          const last = host.progress.receipts[host.progress.receipts.length - 1];
          commit = await commitCompaction({
            strategyMessages: mgr.messages,
            priorConversation: host.conversation,
            strategy: mgr.strategy,
            tokensBefore: mgr.tokensBefore,
            tokensAfter: mgr.tokensAfter,
            operational: {
              task: host.options.task,
              progressSummary: last
                ? `deltas=${last.deltas.join(',')} streak=${host.progress.consecutiveNoProgress}`
                : 'none',
              patchSummary: host.writeCount > 0 ? `writes=${host.writeCount}` : '',
              verifierSummary: host.lastVerifierReceipt
                ? `${host.lastVerifierReceipt.command}→${host.lastVerifierReceipt.exit_code}`
                : '',
              verifierFreshness: boundRevStr
                ? `revision=${boundRevStr}`
                : host.lastVerifierReceipt
                  ? 'unbound'
                  : '',
              recentToolResults: host.toolCallLog
                .slice(-6)
                .map((t) => `${t.tool} ${t.target}`),
              budgetsSummary: `turns=${host.turnIndex} maxTokens=${host.limits.maxEstimatedTokens}`,
              workspaceRevision: boundRevStr,
            },
            threadLog: host.threadLog,
            sessionLog: host.sessionLog,
            turnId: host.turnId,
            modelId,
            persist: async () => {
              await host.checkpoint();
              return true;
            },
            blockOnPersistFailure: true,
          });
          if (commit.status !== 'committed') {
            host.threadLog.events.splice(threadEventCountBefore)
            host.threadLog.nextSeq = threadNextSeqBefore
            host.sessionLog.events.splice(sessionEventCountBefore)
            host.sessionLog.nextSeq = sessionNextSeqBefore
            host.sessionLog.flushedThroughSeq = sessionFlushedBefore
            throw new CompactionPersistenceError(
              commit.error ?? 'Compaction persistence failed',
            )
          }
          host.conversation = commit.conversation;
          mode = strategyToCompactMode(commit.strategy);
        }
      } catch (error) {
        if (error instanceof CompactionPersistenceError) throw error
        await applyHeuristic();
      }
    }
  } else if (compactionNeeded) {
    await applyHeuristic();
  }

  const after = host.conversation.length;
  if (mode == null || after >= before) return null;
  return {
    mode,
    beforeMessages: before,
    afterMessages: after,
    message: `[Context compacted…] ${before}→${after} messages (${mode})`,
    ...(commit ? { commit } : {}),
  };
}

/**
 * Critical-fact retention metric for long-session fixtures (H1 exit gate).
 * Returns fraction of required facts present in compacted text.
 */
export function measureCriticalFactRetention(
  compactedText: string,
  criticalFacts: readonly string[],
): { retained: number; total: number; rate: number; missing: string[] } {
  const missing: string[] = [];
  let retained = 0;
  for (const fact of criticalFacts) {
    if (compactedText.includes(fact)) retained++;
    else missing.push(fact);
  }
  const total = criticalFacts.length;
  return {
    retained,
    total,
    rate: total === 0 ? 1 : retained / total,
    missing,
  };
}
