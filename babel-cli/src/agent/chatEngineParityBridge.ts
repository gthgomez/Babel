/**
 * Live-path bridge for P1–P3 harness parity contracts.
 * Used by ChatEngine (not tests-only): loop reduce, progress, policy arbitration,
 * thread event log, approvals, provider budget/failover.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';
import type { ProviderMessage, ProviderToolCall } from '../runners/base.js';
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
  persistThreadEventLog,
  type ThreadEventLog,
} from './threadEventLog.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordTurnEnded,
  flushSessionEventLog,
  completedToolIdempotencyKeys,
  markInterruptedToolsOnResume,
  type SessionEventLog,
} from './sessionEvents.js';
import {
  createEpisodeEventLog,
  syncAndFlushEpisodeFromSession,
  type EpisodeEventLog,
} from '../evidence/episodeStream.js';
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
} from './liveSessionBridge.js';

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
  /** H2: last projected LiveSession (rebuilt on resume). */
  liveSession?: import('./liveSession.js').LiveSessionV1;
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
 * W2.2 settle step 1–2: persist tool_proposed + tool_started, then flush to disk
 * **before** side effects. Call this immediately before executeActions.
 * Skips keys already terminal (resume no double-mutate).
 */
export function paritySettleProposeTools(
  rt: ParityRuntime,
  tools: Array<{ id: string; name: string }>,
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
      });
    }
    const alreadyStarted = rt.sessionEvents.events.some(
      (e) => e.kind === 'tool_started' && e.idempotency_key === t.id,
    );
    if (!alreadyStarted) {
      recordToolStarted(rt.sessionEvents, {
        turn_id: rt.turnId,
        tool_call_id: t.id,
        tool_name: t.name,
        idempotency_key: t.id,
      });
    }
    proposed += 1;
  }
  if (runDir) {
    flushSessionEventsBestEffort(rt, runDir, 'settle-propose');
  }
  return { proposed, skipped };
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
    flushSessionEventsBestEffort(rt, runDir, 'settle-resume-interrupted');
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
          });
          recordToolStarted(rt.sessionEvents, {
            turn_id: rt.turnId,
            tool_call_id: tc.id,
            tool_name: tc.function.name,
            idempotency_key: tc.id,
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
      // Terminal settle — skip if already terminal (resume double-complete guard).
      if (!completedToolIdempotencyKeys(rt.sessionEvents).has(r.tool_call_id)) {
        recordToolTerminal(rt.sessionEvents, {
          turn_id: rt.turnId,
          tool_call_id: r.tool_call_id,
          tool_name: r.tool_name,
          idempotency_key: r.tool_call_id,
          content: r.content,
          ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
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
  if (input.investigateHardCapTerminal?.trim()) {
    candidates.push({
      source: 'investigate_hard_cap',
      action: 'terminal',
      message: input.investigateHardCapTerminal.trim(),
    });
  }
  if (input.stallKillMessage) {
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
  // Skip progress thrash interventions when env already queued — wrong failure class.
  if (!input.envBlockedSignal?.trim()) {
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
  await persistThreadEventLog(runDir, rt.eventLog);
  flushSessionEventsBestEffort(rt, runDir, `finalize:${outcome}`);
}

function reportEventLogPersistFailure(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    console.error(`[babel] thread_events.json persist failed (${context}): ${msg}`);
  } catch {
    /* ignore console failures */
  }
}

function flushSessionEventsBestEffort(
  rt: ParityRuntime,
  runDir: string,
  context: string,
): void {
  const result = flushSessionEventLog(runDir, rt.sessionEvents);
  if (result.error) {
    try {
      console.error(
        `[babel] session-events.jsonl persist failed (${context}): ${result.error}`,
      );
    } catch {
      /* ignore console failures */
    }
  }
  // Slice A: project session events → episode-events.jsonl (best-effort dual-write).
  flushEpisodeStreamBestEffort(rt, runDir, context);
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
  try {
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
  } catch {
    /* never break finalize/checkpoint for projection failures */
  }
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
  flushSessionEventsBestEffort(rt, runDir, `finalize-sync:${outcome}`);
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
  flushSessionEventsBestEffort(rt, runDir, 'checkpoint');
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
