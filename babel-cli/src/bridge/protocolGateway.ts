/**
 * ADR-010 JSON-RPC gateway over the existing loopback HTTP/WebSocket bridge.
 * Transport only — semantics stay in protocol/client/host.ts.
 */

import type { IncomingMessage } from 'node:http';

import {
  createProtocolHostState,
  handleProtocolRequest,
  parseProtocolRequest,
  type ProtocolHostState,
} from '../protocol/client/host.js';
import type { BabelProtocolRequest } from '../protocol/messages.js';
import type { JsonRpcResponse } from '../protocol/jsonRpc.js';
import { BabelProtocolErrorCode } from '../protocol/types.js';
import { assertAllowedProjectRoot } from './workspaceBound.js';
import { originAllowed as originAllowedStructured } from './originPolicy.js';

export const MAX_RPC_BYTES = 2 * 1024 * 1024;

export type JsonRpcNotificationHandler = (payload: string) => void;

interface GatewaySubscriber {
  handler: JsonRpcNotificationHandler;
  threadId?: string;
}

function notificationThreadId(notification: object): string | undefined {
  const params = (notification as { params?: { thread_id?: unknown } }).params;
  return typeof params?.thread_id === 'string' ? params.thread_id : undefined;
}

export class ProtocolGateway {
  readonly host: ProtocolHostState;
  private subscribers = new Set<GatewaySubscriber>();

  constructor(options: {
    allowedWorkspaceRoot: string;
    engineFactory?: ProtocolHostState['engineFactory'];
    remoteSurface?: boolean;
  }) {
    const allowedRoot = options.allowedWorkspaceRoot;
    this.host = createProtocolHostState({
      executeWithoutNotifications: true,
      projectRootGuard: (projectRoot) => assertAllowedProjectRoot(projectRoot, allowedRoot),
      remoteSurface: options.remoteSurface !== false,
      ...(options.engineFactory ? { engineFactory: options.engineFactory } : {}),
    });
  }

  subscribe(
    handler: JsonRpcNotificationHandler,
    options?: { threadId?: string },
  ): () => void {
    const subscriber: GatewaySubscriber = {
      handler,
      ...(options?.threadId !== undefined ? { threadId: options.threadId } : {}),
    };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private fanout(notification: object): void {
    const payload = JSON.stringify(notification);
    const threadId = notificationThreadId(notification);
    for (const subscriber of this.subscribers) {
      if (!subscriber.threadId) continue;
      if (threadId && subscriber.threadId !== threadId) continue;
      try {
        subscriber.handler(payload);
      } catch {
        /* drop disconnected subscribers */
      }
    }
  }

  async dispatch(raw: string): Promise<JsonRpcResponse> {
    if (Buffer.byteLength(raw, 'utf8') > MAX_RPC_BYTES) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: BabelProtocolErrorCode.INVALID_REQUEST,
          message: `RPC payload exceeds ${MAX_RPC_BYTES} bytes`,
        },
      };
    }
    const parsed = parseProtocolRequest(raw);
    if (!parsed) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: BabelProtocolErrorCode.PARSE_ERROR,
          message: 'Invalid JSON-RPC request',
        },
      };
    }
    return handleProtocolRequest(parsed as BabelProtocolRequest, this.host, (notification) => {
      this.fanout(notification);
    });
  }
}

export function readLimitedBody(
  req: IncomingMessage,
  maxBytes: number = MAX_RPC_BYTES,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: { ok: true; body: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.resume();
        finish({ ok: false, error: `RPC payload exceeds ${maxBytes} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
  });
}

export function originAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
  remoteAddress?: string,
): boolean {
  return originAllowedStructured(origin, allowedOrigins, remoteAddress);
}
