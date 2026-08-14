/**
 * policyShadow.ts — P0-E kill-switch shadow mode + later-success tracking.
 *
 * Coding-task policies (zero-write, force-mutate, read-thrash, exploration fuse,
 * stall kill) default to **shadow**: log what would have intervened, never
 * hard-kill the session. Wall/cost budgets remain hard safety ceilings
 * (BUDGET_EXHAUSTED) outside this module.
 *
 * Ablation (not a code fork): set BABEL_POLICY_MODE_<POLICY>=shadow|enforce|off
 * or BABEL_POLICY_MODE for a global default.
 *
 * Modes for zero-write:
 * - shadow: log once when shadow threshold would kill; soft nudge only if live
 *   threshold still enabled for the class
 * - enforce: live threshold fires as a **terminal** hard-stop (parity action)
 * - off: no log, no nudge, no kill
 *
 * See Codex harness parity plan P0-E and teardown HF-05.
 */

import {
  getChatTaskTune,
  type ChatTaskClass,
} from '../config/chatTaskClass.js';
import {
  buildZeroWriteHardStopMessage,
  resolveEnvThresholdTurns,
  shouldHardBlockZeroWrite,
} from './budgetKillPolicy.js';
import type { PolicyEvent, PolicyEventKind, PolicyEventLog } from './policyEventLog.js';

/** Policies that historically hard-killed or hard-restricted coding runs. */
export type ShadowKillPolicy =
  | 'zero_write'
  | 'force_mutate'
  | 'read_thrash'
  | 'exploration_fuse'
  | 'stall_kill';

/**
 * - shadow: log would-have intervention; soft nudge only (never terminal)
 * - enforce: historical hard-stop / hard-restrict behavior (zero-write is terminal)
 * - off: disable the policy entirely (no log, no nudge, no kill)
 */
export type PolicyShadowMode = 'shadow' | 'enforce' | 'off';

/** Shadow threshold when live zero-write hard-stop is disabled (0). */
export const DEFAULT_SHADOW_ZERO_WRITE_TURNS = 12;

const POLICY_ENV_KEYS: Record<ShadowKillPolicy, string> = {
  zero_write: 'BABEL_POLICY_MODE_ZERO_WRITE',
  force_mutate: 'BABEL_POLICY_MODE_FORCE_MUTATE',
  read_thrash: 'BABEL_POLICY_MODE_READ_THRASH',
  exploration_fuse: 'BABEL_POLICY_MODE_EXPLORATION_FUSE',
  stall_kill: 'BABEL_POLICY_MODE_STALL_KILL',
};

const GLOBAL_MODE_ENV = 'BABEL_POLICY_MODE';
const SHADOW_ZERO_WRITE_TURNS_ENV = 'BABEL_CHAT_ZERO_WRITE_SHADOW_TURNS';
const LIVE_ZERO_WRITE_TURNS_ENV = 'BABEL_CHAT_ZERO_WRITE_HARD_STOP_TURNS';

/** Event kinds that count as shadow interventions for later-success rollup. */
export const SHADOW_INTERVENTION_KINDS: ReadonlySet<PolicyEventKind> = new Set([
  'zero_write_shadow',
  'force_mutate_shadow',
  'read_thrash_shadow',
  'exploration_shadow',
  'stall_shadow_kill',
]);

function parseMode(raw: string | undefined): PolicyShadowMode | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'shadow' || v === 'enforce' || v === 'off') return v;
  return null;
}

/**
 * Per-class defaults: coding profiles shadow kill-switches; governance enforces;
 * investigate: stall remains enforce (may kill); zero-write/force-mutate off.
 */
export function defaultPolicyMode(
  policy: ShadowKillPolicy,
  taskClass: ChatTaskClass,
): PolicyShadowMode {
  if (taskClass === 'governance') {
    if (policy === 'stall_kill') return 'enforce';
    if (policy === 'zero_write') return 'enforce';
    // Force/read/explore: governance hard-restricts under enforce.
    return 'enforce';
  }
  if (taskClass === 'quick_inspect') {
    if (policy === 'zero_write') return 'off';
    if (policy === 'force_mutate') return 'off';
    if (policy === 'stall_kill') return 'off';
    return 'off';
  }
  if (taskClass === 'investigate') {
    if (policy === 'zero_write') return 'off';
    if (policy === 'force_mutate') return 'off';
    // Stall remains enforce — research thrash can still be killed.
    if (policy === 'stall_kill') return 'enforce';
    return 'shadow';
  }
  // default, quick_fix, general_swe — coding path: never hard-kill on heuristics
  return 'shadow';
}

/** Resolve mode: per-policy env → global env → task-class default. */
export function resolvePolicyMode(
  policy: ShadowKillPolicy,
  taskClass: ChatTaskClass,
  env: NodeJS.ProcessEnv = process.env,
): PolicyShadowMode {
  const fromPolicy = parseMode(env[POLICY_ENV_KEYS[policy]]);
  if (fromPolicy) return fromPolicy;
  const fromGlobal = parseMode(env[GLOBAL_MODE_ENV]);
  if (fromGlobal) return fromGlobal;
  return defaultPolicyMode(policy, taskClass);
}

/** Whether stall detector should downgrade kill → nudge (shadow) or never kill (off). */
export function resolveStallShadowMode(
  taskClass: ChatTaskClass,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = resolvePolicyMode('stall_kill', taskClass, env);
  if (mode === 'enforce') return false;
  // shadow and off both avoid kill; off additionally suppresses interventions
  // via resolveStallInterventionsEnabled.
  return true;
}

/** When false, stall detector should not emit interventions at all. */
export function resolveStallInterventionsEnabled(
  taskClass: ChatTaskClass,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolvePolicyMode('stall_kill', taskClass, env) !== 'off';
}

/**
 * Shadow comparison threshold for zero-write would-have-killed.
 * Independent of live hard-stop (which is 0 for general_swe).
 */
export function resolveShadowZeroWriteTurns(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveEnvThresholdTurns(env, SHADOW_ZERO_WRITE_TURNS_ENV, DEFAULT_SHADOW_ZERO_WRITE_TURNS);
}

/** Live zero-write threshold (shared parse with chatZeroWritePolicy). */
function resolveLiveZeroWriteTurns(
  taskClass: ChatTaskClass,
  env: NodeJS.ProcessEnv,
): number {
  return resolveEnvThresholdTurns(
    env,
    LIVE_ZERO_WRITE_TURNS_ENV,
    getChatTaskTune(taskClass).zeroWriteHardStopTurns,
  );
}

export interface ZeroWriteShadowDecision {
  mode: PolicyShadowMode;
  liveThreshold: number;
  shadowThreshold: number;
  /** Live hard-stop threshold would fire. */
  liveWouldFire: boolean;
  /** Shadow threshold would fire (precision/recall narrative). */
  shadowWouldFire: boolean;
  /**
   * Soft nudge for parity arbiter (shadow mode when live threshold still set).
   * Never set when terminalMessage is set.
   */
  arbiterMessage: string | null;
  /**
   * Enforce-mode terminal answer. When set, parity must use action=terminal.
   */
  terminalMessage: string | null;
  /** Policy events to append (shadow and/or hard-stop). At most one zero_write_shadow. */
  events: PolicyEvent[];
}

/**
 * Evaluate zero-write policy under shadow/enforce/off.
 * Callers pass events to PolicyEventLog; message goes to parity arbiter.
 *
 * Pass `alreadyHasZeroWriteShadow` so shadow logs fire once per session, not
 * every turn after the threshold is crossed.
 */
export function evaluateZeroWriteWithShadow(input: {
  executeIntent: boolean;
  completedTurns: number;
  hasAnyWrites: boolean;
  taskClass: ChatTaskClass;
  env?: NodeJS.ProcessEnv;
  atTurn?: number;
  /** When true, skip emitting another zero_write_shadow (session already logged). */
  alreadyHasZeroWriteShadow?: boolean;
}): ZeroWriteShadowDecision {
  const env = input.env ?? process.env;
  const mode = resolvePolicyMode('zero_write', input.taskClass, env);
  const liveThreshold = resolveLiveZeroWriteTurns(input.taskClass, env);
  const shadowThreshold = resolveShadowZeroWriteTurns(env);
  const at = input.atTurn ?? input.completedTurns;

  const liveWouldFire = shouldHardBlockZeroWrite({
    executeIntent: input.executeIntent,
    completedTurns: input.completedTurns,
    threshold: liveThreshold,
    hasAnyWrites: input.hasAnyWrites,
  });
  const shadowWouldFire = shouldHardBlockZeroWrite({
    executeIntent: input.executeIntent,
    completedTurns: input.completedTurns,
    threshold: shadowThreshold,
    hasAnyWrites: input.hasAnyWrites,
  });

  const events: PolicyEvent[] = [];
  if (mode === 'off') {
    return {
      mode,
      liveThreshold,
      shadowThreshold,
      liveWouldFire,
      shadowWouldFire,
      arbiterMessage: null,
      terminalMessage: null,
      events,
    };
  }

  if (mode === 'shadow') {
    // Log once when the shadow threshold would have killed (even if live is 0).
    if (shadowWouldFire && !input.alreadyHasZeroWriteShadow) {
      events.push({
        at_turn: at,
        kind: 'zero_write_shadow',
        detail:
          `would_kill turns=${input.completedTurns} shadow_threshold=${shadowThreshold} ` +
          `live_threshold=${liveThreshold}`,
      });
    }
    // Soft nudge only when class still has a live threshold (legacy HS:Nt classes).
    // general_swe (live 0) stays silent except for the one-shot shadow log above.
    const arbiterMessage =
      liveWouldFire
        ? buildZeroWriteHardStopMessage(input.completedTurns, liveThreshold)
        : null;
    return {
      mode,
      liveThreshold,
      shadowThreshold,
      liveWouldFire,
      shadowWouldFire,
      arbiterMessage,
      terminalMessage: null,
      events,
    };
  }

  // enforce — hard-stop is a real terminal when live threshold fires.
  if (liveWouldFire) {
    events.push({
      at_turn: at,
      kind: 'zero_write_hard_stop',
      detail: `turns=${input.completedTurns}`,
    });
    return {
      mode,
      liveThreshold,
      shadowThreshold,
      liveWouldFire,
      shadowWouldFire,
      arbiterMessage: null,
      terminalMessage: buildZeroWriteHardStopMessage(input.completedTurns, liveThreshold),
      events,
    };
  }

  return {
    mode,
    liveThreshold,
    shadowThreshold,
    liveWouldFire,
    shadowWouldFire,
    arbiterMessage: null,
    terminalMessage: null,
    events,
  };
}

/**
 * Shadow events for soft fuses that historically restricted tools or
 * demanded BLOCKED (exploration exhausted). Soft nudge messages still fire
 * from applyExploreFuses; these events record would-have terminal/restrict.
 *
 * Emits under mode=shadow even when the task class has hardRestrict enabled
 * (live restrict only applies under mode=enforce).
 */
export function buildExploreFuseShadowEvents(input: {
  atTurn: number;
  taskClass: ChatTaskClass;
  forceMutateFired: boolean;
  readThrashFired: boolean;
  explorationExhausted: boolean;
  hardRestrictEnabled: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Session kinds already logged once (P0-E one-shot, same as zero_write_shadow).
   * When set, skips re-emitting force_mutate_shadow / read_thrash_shadow / exploration_shadow.
   */
  alreadyLoggedKinds?: ReadonlySet<string>;
}): PolicyEvent[] {
  const env = input.env ?? process.env;
  const events: PolicyEvent[] = [];
  const already = input.alreadyLoggedKinds;
  // Live restrict only when hardRestrict && mode=enforce (caller enforces that).
  // Under shadow, live_restrict is always 0 even if the class prefers hardRestrict.
  const liveRestrictNote = 'live_restrict=0';

  if (input.forceMutateFired) {
    const mode = resolvePolicyMode('force_mutate', input.taskClass, env);
    if (mode === 'shadow' && !already?.has('force_mutate_shadow')) {
      events.push({
        at_turn: input.atTurn,
        kind: 'force_mutate_shadow',
        detail: `would_restrict_tools=mutate_only ${liveRestrictNote}`,
      });
    }
  }
  if (input.readThrashFired) {
    const mode = resolvePolicyMode('read_thrash', input.taskClass, env);
    if (mode === 'shadow' && !already?.has('read_thrash_shadow')) {
      events.push({
        at_turn: input.atTurn,
        kind: 'read_thrash_shadow',
        detail: `would_restrict_tools=mutate_only ${liveRestrictNote}`,
      });
    }
  }
  if (input.explorationExhausted) {
    const mode = resolvePolicyMode('exploration_fuse', input.taskClass, env);
    if (mode === 'shadow' && !already?.has('exploration_shadow')) {
      events.push({
        at_turn: input.atTurn,
        kind: 'exploration_shadow',
        detail: `would_exhaust_and_restrict ${liveRestrictNote}`,
      });
    }
    // mode=off: caller skips exploration fuse entirely in applyExploreFuses.
  }
  return events;
}

export interface PolicyShadowSummaryInput {
  atTurn: number;
  hasSuccessfulMutation: boolean;
  /** True when coding-task gate would pass (patch + optional verifier). */
  codingTaskPassed: boolean;
  /** Terminal outcome string for the detail line. */
  terminalOutcome: string;
}

/**
 * Append a session-end summary linking shadow interventions to later success.
 * No-op when no shadow intervention events were recorded.
 *
 * `later_succeeded` is coding-task gate pass only (not mere mutation).
 * `later_progressed` records any successful mutation for thrash analysis.
 */
export function recordPolicyShadowSessionOutcome(
  log: PolicyEventLog,
  input: PolicyShadowSummaryInput,
): PolicyEvent | null {
  // Idempotent: streamDone + buildResult may both finalize the same turn.
  if (log.all().some((e) => e.kind === 'policy_shadow_summary')) {
    return null;
  }
  const shadows = log.all().filter((e) => SHADOW_INTERVENTION_KINDS.has(e.kind));
  if (shadows.length === 0) return null;

  const laterSucceeded = input.codingTaskPassed;
  const laterProgressed = input.hasSuccessfulMutation;
  const event: PolicyEvent = {
    at_turn: input.atTurn,
    kind: 'policy_shadow_summary',
    detail:
      `shadow_count=${shadows.length} later_succeeded=${laterSucceeded ? 1 : 0} ` +
      `later_progressed=${laterProgressed ? 1 : 0} ` +
      `mutation=${input.hasSuccessfulMutation ? 1 : 0} ` +
      `coding_pass=${input.codingTaskPassed ? 1 : 0} ` +
      `outcome=${input.terminalOutcome}`,
  };
  log.record(event);
  return event;
}

/** Precision/recall-style rollup for offline scorecards and tests. */
export function measureShadowInterventionOutcomes(events: readonly PolicyEvent[]): {
  shadow_interventions: number;
  sessions_with_summary: number;
  later_succeeded: number;
  later_failed: number;
  later_progressed: number;
  by_kind: Partial<Record<PolicyEventKind, number>>;
} {
  const by_kind: Partial<Record<PolicyEventKind, number>> = {};
  let shadow_interventions = 0;
  let sessions_with_summary = 0;
  let later_succeeded = 0;
  let later_failed = 0;
  let later_progressed = 0;

  for (const e of events) {
    by_kind[e.kind] = (by_kind[e.kind] ?? 0) + 1;
    if (SHADOW_INTERVENTION_KINDS.has(e.kind)) {
      shadow_interventions += 1;
    }
    if (e.kind === 'policy_shadow_summary') {
      sessions_with_summary += 1;
      if (/\blater_succeeded=1\b/.test(e.detail ?? '')) {
        later_succeeded += 1;
      } else {
        later_failed += 1;
      }
      if (/\blater_progressed=1\b/.test(e.detail ?? '')) {
        later_progressed += 1;
      }
    }
  }

  return {
    shadow_interventions,
    sessions_with_summary,
    later_succeeded,
    later_failed,
    later_progressed,
    by_kind,
  };
}

/**
 * Compatibility: task-class stallShadowMode tune OR ablation mode.
 * Prefer resolveStallShadowMode for new call sites.
 */
export function effectiveStallShadowMode(
  taskClass: ChatTaskClass,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveStallShadowMode(taskClass, env);
}
