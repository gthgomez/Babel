/**
 * Live-path bridge for P1–P3 harness parity contracts.
 * Used by ChatEngine (not tests-only): loop reduce, progress, policy arbitration,
 * thread event log, approvals, provider budget/failover.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';
import { classifyToolEffect } from '../executor/contracts.js';
import type { ProviderMessage, ProviderToolCall } from '../runners/base.js';
import type { ProviderId } from '../runners/providerRegistry.js';
import {
  initialAgentLoopState,
  reduceAgentLoop,
  type AgentLoopEvent,
  type AgentLoopState,
} from './agentLoopReducer.js';
import {
  createProgressLedger,
  recordProgressCycle,
  scoreProgressIntervention,
  type ProgressLedger,
  type ProgressIntervention,
  type ProgressReceipt,
} from './progressReceipt.js';
import {
  arbitratePolicy,
  type PolicyCandidate,
} from './policyPrecedence.js';
import {
  createThreadEventLog,
  startTurn,
  endTurn,
  recordAssistantToolCalls,
  recordToolResult,
  rebuildProviderMessagesFromEvents,
  THREAD_EVENT_LOG_FILENAME,
  serializeThreadEventLog,
  persistThreadEventLog,
  type ThreadEventLog,
} from './threadEventLog.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordModelStarted,
  recordProviderRetryScheduled,
  recordProviderRetrySettled,
  recordToolProposed,
  recordToolStarted,
  assertRecoveredOutcomeReconciliationAuthorization,
  recordRecoveredOutcomeReconciled,
  recordToolTerminal,
  recordTurnEnded,
  flushSessionEventLogStrict,
  SESSION_EVENTS_FILENAME,
  serializeSessionEventLog,
  completedToolIdempotencyKeys,
  markInterruptedToolsOnResume,
  type SessionEventLog,
} from './sessionEvents.js';
import {
  createEpisodeEventLog,
  syncAndFlushEpisodeFromSession,
  type EpisodeEventLog,
} from '../evidence/episodeStream.js';
import { bindBdnsAfterCanonicalFlush } from '../diagnostics/bdns/sessionAttach.js';
import {
  createApprovalSession,
  type ApprovalSessionState,
} from './approvalRequests.js';
import {
  shouldCompactByTokens,
  decideProToFlashFailover,
  buildCompactionCapsule,
  formatCompactionCapsule,
  contextBudgetForModel,
  type FailoverDecision,
} from './providerCapabilities.js';
import type { PolicyEvent } from './policyEventLog.js';
import {
  dualWriteBudgetSnapshot,
  persistLiveSessionAuthority,
  persistLiveSessionSnapshot,
  projectFromDurableSession,
  loadLiveSessionAuthority,
  CHECKPOINT_JOURNAL_FILENAME,
  recoverCheckpointArtifacts,
  writeCheckpointJournal,
  INSTRUCTION_MANIFEST_FILENAME,
  TASK_CONTRACT_FILENAME,
  LIVE_SESSION_SNAPSHOT_FILENAME,
} from './liveSessionBridge.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';


export interface ParityRuntime {
  loop: AgentLoopState;
  progress: ProgressLedger;
  eventLog: ThreadEventLog;
  /** W2 PR-E: SessionEventV1 dual-write log (JSONL next to thread_events). */
  sessionEvents: SessionEventLog;
  /**
   * Slice A: canonical episode stream dual-write (episode-events.jsonl).
   * Projected from session events at flush choke points — not a separate
   * instrumentation surface for tools yet.
   */
  episodeStream: EpisodeEventLog;
  approvalSession: ApprovalSessionState;
  turnId: string | null;
  recoveryTried: boolean;
  lastFailover: FailoverDecision | null;
  /** H2: policy-bound instruction + frozen task authority (in-memory + disk). */
  liveAuthority?: import('./liveSessionBridge.js').LiveSessionAuthority;
  /** Immutable session-start lease + governance baseline. */
  authoritySession?: import('../authority/sessionContext.js').AuthoritySessionContext;
  /** Task-intent gate; cannot mint or widen lease authority. */
  taskAuthorityGate?: import('../authority/taskClarity.js').HumanEscalationResult;
  pendingTaskClarification?: { capability: import('../authority/capabilities.js').CapabilityId; options?: string[] };
  /** H2: last projected LiveSession (rebuilt on resume). */
  liveSession?: import('./liveSession.js').LiveSessionV1;
}

export interface PersistenceReceipt {
  status: 'committed' | 'blocked'
  operation: 'checkpoint' | 'finalize'
  runDir: string
  artifacts: Array<{ kind: string; path?: string; status: 'committed' | 'blocked'; error?: string }>
  error?: string
}

export function createParityRuntime(threadId: string): ParityRuntime {
  return {
    loop: initialAgentLoopState(),
    progress: createProgressLedger(),
    eventLog: createThreadEventLog(threadId),
    sessionEvents: createSessionEventLog(threadId),
    episodeStream: createEpisodeEventLog(threadId),
    approvalSession: createApprovalSession(threadId),
    turnId: null,
    recoveryTried: false,
    lastFailover: null,
  };
}

export function parityOnUserTurn(
  rt: ParityRuntime,
  input: {
    task: string;
    model: string;
    provider: string;
    projectRoot: string;
    policyPreset?: string;
    verifier?: string;
    taskClass?: string;
    gatePolicy?: string;
    submissionIndex?: number;
    continuedTask?: boolean;
  },
): void {
  rt.loop = reduceAgentLoop(rt.loop, { type: 'user_turn', task: input.task }).state;
  rt.progress = createProgressLedger();
  rt.recoveryTried = false;
  rt.turnId = startTurn(rt.eventLog, {
    task: input.task,
    model: input.model,
    provider: input.provider,
    projectRoot: input.projectRoot,
    policyPreset: input.policyPreset ?? 'workspace_write',
    ...(input.verifier !== undefined ? { verifier: input.verifier } : {}),
    ...(input.taskClass !== undefined ? { taskClass: input.taskClass } : {}),
    ...(input.gatePolicy !== undefined ? { gatePolicy: input.gatePolicy } : {}),
    ...(input.submissionIndex !== undefined ? { submissionIndex: input.submissionIndex } : {}),
    ...(input.continuedTask !== undefined ? { continuedTask: input.continuedTask } : {}),
  });
  // W2 PR-E dual-write: session event mirrors user submission.
  recordUserSubmitted(rt.sessionEvents, {
    turn_id: rt.turnId,
    task: input.task,
    model: input.model,
    provider: input.provider,
    projectRoot: input.projectRoot,
    ...(input.taskClass !== undefined ? { taskClass: input.taskClass } : {}),
  });
  recordModelStarted(rt.sessionEvents, {
    turn_id: rt.turnId,
    model: input.model,
    provider: input.provider,
  });
}

/** Dual-write provider retry lifecycle facts at the ChatEngine persistence boundary. */
export function parityRecordProviderRetry(
  rt: ParityRuntime,
  input: {
    provider: ProviderId;
    model: string;
    inferenceId?: string;
    attempt: number;
    reason: 'transport' | 'timeout' | 'rate_limit' | 'server_error' | 'stream_idle';
    backoffMs: number;
  },
  runDir?: string,
): void {
  if (!rt.turnId) return;
  recordProviderRetryScheduled(rt.sessionEvents, {
    turn_id: rt.turnId,
    ...(input.inferenceId !== undefined ? { inference_id: input.inferenceId } : {}),
    provider: input.provider,
    model: input.model,
    attempt: input.attempt,
    reason: input.reason,
    backoff_ms: input.backoffMs,
  });
  if (runDir) flushSessionEventsRequired(rt, runDir, 'provider-retry-scheduled');
}

/** Record a retry sequence settlement; historical events never trigger another call on resume. */
export function paritySettleProviderRetry(
  rt: ParityRuntime,
  input: {
    provider: ProviderId;
    model: string;
    inferenceId?: string;
    attempt: number;
    outcome: 'succeeded' | 'failed' | 'cancelled';
  },
  runDir?: string,
): void {
  if (!rt.turnId) return;
  recordProviderRetrySettled(rt.sessionEvents, {
    turn_id: rt.turnId,
    ...(input.inferenceId !== undefined ? { inference_id: input.inferenceId } : {}),
    provider: input.provider,
    model: input.model,
    attempt: input.attempt,
    outcome: input.outcome,
  });
  if (runDir) flushSessionEventsRequired(rt, runDir, 'provider-retry-settled');
}
export function parityReduce(rt: ParityRuntime, event: AgentLoopEvent): AgentLoopState {
  const result = reduceAgentLoop(rt.loop, event);
  rt.loop = result.state;
  return rt.loop;
}

export function parityOnCancel(rt: ParityRuntime): void {
  parityReduce(rt, { type: 'cancel' });
  if (rt.turnId) {
    endTurn(rt.eventLog, rt.turnId, 'CANCELLED', 'cancelled');
  }
}

export function parityOnBudgetExhausted(rt: ParityRuntime, reason: string): void {
  parityReduce(rt, { type: 'budget', exhausted: true, reason });
  if (rt.turnId) {
    endTurn(rt.eventLog, rt.turnId, 'BUDGET_EXHAUSTED', 'failed');
  }
}

/**
 * W2.2 settle step 1: persist tool_proposed before scheduling work. The
 * separate tool_started record is persisted at the concrete dispatch boundary.
 * Skips keys already terminal (resume no double-mutate).
 */
export function paritySettleProposeTools(
  rt: ParityRuntime,
  tools: Array<{
    id: string;
    name: string;
    argsDigest?: string;
    action_index?: number;
    batch_id?: string;
    target_summary?: string;
  }>,
  runDir?: string,
): { proposed: number; skipped: number } {
  if (!rt.turnId || tools.length === 0) return { proposed: 0, skipped: 0 };
  const done = completedToolIdempotencyKeys(rt.sessionEvents);
  let proposed = 0;
  let skipped = 0;
  for (const t of tools) {
    if (done.has(t.id)) {
      skipped += 1;
      continue;
    }
    // Avoid double-propose if propose already ran this turn.
    const alreadyProposed = rt.sessionEvents.events.some(
      (e) =>
        (e.kind === 'tool_proposed' || e.kind === 'tool_started') &&
        e.idempotency_key === t.id,
    );
    if (!alreadyProposed) {
      recordToolProposed(rt.sessionEvents, {
        turn_id: rt.turnId,
        tool_call_id: t.id,
        tool_name: t.name,
        idempotency_key: t.id,
        effect_class: classifyToolEffect(t.name),
        ...(t.argsDigest !== undefined ? { args_digest: t.argsDigest } : {}),
        ...(t.action_index !== undefined ? { action_index: t.action_index } : {}),
        ...(t.batch_id !== undefined ? { batch_id: t.batch_id } : {}),
        ...(t.target_summary !== undefined ? { target_summary: t.target_summary } : {}),
      });
    }
    proposed += 1;
  }
  if (runDir) {
    flushSessionEventsRequired(rt, runDir, 'settle-propose');
  }
  return { proposed, skipped };
}

/** Persist the irreversible dispatch boundary immediately before tool execution. */
export function paritySettleToolStarted(
  rt: ParityRuntime,
  tool: { id: string; name: string; action_index?: number; batch_id?: string; target_summary?: string },
  runDir?: string,
): boolean {
  if (!rt.turnId || completedToolIdempotencyKeys(rt.sessionEvents).has(tool.id)) return false;
  const alreadyStarted = rt.sessionEvents.events.some(
    (event) => event.kind === 'tool_started' && event.idempotency_key === tool.id,
  );
  if (alreadyStarted) return false;
  recordToolStarted(rt.sessionEvents, {
    turn_id: rt.turnId,
    tool_call_id: tool.id,
    tool_name: tool.name,
    idempotency_key: tool.id,
    effect_class: classifyToolEffect(tool.name),
    ...(tool.action_index !== undefined ? { action_index: tool.action_index } : {}),
    ...(tool.batch_id !== undefined ? { batch_id: tool.batch_id } : {}),
    ...(tool.target_summary !== undefined ? { target_summary: tool.target_summary } : {}),
  });
  if (runDir) flushSessionEventsRequired(rt, runDir, 'settle-start');
  return true;
}

/** Persist an explicit, operator-auditable authorization for one recovered unknown effect. */
export function parityAuthorizeRecoveredOutcomeRetry(
  rt: ParityRuntime,
  input: {
    recoveredIdempotencyKey: string;
    operationFingerprint: string;
    reconciliationRef: string;
  },
  runDir?: string,
): void {
  const authorization = {
    recovered_idempotency_key: input.recoveredIdempotencyKey,
    operation_fingerprint: input.operationFingerprint,
    reconciliation_ref: input.reconciliationRef,
  };
  assertRecoveredOutcomeReconciliationAuthorization(rt.sessionEvents, authorization);
  recordRecoveredOutcomeReconciled(rt.sessionEvents, {
    turn_id: rt.turnId,
    ...authorization,
  });
  if (runDir) flushSessionEventsRequired(rt, runDir, 'recovery-reconciled');
}
/**
 * W2.2 resume: mark in-flight tools cancelled and flush (no silent success).
 */
export function paritySettleInterruptedOnResume(
  rt: ParityRuntime,
  runDir?: string,
  reason = 'interrupted_mid_tool',
): number {
  const marked = markInterruptedToolsOnResume(rt.sessionEvents, reason);
  if (runDir && marked.length > 0) {
    flushSessionEventsRequired(rt, runDir, 'settle-resume-interrupted');
  }
  return marked.length;
}

export function parityRecordToolBatch(
  rt: ParityRuntime,
  input: {
    at_turn: number;
    thinking?: string;
    toolCalls: ProviderToolCall[];
    results: Array<{
      tool_call_id: string;
      tool_name: string;
      content: string;
      exit_code?: number;
      target?: string;
      contentHash?: string;
      action_index?: number;
      batch_id?: string;
    }>;
    patchAttempted?: boolean;
    patchFailed?: boolean;
    verifierChanged?: boolean;
    localizedPaths?: string[];
    /** When true, skip propose (already done via paritySettleProposeTools). */
    settleAlreadyProposed?: boolean;
  },
): ProgressReceipt {
  if (rt.turnId && input.toolCalls.length > 0) {
    recordAssistantToolCalls(
      rt.eventLog,
      rt.turnId,
      input.thinking ?? 'Using tools…',
      input.toolCalls,
    );
    // W2.2: if settle propose did not run, still propose+start here (compat).
    if (!input.settleAlreadyProposed) {
      for (const tc of input.toolCalls) {
        const already = rt.sessionEvents.events.some(
          (e) =>
            (e.kind === 'tool_proposed' || e.kind === 'tool_started') &&
            e.idempotency_key === tc.id,
        );
        if (!already) {
          recordToolProposed(rt.sessionEvents, {
            turn_id: rt.turnId,
            tool_call_id: tc.id,
            tool_name: tc.function.name,
            idempotency_key: tc.id,
            effect_class: classifyToolEffect(tc.function.name),
          });
        }
      }
    }
    for (const r of input.results) {
      recordToolResult(rt.eventLog, rt.turnId, {
        tool_call_id: r.tool_call_id,
        tool_name: r.tool_name,
        content: r.content,
        ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
      });
      // Compatibility callers may supply a completed result without using the
      // live dispatch hook. Materialize the same proposal → start evidence before
      // terminal settlement so resume never consumes a malformed lifecycle.
      const hasProposal = rt.sessionEvents.events.some(
        (event) => event.kind === 'tool_proposed' && event.idempotency_key === r.tool_call_id,
      );
      if (!hasProposal) {
        recordToolProposed(rt.sessionEvents, {
          turn_id: rt.turnId,
          tool_call_id: r.tool_call_id,
          tool_name: r.tool_name,
          idempotency_key: r.tool_call_id,
          effect_class: classifyToolEffect(r.tool_name),
          ...(r.action_index !== undefined ? { action_index: r.action_index } : {}),
          ...(r.batch_id !== undefined ? { batch_id: r.batch_id } : {}),
          ...(r.target !== undefined ? { target_summary: r.target } : {}),
        });
      }
      const hasStart = rt.sessionEvents.events.some(
        (event) => event.kind === 'tool_started' && event.idempotency_key === r.tool_call_id,
      );
      // Only the legacy compatibility lane may materialize a start after receiving
      // an already-executed result. The live lane has already proposed the action:
      // a missing marker is proof it never crossed the dispatch boundary.
      const materializeCompatibilityStart = !input.settleAlreadyProposed;
      if (!hasStart && materializeCompatibilityStart) {
        recordToolStarted(rt.sessionEvents, {
          turn_id: rt.turnId,
          tool_call_id: r.tool_call_id,
          tool_name: r.tool_name,
          idempotency_key: r.tool_call_id,
          effect_class: classifyToolEffect(r.tool_name),
          ...(r.action_index !== undefined ? { action_index: r.action_index } : {}),
          ...(r.batch_id !== undefined ? { batch_id: r.batch_id } : {}),
          ...(r.target !== undefined ? { target_summary: r.target } : {}),
        });
      }
      // Terminal settle — skip if already terminal (resume double-complete guard).
      if (!completedToolIdempotencyKeys(rt.sessionEvents).has(r.tool_call_id)) {
        const dispatched = hasStart || materializeCompatibilityStart;
        recordToolTerminal(rt.sessionEvents, {
          turn_id: rt.turnId,
          tool_call_id: r.tool_call_id,
          tool_name: r.tool_name,
          idempotency_key: r.tool_call_id,
          ...(r.action_index !== undefined ? { action_index: r.action_index } : {}),
          ...(r.batch_id !== undefined ? { batch_id: r.batch_id } : {}),
          ...(r.target !== undefined ? { target_summary: r.target } : {}),
          ...(dispatched
            ? {
                content: r.content,
                ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
              }
            : {
                cancelled: true,
                reason: 'pre_dispatch_denied_or_invalid',
                recovery_state: 'TOOL_NOT_STARTED' as const,
                effect_class: classifyToolEffect(r.tool_name),
              }),
        });
      }
    }
  }

  parityReduce(rt, {
    type: 'tool_calls',
    tools: input.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      mutating: isMutatingToolName(tc.function.name),
    })),
  });
  parityReduce(rt, {
    type: 'tool_results',
    results: input.results.map((r) => ({
      id: r.tool_call_id,
      name: r.tool_name,
      exitCode: r.exit_code ?? 0,
      terminal: /\bCIRCUIT_BREAKER\b/.test(r.content),
    })),
  });

  const receipt = recordProgressCycle(rt.progress, {
    at_turn: input.at_turn,
    ...(input.localizedPaths ? { localizedPaths: input.localizedPaths } : {}),
    ...(input.patchAttempted ? { patchAttempted: true } : {}),
    ...(input.patchFailed ? { patchFailed: true } : {}),
    ...(input.verifierChanged ? { verifierChanged: true } : {}),
    reads: input.results
      .filter(
        (r) =>
          r.tool_name === 'read_file' ||
          r.tool_name === 'file_read' ||
          r.tool_name === 'read_range' ||
          r.tool_name === 'grep',
      )
      .map((r) => ({
        path: r.target ?? r.tool_name,
        ...(r.contentHash !== undefined ? { contentHash: r.contentHash } : {}),
      })),
  });
  parityReduce(rt, { type: 'progress', hasDelta: receipt.hasDelta });
  return receipt;
}

function isMutatingToolName(name: string): boolean {
  return (
    name === 'write_file' ||
    name === 'file_write' ||
    name === 'str_replace' ||
    name === 'apply_patch' ||
    name === 'run_command' ||
    name === 'test_run'
  );
}

/**
 * Arbitrate fuse + progress candidates → at most one intervention message.
 *
 * Zero-write:
 * - default/shadow: nudge only (never sole terminal under soft coding path)
 * - enforce ablation: terminal when `zeroWriteTerminalMessage` is set
 */
export function parityArbitrateCycle(input: {
  rt: ParityRuntime;
  fuseLabels: string[];
  forceMutateMessage?: string | null;
  readThrashMessage?: string | null;
  /** Cumulative exploration fuse message (deferred from applyExploreFuses). */
  explorationFuseMessage?: string | null;
  /** Implementor: shell soft-budget nudge. */
  shellSoftMessage?: string | null;
  /** Implementor: investigate tool-budget nudge. */
  investigateBudgetMessage?: string | null;
  /**
   * Hard cap: too many tools without a mutation → terminal thrash stop.
   * Outranks soft investigate_budget / force_mutate nudges.
   */
  investigateHardCapTerminal?: string | null;
  /**
   * Hard cap for read-only inspection queries → terminal answer synthesis.
   * Concludes inspection and prompts model for best-supported informational answer.
   */
  readOnlyHardCapTerminal?: string | null;
  stallMessage?: string | null;
  /** Non-shadow stall kill — terminal via progress_terminal precedence. */
  stallKillMessage?: string | null;
  /** Soft zero-write nudge (shadow / legacy HS classes). */
  zeroWriteCandidate?: string | null;
  /**
   * P0-E enforce ablation: zero-write hard-stop as a real terminal.
   * When set, takes precedence over zeroWriteCandidate.
   */
  zeroWriteTerminalMessage?: string | null;
  hardCeiling?: boolean;
  hardCeilingReason?: string;
  /** Read-only inspection query (bypasses mutation-based progress thrash/stall policies). */
  isReadOnlyInspection?: boolean;
  /**
   * Host/toolchain env block (missing pytest, pre-write host ImportError, …).
   * Caller should suppress post-write import failures (patch-induced).
   * When set, terminals as **env_blocked** — do not burn progress_terminal cycles.
   */
  envBlockedSignal?: string | null;
}): {
  intervention: ProgressIntervention;
  policyMessage: string | null;
  policySource: string | null;
  terminalAnswer: string | null;
} {
  const candidates: PolicyCandidate[] = [];
  if (input.hardCeiling) {
    candidates.push({
      source: 'hard_ceiling',
      action: 'terminal',
      message: input.hardCeilingReason ?? 'Hard resource ceiling',
    });
  }
  // Env blocks outrank progress thrash: host cannot verify — stop the spiral.
  if (input.envBlockedSignal?.trim()) {
    candidates.push({
      source: 'env_blocked',
      action: 'terminal',
      message:
        `ENV_BLOCKED: verification cannot run in this environment. ` +
        `${input.envBlockedSignal.trim()} ` +
        `Fix the host toolchain/deps (or re-run where the project installs cleanly); ` +
        `do not treat this as policy thrash or missing semantic progress.`,
    });
  }
  if (input.readOnlyHardCapTerminal?.trim()) {
    candidates.push({
      source: 'read_only_hard_cap',
      action: 'terminal',
      message: input.readOnlyHardCapTerminal.trim(),
    });
  } else if (input.investigateHardCapTerminal?.trim()) {
    candidates.push({
      source: 'investigate_hard_cap',
      action: 'terminal',
      message: input.investigateHardCapTerminal.trim(),
    });
  }
  if (input.stallKillMessage && !input.isReadOnlyInspection) {
    candidates.push({
      source: 'progress_terminal',
      action: 'terminal',
      message: input.stallKillMessage,
    });
  }
  const progressIx = scoreProgressIntervention(input.rt.progress, {
    recoveryAlreadyTried: input.rt.recoveryTried,
    // Prefer env terminal over "repeated no-progress after recovery"
    ...(input.envBlockedSignal?.trim()
      ? { verifiedExternalBlocker: `ENV_BLOCKED: ${input.envBlockedSignal.trim()}` }
      : {}),
    ...(input.hardCeiling === true
      ? {
          hardCeiling: true as const,
          ...(input.hardCeilingReason
            ? { hardCeilingReason: input.hardCeilingReason }
            : {}),
        }
      : {}),
  });
  // Skip progress thrash interventions when env, read-only inspection, or read-only hard cap active.
  if (!input.envBlockedSignal?.trim() && !input.readOnlyHardCapTerminal?.trim() && !input.isReadOnlyInspection) {
    if (progressIx.action === 'terminal') {
      candidates.push({
        source: 'progress_terminal',
        action: 'terminal',
        message: progressIx.reason,
      });
    } else if (progressIx.action === 'recover') {
      candidates.push({
        source: 'progress_recover',
        action: 'nudge',
        message: `Recovery: ${progressIx.strategy}. Summarize evidence and change approach.`,
      });
    } else if (progressIx.action === 'nudge') {
      candidates.push({
        source: 'progress_nudge',
        action: 'nudge',
        message: progressIx.message,
      });
    }
  }
  if (input.forceMutateMessage) {
    candidates.push({
      source: 'force_mutate',
      action: 'nudge',
      message: input.forceMutateMessage,
    });
  }
  if (input.investigateBudgetMessage) {
    candidates.push({
      source: 'investigate_budget',
      action: 'nudge',
      message: input.investigateBudgetMessage,
    });
  }
  if (input.shellSoftMessage) {
    candidates.push({
      source: 'shell_soft_budget',
      action: 'nudge',
      message: input.shellSoftMessage,
    });
  }
  if (input.readThrashMessage) {
    candidates.push({
      source: 'read_thrash',
      action: 'nudge',
      message: input.readThrashMessage,
    });
  }
  if (input.explorationFuseMessage) {
    candidates.push({
      source: 'exploration_fuse',
      action: 'nudge',
      message: input.explorationFuseMessage,
    });
  }
  // fuseLabels: only when no dedicated force/read/explore messages (thought-only labels).
  if (
    input.fuseLabels.length > 0 &&
    !input.forceMutateMessage &&
    !input.readThrashMessage &&
    !input.explorationFuseMessage
  ) {
    candidates.push({
      source: 'exploration_fuse',
      action: 'nudge',
      message: input.fuseLabels.join(' '),
    });
  }
  if (input.stallMessage) {
    candidates.push({
      source: 'stall',
      action: 'nudge',
      message: input.stallMessage,
    });
  }
  // Zero-write: enforce ablation → terminal; otherwise nudge-only (P0-E / P1-B).
  if (input.zeroWriteTerminalMessage) {
    candidates.push({
      source: 'zero_write',
      action: 'terminal',
      message: input.zeroWriteTerminalMessage,
    });
  } else if (input.zeroWriteCandidate) {
    candidates.push({
      source: 'zero_write',
      action: 'nudge',
      message: input.zeroWriteCandidate,
    });
  }

  const winner = arbitratePolicy(candidates);
  if (winner) {
    parityReduce(input.rt, {
      type: 'policy_decision',
      intervention: winner.source,
    });
  }

  if (winner?.action === 'terminal') {
    return {
      intervention: progressIx,
      policyMessage: null,
      policySource: winner.source,
      terminalAnswer: winner.message,
    };
  }
  if (progressIx.action === 'recover') {
    input.rt.recoveryTried = true;
  }
  return {
    intervention: progressIx,
    policyMessage: winner?.action === 'nudge' || winner?.action === 'restrict'
      ? winner.message
      : null,
    policySource: winner?.source ?? null,
    terminalAnswer: null,
  };
}

export function parityEndTurn(
  rt: ParityRuntime,
  outcome: TerminalOutcome,
  status: string,
): void {
  // Idempotent: streamDone + buildResult both call this when submitMessage wraps stream.
  if (
    rt.turnId &&
    rt.eventLog.events.some(
      (e) => e.kind === 'turn_ended' && e.turn_id === rt.turnId,
    )
  ) {
    return;
  }
  let event: AgentLoopEvent;
  switch (outcome) {
    case 'CANCELLED':
      event = { type: 'cancel' };
      break;
    case 'BUDGET_EXHAUSTED':
      event = { type: 'budget', exhausted: true, reason: status };
      break;
    case 'VERIFIED_COMPLETE':
      event = { type: 'complete', verified: true };
      break;
    case 'UNVERIFIED_PATCH':
      event = { type: 'complete', verified: false };
      break;
    case 'BLOCKED_POLICY':
      event = { type: 'blocked', kind: 'policy', reason: status };
      break;
    case 'BLOCKED_EXTERNAL':
      event = { type: 'blocked', kind: 'external', reason: status };
      break;
    case 'INFRA_FAILURE':
      event = { type: 'infra_failure', reason: status };
      break;
    default:
      event = { type: 'agent_failure', reason: status };
  }
  parityReduce(rt, event);
  if (rt.turnId) {
    endTurn(rt.eventLog, rt.turnId, outcome, status);
    // W2 PR-E: only one turn_ended per turn_id in session log.
    const already = rt.sessionEvents.events.some(
      (e) => e.kind === 'turn_ended' && e.turn_id === rt.turnId,
    );
    if (!already) {
      recordTurnEnded(rt.sessionEvents, {
        turn_id: rt.turnId,
        outcome,
        status,
      });
    }
  }
}

/**
 * AC3 choke point: every turn terminal MUST go through this.
 * Always: parityEndTurn (memory) then persistThreadEventLog (disk) + session-events.jsonl.
 * Idempotent on turn_ended — safe if streamDone + buildResult both fire.
 */
export async function finalizeParityTurn(
  rt: ParityRuntime,
  runDir: string,
  outcome: TerminalOutcome,
  status: string,
): Promise<void> {
  parityEndTurn(rt, outcome, status);
  parityPersistLiveSession(rt, runDir);
  await persistThreadEventLog(runDir, rt.eventLog);
  flushSessionEventsRequired(rt, runDir, `finalize:${outcome}`);
}

function reportEventLogPersistFailure(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    console.error(`[babel] thread_events.json persist failed (${context}): ${msg}`);
  } catch {
    /* ignore console failures */
  }
}

/** Flush primary session evidence before crossing an effect/terminal boundary. */
function flushSessionEventsRequired(
  rt: ParityRuntime,
  runDir: string,
  context: string,
): void {
  flushSessionEventLogStrict(runDir, rt.sessionEvents);
  flushEpisodeStreamBestEffort(rt, runDir, context);
  void bindBdnsAfterCanonicalFlush({
    sessionId: rt.sessionEvents.session_id,
    runDir,
    workspaceRoot: process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(),
  }).catch(() => undefined);
}

/**
 * Dual-write episode stream from already-recorded session events.
 * Never throws — failures log like session-events.
 */
function flushEpisodeStreamBestEffort(
  rt: ParityRuntime,
  runDir: string,
  context: string,
): void {
  try {
    const result = syncAndFlushEpisodeFromSession(
      runDir,
      rt.episodeStream,
      rt.sessionEvents,
    );
    if (result.error) {
      try {
        console.error(
          `[babel] episode-events.jsonl persist failed (${context}): ${result.error}`,
        );
      } catch {
        /* ignore console failures */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      console.error(
        `[babel] episode-events.jsonl persist failed (${context}): ${msg}`,
      );
    } catch {
      /* ignore console failures */
    }
  }
}

/** H2: dual-write budget + project LiveSession + persist authority/snapshot. */
function parityPersistLiveSession(rt: ParityRuntime, runDir: string): void {
  // A compatibility runtime with no session events must not overwrite a
  // previously durable projection with an empty one.
  if (rt.sessionEvents.events.length === 0) return;
  const turnsUsed = rt.sessionEvents.events.filter(
    (e) => e.kind === 'user_submitted',
  ).length;
  dualWriteBudgetSnapshot(rt.sessionEvents, rt.turnId, {
    turns_used: turnsUsed,
    turns_remaining: null,
  });
  if (rt.liveAuthority) {
    persistLiveSessionAuthority(runDir, rt.liveAuthority);
  }
  const live = projectFromDurableSession({
    sessionLog: rt.sessionEvents,
    threadLog: rt.eventLog,
    ...(rt.liveAuthority ? { authority: rt.liveAuthority } : {}),
  });
  rt.liveSession = live;
  persistLiveSessionSnapshot(runDir, live);
}

/** Fire-and-forget finalize for sync call sites (streamDone/cancel/buildResult). */
export function finalizeParityTurnSync(
  rt: ParityRuntime,
  runDir: string,
  outcome: TerminalOutcome,
  status: string,
): void {
  parityEndTurn(rt, outcome, status);
  parityPersistLiveSession(rt, runDir);
  persistThreadEventLog(runDir, rt.eventLog).catch((err) => {
    reportEventLogPersistFailure(`finalize:${outcome}`, err);
  });
  flushSessionEventsRequired(rt, runDir, `finalize-sync:${outcome}`);
}

/**
 * Non-terminal mid-loop checkpoint only — does NOT end the turn.
 * Use after tool batches that continue the loop.
 */
export function checkpointParityEventLog(rt: ParityRuntime, runDir: string): void {
  parityPersistLiveSession(rt, runDir);
  persistThreadEventLog(runDir, rt.eventLog).catch((err) => {
    reportEventLogPersistFailure('checkpoint', err);
  });
  flushSessionEventsRequired(rt, runDir, 'checkpoint');
}

/**
 * Await every authority-bearing checkpoint artifact. Compaction and other
 * state-replacing operations must use this path instead of fire-and-forget.
 *
 * Multi-artifact atomicity (all-or-nothing across 5 primaries):
 * 1. Memory-only prepare (budget dual-write for payload; cursors not advanced)
 * 2. Stage sibling `.tmp` files for the full batch
 * 3. Backup existing primaries to `.bak`
 * 4. Fixed-order rename; on failure restore from `.bak` or unlink newly created primaries
 * 5. Advance `flushedThroughSeq` / `liveSession` only after all renames succeed
 *
 * Failure contract:
 * - Disk primaries restored to pre-checkpoint state (byte-equal or absent)
 * - Session event list + `nextSeq` + `flushedThroughSeq` restored
 * - All batch `.tmp` / `.bak` sidecars removed
 * - Receipt is `blocked` with no child artifacts marked `committed`
 */
export async function checkpointParityEventLogStrict(
  rt: ParityRuntime,
  runDir: string,
  options?: { injectCommitFailureAfter?: number },
): Promise<PersistenceReceipt> {
  const initialEventsCount = rt.sessionEvents.events.length;
  const initialNextSeq = rt.sessionEvents.nextSeq;
  const initialFlushedThroughSeq = rt.sessionEvents.flushedThroughSeq;
  const batchId = randomUUID();
  const tmpPaths: string[] = [];
  const bakPaths: Array<string | null> = [];

  const unlinkQuiet = (path: string | null | undefined): void => {
    if (!path) return;
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* best-effort sidecar cleanup */
    }
  };

  /** Remove every staged/backup sidecar for this batch (all failure + success paths). */
  const cleanupBatchSidecars = (): void => {
    for (const p of tmpPaths) unlinkQuiet(p);
    for (const p of bakPaths) unlinkQuiet(p);
  };

  /** Roll back dual-write budget events and seq cursor; never leave half-advanced memory. */
  const restoreMemoryCursors = (): void => {
    if (rt.sessionEvents.events.length > initialEventsCount) {
      rt.sessionEvents.events.length = initialEventsCount;
    }
    rt.sessionEvents.nextSeq = initialNextSeq;
    rt.sessionEvents.flushedThroughSeq = initialFlushedThroughSeq;
  };

  try {
    recoverCheckpointArtifacts(runDir);
    const turnsUsed = rt.sessionEvents.events.filter((event) => event.kind === 'user_submitted').length;
    dualWriteBudgetSnapshot(rt.sessionEvents, rt.turnId, {
      turns_used: turnsUsed,
      turns_remaining: null,
    });

    if (!rt.liveAuthority) throw new Error('live authority is missing');

    const projectedLive = projectFromDurableSession({
      sessionLog: rt.sessionEvents,
      threadLog: rt.eventLog,
      authority: rt.liveAuthority,
    });

    const targets: Array<{
      kind: 'authority' | 'live_session' | 'thread_events' | 'session_events';
      filename: string;
      content: string;
    }> = [
      {
        kind: 'authority',
        filename: INSTRUCTION_MANIFEST_FILENAME,
        content: JSON.stringify(rt.liveAuthority.instructionManifest, null, 2),
      },
      {
        kind: 'authority',
        filename: TASK_CONTRACT_FILENAME,
        content: JSON.stringify(rt.liveAuthority.taskContract, null, 2),
      },
      {
        kind: 'live_session',
        filename: LIVE_SESSION_SNAPSHOT_FILENAME,
        content: JSON.stringify(projectedLive, null, 2),
      },
      {
        kind: 'thread_events',
        filename: THREAD_EVENT_LOG_FILENAME,
        content: serializeThreadEventLog(rt.eventLog),
      },
      {
        kind: 'session_events',
        filename: SESSION_EVENTS_FILENAME,
        content: serializeSessionEventLog(rt.sessionEvents),
      },
    ];

    mkdirSync(runDir, { recursive: true });
    writeCheckpointJournal(runDir, {
      schema_version: 1,
      batch_id: batchId,
      status: 'prepared',
      backups_ready: false,
      targets: targets.map((target) => target.filename),
    });

    // Step 2: Sibling .tmp file staging phase
    for (const t of targets) {
      const targetPath = join(runDir, t.filename);
      const tmpPath = `${targetPath}.${batchId}.tmp`;
      tmpPaths.push(tmpPath);
      writeFileSync(tmpPath, t.content, 'utf-8');
    }

    // Step 3: Primary target backup phase
    for (const t of targets) {
      const targetPath = join(runDir, t.filename);
      if (existsSync(targetPath)) {
        const bakPath = `${targetPath}.${batchId}.bak`;
        copyFileSync(targetPath, bakPath);
        bakPaths.push(bakPath);
      } else {
        bakPaths.push(null);
      }
    }
    writeCheckpointJournal(runDir, {
      schema_version: 1,
      batch_id: batchId,
      status: 'prepared',
      backups_ready: true,
      targets: targets.map((target) => target.filename),
    });

    // Step 4: Fixed-order rename. injectCommitFailureAfter === i throws BEFORE rename of index i.
    // Do not mark receipt artifacts committed until the full batch succeeds (honest blocked receipts).
    const committedIndices: number[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        if (options?.injectCommitFailureAfter === i) {
          throw new Error('simulated_commit_failure');
        }
        const targetPath = join(runDir, targets[i]!.filename);
        const tmpPath = tmpPaths[i]!;
        renameSync(tmpPath, targetPath);
        committedIndices.push(i);
      }
    } catch (commitErr) {
      // Disk rollback: restore pre-existing primaries; unlink primaries created by this batch.
      for (let i = 0; i < targets.length; i++) {
        const targetPath = join(runDir, targets[i]!.filename);
        const bakPath = bakPaths[i];
        if (bakPath && existsSync(bakPath)) {
          copyFileSync(bakPath, targetPath);
        } else if (committedIndices.includes(i) && existsSync(targetPath)) {
          unlinkQuiet(targetPath);
        }
      }
      throw commitErr;
    }

    // Step 5: Post-commit state advance (success only) — then drop sidecars
    writeCheckpointJournal(runDir, {
      schema_version: 1,
      batch_id: batchId,
      status: 'committed',
      backups_ready: true,
      targets: targets.map((target) => target.filename),
    });
    cleanupBatchSidecars();
    unlinkQuiet(join(runDir, CHECKPOINT_JOURNAL_FILENAME));
    const maxSeq =
      rt.sessionEvents.events.length > 0
        ? Math.max(...rt.sessionEvents.events.map((e) => e.seq))
        : -1;
    rt.sessionEvents.flushedThroughSeq = maxSeq;
    rt.liveSession = projectedLive;

    const artifacts: PersistenceReceipt['artifacts'] = targets.map((t) => ({
      kind: t.kind,
      path: join(runDir, t.filename),
      status: 'committed' as const,
    }));

    flushEpisodeStreamBestEffort(rt, runDir, 'checkpoint-strict');
    return { status: 'committed', operation: 'checkpoint', runDir, artifacts };
  } catch (error) {
    cleanupBatchSidecars();
    unlinkQuiet(join(runDir, CHECKPOINT_JOURNAL_FILENAME));
    restoreMemoryCursors();
    const message = error instanceof Error ? error.message : String(error);
    // Honest blocked receipt: never report partial committed child artifacts after rollback.
    return {
      status: 'blocked',
      operation: 'checkpoint',
      runDir,
      artifacts: [{ kind: 'checkpoint', status: 'blocked', error: message }],
      error: message,
    };
  }
}


/**
 * Cancel terminal: memory cancel + disk flush via finalize choke point.
 */
export function finalizeParityCancel(rt: ParityRuntime, runDir: string): void {
  // parityOnCancel ends turn as CANCELLED in memory; still need disk flush.
  if (
    rt.turnId &&
    !rt.eventLog.events.some(
      (e) => e.kind === 'turn_ended' && e.turn_id === rt.turnId,
    )
  ) {
    parityOnCancel(rt);
  }
  finalizeParityTurnSync(rt, runDir, 'CANCELLED', 'cancelled');
}

export function parityProviderMessages(
  rt: ParityRuntime,
  systemPrompt?: string,
): ProviderMessage[] {
  return rebuildProviderMessagesFromEvents(rt.eventLog, {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });
}

export function parityShouldCompact(
  estimatedRequestTokens: number,
  modelId: string,
): boolean {
  return shouldCompactByTokens(estimatedRequestTokens, modelId);
}

export function parityBuildCapsule(input: {
  task: string;
  progress: ProgressLedger;
  patchSummary?: string;
  verifierSummary?: string;
  recentToolResults?: string[];
  taskAcceptanceId?: string;
  planStep?: string;
  changedPaths?: string[];
  unresolvedFailures?: string[];
  verifierFreshness?: string;
  approvalsSummary?: string;
  budgetsSummary?: string;
  workspaceRevision?: string;
  evidenceRefs?: string[];
  rawObservationRefs?: string[];
}): string {
  const last = input.progress.receipts[input.progress.receipts.length - 1];
  return formatCompactionCapsule(
    buildCompactionCapsule({
      task: input.task,
      progressSummary: last
        ? `deltas=${last.deltas.join(',')} streak=${input.progress.consecutiveNoProgress}`
        : 'none',
      ...(input.patchSummary ? { patchSummary: input.patchSummary } : {}),
      ...(input.verifierSummary ? { verifierSummary: input.verifierSummary } : {}),
      ...(input.recentToolResults
        ? { recentToolResults: input.recentToolResults }
        : {}),
      ...(input.taskAcceptanceId ? { taskAcceptanceId: input.taskAcceptanceId } : {}),
      ...(input.planStep ? { planStep: input.planStep } : {}),
      ...(input.changedPaths ? { changedPaths: input.changedPaths } : {}),
      ...(input.unresolvedFailures
        ? { unresolvedFailures: input.unresolvedFailures }
        : {}),
      ...(input.verifierFreshness
        ? { verifierFreshness: input.verifierFreshness }
        : {}),
      ...(input.approvalsSummary
        ? { approvalsSummary: input.approvalsSummary }
        : {}),
      ...(input.budgetsSummary ? { budgetsSummary: input.budgetsSummary } : {}),
      ...(input.workspaceRevision
        ? { workspaceRevision: input.workspaceRevision }
        : {}),
      ...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
      ...(input.rawObservationRefs
        ? { rawObservationRefs: input.rawObservationRefs }
        : {}),
    }),
  );
}

export function parityTryFailover(
  rt: ParityRuntime,
  modelId: string,
  error: unknown,
): FailoverDecision | null {
  const d = decideProToFlashFailover(modelId, error);
  if (d) rt.lastFailover = d;
  return d;
}

export function parityContextBudget(modelId: string) {
  return contextBudgetForModel(modelId);
}

export function parityPolicyEvent(
  source: string,
  detail: string,
  at_turn: number,
): PolicyEvent {
  return {
    at_turn,
    kind: 'progress_policy',
    detail: `${source}: ${detail}`,
  };
}
