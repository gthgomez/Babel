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
  resolveEnvThresholdTurns,
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
import {
  buildExploreFuseShadowEvents,
  resolvePolicyMode,
} from './policyShadow.js';

/** Env override for zero-write hard-stop turns; 0 disables. */
export function resolveZeroWriteHardStopTurns(
  taskClass: ChatTaskClass,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveEnvThresholdTurns(
    env,
    'BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS',
    getChatTaskTune(taskClass).zeroWriteHardStopTurns,
  );
}

/**
 * After a completed tool turn: when execute + zero writes past threshold,
 * return the BLOCKED answer; otherwise null.
 *
 * Prefer {@link evaluateZeroWriteWithShadow} on the live chat path (P0-E).
 * This helper remains for offline scorecards / prove smokes and still emits
 * `zero_write_hard_stop` when the live threshold fires (enforce-style).
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
    investigate_hard_cap: {
      reason: 'Too many tools without a file mutation (investigate hard cap)',
      missing: 'A successful str_replace/write_file before more exploration',
      target: 'investigate_budget',
    },
    env_blocked: {
      reason: 'Environment / toolchain cannot run verification',
      missing: 'Working project runtime (deps installed, conftest importable, pytest/node on PATH)',
      target: 'environment',
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
  /**
   * One-shot shadow kinds already emitted this session (force_mutate_shadow, …).
   * Prevents 12× force_mutate_shadow spam while soft nudges may still re-fire.
   */
  shadowLoggedKinds?: Set<string>;
  /**
   * Soft investigate budget already nudged once since last write.
   * Prevents Wave A–style 13× soft spam without terminalizing.
   */
  investigateSoftNudgeDone?: boolean;
}

/** Result of fuse evaluation — messages may be deferred to the policy arbiter. */
export interface ExploreFuseResult {
  labels: string[];
  forceMutateMessage: string | null;
  readThrashMessage: string | null;
  explorationFuseMessage: string | null;
  shellSoftMessage: string | null;
  investigateBudgetMessage: string | null;
  /**
   * Hard cap on tools without a write — terminal candidate (not a soft nudge).
   * Set when toolsWithoutWrite >= investigate hard cap for the task class.
   */
  investigateHardCapTerminal: string | null;
}

/** Build hard-cap terminal message for explore-without-mutate thrash. */
export function buildInvestigateHardCapTerminalMessage(
  toolsWithoutWrite: number,
  hardCap: number,
): string {
  return [
    `BLOCKED: ${toolsWithoutWrite} tools without a successful file mutation ` +
      `(hard cap ${hardCap} for this task class).`,
    'You spent the investigate budget exploring without applying a fix.',
    'Stop reading. If you can still fix the issue, the next turn must use str_replace/write_file;',
    'this session is terminating explore thrash so cost is not burned on re-reads.',
  ].join(' ');
}

/**
 * Resolve hard cap for tools-before-first-write.
 * Explicit tune field wins; else 2× soft investigate budget; 0 disables.
 */
export function resolveInvestigateToolHardCap(
  investigateToolBudget: number,
  explicitHardCap?: number,
): number {
  if (explicitHardCap !== undefined && explicitHardCap >= 0) {
    return explicitHardCap;
  }
  if (investigateToolBudget <= 0) return 0;
  return investigateToolBudget * 2;
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
  /** Injectable env for ablation tests (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}): ExploreFuseResult {
  if (!input.executeIntent) {
    return {
      labels: [],
      forceMutateMessage: null,
      readThrashMessage: null,
      explorationFuseMessage: null,
      shellSoftMessage: null,
      investigateBudgetMessage: null,
      investigateHardCapTerminal: null,
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
  let investigateHardCapTerminal: string | null = null;

  // Policy fuses can fire as soft nudges (message only — model keeps full
  // tool access) or as hard restrictions (tools restricted next turn).
  // Soft-nudge mode matches Claude Code / Grok CLI: trust the model to
  // sequence its own tools, with the hard-stop as the safety net.
  // P0-E: ablation modes (shadow|enforce|off) via resolvePolicyMode.
  // Hard restrict applies only when mode === 'enforce' (shadow never restricts).
  const hardRestrict = tune.restrictToolsOnPolicyFire === true;
  const env = input.env ?? process.env;
  const forceMode = resolvePolicyMode('force_mutate', input.taskClass, env);
  const thrashMode = resolvePolicyMode('read_thrash', input.taskClass, env);
  const exploreMode = resolvePolicyMode('exploration_fuse', input.taskClass, env);
  let forceMutateFired = false;
  let readThrashFired = false;
  let explorationExhausted = false;

  if (
    forceMode !== 'off' &&
    shouldForceMutateEscalation({
      executeIntent: true,
      turnsWithoutWrite: s.turnsWithoutWrite,
      threshold: input.forceMutateTurnsOverride ?? tune.forceMutateTurns,
      hasAnyWrites: input.hasAnyWrites,
    })
  ) {
    forceMutateFired = true;
    forceMutateMessage = buildForceMutateMessage(s.turnsWithoutWrite);
    if (!defer) input.pushUser(forceMutateMessage);
    // Hard restrict only in enforce mode when the task class enables it.
    if (hardRestrict && forceMode === 'enforce') {
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
    thrashMode !== 'off' &&
    shouldFireReadThrashFuse({
      executeIntent: true,
      consecutiveReadOnlyTools: s.consecutiveReadOnlyTools,
      budget: tune.readThrashToolBudget,
    })
  ) {
    readThrashFired = true;
    readThrashMessage = buildReadThrashFuseMessage(s.consecutiveReadOnlyTools);
    if (!defer) input.pushUser(readThrashMessage);
    if (hardRestrict && thrashMode === 'enforce') {
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

  const result =
    exploreMode === 'off'
      ? { fired: [] as string[], restrictTools: false }
      : applyCumulativeExplorationEscalation(
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
  explorationExhausted = result.restrictTools === true;
  if (hardRestrict && exploreMode === 'enforce' && result.restrictTools) {
    s.restrictToolsNextTurn = true;
  }
  out.push(...result.fired);

  // P0-E: record would-have-restrict / exhaust while soft-nudge path continues.
  // One-shot per kind per session (same discipline as zero_write_shadow).
  if (!s.shadowLoggedKinds) s.shadowLoggedKinds = new Set();
  for (const shadowEv of buildExploreFuseShadowEvents({
    atTurn: input.currentTurn ?? 0,
    taskClass: input.taskClass,
    forceMutateFired,
    readThrashFired,
    explorationExhausted,
    hardRestrictEnabled: hardRestrict,
    env,
    alreadyLoggedKinds: s.shadowLoggedKinds,
  })) {
    input.onPolicyEvent?.(shadowEv);
    s.shadowLoggedKinds.add(shadowEv.kind);
  }

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
  // Fire once per zero-write streak when toolsWithoutWrite first reaches soft
  // budget — not every later turn at the same count or above (Wave A spam).
  // Hard cap remains the terminal stop.
  if (input.hasAnyWrites || s.toolsWithoutWrite === 0) {
    s.investigateSoftNudgeDone = false;
  }
  const invEval = evaluateInvestigateToolBudget({
    toolCallCount: s.toolsWithoutWrite,
    budget: tune.investigateToolBudget,
    hasAnyWrites: input.hasAnyWrites,
    phase: s.phase,
  });
  if (invEval.fire && invEval.message && !s.investigateSoftNudgeDone) {
    investigateBudgetMessage = invEval.message;
    if (!defer) input.pushUser(invEval.message);
    out.push('[Implementor: investigate tool budget]');
    input.onPolicyEvent?.({
      at_turn: input.currentTurn ?? 0,
      kind: 'investigate_budget',
      detail: `tools_without_write=${s.toolsWithoutWrite}`,
    });
    s.investigateSoftNudgeDone = true;
  }

  // Hard cap: stop explore thrash (pilot: 53 tools before first write).
  // Soft budget still nudges once; hard cap is a terminal candidate for the arbiter.
  const hardCap = resolveInvestigateToolHardCap(
    tune.investigateToolBudget,
    tune.investigateToolHardCap,
  );
  if (
    hardCap > 0 &&
    !input.hasAnyWrites &&
    s.toolsWithoutWrite >= hardCap
  ) {
    investigateHardCapTerminal = buildInvestigateHardCapTerminalMessage(
      s.toolsWithoutWrite,
      hardCap,
    );
    out.push('[Implementor: investigate hard cap — terminal]');
    input.onPolicyEvent?.({
      at_turn: input.currentTurn ?? 0,
      kind: 'investigate_budget',
      detail: `hard_cap tools_without_write=${s.toolsWithoutWrite} cap=${hardCap}`,
    });
  }

  return {
    labels: out,
    forceMutateMessage,
    readThrashMessage,
    explorationFuseMessage,
    shellSoftMessage,
    investigateBudgetMessage,
    investigateHardCapTerminal,
  };
}
