/**
 * Command Code own-CLI wire shapes (ACP-aligned JSON-RPC over stdio).
 */

export const COMMAND_CODE_ACP_PROTOCOL_VERSION = 2;

export type CommandCodeAcpMethod =
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

export interface CommandCodeWireMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export type CommandCodeFixtureDirection = 'stdin' | 'stdout';

export interface CommandCodeFixtureLine {
  direction: CommandCodeFixtureDirection;
  message: CommandCodeWireMessage;
}

export function serializeCommandCodeLine(message: CommandCodeWireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseCommandCodeLine(line: string): CommandCodeWireMessage {
  const trimmed = line.trim();
  if (!trimmed) throw new Error('COMMAND_CODE_PROTOCOL_EMPTY_LINE');
  const parsed = JSON.parse(trimmed) as CommandCodeWireMessage;
  if (parsed?.jsonrpc !== '2.0') {
    throw new Error('COMMAND_CODE_PROTOCOL_INVALID_JSONRPC');
  }
  return parsed;
}

export function isCommandCodeNotification(message: CommandCodeWireMessage): boolean {
  return typeof message.method === 'string' && message.id === undefined;
}

export function isCommandCodeRequest(message: CommandCodeWireMessage): boolean {
  return typeof message.method === 'string' && message.id !== undefined;
}
