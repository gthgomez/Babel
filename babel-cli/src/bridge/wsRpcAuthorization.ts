/**
 * Fail-closed JSON-RPC authorization for thread-scoped WebSocket transports.
 * A ticket-bound socket may only mutate or read its subscribed thread.
 */

import { parseProtocolRequest } from '../protocol/client/host.js';
import type { BabelProtocolMethod } from '../protocol/types.js';

const THREAD_SCOPED_METHODS = new Set<BabelProtocolMethod>([
  'turn.submit',
  'turn.cancel',
  'history.lookup',
  'workspace.changes',
  'verification.lookup',
  'approval.decide',
]);

const SESSION_SCOPED_METHODS = new Set<BabelProtocolMethod>(['thread.create', 'thread.resume']);

function threadIdFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const threadId = (params as { thread_id?: unknown }).thread_id;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
}

function sessionIdFromParams(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const sessionId = (params as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

export type WsRpcAuthResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Authorize a JSON-RPC payload from a WebSocket that was opened with a thread ticket.
 */
export function authorizeThreadScopedWsRpc(
  raw: string,
  context: { bridgeSessionId: string; subscribedThreadId: string },
): WsRpcAuthResult {
  const parsed = parseProtocolRequest(raw);
  if (!parsed || typeof parsed.method !== 'string') {
    return { ok: false, message: 'Invalid JSON-RPC request' };
  }
  const method = parsed.method as BabelProtocolMethod;
  const params = (parsed as { params?: unknown }).params;

  if (SESSION_SCOPED_METHODS.has(method)) {
    const sessionId = sessionIdFromParams(params);
    if (!sessionId || sessionId !== context.bridgeSessionId) {
      return { ok: false, message: 'session_id must match the WebSocket bridge session' };
    }
    if (method === 'thread.resume') {
      const threadId = threadIdFromParams(params);
      if (threadId && threadId !== context.subscribedThreadId) {
        return { ok: false, message: 'thread.resume is limited to the subscribed thread' };
      }
    }
    return { ok: true };
  }

  if (THREAD_SCOPED_METHODS.has(method)) {
    const threadId = threadIdFromParams(params);
    if (!threadId || threadId !== context.subscribedThreadId) {
      return { ok: false, message: 'RPC thread_id must match the WebSocket ticket thread' };
    }
    const approvalThread = (params as { thread_id?: string }).thread_id;
    if (method === 'approval.decide' && approvalThread && approvalThread !== context.subscribedThreadId) {
      return { ok: false, message: 'approval.decide is limited to the subscribed thread' };
    }
    return { ok: true };
  }

  return { ok: false, message: `Method ${method} is not allowed over a thread-scoped WebSocket` };
}
