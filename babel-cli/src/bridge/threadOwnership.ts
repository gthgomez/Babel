/**
 * Session ↔ thread ownership for WS ticket mint.
 * Caller-supplied pairings are not trusted; the registry is.
 */

export type ThreadOwnershipError =
  | 'unknown_thread'
  | 'inactive_thread'
  | 'owned_by_other'
  | 'unowned_thread'
  | 'session_missing';

export interface ThreadOwnershipRecord {
  sessionId: string;
  active: boolean;
}

export class ThreadOwnershipRegistry {
  private readonly owners = new Map<string, ThreadOwnershipRecord>();

  /** Bind owner at thread.create. Overwrite only if previously unowned or same owner. */
  bind(threadId: string, sessionId: string): void {
    const rec = this.owners.get(threadId);
    if (!rec || rec.sessionId === '' || rec.sessionId === sessionId) {
      this.owners.set(threadId, { sessionId, active: true });
    }
  }

  deactivate(threadId: string): void {
    const rec = this.owners.get(threadId);
    if (rec) rec.active = false;
  }

  ownerOf(threadId: string): ThreadOwnershipRecord | undefined {
    return this.owners.get(threadId);
  }

  /**
   * Fail-closed: mint only when the thread already belongs to the caller.
   * First-claim at mint time is not allowed.
   */
  authorizeMint(input: {
    threadId: string;
    sessionId: string;
    threadExists: boolean;
  }): { ok: true } | { ok: false; error: ThreadOwnershipError } {
    if (!input.threadExists) return { ok: false, error: 'unknown_thread' };
    const rec = this.owners.get(input.threadId);
    if (!rec) return { ok: false, error: 'unowned_thread' };
    if (!rec.active) return { ok: false, error: 'inactive_thread' };
    if (rec.sessionId === '') return { ok: false, error: 'unowned_thread' };
    if (rec.sessionId !== input.sessionId) return { ok: false, error: 'owned_by_other' };
    return { ok: true };
  }
}
