/**
 * Operation-bound remote approval broker.
 * Remote surface may consume ALLOW_ONCE or DENY only — never ALLOW_SESSION.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { AgentAction } from '../agent/actions.js';
import {
  approvalOperationFromAgentAction,
  approvalOperationFromChatTool,
  digestApprovalOperation,
  type ApprovalOperation,
} from '../agent/approvalOperation.js';
import type { ChatToolAction } from '../agent/chatToolDefinitions.js';

export const REMOTE_APPROVAL_TTL_MS = 15 * 60 * 1000;
export const REMOTE_ALLOWED_DECISIONS = ['allow_once', 'deny'] as const;

export type RemoteApprovalDecision = (typeof REMOTE_ALLOWED_DECISIONS)[number];

export type RemoteApprovalState =
  | 'pending'
  | 'consumed'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'stale';

export interface RemotePendingApproval {
  approval_id: string;
  thread_id: string;
  turn_id: string;
  operation: ApprovalOperation;
  digest: string;
  created_at: number;
  expires_at: number;
  state: RemoteApprovalState;
  /** Same object the engine will execute — recomputed immediately before consume. */
  liveAction?: AgentAction | ChatToolAction;
  liveCwd?: string;
}

export interface RemoteApprovalDecideInput {
  approval_id: string;
  decision: string;
  operation_digest?: string;
  thread_id: string;
  turn_id: string;
  now?: number;
}

export type RemoteApprovalDecideError =
  | 'not_found'
  | 'not_pending'
  | 'expired'
  | 'stale'
  | 'cancelled'
  | 'wrong_thread'
  | 'wrong_turn'
  | 'digest_mismatch'
  | 'session_grant_forbidden'
  | 'invalid_decision'
  | 'replay';

export interface RemoteSurfaceContext {
  broker: RemoteApprovalBroker;
  threadId: string;
  turnId: string;
  failClosedMcp: true;
  cwd: string;
  notify?: (notification: unknown) => void;
}

const remoteSurface = new AsyncLocalStorage<RemoteSurfaceContext>();

export function runOnRemoteSurface<T>(ctx: RemoteSurfaceContext, fn: () => T): T {
  return remoteSurface.run(ctx, fn);
}

export function getRemoteSurface(): RemoteSurfaceContext | undefined {
  return remoteSurface.getStore();
}

export function isRemoteAllowOnceDecision(value: string): value is RemoteApprovalDecision {
  return value === 'allow_once' || value === 'deny';
}

export class RemoteApprovalBroker {
  private readonly pending = new Map<string, RemotePendingApproval>();
  private readonly waiters = new Map<
    string,
    { resolve: (allowed: boolean) => void; reject: (err: Error) => void }
  >();

  constructor(private readonly ttlMs: number = REMOTE_APPROVAL_TTL_MS) {}

  createPending(input: {
    thread_id: string;
    turn_id: string;
    operation: ApprovalOperation;
    now?: number;
    liveAction?: AgentAction | ChatToolAction;
    liveCwd?: string;
  }): RemotePendingApproval {
    const now = input.now ?? Date.now();
    const digest = digestApprovalOperation(input.operation);
    const record: RemotePendingApproval = {
      approval_id: randomUUID(),
      thread_id: input.thread_id,
      turn_id: input.turn_id,
      operation: input.operation,
      digest,
      created_at: now,
      expires_at: now + this.ttlMs,
      state: 'pending',
      ...(input.liveAction !== undefined ? { liveAction: input.liveAction } : {}),
      ...(input.liveCwd !== undefined ? { liveCwd: input.liveCwd } : {}),
    };
    this.pending.set(record.approval_id, record);
    return record;
  }

  liveDigest(record: RemotePendingApproval): string | undefined {
    if (!record.liveAction) return undefined;
    const ctx = {
      thread_id: record.thread_id,
      turn_id: record.turn_id,
      cwd: record.liveCwd ?? record.operation.canonical_cwd,
    };
    const live =
      'server' in record.liveAction
        ? approvalOperationFromChatTool(record.liveAction as ChatToolAction, ctx)
        : approvalOperationFromAgentAction(record.liveAction as AgentAction, ctx);
    return digestApprovalOperation(live);
  }

  get(approvalId: string): RemotePendingApproval | undefined {
    return this.pending.get(approvalId);
  }

  listPending(threadId: string): RemotePendingApproval[] {
    return [...this.pending.values()].filter(
      (item) => item.thread_id === threadId && item.state === 'pending',
    );
  }

  decide(
    input: RemoteApprovalDecideInput,
  ): { ok: true; record: RemotePendingApproval } | { ok: false; error: RemoteApprovalDecideError } {
    const record = this.pending.get(input.approval_id);
    if (!record) return { ok: false, error: 'not_found' };
    const now = input.now ?? Date.now();

    if (input.decision === 'allow_session' || input.decision === 'narrow_rule') {
      return { ok: false, error: 'session_grant_forbidden' };
    }
    if (!isRemoteAllowOnceDecision(input.decision)) {
      return { ok: false, error: 'invalid_decision' };
    }
    if (record.state === 'consumed' || record.state === 'denied') {
      return { ok: false, error: 'replay' };
    }
    if (record.state === 'cancelled') return { ok: false, error: 'cancelled' };
    if (record.state === 'stale') return { ok: false, error: 'stale' };
    if (record.state !== 'pending') return { ok: false, error: 'not_pending' };
    if (now > record.expires_at) {
      record.state = 'expired';
      this.failWaiter(record.approval_id, false);
      return { ok: false, error: 'expired' };
    }
    if (record.thread_id !== input.thread_id) return { ok: false, error: 'wrong_thread' };
    if (record.turn_id !== input.turn_id) return { ok: false, error: 'wrong_turn' };
    if (input.operation_digest !== undefined && input.operation_digest !== record.digest) {
      return { ok: false, error: 'digest_mismatch' };
    }

    if (input.decision === 'deny') {
      record.state = 'denied';
      this.failWaiter(record.approval_id, false);
      return { ok: true, record };
    }

    const live = this.liveDigest(record);
    if (live !== undefined && live !== record.digest) {
      record.state = 'stale';
      this.failWaiter(record.approval_id, false);
      return { ok: false, error: 'digest_mismatch' };
    }
    if (live === undefined && input.operation_digest === undefined) {
      return { ok: false, error: 'digest_mismatch' };
    }

    record.state = 'consumed';
    this.succeedWaiter(record.approval_id, true);
    return { ok: true, record };
  }

  cancelTurn(threadId: string, turnId: string, now?: number): number {
    void now;
    let count = 0;
    for (const record of this.pending.values()) {
      if (record.thread_id === threadId && record.turn_id === turnId && record.state === 'pending') {
        record.state = 'cancelled';
        this.failWaiter(record.approval_id, false);
        count += 1;
      }
    }
    return count;
  }

  markStale(approvalId: string): void {
    const record = this.pending.get(approvalId);
    if (!record || record.state !== 'pending') return;
    record.state = 'stale';
    this.failWaiter(approvalId, false);
  }

  async requestAllowOnce(input: {
    action: AgentAction | ChatToolAction;
    thread_id: string;
    turn_id: string;
    cwd: string;
    notify?: (notification: unknown) => void;
    now?: number;
    wait?: (approvalId: string) => Promise<boolean>;
  }): Promise<boolean> {
    const ctx = {
      thread_id: input.thread_id,
      turn_id: input.turn_id,
      cwd: input.cwd,
    };
    const operation =
      'server' in input.action
        ? approvalOperationFromChatTool(input.action as ChatToolAction, ctx)
        : approvalOperationFromAgentAction(input.action as AgentAction, ctx);
    const record = this.createPending({
      thread_id: input.thread_id,
      turn_id: input.turn_id,
      operation,
      liveAction: input.action,
      liveCwd: input.cwd,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    input.notify?.({
      jsonrpc: '2.0',
      method: 'permission.request',
      params: {
        thread_id: record.thread_id,
        turn_id: record.turn_id,
        approval_id: record.approval_id,
        permission: record.operation.action_type,
        reason: 'Remote consequential action requires ALLOW_ONCE or DENY',
        action_type: record.operation.action_type,
        command: record.operation.command,
        cwd: record.operation.canonical_cwd,
        target_path: record.operation.target_path,
        operation_digest: record.digest,
        allowed_decisions: [...REMOTE_ALLOWED_DECISIONS],
        expires_at: new Date(record.expires_at).toISOString(),
      },
    });
    const confirmLive = (allowed: boolean): boolean => {
      if (!allowed) return false;
      const live = this.liveDigest(record);
      if (live !== undefined && live !== record.digest) {
        record.state = 'stale';
        return false;
      }
      return true;
    };
    if (input.wait) {
      return input.wait(record.approval_id).then(confirmLive);
    }
    return new Promise<boolean>((resolve, reject) => {
      this.waiters.set(record.approval_id, {
        resolve: (allowed) => resolve(confirmLive(allowed)),
        reject,
      });
    });
  }

  private succeedWaiter(id: string, allowed: boolean): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.resolve(allowed);
  }

  private failWaiter(id: string, allowed: boolean): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.resolve(allowed);
  }
}

export function remoteMcpIsFailClosed(): boolean {
  return getRemoteSurface()?.failClosedMcp === true;
}

export function remoteMcpFailClosedObservation(server: string): string {
  return `Remote MCP fail-closed: ${server} is not executable on the remote surface because chat MCP bypasses the operation-bound approval contract.`;
}
