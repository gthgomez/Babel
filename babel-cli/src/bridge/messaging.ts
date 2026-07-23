/**
 * Message routing for the Babel IDE Bridge.
 *
 * BridgeMessageRouter connects transports to session runners and
 * queue/dispatch/route messages between remote clients and session
 * execution environments.
 *
 * Phase 1 — Session Server + Transport. Core routing infrastructure
 * with message queuing for disconnected transports.
 */

import type { BridgeMessage, BridgeTransport } from './types.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Max number of queued messages per session when transport is disconnected. */
const MAX_QUEUED_MESSAGES = 500;

/** Default heartbeat interval in milliseconds. */
const HEARTBEAT_INTERVAL_MS = 30_000;

// ─── MessageQueue ──────────────────────────────────────────────────────────────

/**
 * FIFO message queue with bounded capacity.
 * When full, the oldest message is dropped.
 */
class MessageQueue {
  private messages: BridgeMessage[] = [];
  private readonly capacity: number;

  constructor(capacity: number = MAX_QUEUED_MESSAGES) {
    this.capacity = capacity;
  }

  /** Enqueue a message. Drops oldest if at capacity. */
  enqueue(msg: BridgeMessage): void {
    if (this.messages.length >= this.capacity) {
      this.messages.shift();
    }
    this.messages.push(msg);
  }

  /** Dequeue all messages. Returns empty array if none queued. */
  drain(): BridgeMessage[] {
    const all = this.messages;
    this.messages = [];
    return all;
  }

  /** Number of queued messages. */
  get length(): number {
    return this.messages.length;
  }

  /** Whether the queue has messages. */
  get hasMessages(): boolean {
    return this.messages.length > 0;
  }
}

// ─── BridgeMessageRouter ───────────────────────────────────────────────────────

/**
 * Routes BridgeMessages between remote clients and session runners.
 *
 * Manages the ingress/egress message flow:
 *   - Ingress:  remote client → session runner (prompts, permission responses)
 *   - Egress:   session runner → remote client (responses, tool calls,
 *               permission requests)
 *   - Queue:    messages are queued when transport is disconnected and
 *               delivered on reconnect
 *
 * Keeps routing state per session ID. Supports one client transport and
 * one session transport per router instance.
 */
export class BridgeMessageRouter {
  private clientTransport: BridgeTransport | null = null;
  private sessionTransport: BridgeTransport | null = null;
  private readonly sessionId: string;
  private queue = new MessageQueue();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Handler for client messages that trigger session actions. */
  private onIngressHandler: ((msg: BridgeMessage) => void) | null = null;

  /** Handler for session messages that should be forwarded to client. */
  private onEgressHandler: ((msg: BridgeMessage) => void) | null = null;

  private clientUnsubscribe: (() => void) | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private _closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  // ── Transport binding ──────────────────────────────────────────────────────

  /**
   * Attach a client transport (remote IDE, external tool).
   *
   * If a previous client transport was attached, it is detached first.
   * Any queued messages are immediately delivered to the new transport.
   */
  attachClient(transport: BridgeTransport): void {
    this.detachClient();

    this.clientTransport = transport;
    this.clientUnsubscribe = transport.onMessage((msg) => {
      this.onIngressHandler?.(msg);
    });

    // Deliver queued messages to the newly connected client
    this.flushQueue();

    // Start heartbeat if not already running
    this.ensureHeartbeat();
  }

  /**
   * Attach a session transport (local session runner).
   */
  attachSession(transport: BridgeTransport): void {
    this.detachSession();

    this.sessionTransport = transport;
    this.sessionUnsubscribe = transport.onMessage((msg) => {
      this.onEgressHandler?.(msg);
    });
  }

  /**
   * Detach the current client transport. Queues messages for later delivery.
   */
  detachClient(): void {
    if (this.clientUnsubscribe) {
      this.clientUnsubscribe();
      this.clientUnsubscribe = null;
    }
    this.clientTransport = null;
  }

  /**
   * Detach the current session transport.
   */
  detachSession(): void {
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    this.sessionTransport = null;
  }

  // ── Ingress / Egress handlers ─────────────────────────────────────────────

  /**
   * Register a handler for ingress messages (client → session).
   * These are prompts, permission responses, and tool results from
   * the remote client that should be forwarded to the session runner.
   */
  onIngress(handler: (msg: BridgeMessage) => void): void {
    this.onIngressHandler = handler;
  }

  /**
   * Register a handler for egress messages (session → client).
   * These are responses, tool calls, and permission requests from
   * the session runner that should be forwarded to the remote client.
   */
  onEgress(handler: (msg: BridgeMessage) => void): void {
    this.onEgressHandler = handler;
  }

  // ── Send / Forward ────────────────────────────────────────────────────────

  /**
   * Send a message to the client transport.
   * If the client is disconnected, the message is queued.
   */
  sendToClient(msg: BridgeMessage): void {
    if (this.clientTransport && !this.isClientClosed()) {
      this.clientTransport.send(msg);
    } else {
      this.queue.enqueue(msg);
    }
  }

  /**
   * Send a message to the session transport.
   */
  sendToSession(msg: BridgeMessage): void {
    this.sessionTransport?.send(msg);
  }

  // ── Queue management ──────────────────────────────────────────────────────

  /**
   * Deliver all queued messages to the client transport.
   */
  flushQueue(): void {
    if (!this.clientTransport || this.isClientClosed()) return;
    const messages = this.queue.drain();
    for (const msg of messages) {
      this.clientTransport.send(msg);
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  /**
   * Start the heartbeat timer if transports are attached and
   * the timer is not already running.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    if (!this.clientTransport && !this.sessionTransport) return;

    this.heartbeatTimer = setInterval(() => {
      const hb: BridgeMessage = {
        type: 'heartbeat',
        sessionId: this.sessionId,
      };
      if (this.clientTransport && !this.isClientClosed()) {
        this.clientTransport.send(hb);
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Allow the process to exit even if the timer is still active
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      (this.heartbeatTimer as NodeJS.Timeout).unref();
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /**
   * Close the router. Detaches all transports and stops the heartbeat.
   */
  close(): void {
    if (this._closed) return;
    this._closed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.detachClient();
    this.detachSession();
    this.onIngressHandler = null;
    this.onEgressHandler = null;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** The session ID this router manages. */
  get id(): string {
    return this.sessionId;
  }

  /**
   * Whether the connected client transport has pending messages to deliver.
   */
  get hasQueuedMessages(): boolean {
    return this.queue.hasMessages;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private isClientClosed(): boolean {
    if (!this.clientTransport) return true;
    // Duck-type check for closed property
    return 'closed' in this.clientTransport &&
      typeof (this.clientTransport as Record<string, unknown>).closed === 'boolean' &&
      (this.clientTransport as Record<string, unknown>).closed === true;
  }
}
