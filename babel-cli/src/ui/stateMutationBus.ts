/**
 * StateMutationBus — typed event-driven state mutation for the Babel TUI.
 *
 * Tier 3: Event bus pattern for state mutation (decouple component state from
 * rendering). Replaces ad-hoc `this.field = value` mutations scattered across
 * event handlers with a centralized dispatch → reduce → subscribe pipeline.
 *
 * Why:
 *   - Renderers currently mutate 25-35 instance fields directly inside event
 *     handlers, the render() method, and FrameScheduler callbacks. There's no
 *     single place to audit state transitions.
 *   - Adding a new feature (e.g., a new keybinding) requires touching state
 *     mutation logic in multiple places.
 *   - Testing state transitions requires instantiating full renderers.
 *
 * Architecture:
 *   1. **Mutation types** — every state change is a typed mutation with a
 *      discriminant and payload (discriminated union).
 *   2. **Reducer** — a pure function (currentState, mutation) → newState.
 *   3. **Dispatch** — components call `dispatch(mutation)` instead of mutating
 *      fields directly.
 *   4. **Subscribe** — components subscribe to specific mutation types for
 *      cross-cutting concerns (logging, telemetry, a11y announcements).
 *   5. **Middleware** — optional validation/transformation before reduce.
 *
 * This is additive — existing code can migrate incrementally. The BabelEventBus
 * (simple EventEmitter) continues to work for pipeline → renderer events.
 *
 * Usage:
 *   import { createStateStore, type TuiMutation } from './stateMutationBus.js';
 *
 *   const store = createStateStore<TuiState>(initialState, tuiReducer);
 *   store.dispatch({ type: 'stage:transition', stage: 2 });
 *   store.subscribe('stage:transition', (m) => { ... });
 *
 * @module stateMutationBus
 */

// ── Core types ───────────────────────────────────────────────────────────────

/** Base mutation type — all mutations extend this. */
export interface Mutation {
  /** Discriminant for the reducer to switch on. */
  type: string;
  /** Timestamp for ordering/debugging (set by dispatch if not provided). */
  ts?: number;
}

/** A reducer is a pure function: (state, mutation) → new state. */
export type Reducer<S, M extends Mutation> = (state: S, mutation: M) => S;

/** Middleware: intercepts mutations before the reducer. Return null to cancel. */
export type Middleware<M extends Mutation> = (mutation: M) => M | null;

/** Subscription callback for a specific mutation type. */
export type MutationSubscriber<M extends Mutation> = (mutation: M) => void;

// ── State store ──────────────────────────────────────────────────────────────

/**
 * A lightweight typed state store with dispatch/reduce/subscribe.
 *
 * Generic over:
 *   - S: the state shape
 *   - M: the mutation union type (must extend Mutation)
 */
export class StateStore<S, M extends Mutation> {
  private state: S;
  private reducer: Reducer<S, M>;
  private middlewares: Middleware<M>[] = [];
  private subscribers = new Map<string, Set<MutationSubscriber<any>>>();
  private mutationLog: M[] = [];
  private logMaxSize: number;

  constructor(initialState: S, reducer: Reducer<S, M>, options?: { maxLogSize?: number }) {
    this.state = initialState;
    this.reducer = reducer;
    this.logMaxSize = options?.maxLogSize ?? 500;
  }

  /** Current state (read-only — mutate via dispatch). */
  get currentState(): Readonly<S> {
    return this.state;
  }

  /**
   * Dispatch a mutation through the pipeline:
   *   1. Set timestamp if not provided
   *   2. Run through middleware chain (any middleware returning null cancels)
   *   3. Apply reducer to produce new state
   *   4. Notify subscribers
   *   5. Append to mutation log
   *
   * Returns true if the mutation was applied (state changed), false if cancelled or unchanged.
   */
  dispatch<K extends M['type']>(mutation: Extract<M, { type: K }>): boolean {
    // Set timestamp if not provided
    const stamped: M = mutation.ts !== undefined ? mutation : { ...mutation, ts: Date.now() };

    // Run middleware chain
    let processed: M | null = stamped;
    for (const mw of this.middlewares) {
      if (!processed) break;
      processed = mw(processed);
    }
    if (!processed) return false; // cancelled by middleware

    // Apply reducer
    const prevState = this.state;
    this.state = this.reducer(this.state, processed);
    const changed = this.state !== prevState;

    // Only notify if state actually changed
    if (changed) {
      // Notify type-specific subscribers
      const subs = this.subscribers.get(processed.type);
      if (subs) {
        for (const sub of [...subs]) {
          // snapshot to avoid mutation-during-iteration
          try {
            sub(processed);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[babel:tui] subscriber error in "${processed.type}": ${message}\n`,
            );
          }
        }
      }

      // Notify wildcard subscribers ('*' matches all mutation types)
      const wildcard = this.subscribers.get('*');
      if (wildcard) {
        for (const sub of [...wildcard]) {
          // snapshot to avoid mutation-during-iteration
          try {
            sub(processed);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[babel:tui] subscriber error in "*": ${message}\n`);
          }
        }
      }

      // Append to log (only effective mutations)
      this.mutationLog.push(processed);
      if (this.mutationLog.length > this.logMaxSize) {
        this.mutationLog.shift();
      }
    }

    return changed;
  }

  /**
   * Subscribe to mutations of a specific type.
   * Use '*' to subscribe to all mutation types.
   * Returns an unsubscribe function.
   */
  subscribe<K extends M['type']>(
    type: K,
    callback: MutationSubscriber<Extract<M, { type: K }>>,
  ): () => void {
    if (!this.subscribers.has(type)) {
      this.subscribers.set(type, new Set());
    }
    const subs = this.subscribers.get(type)!;
    subs.add(callback);

    return () => {
      subs.delete(callback);
      if (subs.size === 0) this.subscribers.delete(type);
    };
  }

  /** Add middleware to the dispatch pipeline. */
  use(middleware: Middleware<M>): () => void {
    this.middlewares.push(middleware);
    return () => {
      const idx = this.middlewares.indexOf(middleware);
      if (idx >= 0) this.middlewares.splice(idx, 1);
    };
  }

  /** Get the mutation log (for debugging/testing). */
  getMutationLog(): readonly M[] {
    return this.mutationLog;
  }

  /** Clear the mutation log. */
  clearLog(): void {
    this.mutationLog = [];
  }

  /** Replace state by dispatching through the standard pipeline. */
  setState(state: S): void {
    this.dispatch({ type: '@internal:reset', state } as any);
  }
}

// ── Convenience factory ─────────────────────────────────────────────────────

/**
 * Create a StateStore with the given initial state and reducer.
 * Thin wrapper around `new StateStore(...)` for ergonomics.
 */
export function createStateStore<S, M extends Mutation>(
  initialState: S,
  reducer: Reducer<S, M>,
  options?: { maxLogSize?: number },
): StateStore<S, M> {
  return new StateStore<S, M>(initialState, reducer, options);
}

/**
 * Create a StateStore pre-configured with TuiState defaults and the TUI reducer.
 * This is the canonical way to create a TUI state store — use this instead of
 * manually composing createStateStore + createInitialTuiState + tuiStateReducer.
 */
export function createTuiStore(options?: {
  maxLogSize?: number;
}): StateStore<TuiState, TuiMutation> {
  return new StateStore(createInitialTuiState(), tuiStateReducer, options);
}

// ── TUI-specific mutation types ──────────────────────────────────────────────
// These are the canonical mutation types for the ConversationalRenderer and
// WaterfallRenderer. Components dispatch these instead of mutating fields.

/** Stage transition (governed pipeline). */
export interface StageTransitionMutation extends Mutation {
  type: 'stage:transition';
  stage: number;
}

/** Activity log line received. */
export interface ActivityLogMutation extends Mutation {
  type: 'activity:log';
  line: string;
  filePath?: string;
}

/** Tool call started. */
export interface ToolCallStartMutation extends Mutation {
  type: 'tool:start';
  toolId: number;
  tool: string;
  target: string;
}

/** Tool call completed. */
export interface ToolCallCompleteMutation extends Mutation {
  type: 'tool:complete';
  toolId: number;
  detail?: string;
}

/** Thought/reasoning text chunk received. */
export interface ThoughtChunkMutation extends Mutation {
  type: 'thought:chunk';
  text: string;
}

/** Answer text chunk received. */
export interface AnswerChunkMutation extends Mutation {
  type: 'answer:chunk';
  text: string;
}

/** Renderer state transition (thinking → streaming → done → failed). */
export interface StateTransitionMutation extends Mutation {
  type: 'state:transition';
  to: 'idle' | 'thinking' | 'streaming' | 'done' | 'failed';
}

/** Pause/resume toggle. */
export interface PauseToggleMutation extends Mutation {
  type: 'pause:toggle';
  paused: boolean;
}

/** Thought collapse/expand toggle. */
export interface ThoughtToggleMutation extends Mutation {
  type: 'thought:toggle';
  collapsed: boolean;
}

/** File change notification. */
export interface FileChangedMutation extends Mutation {
  type: 'file:changed';
  filePath: string;
  additions: number;
  deletions: number;
}

/** Cost estimate update. */
export interface CostUpdateMutation extends Mutation {
  type: 'cost:update';
  costUSD: number;
  perRunCost?: number;
}

/** Plan step count (for progress bar). */
export interface PlanStepCountMutation extends Mutation {
  type: 'planStep:count';
  planStepCount: number;
}

/** Agent ID. */
export interface AgentIdMutation extends Mutation {
  type: 'agent:id';
  id: string;
}

/** Increment completed tool calls counter (no pending-tool tracking). */
export interface ToolIncrementMutation extends Mutation {
  type: 'tools:increment';
  count?: number;
}

/** Update activeAction without adding a log entry (for waiting-state ellipsis). */
export interface ActiveActionUpdateMutation extends Mutation {
  type: 'action:update';
  action: string;
}

/** Error / failure. */
export interface ErrorMutation extends Mutation {
  type: 'error';
  message: string;
  stage?: number;
}

/** State reset (via setState). */
export interface ResetStateMutation extends Mutation {
  type: '@internal:reset';
  state: TuiState;
}

/** Union of all TUI mutation types. */
export type TuiMutation =
  | StageTransitionMutation
  | ActivityLogMutation
  | ToolCallStartMutation
  | ToolCallCompleteMutation
  | ThoughtChunkMutation
  | AnswerChunkMutation
  | StateTransitionMutation
  | PauseToggleMutation
  | ThoughtToggleMutation
  | FileChangedMutation
  | CostUpdateMutation
  | PlanStepCountMutation
  | AgentIdMutation
  | ToolIncrementMutation
  | ActiveActionUpdateMutation
  | ErrorMutation
  | ResetStateMutation;

// ── TUI state shape ──────────────────────────────────────────────────────────

/** Complete TUI session state (used by both ConversationalRenderer and WaterfallRenderer). */
export interface TuiState {
  /** Current renderer state machine. */
  renderState: 'idle' | 'thinking' | 'streaming' | 'done' | 'failed';
  /** Pipeline stage (1-4 for governed, 0 for chat). */
  stage: number;
  /** Accumulated thought/reasoning text. */
  thoughtText: string;
  /** Whether thought panel is collapsed. */
  thoughtCollapsed: boolean;
  /** Whether renderer is paused. */
  paused: boolean;
  /** Active activity description. */
  activeAction: string;
  /** Recent activity log lines (max 10). */
  activityLog: string[];
  /** Recently touched files (max 6). */
  activeFiles: string[];
  /** Plan step count (for progress bar). */
  planStepCount: number;
  /** Agent ID (governed mode). */
  agentId: string;
  /** Pending tool calls (toolId → {tool, target}). */
  pendingToolCalls: Map<number, { tool: string; target: string }>;
  /** Total tool calls completed. */
  completedToolCalls: number;
  /** Cached cost string (updated every 30s). */
  cachedCostStr: string;
  /** Error message if in failed state. */
  errorMessage: string;
  /** Failed stage if in failed state. */
  failedStage: number;
  /** Timestamp of last activity. */
  lastActivityTime: number;
}

/** Default initial TUI state. */
export function createInitialTuiState(): TuiState {
  return {
    renderState: 'idle',
    stage: 0,
    thoughtText: '',
    thoughtCollapsed: false,
    paused: false,
    activeAction: '',
    activityLog: [],
    activeFiles: [],
    planStepCount: 0,
    agentId: '',
    pendingToolCalls: new Map(),
    completedToolCalls: 0,
    cachedCostStr: '0.0000',
    errorMessage: '',
    failedStage: 0,
    lastActivityTime: 0,
  };
}

// ── TUI state reducer ───────────────────────────────────────────────────────

/**
 * Pure reducer for TuiState. Handles all TuiMutation types.
 * Returns a new state object (or the same state if no change).
 */
export function tuiStateReducer(state: TuiState, mutation: TuiMutation): TuiState {
  switch (mutation.type) {
    case 'stage:transition': {
      if (state.stage === mutation.stage) return state;
      return { ...state, stage: mutation.stage, activeAction: stageLabel(mutation.stage) };
    }
    case 'activity:log': {
      const log = [...state.activityLog, mutation.line];
      if (log.length > 10) log.shift();
      const files = mutation.filePath
        ? [mutation.filePath, ...state.activeFiles.filter((f) => f !== mutation.filePath)].slice(
            0,
            6,
          )
        : [...state.activeFiles];
      return {
        ...state,
        activityLog: log,
        activeFiles: files,
        activeAction: mutation.line,
        lastActivityTime: mutation.ts ?? Date.now(),
      };
    }
    case 'tool:start': {
      const pending = new Map(state.pendingToolCalls);
      pending.set(mutation.toolId, { tool: mutation.tool, target: mutation.target });
      return { ...state, pendingToolCalls: pending, lastActivityTime: mutation.ts ?? Date.now() };
    }
    case 'tool:complete': {
      const pending = new Map(state.pendingToolCalls);
      const wasPending = pending.delete(mutation.toolId);
      return {
        ...state,
        pendingToolCalls: pending,
        completedToolCalls: wasPending ? state.completedToolCalls + 1 : state.completedToolCalls,
        lastActivityTime: mutation.ts ?? Date.now(),
      };
    }
    case 'thought:chunk': {
      return {
        ...state,
        thoughtText: state.thoughtText + mutation.text,
        lastActivityTime: mutation.ts ?? Date.now(),
      };
    }
    case 'answer:chunk': {
      return { ...state, lastActivityTime: mutation.ts ?? Date.now() };
    }
    case 'state:transition': {
      if (state.renderState === mutation.to) return state;
      return { ...state, renderState: mutation.to, lastActivityTime: mutation.ts ?? Date.now() };
    }
    case 'pause:toggle': {
      if (state.paused === mutation.paused) return state;
      return { ...state, paused: mutation.paused };
    }
    case 'thought:toggle': {
      if (state.thoughtCollapsed === mutation.collapsed) return state;
      return { ...state, thoughtCollapsed: mutation.collapsed };
    }
    case 'file:changed': {
      const files = [
        mutation.filePath,
        ...state.activeFiles.filter((f) => f !== mutation.filePath),
      ].slice(0, 6);
      return { ...state, activeFiles: files };
    }
    case 'cost:update': {
      const costStr = mutation.costUSD.toFixed(4);
      if (state.cachedCostStr === costStr) return state;
      return { ...state, cachedCostStr: costStr };
    }
    case 'planStep:count': {
      if (state.planStepCount === mutation.planStepCount) return state;
      return { ...state, planStepCount: mutation.planStepCount };
    }
    case 'agent:id': {
      if (state.agentId === mutation.id) return state;
      return { ...state, agentId: mutation.id };
    }
    case 'tools:increment': {
      const inc = mutation.count ?? 1;
      if (inc === 0) return state;
      return {
        ...state,
        completedToolCalls: state.completedToolCalls + inc,
        lastActivityTime: mutation.ts ?? Date.now(),
      };
    }
    case 'action:update': {
      if (state.activeAction === mutation.action) return state;
      return {
        ...state,
        activeAction: mutation.action,
        lastActivityTime: mutation.ts ?? Date.now(),
      };
    }
    case 'error': {
      return {
        ...state,
        renderState: 'failed',
        errorMessage: mutation.message,
        failedStage: mutation.stage ?? state.stage,
      };
    }
    case '@internal:reset':
      return (mutation as ResetStateMutation).state;
    default:
      return state;
  }
}

function stageLabel(index: number): string {
  switch (index) {
    case 1:
      return 'Analyzing request';
    case 2:
      return 'Planning';
    case 3:
      return 'Reviewing';
    case 4:
      return 'Applying changes';
    default:
      return 'Working';
  }
}
