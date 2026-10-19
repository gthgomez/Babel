/**
 * Loopback JSON-RPC client for BridgeServer `/rpc` (Desktop + Remote share one host).
 */

import type { JsonRpcResponse } from '../protocol/jsonRpc.js';
import { DESKTOP_CLIENT_ID_HEADER } from './desktopControllerAuth.js';

export interface HttpProtocolClientOptions {
  baseUrl: string;
  bearerToken?: string;
  /** Loopback Desktop controller identity (no host bearer on ordinary input). */
  desktopClientId?: string;
  fetchImpl?: typeof fetch;
}

export class HttpProtocolClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly desktopClientId: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpProtocolClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.bearerToken = options.bearerToken ?? undefined;
    this.desktopClientId = options.desktopClientId ?? undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.bearerToken && !this.desktopClientId) {
      throw new Error('HttpProtocolClient requires bearerToken or desktopClientId');
    }
  }

  private requestHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.desktopClientId) {
      headers[DESKTOP_CLIENT_ID_HEADER] = this.desktopClientId;
    }
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }
    return headers;
  }

  async call<M extends string, P, R>(
    method: M,
    params: P,
    id: string | number = Date.now(),
  ): Promise<R> {
    const response = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: this.requestHeaders(),
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
      headers: this.requestHeaders(),
      body: JSON.stringify({ projectRoot }),
    });
    if (!response.ok) {
      throw new Error(`Create transport session failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { sessionId: string };
    return payload.sessionId;
  }
}
