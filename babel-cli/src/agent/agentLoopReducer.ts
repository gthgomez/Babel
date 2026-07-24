/**
 * Unified agent-loop reducer/state machine.
 *
 * One pure reducer owns loop semantics for streamed, non-streamed, headless,
 * and benchmark surfaces. Presentation is a subscriber; it never owns agent
 * semantics. Terminal tool / circuit-breaker results stop the loop immediately.
 */

import type { TerminalOutcome } from '../schemas/agentContracts.js';

// ─── Loop phases (plan §P1-A) ───────────────────────────────────────────────

export type AgentLoopPhase =
  | 'orient'
  | 'investigate'
  | 'mutate'
  | 'verify'
  | 'recover'
  | 'synthesize'
  | 'terminal';

export type AgentLoopEvent =
  | { type: 'user_turn'; task: string }
  | { type: 'provider_delta'; text: string }
  | { type: 'tool_calls'; tools: AgentLoopToolCall[]; terminal?: boolean }
  | { type: 'tool_results'; results: AgentLoopToolResult[]; terminal?: boolean }
  | { type: 'policy_decision'; intervention: string }
  | { type: 'approval'; decision: 'allow' | 'deny' | 'ask' }
  | { type: 'budget'; exhausted: boolean; reason?: string }
  | { type: 'cancel' }
  | { type: 'circuit_breaker'; reason: string }
  | { type: 'complete'; verified: boolean }
  | { type: 'blocked'; kind: 'policy' | 'external'; reason: string }
  | { type: 'infra_failure'; reason: string }
  | { type: 'agent_failure'; reason: string }
  | { type: 'progress'; hasDelta: boolean; phaseHint?: AgentLoopPhase };

export interface AgentLoopToolCall {
  id: string;
  name: string;
  /** True when the tool mutates the workspace. */
  mutating: boolean;
  /** True when the tool is terminal (finish / ask_approval). */
  terminal?: boolean;
}

export interface AgentLoopToolResult {
  id: string;
  name: string;
  exitCode: number;
  /** Circuit-breaker or other terminal stop signal from the tool layer. */
  terminal?: boolean;
}

export interface AgentLoopState {
  phase: AgentLoopPhase;
  task: string;
  cycle: number;
  /** At most one policy intervention presented per cycle. */
  policyInterventionThisCycle: string | null;
  lastToolNames: string[];
  cancelled: boolean;
  terminal: boolean;
  outcome: TerminalOutcome | null;
  reason: string | null;
  /** Consecutive cycles with no progress (fed by ProgressReceipt). */
  noProgressStreak: number;
}

export type AgentLoopEffect =
  | { type: 'emit_phase'; phase: AgentLoopPhase }
  | { type: 'stop'; outcome: TerminalOutcome; reason: string }
  | { type: 'present_policy'; intervention: string }
  | { type: 'request_tools' }
  | { type: 'run_tools'; tools: AgentLoopToolCall[] }
  | { type: 'synthesize' };

export interface ReduceResult {
  state: AgentLoopState;
  effects: AgentLoopEffect[];
}

export function initialAgentLoopState(task = ''): AgentLoopState {
  return {
    phase: 'orient',
    task,
    cycle: 0,
    policyInterventionThisCycle: null,
    lastToolNames: [],
    cancelled: false,
    terminal: false,
    outcome: null,
    reason: null,
    noProgressStreak: 0,
  };
}

function stop(
  state: AgentLoopState,
  outcome: TerminalOutcome,
  reason: string,
): ReduceResult {
  return {
    state: {
      ...state,
      phase: 'terminal',
      terminal: true,
      outcome,
      reason,
    },
    effects: [{ type: 'stop', outcome, reason }],
  };
}

/**
 * Pure reducer: apply one event, return next state + effects.
 * Idempotent for already-terminal states (ignores further events).
 */
export function reduceAgentLoop(
  state: AgentLoopState,
  event: AgentLoopEvent,
): ReduceResult {
  if (state.terminal && event.type !== 'user_turn') {
    return { state, effects: [] };
  }

  switch (event.type) {
    case 'user_turn':
      return {
        state: {
          ...initialAgentLoopState(event.task),
          phase: 'orient',
          task: event.task,
        },
        effects: [
          { type: 'emit_phase', phase: 'orient' },
          { type: 'request_tools' },
        ],
      };

    case 'cancel':
      return stop({ ...state, cancelled: true }, 'CANCELLED', 'User cancelled');

    case 'budget':
      if (event.exhausted) {
        return stop(
          state,
          'BUDGET_EXHAUSTED',
          event.reason ?? 'Budget exhausted',
        );
      }
      return { state, effects: [] };

    case 'circuit_breaker':
      return stop(state, 'BLOCKED_POLICY', event.reason);

    case 'blocked':
      return stop(
        state,
        event.kind === 'policy' ? 'BLOCKED_POLICY' : 'BLOCKED_EXTERNAL',
        event.reason,
      );

    case 'infra_failure':
      return stop(state, 'INFRA_FAILURE', event.reason);

    case 'agent_failure':
      return stop(state, 'AGENT_FAILURE', event.reason);

    case 'complete':
      return stop(
        state,
        event.verified ? 'VERIFIED_COMPLETE' : 'UNVERIFIED_PATCH',
        event.verified ? 'Verifier passed' : 'Completed without verifier',
      );

    case 'policy_decision': {
      // At most one policy intervention per cycle.
      if (state.policyInterventionThisCycle !== null) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          policyInterventionThisCycle: event.intervention,
        },
        effects: [{ type: 'present_policy', intervention: event.intervention }],
      };
    }

    case 'tool_calls': {
      if (event.terminal || event.tools.some((t) => t.terminal)) {
        // Terminal tool requested — move toward synthesize/verify; do not stop yet
        // unless the batch is pure finish with no work left.
        const onlyFinish =
          event.tools.length > 0 &&
          event.tools.every((t) => t.name === 'finish' || t.terminal);
        if (onlyFinish) {
          return {
            state: {
              ...state,
              phase: 'synthesize',
              cycle: state.cycle + 1,
              policyInterventionThisCycle: null,
              lastToolNames: event.tools.map((t) => t.name),
            },
            effects: [
              { type: 'emit_phase', phase: 'synthesize' },
              { type: 'run_tools', tools: event.tools },
              { type: 'synthesize' },
            ],
          };
        }
      }
      const hasMutate = event.tools.some((t) => t.mutating);
      const phase: AgentLoopPhase = hasMutate ? 'mutate' : 'investigate';
      return {
        state: {
          ...state,
          phase,
          cycle: state.cycle + 1,
          policyInterventionThisCycle: null,
          lastToolNames: event.tools.map((t) => t.name),
        },
        effects: [
          { type: 'emit_phase', phase },
          { type: 'run_tools', tools: event.tools },
        ],
      };
    }

    case 'tool_results': {
      // Honor terminal tool/circuit-breaker results immediately.
      const terminalResult = event.results.find((r) => r.terminal);
      if (event.terminal || terminalResult) {
        return stop(
          state,
          'BLOCKED_POLICY',
          terminalResult
            ? `Terminal tool result: ${terminalResult.name}`
            : 'Terminal tool batch',
        );
      }
      const hasVerify = event.results.some(
        (r) =>
          r.name === 'run_command' ||
          r.name === 'test_run' ||
          r.name === 'shell_exec',
      );
      const phase: AgentLoopPhase = hasVerify ? 'verify' : state.phase;
      return {
        state: { ...state, phase },
        effects: [{ type: 'emit_phase', phase }, { type: 'request_tools' }],
      };
    }

    case 'progress': {
      const noProgressStreak = event.hasDelta ? 0 : state.noProgressStreak + 1;
      const phase = event.phaseHint ?? state.phase;
      // Recovery when stuck without terminal yet.
      if (!event.hasDelta && noProgressStreak >= 2 && state.phase !== 'recover') {
        return {
          state: { ...state, noProgressStreak, phase: 'recover' },
          effects: [{ type: 'emit_phase', phase: 'recover' }],
        };
      }
      return {
        state: { ...state, noProgressStreak, phase },
        effects: event.phaseHint
          ? [{ type: 'emit_phase', phase: event.phaseHint }]
          : [],
      };
    }

    case 'provider_delta':
    case 'approval':
      return { state, effects: [] };

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return { state, effects: [] };
    }
  }
}

/**
 * Run a sequence of events through the reducer (fixture parity helper).
 * Used by stream vs non-stream golden fixtures — both surfaces must feed the
 * same event sequence and observe identical state/outcome.
 */
export function foldAgentLoop(
  events: AgentLoopEvent[],
  initialTask = '',
): AgentLoopState {
  let state = initialAgentLoopState(initialTask);
  for (const event of events) {
    state = reduceAgentLoop(state, event).state;
  }
  return state;
}

// ─── Tool batch ordering (P1-A acceptance: preserve write→read) ─────────────

export interface OrderedToolAction {
  index: number;
  name: string;
  mutating: boolean;
  readOnly: boolean;
}

export type ToolBatchPlan =
  | { kind: 'parallel_reads'; indices: number[] }
  | { kind: 'sequential'; index: number };

/**
 * Partition tools into execution batches that preserve original order.
 * Only independent consecutive read-only tools may run in parallel.
 * A write never moves before an earlier tool, and a later read never
 * jumps ahead of a preceding write.
 */
export function planToolBatches(actions: OrderedToolAction[]): ToolBatchPlan[] {
  const sorted = [...actions].sort((a, b) => a.index - b.index);
  const plan: ToolBatchPlan[] = [];
  let i = 0;
  while (i < sorted.length) {
    const cur = sorted[i]!;
    if (cur.readOnly && !cur.mutating) {
      const indices: number[] = [cur.index];
      let j = i + 1;
      while (j < sorted.length && sorted[j]!.readOnly && !sorted[j]!.mutating) {
        indices.push(sorted[j]!.index);
        j += 1;
      }
      plan.push({ kind: 'parallel_reads', indices });
      i = j;
    } else {
      plan.push({ kind: 'sequential', index: cur.index });
      i += 1;
    }
  }
  return plan;
}

/** Flatten batch plan back to execution order (reads within a batch keep relative order). */
export function flattenBatchPlan(plan: ToolBatchPlan[]): number[] {
  const out: number[] = [];
  for (const batch of plan) {
    if (batch.kind === 'parallel_reads') out.push(...batch.indices);
    else out.push(batch.index);
  }
  return out;
}

/** True when plan preserves original index order (no reordering across writes). */
export function preservesToolOrder(
  actions: OrderedToolAction[],
  plan: ToolBatchPlan[],
): boolean {
  const flat = flattenBatchPlan(plan);
  if (flat.length !== actions.length) return false;
  // Flattened order must equal sorted original indices — we only group consecutive reads.
  const expected = [...actions].map((a) => a.index).sort((a, b) => a - b);
  return flat.every((idx, i) => idx === expected[i]);
}

const DEFAULT_READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'grep',
  'glob',
  'finish',
  'web_search',
  'web_fetch',
  'git_context',
  'semantic_search',
  'mcp_tool_search',
  'lsp',
]);

/** Build ordered tool descriptors for planToolBatches from action type names. */
export function orderChatToolActions(
  actions: Array<{ type: string; mutation?: boolean }>,
  readOnlyTools: ReadonlySet<string> = DEFAULT_READ_ONLY_TOOLS,
): OrderedToolAction[] {
  return actions.map((action, index) => {
    const isReadSubAgent = action.type === 'sub_agent' && action.mutation !== true;
    const readOnly = readOnlyTools.has(action.type) || isReadSubAgent;
    return {
      index,
      name: action.type,
      mutating: !readOnly,
      readOnly,
    };
  });
}

/** True when observation indicates a circuit-breaker terminal stop. */
export function isCircuitBreakerObservation(observation: string): boolean {
  return /\bCIRCUIT_BREAKER\b/.test(observation);
}
