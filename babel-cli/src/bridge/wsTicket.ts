/**
 * Short-lived, single-use WebSocket tickets for Babel Remote V1.
 * Long-lived bearer tokens stay on authenticated HTTP and never enter a V1 WS URL.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const WS_TICKET_TTL_MS = 30_000;
export const WS_TICKET_BYTES = 32;

export interface MintedWsTicket {
  ticket: string;
  expires_at: string;
  session_id: string;
  thread_id: string;
  ttl_ms: number;
}

export interface ConsumedWsTicket {
  sessionId: string;
  threadId: string;
  mintedAt: number;
}

export type TicketConsumeError =
  | 'missing'
  | 'unknown'
  | 'expired'
  | 'replayed'
  | 'scope_mismatch';

interface StoredTicket {
  token: string;
  sessionId: string;
  threadId: string;
  mintedAt: number;
  expiresAt: number;
  consumed: boolean;
}

export class WsTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(private readonly ttlMs: number = WS_TICKET_TTL_MS) {}

  mint(input: {
    sessionId: string;
    threadId: string;
    now?: number;
  }): MintedWsTicket {
    const now = input.now ?? Date.now();
    const token = randomBytes(WS_TICKET_BYTES).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.tickets.set(token, {
      token,
      sessionId: input.sessionId,
      threadId: input.threadId,
      mintedAt: now,
      expiresAt,
      consumed: false,
    });
    this.gc(now);
    return {
      ticket: token,
      expires_at: new Date(expiresAt).toISOString(),
      session_id: input.sessionId,
      thread_id: input.threadId,
      ttl_ms: this.ttlMs,
    };
  }

  consume(input: {
    ticket: string | undefined;
    sessionId: string;
    threadId?: string;
    now?: number;
  }): { ok: true; value: ConsumedWsTicket } | { ok: false; error: TicketConsumeError } {
    if (!input.ticket) return { ok: false, error: 'missing' };
    const now = input.now ?? Date.now();
    const stored = this.tickets.get(input.ticket);
    if (!stored) return { ok: false, error: 'unknown' };
    if (stored.consumed) return { ok: false, error: 'replayed' };
    if (now > stored.expiresAt) {
      this.tickets.delete(input.ticket);
      return { ok: false, error: 'expired' };
    }
    if (stored.sessionId !== input.sessionId) {
      return { ok: false, error: 'scope_mismatch' };
    }
    if (input.threadId !== undefined && stored.threadId !== input.threadId) {
      return { ok: false, error: 'scope_mismatch' };
    }
    stored.consumed = true;
    return {
      ok: true,
      value: {
        sessionId: stored.sessionId,
        threadId: stored.threadId,
        mintedAt: stored.mintedAt,
      },
    };
  }

  /** Test/diagnostic only — never log the raw ticket. */
  size(): number {
    return this.tickets.size;
  }

  private gc(now: number): void {
    for (const [key, value] of this.tickets) {
      if (value.consumed || now > value.expiresAt) {
        this.tickets.delete(key);
      }
    }
  }
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  const max = Math.max(left.length, right.length);
  const paddedLeft = Buffer.alloc(max, 0);
  const paddedRight = Buffer.alloc(max, 0);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight);
}
