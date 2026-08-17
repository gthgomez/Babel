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

export class ProtocolGateway {
  readonly host: ProtocolHostState;
  /** Stage 1: one trusted operator connection. */
  private subscriber: JsonRpcNotificationHandler | null = null;

  constructor(options: {
    allowedWorkspaceRoot: string;
    engineFactory?: ProtocolHostState['engineFactory'];
  }) {
    const allowedRoot = options.allowedWorkspaceRoot;
    this.host = createProtocolHostState({
      executeWithoutNotifications: true,
      projectRootGuard: (projectRoot) => assertAllowedProjectRoot(projectRoot, allowedRoot),
      ...(options.engineFactory ? { engineFactory: options.engineFactory } : {}),
    });
  }

  subscribe(handler: JsonRpcNotificationHandler): () => void {
    this.subscriber = handler;
    return () => {
      if (this.subscriber === handler) this.subscriber = null;
    };
  }

  private fanout(notification: object): void {
    if (!this.subscriber) return;
    try {
      this.subscriber(JSON.stringify(notification));
    } catch {
      this.subscriber = null;
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
