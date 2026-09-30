/**
 * Runtime coordinator contracts — the renderer-independent lifecycle facade.
 *
 * P03 extracts in-process turn orchestration behind a narrow boundary without
 * importing any renderer/UI module. The coordinator selects exactly one mode
 * adapter for a turn and reuses P02's `PreparedTurn`; it coordinates the
 * existing controllers and never becomes another completion, verifier, event or
 * policy authority.
 *
 * The contracts here deliberately depend only on executor/agent types, never on
 * `interactive/` or `ui/`. A UI adapter may attach through `RuntimeEventSink`,
 * but the runtime must not require it.
 */

import type { ChatEvent, TaskIntent } from '../agent/chatEngine.js';
import type { BabelMode, SessionDescriptor } from '../executor/contracts.js';
import type {
  ModeCapability,
  ModeControllerKind,
  PreparedTurn,
} from '../executor/modeAdapters.js';

/** Version of the shared runtime-coordinator contract. */
export const RUNTIME_COORDINATOR_VERSION = 'runtime-coordinator-v1' as const;

/** Environment switch that selects the pre-P03 direct adapter per surface. */
export const RUNTIME_COORDINATOR_ENV = 'BABEL_RUNTIME_COORDINATOR' as const;

/**
 * Structural controller subject the coordinator drives.
 *
 * A `ChatEngine` satisfies this; a future V9 pipeline handle can too. Keeping
 * the shape structural prevents the runtime contracts from importing an engine
 * implementation.
 */
export interface RuntimeControllerSubject {
  submitMessageStream(task: string, intent?: TaskIntent): AsyncIterable<ChatEvent>;
  cancel?(): void;
}

/** Renderer-independent event sink. UI adapters attach here; runtime does not. */
export type RuntimeEventSink = (event: ChatEvent) => void;

/** Injected services keep coordinator behaviour deterministic in tests. */
export interface RuntimeCoordinatorDependencies {
  /** Clock used for execution identity metadata. */
  now(): Date;
  /** Unique-id factory for execution tokens. */
  newId(): string;
  /** Optional subject resolver for surfaces that do not pass one directly. */
  resolveSubject?(turn: RuntimeTurnRequest): RuntimeControllerSubject | null;
}

/** One turn prepared for exactly one controller. */
export interface RuntimeTurnRequest {
  /** P02 preparation output. The runtime does not invent task semantics here. */
  prepared: PreparedTurn;
  /** Empty string means the surface has no durable thread identity yet. */
  threadId: string;
  /** Stable per-turn identity within the thread. */
  turnId: string;
  task: string;
  intent?: TaskIntent;
  /** Controller subject bound to this turn (engine or future V9 handle). */
  subject?: RuntimeControllerSubject;
}

/** Opaque handle proving one adapter owns one turn. */
export interface RuntimeExecution {
  readonly version: typeof RUNTIME_COORDINATOR_VERSION;
  readonly token: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly mode: BabelMode;
  readonly controller: ModeControllerKind;
  readonly generation: number;
  readonly startedAt: string;
}

/** The facade CLI and protocol surfaces share. */
export interface RuntimeCoordinator {
  readonly version: typeof RUNTIME_COORDINATOR_VERSION;
  /** Mode capability for the current surface (P02 semantics, unchanged). */
  capabilities(mode: BabelMode): ModeCapability;
  /** Build a `PreparedTurn` from a durable descriptor (P02 reuse). */
  prepare(descriptor: SessionDescriptor): PreparedTurn;
  /** Bind exactly one adapter to a turn. Throws on unsupported/owned turns. */
  beginTurn(request: RuntimeTurnRequest): RuntimeExecution;
  /** Single-use stream from the owning adapter. */
  submit(execution: RuntimeExecution): AsyncIterable<ChatEvent>;
  /**
   * Request cancellation. Cancellation is a request: it does not release
   * ownership — `settle` does, mirroring the P01 protocol contract.
   */
  cancel(execution: RuntimeExecution): Promise<void>;
  /**
   * Release ownership when an execution actually settles. Idempotent; a stale
   * finalizer cannot release a successor's ownership.
   */
  settle(execution: RuntimeExecution): boolean;
  /** Number of thread-owned executions currently active. */
  activeCount(): number;
}

/** Per-mode adapter. Distinct adapters preserve distinct controller semantics. */
export interface RuntimeModeAdapter {
  readonly mode: BabelMode;
  readonly controller: ModeControllerKind;
  readonly capability: ModeCapability;
  submit(request: RuntimeTurnRequest): AsyncIterable<ChatEvent>;
  cancel(request: RuntimeTurnRequest): Promise<void>;
}

/** Raised when a mode has no controller wired to this surface (e.g. Deep). */
export class RuntimeModeUnsupportedError extends Error {
  readonly mode: BabelMode;

  constructor(mode: BabelMode, reason?: string) {
    super(reason ?? `Mode ${mode} is not supported by the runtime coordinator`);
    this.name = 'RuntimeModeUnsupportedError';
    this.mode = mode;
  }
}

/** Raised when a thread already has an owning execution. */
export class RuntimeTurnOwnedError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Turn already owned for thread: ${threadId}`);
    this.name = 'RuntimeTurnOwnedError';
    this.threadId = threadId;
  }
}

/** Raised on an unknown, settled, or twice-submitted execution handle. */
export class RuntimeExecutionSettledError extends Error {
  readonly token: string;

  constructor(token: string, reason: string) {
    super(`Runtime execution ${token} cannot proceed: ${reason}`);
    this.name = 'RuntimeExecutionSettledError';
    this.token = token;
  }
}

/** Raised when an adapter needs a controller subject that was not supplied. */
export class RuntimeSubjectUnavailableError extends Error {
  readonly mode: BabelMode;

  constructor(mode: BabelMode) {
    super(`Runtime coordinator requires a controller subject for mode: ${mode}`);
    this.name = 'RuntimeSubjectUnavailableError';
    this.mode = mode;
  }
}
