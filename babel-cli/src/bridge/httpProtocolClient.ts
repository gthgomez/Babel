/**
 * Loopback JSON-RPC client for BridgeServer `/rpc` (Desktop + Remote share one host).
 */

import type { JsonRpcResponse } from '../protocol/jsonRpc.js';

export interface HttpProtocolClientOptions {
  baseUrl: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
}

export class HttpProtocolClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpProtocolClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<M extends string, P, R>(
    method: M,
    params: P,
    id: string | number = Date.now(),
  ): Promise<R> {
    const response = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const body = (await response.json()) as JsonRpcResponse<R>;
    if (!response.ok || 'error' in body) {
      const message =
        'error' in body
          ? `${body.error.code}: ${body.error.message}`
          : `HTTP ${response.status}`;
      throw new Error(`Protocol RPC ${method} failed: ${message}`);
    }
    return body.result as R;
  }

  async createTransportSession(projectRoot: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectRoot }),
    });
    if (!response.ok) {
      throw new Error(`Create transport session failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { sessionId: string };
    return payload.sessionId;
  }
}
