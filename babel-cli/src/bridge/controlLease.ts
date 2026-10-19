/**
 * Per-thread control lease with monotonic fencing epochs.
 * One holder may issue mutating remote RPCs while the lease is valid.
 * Committed epoch counters never decrease across release, expiry, or revocation.
 */

export const DEFAULT_CONTROL_LEASE_TTL_MS = 30_000;
export const DEFAULT_CONTROL_RENEW_INTERVAL_MS = 10_000;

export interface ControlLeaseRecord {
  threadId: string;
  holderClientId: string;
  epoch: number;
  expiresAtMs: number;
}

export type ControlLeaseError =
  | 'lease_required'
  | 'stale_epoch'
  | 'epoch_required'
  | 'held_by_other'
  | 'not_holder'
  | 'unknown_thread';

export class ControlLeaseRegistry {
  private readonly leases = new Map<string, ControlLeaseRecord>();
  /** Highest epoch ever committed for a thread (never decremented). */
  private readonly committedEpoch = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_CONTROL_LEASE_TTL_MS;
  }

  status(threadId: string): {
    held: boolean;
    holderClientId?: string;
    epoch?: number;
    expiresAtMs?: number;
    committed_epoch?: number;
  } {
    const rec = this.getValid(threadId);
    const committed = this.committedEpoch.get(threadId);
    if (!rec) {
      return committed !== undefined ? { held: false, committed_epoch: committed } : { held: false };
    }
    const out: {
      held: boolean;
      holderClientId?: string;
      epoch?: number;
      expiresAtMs?: number;
      committed_epoch?: number;
    } = {
      held: true,
      holderClientId: rec.holderClientId,
      epoch: rec.epoch,
      expiresAtMs: rec.expiresAtMs,
    };
    if (committed !== undefined) out.committed_epoch = committed;
    return out;
  }

  acquire(input: {
    threadId: string;
    clientId: string;
    force?: boolean;
    /** When true, a paired device may take a lease held by a desktop controller. */
    remotePriorityTakeover?: boolean;
  }): { ok: true; epoch: number; expiresAtMs: number } | { ok: false; error: ControlLeaseError } {
    const existing = this.getValid(input.threadId);
    if (existing && existing.holderClientId !== input.clientId) {
      if (!input.force) {
        const remoteTakeover =
          input.remotePriorityTakeover === true &&
          existing.holderClientId.startsWith('desktop:') &&
          input.clientId.startsWith('device:');
        if (!remoteTakeover) return { ok: false, error: 'held_by_other' };
      }
    }
    if (existing && existing.holderClientId === input.clientId && !input.force) {
      existing.expiresAtMs = Date.now() + this.ttlMs;
      this.leases.set(input.threadId, existing);
      return { ok: true, epoch: existing.epoch, expiresAtMs: existing.expiresAtMs };
    }
    const epoch = this.bumpCommittedEpoch(input.threadId);
    const expiresAtMs = Date.now() + this.ttlMs;
    this.leases.set(input.threadId, {
      threadId: input.threadId,
      holderClientId: input.clientId,
      epoch,
      expiresAtMs,
    });
    return { ok: true, epoch, expiresAtMs };
  }

  renew(input: {
    threadId: string;
    clientId: string;
    epoch: number;
  }): { ok: true; expiresAtMs: number } | { ok: false; error: ControlLeaseError } {
    const rec = this.getValid(input.threadId);
    if (!rec) return { ok: false, error: 'lease_required' };
    if (rec.holderClientId !== input.clientId) return { ok: false, error: 'not_holder' };
    if (rec.epoch !== input.epoch) return { ok: false, error: 'stale_epoch' };
    rec.expiresAtMs = Date.now() + this.ttlMs;
    this.leases.set(input.threadId, rec);
    return { ok: true, expiresAtMs: rec.expiresAtMs };
  }

  release(input: {
    threadId: string;
    clientId: string;
    epoch: number;
  }): { ok: true } | { ok: false; error: ControlLeaseError } {
    const rec = this.leases.get(input.threadId);
    if (!rec) return { ok: true };
    if (rec.holderClientId !== input.clientId) return { ok: false, error: 'not_holder' };
    if (rec.epoch !== input.epoch) return { ok: false, error: 'stale_epoch' };
    this.leases.delete(input.threadId);
    return { ok: true };
  }

  authorizeMutation(input: {
    threadId: string;
    clientId: string;
    controlEpoch?: number;
    allowHostAutoAcquire: boolean;
    requireExplicitEpoch: boolean;
  }): { ok: true; epoch: number } | { ok: false; error: ControlLeaseError } {
    const rec = this.getValid(input.threadId);
    if (!rec) {
      if (input.allowHostAutoAcquire) {
        const acquired = this.acquire({ threadId: input.threadId, clientId: input.clientId });
        if (!acquired.ok) return acquired;
        return { ok: true, epoch: acquired.epoch };
      }
      return { ok: false, error: 'lease_required' };
    }
    if (rec.holderClientId !== input.clientId) {
      return { ok: false, error: 'held_by_other' };
    }
    if (input.requireExplicitEpoch && input.controlEpoch === undefined) {
      return { ok: false, error: 'epoch_required' };
    }
    if (input.controlEpoch === undefined) {
      rec.expiresAtMs = Date.now() + this.ttlMs;
      this.leases.set(input.threadId, rec);
      return { ok: true, epoch: rec.epoch };
    }
    if (input.controlEpoch !== rec.epoch) {
      return { ok: false, error: 'stale_epoch' };
    }
    rec.expiresAtMs = Date.now() + this.ttlMs;
    this.leases.set(input.threadId, rec);
    return { ok: true, epoch: rec.epoch };
  }

  fenceDevice(deviceClientId: string): void {
    for (const [threadId, rec] of this.leases) {
      if (rec.holderClientId === deviceClientId) {
        this.leases.delete(threadId);
      }
    }
  }

  private bumpCommittedEpoch(threadId: string): number {
    const next = (this.committedEpoch.get(threadId) ?? 0) + 1;
    this.committedEpoch.set(threadId, next);
    return next;
  }

  private getValid(threadId: string): ControlLeaseRecord | undefined {
    const rec = this.leases.get(threadId);
    if (!rec) return undefined;
    if (rec.expiresAtMs < Date.now()) {
      this.leases.delete(threadId);
      return undefined;
    }
    return rec;
  }
}
