/**
 * Session ↔ thread ownership for WS ticket mint.
 * Caller-supplied pairings are not trusted; the registry is.
 */

export type ThreadOwnershipError =
  | 'unknown_thread'
  | 'inactive_thread'
  | 'owned_by_other'
  | 'session_missing';

export interface ThreadOwnershipRecord {
  sessionId: string;
  active: boolean;
}

export class ThreadOwnershipRegistry {
  private readonly owners = new Map<string, ThreadOwnershipRecord>();

  registerExisting(threadId: string): void {
    if (!this.owners.has(threadId)) {
      this.owners.set(threadId, { sessionId: '', active: true });
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
   * Bind thread to session if unowned. Deny if owned by another session
   * or inactive. Empty sessionId on the record means unowned.
   */
  authorizeMint(input: {
    threadId: string;
    sessionId: string;
    threadExists: boolean;
  }): { ok: true } | { ok: false; error: ThreadOwnershipError } {
    if (!input.threadExists) return { ok: false, error: 'unknown_thread' };
    const rec = this.owners.get(input.threadId);
    if (!rec) {
      this.owners.set(input.threadId, { sessionId: input.sessionId, active: true });
      return { ok: true };
    }
    if (!rec.active) return { ok: false, error: 'inactive_thread' };
    if (rec.sessionId === '') {
      rec.sessionId = input.sessionId;
      return { ok: true };
    }
    if (rec.sessionId !== input.sessionId) return { ok: false, error: 'owned_by_other' };
    return { ok: true };
  }
}
