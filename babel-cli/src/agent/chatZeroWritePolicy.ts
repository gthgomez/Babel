/**
 * Zero-write thrash policy for chat execute tasks.
 * Pure helpers — no I/O. Used by ChatEngine submit + stream paths.
 */

import {
  getChatTaskTune,
  type ChatTaskClass,
} from '../config/chatTaskClass.js';
import {
  buildForceMutateMessage,
  buildZeroWriteHardStopMessage,
  shouldForceMutateEscalation,
  shouldHardBlockZeroWrite,
} from './budgetKillPolicy.js';
import type { RestrictedToolMode } from './chatToolDefinitions.js';
import type { BlockedReport } from '../schemas/agentContracts.js';
import { applyCumulativeExplorationEscalation } from './explorationFuse.js';
import {
  buildReadThrashFuseMessage,
  shouldFireReadThrashFuse,
} from './readThrashPolicy.js';
import type { PolicyEvent } from './policyEventLog.js';
import type { ChatPhase } from './chatPhaseNudge.js';
import {
  evaluateInvestigateToolBudget,
  evaluateShellSoftBudget,
} from './implementorPolicy.js';

/** Env override for zero-write hard-stop turns; 0 disables. */
export function resolveZeroWriteHardStopTurns(
  taskClass: ChatTaskClass,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS']?.trim();
  if (raw !== undefined && raw !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return getChatTaskTune(taskClass).zeroWriteHardStopTurns;
}

/**
 * After a completed tool turn: when execute + zero writes past threshold,
 * return the BLOCKED answer; otherwise null.
 */
export function evaluateZeroWriteHardStop(input: {
  executeIntent: boolean;
  completedTurns: number;
  hasAnyWrites: boolean;
  taskClass: ChatTaskClass;
  env?: NodeJS.ProcessEnv;
  onPolicyEvent?: (event: PolicyEvent) => void;
}): string | null {
  const threshold = resolveZeroWriteHardStopTurns(input.taskClass, input.env);
  if (
    !shouldHardBlockZeroWrite({
      executeIntent: input.executeIntent,
      completedTurns: input.completedTurns,
      threshold,
      hasAnyWrites: input.hasAnyWrites,
    })
  ) {
    return null;
  }
  input.onPolicyEvent?.({
    at_turn: input.completedTurns,
    kind: 'zero_write_hard_stop',
    detail: `turns=${input.completedTurns}`,
  });
  return buildZeroWriteHardStopMessage(input.completedTurns, threshold);
}

export function buildZeroWriteHardStopBlockedReport(answer: string): BlockedReport {
  return {
    schema_version: 1,
    status: 'BLOCKED',
    reason: 'Zero successful file mutations by hard-stop turn threshold',
    missing: 'A real patch via str_replace / write_file / apply_patch',
    checked: [
      {
        action: 'zero_write_hard_stop',
        target: 'mutation',
        finding: answer.slice(0, 240),
      },
    ],
  };
}

/**
 * BlockedReport for progress/stall/hard-ceiling terminals — not zero-write.
 * Use when parity arbiter wins with a non-zero_write terminal source.
 */
export function buildPolicyTerminalBlockedReport(
  source: string,
  answer: string,
): BlockedReport {
  if (source === 'zero_write') {
    return buildZeroWriteHardStopBlockedReport(answer);
  }
  const labels: Record<string, { reason: string; missing: string; target: string }> = {
    hard_ceiling: {
      reason: 'Hard resource ceiling',
      missing: 'Within-budget path to completion',
      target: 'budget',
    },
    progress_terminal: {
      reason: 'Repeated no-progress after recovery',
      missing: 'Semantic progress (mutation, new localization, or hypothesis change)',
      target: 'progress',
    },
    stall: {
      reason: 'Stall kill intervention',
      missing: 'Non-repeating tool trajectory toward a fix',
      target: 'stall',
    },
    explicit_deny: {
      reason: 'Explicit policy denial',
      missing: 'An allowed action path',
      target: 'policy',
    },
    circuit_breaker: {
      reason: 'Circuit breaker terminal stop',
      missing: 'Safe tool path within circuit limits',
      target: 'circuit_breaker',
    },
    external_blocker: {
      reason: 'Verified external blocker',
      missing: 'External dependency or permission',
      target: 'external',
    },
  };
  const meta = labels[source] ?? {
    reason: `Terminal policy intervention: ${source}`,
    missing: 'A viable recovery or mutation path',
    target: 'policy',
  };
  return {
    schema_version: 1,
    status: 'BLOCKED',
    reason: meta.reason,
    missing: meta.missing,
    checked: [
      {
        action: source,
        target: meta.target,
        finding: answer.slice(0, 240),
      },
    ],
  };
}

/** Force-mutate / thrash restriction: no shell until a patch exists. */
export function resolveRestrictedToolMode(hasAnyWrites: boolean): RestrictedToolMode {
  return hasAnyWrites ? 'act_or_verify' : 'mutate_only';
}

/** Strip internal tool-log index for CLI/harness payloads. */
export function exportToolCallLog<T extends { index?: number }>(
  toolCallLog: T[],
): Array<Omit<T, 'index'>> {
  return toolCallLog.map(({ index: _index, ...rest }) => rest);
}

/** Mutable fuse state owned by ChatEngine; updated in place. */
export interface ExploreFuseState {
  turnsWithoutWrite: number;
  consecutiveReadOnlyTools: number;
  cumulativeExplorationTools: number;
  restrictToolsNextTurn: boolean;
  /** Implementor: consecutive shell tools without a mutation. */
  consecutiveNonMutatingShells: number;
  /** Implementor: total tool calls since last write (session). */
  toolsWithoutWrite: number;
  /** Current control phase for investigate-budget gating. */
  phase: ChatPhase | null;
}

/** Result of fuse evaluation — messages may be deferred to the policy arbiter. */
export interface ExploreFuseResult {
  labels: string[];
  forceMutateMessage: string | null;
  readThrashMessage: string | null;
  explorationFuseMessage: string | null;
  shellSoftMessage: string | null;
  investigateBudgetMessage: string | null;
}

/**
 * Force-mutate + read-thrash + cumulative exploration fuses.
 * Mutates fuse state in place.
 *
 * When `deferMessagesToArbiter` is true (chat live path), messages are returned
 * as candidates so parityArbitrateCycle presents at most one intervention.
 * When false, messages are pushed immediately (legacy / isolated call sites).
 */
export function applyExploreFuses(input: {
  executeIntent: boolean;
  taskClass: ChatTaskClass;
  hasAnyWrites: boolean;
  state: ExploreFuseState;
  pushUser: (content: string) => void;
  onPolicyEvent?: (event: PolicyEvent) => void;
  currentTurn?: number;
  /** When true, do not pushUser — return messages for policy arbitration. */
  deferMessagesToArbiter?: boolean;
  /** Override force-mutate turn threshold (plan→execute elevated mutate). */
  forceMutateTurnsOverride?: number;
}): ExploreFuseResult {
  if (!input.executeIntent) {
    return {
      labels: [],
      forceMutateMessage: null,
      readThrashMessage: null,
      explorationFuseMessage: null,
      shellSoftMessage: null,
      investigateBudgetMessage: null,
    };
  }
  const tune = getChatTaskTune(input.taskClass);
  const out: string[] = [];
  const s = input.state;
  const defer = input.deferMessagesToArbiter === true;
  let forceMutateMessage: string | null = null;
  let readThrashMessage: string | null = null;
  let explorationFuseMessage: string | null = null;
  let shellSoftMessage: string | null = null;
  let investigateBudgetMessage: string | null = null;

  // Policy fuses can fire as soft nudges (message only — model keeps full
  // tool access) or as hard restrictions (tools restricted next turn).
  // Soft-nudge mode matches Claude Code / Grok CLI: trust the model to
  // sequence its own tools, with the hard-stop as the safety net.
  const hardRestrict = tune.restrictToolsOnPolicyFire === true;

  if (
    shouldForceMutateEscalation({
      executeIntent: true,
      turnsWithoutWrite: s.turnsWithoutWrite,
      threshold: input.forceMutateTurnsOverride ?? tune.forceMutateTurns,
      hasAnyWrites: input.hasAnyWrites,
    })
  ) {
    forceMutateMessage = buildForceMutateMessage(s.turnsWithoutWrite);
    if (!defer) input.pushUser(forceMutateMessage);
    if (hardRestrict) {
      s.restrictToolsNextTurn = true;
      input.onPolicyEvent?.({
        at_turn: input.currentTurn ?? 0,
        kind: 'restrict_tools',
        detail: 'mode=mutate_only',
      });
    }
    out.push('[Force mutate: zero writes — soft nudge]');
    input.onPolicyEvent?.({
      at_turn: input.currentTurn ?? 0,
      kind: 'force_mutate',
      detail: `turns_without_write=${s.turnsWithoutWrite}`,
    });
    s.turnsWithoutWrite = 0;
  }

  if (
    shouldFireReadThrashFuse({
      executeIntent: true,
      consecutiveReadOnlyTools: s.consecutiveReadOnlyTools,
      budget: tune.readThrashToolBudget,
    })
  ) {
    readThrashMessage = buildReadThrashFuseMessage(s.consecutiveReadOnlyTools);
    if (!defer) input.pushUser(readThrashMessage);
    if (hardRestrict) {
      s.restrictToolsNextTurn = true;
      input.onPolicyEvent?.({
        at_turn: input.currentTurn ?? 0,
        kind: 'restrict_tools',
        detail: 'mode=mutate_only',
      });
    }
    out.push('[Read thrash fuse: soft nudge]');
    input.onPolicyEvent?.({
      at_turn: input.currentTurn ?? 0,
      kind: 'read_thrash_fuse',
      detail: `consecutive_read_only=${s.consecutiveReadOnlyTools}`,
    });
    s.consecutiveReadOnlyTools = 0;
  }

  const result = applyCumulativeExplorationEscalation(
    s.cumulativeExplorationTools,
    tune.readThrashToolBudget,
    (msg) => {
      if (defer) {
        explorationFuseMessage = msg.content;
      } else {
        input.pushUser(msg.content);
      }
    },
  );
  if (hardRestrict && result.restrictTools) s.restrictToolsNextTurn = true;
  out.push(...result.fired);

  // Implementor W1: shell soft budget (non-mutating shell thrash).
  const shellEval = evaluateShellSoftBudget({
    consecutiveNonMutatingShells: s.consecutiveNonMutatingShells,
    budget: tune.shellSoftBudget,
    hasAnyWrites: input.hasAnyWrites,
  });
  if (shellEval.fire && shellEval.message) {
    shellSoftMessage = shellEval.message;
    if (!defer) input.pushUser(shellEval.message);
    out.push('[Implementor: shell soft budget]');
    input.onPolicyEvent?.({
      at_turn: input.currentTurn ?? 0,
      kind: 'shell_soft_budget',
      detail: `consecutive_shells=${s.consecutiveNonMutatingShells}`,
    });
    s.consecutiveNonMutatingShells = 0;
  }

  // Implementor W1: investigate tool budget (soft force-mutate by tool count).
  const invEval = evaluateInvestigateToolBudget({
    toolCallCount: s.toolsWithoutWrite,
    budget: tune.investigateToolBudget,
    hasAnyWrites: input.hasAnyWrites,
    phase: s.phase,
  });
  if (invEval.fire && invEval.message) {
    investigateBudgetMessage = invEval.message;
    if (!defer) input.pushUser(invEval.message);
    out.push('[Implementor: investigate tool budget]');
    input.onPolicyEvent?.({
      at_turn: input.currentTurn ?? 0,
      kind: 'investigate_budget',
      detail: `tools_without_write=${s.toolsWithoutWrite}`,
    });
  }

  return {
    labels: out,
    forceMutateMessage,
    readThrashMessage,
    explorationFuseMessage,
    shellSoftMessage,
    investigateBudgetMessage,
  };
}
