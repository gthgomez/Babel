/**
 * JSON-RPC 2.0 envelope types for the Babel app-server protocol.
 *
 * Transport: NDJSON over stdio (one envelope per line). See ADR-010.
 */

import type { BabelProtocolErrorCode } from './types.js';

export const JSON_RPC_VERSION = '2.0' as const;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number;
  method: M;
  params?: P;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: M;
  params: P;
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number;
  result: R;
}

export interface JsonRpcErrorObject {
  code: BabelProtocolErrorCode | number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccessResponse<R> | JsonRpcErrorResponse;

export function isJsonRpcErrorResponse(
  response: JsonRpcResponse,
): response is JsonRpcErrorResponse {
  return 'error' in response;
}