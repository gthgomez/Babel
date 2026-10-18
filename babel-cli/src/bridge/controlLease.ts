/**
 * Per-thread control lease with monotonic fencing epochs.
 * One holder may issue mutating remote RPCs while the lease is valid.
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
  | 'held_by_other'
  | 'not_holder'
  | 'unknown_thread';

export class ControlLeaseRegistry {
  private readonly leases = new Map<string, ControlLeaseRecord>();
  private readonly ttlMs: number;

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_CONTROL_LEASE_TTL_MS;
  }

  status(threadId: string): {
    held: boolean;
    holderClientId?: string;
    epoch?: number;
    expiresAtMs?: number;
  } {
    const rec = this.getValid(threadId);
    if (!rec) return { held: false };
    return {
      held: true,
      holderClientId: rec.holderClientId,
      epoch: rec.epoch,
      expiresAtMs: rec.expiresAtMs,
    };
  }

  acquire(input: {
    threadId: string;
    clientId: string;
    force?: boolean;
  }): { ok: true; epoch: number; expiresAtMs: number } | { ok: false; error: ControlLeaseError } {
    const existing = this.getValid(input.threadId);
    if (existing && existing.holderClientId !== input.clientId) {
      if (!input.force) return { ok: false, error: 'held_by_other' };
    }
    const epoch = existing && existing.holderClientId === input.clientId
      ? existing.epoch
      : (existing?.epoch ?? 0) + 1;
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

  /**
   * Host-local bearer clients may auto-bind when no remote holder exists.
   */
  authorizeMutation(input: {
    threadId: string;
    clientId: string;
    controlEpoch?: number;
    allowHostAutoAcquire: boolean;
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
    if (input.controlEpoch !== undefined && input.controlEpoch !== rec.epoch) {
      return { ok: false, error: 'stale_epoch' };
    }
    rec.expiresAtMs = Date.now() + this.ttlMs;
    this.leases.set(input.threadId, rec);
    return { ok: true, epoch: rec.epoch };
  }

  fenceDevice(deviceClientId: string): void {
    for (const [threadId, rec] of this.leases) {
      if (rec.holderClientId === deviceClientId) this.leases.delete(threadId);
    }
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
