import type { AgentAction } from '../agent/actions.js';

function toolCallRecord(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = params.toolCall;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  return undefined;
}

export function permissionActionFromAcpParams(
  params: Record<string, unknown>,
  cwd: string,
): AgentAction {
  const title = typeof params.title === 'string' ? params.title : 'Command Code permission';
  const toolCall = toolCallRecord(params);
  const toolCallId =
    typeof toolCall?.toolCallId === 'string'
      ? toolCall.toolCallId
      : typeof params.toolCallId === 'string'
        ? params.toolCallId
        : undefined;
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind : undefined;
  const rawInput = toolCall?.rawInput ?? toolCall?.input;

  if (kind === 'read' || kind === 'read_file') {
    const path =
      typeof rawInput === 'object' && rawInput && 'path' in (rawInput as object)
        ? String((rawInput as { path?: unknown }).path ?? '')
        : '';
    if (!path) {
      return failClosedPermission(title, toolCallId);
    }
    return {
      type: 'ask_approval',
      reason: `${title}${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'read_file', path },
    };
  }
  if (kind === 'edit' || kind === 'write' || kind === 'delete') {
    const path =
      typeof rawInput === 'object' && rawInput && 'path' in (rawInput as object)
        ? String((rawInput as { path?: unknown }).path ?? '')
        : '';
    if (!path) {
      return failClosedPermission(title, toolCallId);
    }
    return {
      type: 'ask_approval',
      reason: `${title}${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'read_file', path },
    };
  }
  if (kind === 'execute' || kind === 'bash' || kind === 'run_command') {
    const command =
      typeof rawInput === 'object' && rawInput && 'command' in (rawInput as object)
        ? String((rawInput as { command?: unknown }).command ?? '')
        : typeof rawInput === 'string'
          ? rawInput
          : '';
    if (!command) {
      return failClosedPermission(title, toolCallId);
    }
    return {
      type: 'ask_approval',
      reason: `${title}${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'run_command', command, cwd },
    };
  }

  const subject = params.subject as { path?: string } | undefined;
  if (subject?.path) {
    return {
      type: 'ask_approval',
      reason: title,
      requested_action: { type: 'read_file', path: subject.path },
    };
  }
  return failClosedPermission(title, toolCallId);
}

function failClosedPermission(title: string, toolCallId?: string): AgentAction {
  return {
    type: 'ask_approval',
    reason: `Unrecognized Command Code permission (${title}${toolCallId ? `:${toolCallId}` : ''})`,
    requested_action: { type: 'run_command', command: '__unknown_permission__', cwd: process.cwd() },
  };
}

export function selectAllowOnceOptionId(options: unknown[]): string | null {
  for (const row of options) {
    if (!row || typeof row !== 'object') continue;
    const kind = (row as { kind?: string }).kind;
    const optionId = (row as { optionId?: string }).optionId;
    if (kind === 'allow_once' && typeof optionId === 'string') return optionId;
  }
  return null;
}
