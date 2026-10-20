/**
 * OpenCode own-CLI wire shapes (ACP-aligned JSON-RPC over stdio).
 */

export const OPENCODE_ACP_PROTOCOL_VERSION = 1;

export type OpenCodeAcpMethod =
  | 'initialize'
  | 'session/new'
  | 'session/list'
  | 'session/resume'
  | 'session/close'
  | 'session/prompt'
  | 'session/cancel'
  | 'session/update'
  | 'session/request_permission'
  | 'session/set_config_option';

export interface OpenCodeWireMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export type OpenCodeFixtureDirection = 'stdin' | 'stdout';

export interface OpenCodeFixtureLine {
  direction: OpenCodeFixtureDirection;
  message: OpenCodeWireMessage;
  /** When set, stdin steps must match params exactly (strict wire qualification). */
  expectParams?: Record<string, unknown>;
}

export function serializeOpenCodeLine(message: OpenCodeWireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseOpenCodeLine(line: string): OpenCodeWireMessage {
  const trimmed = line.trim();
  if (!trimmed) throw new Error('OPENCODE_PROTOCOL_EMPTY_LINE');
  const parsed = JSON.parse(trimmed) as OpenCodeWireMessage;
  if (parsed?.jsonrpc !== '2.0') {
    throw new Error('OPENCODE_PROTOCOL_INVALID_JSONRPC');
  }
  return parsed;
}

export function isOpenCodeNotification(message: OpenCodeWireMessage): boolean {
  return typeof message.method === 'string' && message.id === undefined;
}

export function isOpenCodeRequest(message: OpenCodeWireMessage): boolean {
  return typeof message.method === 'string' && message.id !== undefined;
}
