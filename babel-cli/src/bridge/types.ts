/**
 * Bridge types for Babel IDE Bridge / Remote Sessions.
 *
 * Defines session identity, message protocol, transport abstraction,
 * and configuration file schema for the bridge server.
 *
 * Phase 1 — Session Server + Transport. See ADR-GAP-003.
 */

// ─── Session identity ──────────────────────────────────────────────────────────

export interface BridgeSession {
  sessionId: string;
  projectRoot: string;
  createdAt: Date;
  lastActiveAt: Date;
  status: 'idle' | 'running' | 'crashed';
  transport: 'inproc' | 'ws' | 'sse';
}

// ─── Configuration (read from ~/.babel/bridge.json) ───────────────────────────

export interface BridgeConfigFile {
  /** HTTP listen port. Default 4545. */
  port?: number | undefined;
  /** HMAC-SHA256 auth token for bearer authentication. */
  authToken?: string | undefined;
  /** Allowed CORS origins. Defaults to ['http://localhost:*'] when empty. */
  allowedOrigins?: string[] | undefined;
}

// ─── Bridge messages (bidirectional) ───────────────────────────────────────────

/**
 * A sequence number attached to each bridge message for reorder detection.
 * Monotonically increasing per session. Optional for one-off messages.
 */
export type SequenceNumber = number;

/** Core message types exchanged between the bridge server and remote clients. */
export type BridgeMessage =
  | {
      type: 'prompt';
      text: string;
      sessionId: string;
      seq?: SequenceNumber;
    }
  | {
      type: 'response';
      chunk: string;
      sessionId: string;
      seq?: SequenceNumber;
    }
  | {
      type: 'permission_request';
      tool: string;
      reason: string;
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'permission_response';
      granted: boolean;
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'tool_call';
      tool: string;
      args: Record<string, unknown>;
      sessionId: string;
      callId: string;
      seq?: SequenceNumber;
    }
  | {
      type: 'tool_result';
      result: unknown;
      sessionId: string;
      callId: string;
      seq?: SequenceNumber;
    }
  | {
      type: 'done';
      sessionId: string;
      summary?: string;
    }
  | {
      type: 'error';
      message: string;
      sessionId: string;
    }
  | {
      type: 'heartbeat';
      sessionId: string;
    };

/**
 * Discriminated union helper — narrow a message by its `type` discriminant.
 */
export type BridgeMessageType = BridgeMessage['type'];

// ─── Transport abstraction ─────────────────────────────────────────────────────

/**
 * Pluggable transport layer for bridge message exchange.
 *
 * Implementations:
 *   - InProcessTransport — direct function calls (default, in-process).
 *   - WebSocketTransport — wraps a raw WebSocket connection for remote clients.
 *
 * Each transport instance carries an optional session ID scope so the message
 * router can correlate inbound messages to the correct session without
 * inspecting every payload.
 */
export interface BridgeTransport {
  /** The session ID this transport is associated with, if any. */
  readonly sessionId?: string | undefined;

  /**
   * Send a single bridge message through the transport.
   * Must not throw for transient failures; implementations should queue
   * and retry internally.
   */
  send(message: BridgeMessage): void;

  /**
   * Register a handler for inbound messages. Returns an unsubscribe function.
   *
   * Only ONE handler at a time is supported per transport. Calling onMessage
   * a second time replaces the previous handler.
   */
  onMessage(handler: (msg: BridgeMessage) => void): () => void;

  /**
   * Close the transport. After close(), send() should no-op or throw.
   * The onClose callback (if registered) fires after cleanup.
   */
  close(): void;

  /**
   * Register a close handler. Fires once when the transport closes.
   * The close handler takes an optional error code or reason string.
   */
  onClose?(handler: (reason?: string) => void): void;
}

// ─── Session registry ──────────────────────────────────────────────────────────

/**
 * Entry in the in-memory session registry, managed by sessionRunner.
 */
export interface SessionRegistryEntry {
  session: BridgeSession;
  /** Transport for communicating with the remote client (if any). */
  clientTransport?: BridgeTransport | undefined;
  /** Abort controller for cancelling the session. */
  abortController: AbortController;
  /** Timestamp of last activity for idle-detection. */
  lastActivityMs: number;
  /** Optional child process reference (session runner). */
  childPid?: number | undefined;
  /** Readline interface for NDJSON parsing — must be closed in removeSession. */
  readline?: import('node:readline').Interface;
  /** Reference to the spawned child process for lifecycle management. */
  childProcess?: import('node:child_process').ChildProcess;
}

// ─── Bridge server state ───────────────────────────────────────────────────────

export interface BridgeServerState {
  sessions: Map<string, SessionRegistryEntry>;
  startedAt: Date;
  config: BridgeConfigFile;
}
