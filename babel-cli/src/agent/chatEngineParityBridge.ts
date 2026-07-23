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

export interface ParityRuntime {
  loop: AgentLoopState;
  progress: ProgressLedger;
  eventLog: ThreadEventLog;
  approvalSession: ApprovalSessionState;
  turnId: string | null;
  recoveryTried: boolean;
  lastFailover: FailoverDecision | null;
}

export function createParityRuntime(threadId: string): ParityRuntime {
  return {
    loop: initialAgentLoopState(),
    progress: createProgressLedger(),
    eventLog: createThreadEventLog(threadId),
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
  },
): ProgressReceipt {
  if (rt.turnId && input.toolCalls.length > 0) {
    recordAssistantToolCalls(
      rt.eventLog,
      rt.turnId,
      input.thinking ?? 'Using tools…',
      input.toolCalls,
    );
    for (const r of input.results) {
      recordToolResult(rt.eventLog, rt.turnId, {
        tool_call_id: r.tool_call_id,
        tool_name: r.tool_name,
        content: r.content,
        ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
      });
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
 * Zero-write alone is never terminal unless progress score says terminal.
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
  stallMessage?: string | null;
  /** Non-shadow stall kill — terminal via progress_terminal precedence. */
  stallKillMessage?: string | null;
  zeroWriteCandidate?: string | null;
  hardCeiling?: boolean;
  hardCeilingReason?: string;
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
  if (input.stallKillMessage) {
    candidates.push({
      source: 'progress_terminal',
      action: 'terminal',
      message: input.stallKillMessage,
    });
  }
  const progressIx = scoreProgressIntervention(input.rt.progress, {
    recoveryAlreadyTried: input.rt.recoveryTried,
    ...(input.hardCeiling === true
      ? {
          hardCeiling: true as const,
          ...(input.hardCeilingReason
            ? { hardCeilingReason: input.hardCeilingReason }
            : {}),
        }
      : {}),
  });
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
  // Zero-write is nudge-only here — never sole terminal (P1-B).
  if (input.zeroWriteCandidate) {
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
  }
}

/**
 * AC3 choke point: every turn terminal MUST go through this.
 * Always: parityEndTurn (memory) then persistThreadEventLog (disk).
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
}

function reportEventLogPersistFailure(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    console.error(`[babel] thread_events.json persist failed (${context}): ${msg}`);
  } catch {
    /* ignore console failures */
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
  persistThreadEventLog(runDir, rt.eventLog).catch((err) => {
    reportEventLogPersistFailure(`finalize:${outcome}`, err);
  });
}

/**
 * Non-terminal mid-loop checkpoint only — does NOT end the turn.
 * Use after tool batches that continue the loop.
 */
export function checkpointParityEventLog(rt: ParityRuntime, runDir: string): void {
  persistThreadEventLog(runDir, rt.eventLog).catch((err) => {
    reportEventLogPersistFailure('checkpoint', err);
  });
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
