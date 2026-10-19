/**
 * Deterministic Command Code own-CLI wire shapes (ACP-aligned subset).
 * Fixtures replay these messages; no live provider or credential traffic.
 */

export const COMMAND_CODE_PROTOCOL_VERSION = 1;

export type CommandCodeMethod =
  | 'session/new'
  | 'session/prompt'
  | 'session/cancel'
  | 'session/update';

export interface CommandCodeWireMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: CommandCodeMethod;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
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
  const parsed = JSON.parse(line) as CommandCodeWireMessage;
  if (parsed?.jsonrpc !== '2.0') {
    throw new Error('COMMAND_CODE_PROTOCOL_INVALID_JSONRPC');
  }
  return parsed;
}
