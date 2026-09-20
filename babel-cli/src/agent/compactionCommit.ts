/**
 * compactionCommit.ts — H1 canonical compaction commit.
 *
 * One recoverable operation that updates:
 *   - in-memory conversation (separates LLM summary from operational capsule)
 *   - ThreadEventLog (compaction_capsule + advisory compaction_summary)
 *   - SessionEventLog (compaction_created)
 *
 * Persistence failure yields an explicit degraded/blocked status, never silent divergence.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage } from './chatCompaction.js';
import { estimateTokens } from './chatCompaction.js';
import type { ProviderToolCall, RunnerCallbacks } from '../runners/base.js';
import { LIVE_OPENROUTER_MODEL_ID } from '../modelPolicy.js';
import {
  appendThreadEvent,
  type ThreadEvent,
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
  /** Captured before compaction work begins; fences stale ownership on resume. */
  ownershipGeneration?: number;
  modelId: string;
  /**
   * Optional persistence hook. Called after in-memory + event append.
   * Throw or return false to signal persistence failure.
   */
  persist?: () => void | boolean | Promise<void | boolean>;
  /** When true, persistence failure is blocked (hard); default degraded. */
  blockOnPersistFailure?: boolean;
  /** Ownership fence checked before any live or durable mutation. */
  isOwnerCurrent?: () => boolean;
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
    .toLowerCase();
  return `obs:${h}`;
}

/**
 * Collect tool_call_id values still present after compaction (paired results).
 */
export function collectPreservedToolCallIds(messages: ChatMessage[]): string[] {
  const declared = new Set<string>();
  for (const message of messages) {
    const calls = (message as WorkingSetMessage).tool_calls;
    if (message.role === 'assistant' && Array.isArray(calls)) {
      for (const call of calls) if (call.id) declared.add(call.id);
    }
  }
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId && declared.has(m.toolCallId)) ids.push(m.toolCallId);
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
    const calls = (m as WorkingSetMessage).tool_calls;
    if (m.role === 'assistant' && Array.isArray(calls)) {
      for (const call of calls) if (call.id) assistantIds.add(call.id);
    }
    if (m.role === 'tool' && m.toolCallId) {
      resultIds.add(m.toolCallId);
    }
  }
  return [...new Set([
    ...[...assistantIds].filter((id) => !resultIds.has(id)),
    ...[...resultIds].filter((id) => !assistantIds.has(id)),
  ])].sort();
}

/**
 * Assemble conversation: controller-owned system + capsule, model summary as
 * assistant context, and the non-system working set. The summary is never a
 * system instruction and never part of the durable capsule.
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
  out.push({
    role: 'system',
    content: capsuleText,
    name: 'compaction_capsule',
    provenance: 'controller',
    authoritative: true,
  });
  if (summaryContent) {
    out.push({
      role: 'assistant',
      content: summaryContent,
      name: 'compaction_summary',
      provenance: 'model',
      authoritative: false,
    });
  }
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
  // Kept as a compatibility helper for callers/tests. Model text is no longer
  // allowed into the controller-owned durable capsule.
  void summaryContent;
  return capsuleText;
}

/**
 * Build raw observation refs for messages dropped between prior and strategy result.
 */
export function buildRawObservationRefs(
  prior: ChatMessage[],
  afterStrategy: ChatMessage[],
): string[] {
  const retainedCounts = new Map<string, number>();
  for (const message of afterStrategy) {
    const key = observationIdentity(message);
    retainedCounts.set(key, (retainedCounts.get(key) ?? 0) + 1);
  }
  const refs: string[] = [];
  for (let i = 0; i < prior.length; i++) {
    const m = prior[i]!;
    const key = observationIdentity(m);
    const retained = retainedCounts.get(key) ?? 0;
    if (retained > 0) {
      retainedCounts.set(key, retained - 1);
    } else if (m.role !== 'system') {
      refs.push(messageObservationRef(m, i));
    }
  }
  return refs;
}

function observationIdentity(message: ChatMessage): string {
  return `${message.role}|${message.name ?? ''}|${message.toolCallId ?? ''}|${message.content}`;
}

/** ChatMessage plus optional native tool_calls carried by the live working set. */
type WorkingSetMessage = ChatMessage & {
  tool_calls?: ProviderToolCall[];
};

type DurableToolCycle = {
  assistant: Extract<ThreadEvent, { kind: 'assistant_tool_calls' }>;
  results: Array<Extract<ThreadEvent, { kind: 'tool_result' }>>;
};

type RetainedAppend =
  | { kind: 'user_message'; content: string }
  | {
      kind: 'assistant_message';
      content: string;
      name?: string;
      provenance?: 'controller' | 'model' | 'mixed';
      authoritative?: boolean;
    }
  | {
      kind: 'assistant_tool_calls';
      content: string;
      tool_calls: ProviderToolCall[];
    }
  | {
      kind: 'tool_result';
      tool_call_id: string;
      tool_name: string;
      content: string;
      exit_code?: number;
    };

export interface RetainedWorkingSetPlan {
  appends: RetainedAppend[];
  preservedToolCallIds: string[];
}

function collectDurableToolCycles(events: readonly ThreadEvent[]): DurableToolCycle[] {
  const cycles: DurableToolCycle[] = [];
  let current: DurableToolCycle | null = null;
  for (const event of events) {
    if (event.kind === 'assistant_tool_calls') {
      current = { assistant: event, results: [] };
      cycles.push(current);
      continue;
    }
    if (event.kind === 'tool_result' && current) {
      const declared = new Set(current.assistant.tool_calls.map((call) => call.id));
      if (declared.has(event.tool_call_id)) current.results.push(event);
    }
  }
  return cycles;
}

function consecutiveToolMessages(
  messages: readonly WorkingSetMessage[],
  afterIndex: number,
): WorkingSetMessage[] {
  const batch: WorkingSetMessage[] = [];
  for (let index = afterIndex + 1; index < messages.length; index++) {
    const next = messages[index]!;
    if (next.role !== 'tool') break;
    batch.push(next);
  }
  return batch;
}

function messageToolCalls(message: WorkingSetMessage): ProviderToolCall[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

function findCycleForBatch(
  cycles: readonly DurableToolCycle[],
  batchIds: readonly string[],
  usedAssistantEventIds: ReadonlySet<string>,
): DurableToolCycle | null {
  if (batchIds.length === 0) return null;
  const batchSet = new Set(batchIds);
  for (const cycle of cycles) {
    if (usedAssistantEventIds.has(cycle.assistant.event_id)) continue;
    const declared = cycle.assistant.tool_calls.map((call) => call.id);
    if (declared.length === batchIds.length && declared.every((id) => batchSet.has(id))) {
      return cycle;
    }
  }
  for (const cycle of cycles) {
    if (usedAssistantEventIds.has(cycle.assistant.event_id)) continue;
    const declared = new Set(cycle.assistant.tool_calls.map((call) => call.id));
    if (batchIds.every((id) => declared.has(id))) return cycle;
  }
  // Never merge ids that belong to different assistant batches.
  const firstId = batchIds[0];
  if (!firstId) return null;
  for (const cycle of cycles) {
    if (usedAssistantEventIds.has(cycle.assistant.event_id)) continue;
    if (cycle.assistant.tool_calls.some((call) => call.id === firstId)) return cycle;
  }
  return null;
}

function lookupToolResult(
  events: readonly ThreadEvent[],
  toolCallId: string,
): Extract<ThreadEvent, { kind: 'tool_result' }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind === 'tool_result' && event.tool_call_id === toolCallId) return event;
  }
  return undefined;
}

/**
 * Plan the durable events that must follow a compaction capsule so native
 * reconstruction delivers the actual retained working set. Batch membership
 * is the assistant's own tool_calls or the immediately following consecutive
 * tool results — never the remainder of the conversation suffix.
 */
export function planRetainedWorkingSet(
  conversation: ChatMessage[],
  threadLog: ThreadEventLog,
): RetainedWorkingSetPlan {
  const nonSystem = conversation.filter((message) => message.role !== 'system') as WorkingSetMessage[];
  const cycles = collectDurableToolCycles(threadLog.events);
  const usedAssistantEventIds = new Set<string>();
  const usedCallIds = new Set<string>();
  const appends: RetainedAppend[] = [];
  const preservedToolCallIds: string[] = [];
  let skipFollowingTools = 0;
  let anonymousCount = 0;
  for (let index = 0; index < nonSystem.length; index++) {
    const message = nonSystem[index]!;
    if (message.role !== 'assistant') continue;
    const declared = messageToolCalls(message);
    const consecutive = consecutiveToolMessages(nonSystem, index);
    const batchIds = declared.length > 0
      ? declared.map((call) => call.id)
      : consecutive.map((tool) => tool.toolCallId).filter((id): id is string => Boolean(id));
    const isToolAssistant =
      declared.length > 0 || message.name === 'tool_calls' || consecutive.length > 0;
    if (isToolAssistant && batchIds.length === 0) anonymousCount++;
  }
  const anonymousQueue = cycles.slice(-anonymousCount);
  let anonymousAt = 0;

  for (let index = 0; index < nonSystem.length; index++) {
    if (skipFollowingTools > 0) {
      skipFollowingTools--;
      continue;
    }
    const message = nonSystem[index]!;
    if (message.role === 'user') {
      appends.push({ kind: 'user_message', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const declaredCalls = messageToolCalls(message);
      const consecutiveTools = consecutiveToolMessages(nonSystem, index);
      const batchIds = declaredCalls.length > 0
        ? declaredCalls.map((call) => call.id)
        : consecutiveTools
            .map((tool) => tool.toolCallId)
            .filter((id): id is string => Boolean(id));
      const isToolAssistant =
        declaredCalls.length > 0 ||
        message.name === 'tool_calls' ||
        consecutiveTools.length > 0;
      if (!isToolAssistant) {
        appends.push({
          kind: 'assistant_message',
          content: message.content,
          ...(message.name !== undefined ? { name: message.name } : {}),
          ...(message.provenance !== undefined ? { provenance: message.provenance } : {}),
          ...(message.authoritative !== undefined ? { authoritative: message.authoritative } : {}),
        });
        continue;
      }

      let cycle = findCycleForBatch(cycles, batchIds, usedAssistantEventIds);
      if (!cycle && batchIds.length === 0) {
        while (anonymousAt < anonymousQueue.length) {
          const candidate = anonymousQueue[anonymousAt++]!;
          if (!usedAssistantEventIds.has(candidate.assistant.event_id)) {
            cycle = candidate;
            break;
          }
        }
      }
      const toolCalls = cycle
        ? cycle.assistant.tool_calls.filter((call) => {
            if (batchIds.length === 0) return !usedCallIds.has(call.id);
            return batchIds.includes(call.id) && !usedCallIds.has(call.id);
        })
        : declaredCalls.filter((call) => !usedCallIds.has(call.id));
      const resultById = new Map<string, WorkingSetMessage>();
      for (const tool of consecutiveTools) {
        if (tool.toolCallId) resultById.set(tool.toolCallId, tool);
      }
      // A retained assistant tool call is valid only when its result is also
      // durable or still present in the working set. Never fabricate an empty
      // result: an orphan call would become executable protocol history.
      const completeToolCalls = toolCalls.filter((call) =>
        resultById.has(call.id) ||
        Boolean(lookupToolResult(threadLog.events, call.id)) ||
        Boolean(cycle?.results.some((result) => result.tool_call_id === call.id)),
      );
      if (completeToolCalls.length === 0) {
        appends.push({
          kind: 'assistant_message',
          content: message.content,
          ...(message.name !== undefined ? { name: message.name } : {}),
          ...(message.provenance !== undefined ? { provenance: message.provenance } : {}),
          ...(message.authoritative !== undefined ? { authoritative: message.authoritative } : {}),
        });
        // The assistant declaration is incomplete.  Drop its adjacent tool
        // results as well; retaining an orphan result would rebuild invalid
        // protocol history that the provider could treat as executable state.
        skipFollowingTools = consecutiveTools.length;
        continue;
      }
      if (toolCalls.length === 0) {
        appends.push({
          kind: 'assistant_message',
          content: message.content,
          ...(message.name !== undefined ? { name: message.name } : {}),
          ...(message.provenance !== undefined ? { provenance: message.provenance } : {}),
          ...(message.authoritative !== undefined ? { authoritative: message.authoritative } : {}),
        });
        continue;
      }
      if (cycle) usedAssistantEventIds.add(cycle.assistant.event_id);
      appends.push({
        kind: 'assistant_tool_calls',
        content: (cycle?.assistant.content || message.content || 'Using tools…'),
        tool_calls: completeToolCalls,
      });
      for (const call of completeToolCalls) {
        if (usedCallIds.has(call.id)) continue;
        usedCallIds.add(call.id);
        const kept = resultById.get(call.id);
        const durable = lookupToolResult(threadLog.events, call.id);
        const cycleResult = cycle?.results.find((result) => result.tool_call_id === call.id);
        appends.push({
          kind: 'tool_result',
          tool_call_id: call.id,
          tool_name: kept?.toolName ?? durable?.tool_name ?? cycleResult?.tool_name ?? call.function.name,
          content: kept?.content ?? durable?.content ?? cycleResult?.content ?? '',
          ...(cycleResult?.exit_code !== undefined
            ? { exit_code: cycleResult.exit_code }
            : durable?.exit_code !== undefined
              ? { exit_code: durable.exit_code }
              : {}),
        });
        preservedToolCallIds.push(call.id);
      }
      skipFollowingTools = consecutiveTools.length;
      continue;
    }
    if (message.role === 'tool') {
      // A standalone tool result has no retained assistant declaration in
      // this pass, so it cannot be restored without inventing a call cycle.
      continue;
    }
  }

  return { appends, preservedToolCallIds };
}

function appendRetainedWorkingSet(
  threadLog: ThreadEventLog,
  turnId: string,
  plan: RetainedWorkingSetPlan,
): string[] {
  const eventIds: string[] = [];
  for (const item of plan.appends) {
    if (item.kind === 'user_message') {
      eventIds.push(appendThreadEvent(threadLog, {
        kind: 'user_message',
        turn_id: turnId,
        content: item.content,
      }).event_id);
    } else if (item.kind === 'assistant_message') {
      eventIds.push(appendThreadEvent(threadLog, {
        kind: 'assistant_message',
        turn_id: turnId,
        content: item.content,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.provenance !== undefined ? { provenance: item.provenance } : {}),
        ...(item.authoritative !== undefined ? { authoritative: item.authoritative } : {}),
      }).event_id);
    } else if (item.kind === 'assistant_tool_calls') {
      eventIds.push(appendThreadEvent(threadLog, {
        kind: 'assistant_tool_calls',
        turn_id: turnId,
        content: item.content,
        tool_calls: item.tool_calls,
      }).event_id);
    } else {
      eventIds.push(appendThreadEvent(threadLog, {
        kind: 'tool_result',
        turn_id: turnId,
        tool_call_id: item.tool_call_id,
        tool_name: item.tool_name,
        content: item.content,
        ...(item.exit_code !== undefined ? { exit_code: item.exit_code } : {}),
      }).event_id);
    }
  }
  return eventIds;
}

function ownershipGenerationForTurn(threadLog: ThreadEventLog, turnId: string): number | undefined {
  const event = threadLog.events.find(
    (candidate): candidate is Extract<ThreadEvent, { kind: 'turn_started' }> =>
      candidate.kind === 'turn_started' && candidate.turn_id === turnId,
  );
  return event?.ownership_generation;
}

/**
 * Canonical H1 compaction commit: memory + thread + session, recoverable.
 */
export async function commitCompaction(
  input: CompactionCommitInput,
): Promise<CompactionCommitResult> {
  if (input.isOwnerCurrent && !input.isOwnerCurrent()) {
    return {
      status: 'noop',
      conversation: input.priorConversation.map((message) => ({ ...message })),
      strategy: input.strategy,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      budget: buildContextBudgetSnapshot({
        nextRequestTokens: estimateTokens(input.priorConversation),
        activeWindowTokens: estimateTokens(input.priorConversation),
        canonicalStateTokens: 0,
        contextWindow: resolveProviderCapabilities(input.modelId).contextWindow,
        maxOutputTokens: resolveProviderCapabilities(input.modelId).maxOutputTokens,
      }),
      capsule: buildCompactionCapsule({ task: input.operational.task, rawObservationRefs: [] }),
      capsuleText: '',
      preservedToolCallIds: collectPreservedToolCallIds(input.priorConversation),
      evidenceRefs: [],
    };
  }
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
  const retained = planRetainedWorkingSet(conversation, input.threadLog);
  const preservedToolCallIds =
    retained.preservedToolCallIds.length > 0
      ? retained.preservedToolCallIds
      : collectPreservedToolCallIds(conversation);
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
  const ownedThreadEventIds: string[] = [];
  const ownedSessionEventIds: string[] = [];
  const rollbackLocalEvents = (): void => {
    const ownedThreadIds = new Set(ownedThreadEventIds);
    const ownedSessionIds = new Set(ownedSessionEventIds);
    input.threadLog.events.splice(
      0,
      input.threadLog.events.length,
      ...input.threadLog.events.filter((event) => !ownedThreadIds.has(event.event_id)),
    );
    input.sessionLog.events.splice(
      0,
      input.sessionLog.events.length,
      ...input.sessionLog.events.filter((event) => !ownedSessionIds.has(event.event_id)),
    );
  };
  const rollbackAndPersist = async (): Promise<boolean> => {
    rollbackLocalEvents();
    if (!input.persist) return true;
    try {
      return (await input.persist()) !== false;
    } catch {
      return false;
    }
  };

  try {
    if (input.isOwnerCurrent && !input.isOwnerCurrent()) {
      return {
        status: 'noop',
        conversation: input.priorConversation.map((message) => ({ ...message })),
        strategy: input.strategy,
        tokensBefore: input.tokensBefore,
        tokensAfter,
        budget,
        capsule,
        capsuleText: durableContent,
        preservedToolCallIds,
        evidenceRefs: rawRefs,
      };
    }
    ownedSessionEventIds.push(recordCompactionStarted(input.sessionLog, input.turnId, {
      operation_id: operationId,
      strategy: input.strategy,
      ...replacementBoundary,
    }).event_id);
    ownedSessionEventIds.push(recordCompactionSummary(input.sessionLog, input.turnId, {
      operation_id: operationId,
      capsule_digest: capsuleDigest,
      raw_observation_refs: rawRefs,
      preserved_tool_call_ids: preservedToolCallIds,
    }).event_id);
    const threadEv = appendThreadEvent(input.threadLog, {
      kind: 'compaction_capsule',
      turn_id: turnId,
      content: durableContent,
      preserved_tool_call_ids: preservedToolCallIds,
      raw_observation_refs: rawRefs,
      ...(input.ownershipGeneration !== undefined
        ? { ownership_generation: input.ownershipGeneration }
        : ownershipGenerationForTurn(input.threadLog, turnId) !== undefined
          ? { ownership_generation: ownershipGenerationForTurn(input.threadLog, turnId) }
          : {}),
    });
    threadEventId = threadEv.event_id;
    ownedThreadEventIds.push(threadEv.event_id);
    if (summaryContent) {
      ownedThreadEventIds.push(appendThreadEvent(input.threadLog, {
        kind: 'compaction_summary',
        turn_id: turnId,
        content: summaryContent,
        provenance: 'model',
        authoritative: false,
      }).event_id);
    }
    ownedThreadEventIds.push(...appendRetainedWorkingSet(input.threadLog, turnId, retained));

    const sessionEv = recordCompactionCommitted(input.sessionLog, input.turnId, {
      operation_id: operationId,
      thread_event_id: threadEv.event_id,
      capsule_digest: capsuleDigest,
      ...replacementBoundary,
      preserved_tool_call_ids: preservedToolCallIds,
    });
    sessionEventId = sessionEv.event_id;
    ownedSessionEventIds.push(sessionEv.event_id);
    // Retain the legacy boundary for current replay/live-session consumers.
    ownedSessionEventIds.push(recordCompactionCreated(input.sessionLog, input.turnId, {
      preserved_tool_call_ids: preservedToolCallIds,
      content_preview: durableContent.slice(0, 240),
      strategy: input.strategy,
      tokens_before: input.tokensBefore,
      tokens_after: tokensAfter,
      status: 'committed',
    }).event_id);
  } catch (err) {
    rollbackLocalEvents();
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
      if (input.isOwnerCurrent && !input.isOwnerCurrent()) {
        rollbackLocalEvents();
        return {
          status: 'noop',
          conversation: input.priorConversation.map((message) => ({ ...message })),
          strategy: input.strategy,
          tokensBefore: input.tokensBefore,
          tokensAfter,
          budget,
          capsule,
          capsuleText: durableContent,
          preservedToolCallIds,
          evidenceRefs: rawRefs,
        };
      }
      const ok = await input.persist();
      if (ok === false) {
        const rollbackPersisted = await rollbackAndPersist();
        return {
          status: !rollbackPersisted || input.blockOnPersistFailure
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
          error: rollbackPersisted
            ? 'persist_returned_false'
            : 'persist_returned_false_and_rollback_failed',
        };
      }
      if (input.isOwnerCurrent && !input.isOwnerCurrent()) {
        const rollbackPersisted = await rollbackAndPersist();
        if (!rollbackPersisted) {
          return {
            status: 'blocked_persistence',
            conversation,
            strategy: input.strategy,
            tokensBefore: input.tokensBefore,
            tokensAfter,
            budget,
            capsule,
            capsuleText: durableContent,
            preservedToolCallIds,
            evidenceRefs: rawRefs,
            error: 'stale_compaction_rollback_persist_failed',
          };
        }
        return {
          status: 'noop',
          conversation: input.priorConversation.map((message) => ({ ...message })),
          strategy: input.strategy,
          tokensBefore: input.tokensBefore,
          tokensAfter,
          budget,
          capsule,
          capsuleText: durableContent,
          preservedToolCallIds,
          evidenceRefs: rawRefs,
        };
      }
    } catch (err) {
      const rollbackPersisted = await rollbackAndPersist();
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: !rollbackPersisted || input.blockOnPersistFailure
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
          error: rollbackPersisted
            ? `persist_failed: ${msg}`
            : `persist_failed_and_rollback_failed: ${msg}`,
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
  /** Admission recovery may request one bounded compaction even before the normal token trigger. */
  forceCompaction?: boolean;
  isOwnerCurrent?: () => boolean;
}

export interface ChatEngineCompactInfo {
  mode: 'llm' | 'heuristic';
  beforeMessages: number;
  afterMessages: number;
  /** True when retained conversation content was replaced, even at equal count. */
  changed: boolean;
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
  let changed = false;
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
    host.forceCompaction === true ||
    tokenTriggered ||
    tokenEstimate > host.limits.maxEstimatedTokens - reserve;
  const ownerIsCurrent = (): boolean => !host.isOwnerCurrent || host.isOwnerCurrent();
  const applyHeuristic = async (): Promise<void> => {
    if (!ownerIsCurrent()) return;
    const prior = [...host.conversation]
    const priorFingerprint = JSON.stringify(host.conversation);
    host.compactHeuristic();
    try {
      await host.checkpoint()
      if (!ownerIsCurrent()) {
        host.conversation = prior;
        return;
      }
      changed = JSON.stringify(host.conversation) !== priorFingerprint;
      if (changed) mode = 'heuristic';
    } catch (error) {
      host.conversation = prior
      throw new CompactionPersistenceError(
        `Heuristic compaction checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  };

  if (host.compactionManager) {
    if (compactionNeeded) {
      if (!ownerIsCurrent()) return null;
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
        if (!ownerIsCurrent()) return null;
        if (mgr.changed) {
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
            isOwnerCurrent: ownerIsCurrent,
          });
          if (commit.status !== 'committed') {
            if (commit.status === 'noop') return null;
            throw new CompactionPersistenceError(
              commit.error ?? 'Compaction persistence failed',
            )
          }
          if (!ownerIsCurrent()) return null;
          host.conversation = commit.conversation;
          mode = strategyToCompactMode(commit.strategy);
          changed = true;
        }
      } catch (error) {
        if (error instanceof CompactionPersistenceError) throw error
        await applyHeuristic();
      }
    }
  } else if (compactionNeeded) {
    if (!ownerIsCurrent()) return null;
    await applyHeuristic();
  }

  const after = host.conversation.length;
  if (mode == null || !changed) return null;
  return {
    mode,
    beforeMessages: before,
    afterMessages: after,
    changed,
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
