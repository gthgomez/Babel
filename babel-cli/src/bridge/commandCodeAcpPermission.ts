import type { AgentAction } from '../agent/actions.js';

export function permissionActionFromAcpParams(
  params: Record<string, unknown>,
  cwd: string,
): AgentAction {
  const title = typeof params.title === 'string' ? params.title : 'Command Code permission';
  const toolCall = params.toolCall as { title?: string; kind?: string; input?: unknown } | undefined;
  if (toolCall?.kind === 'execute' || toolCall?.title) {
    const command =
      typeof toolCall.input === 'object' && toolCall.input && 'command' in (toolCall.input as object)
        ? String((toolCall.input as { command?: unknown }).command ?? title)
        : title;
    return {
      type: 'ask_approval',
      reason: title,
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
  return {
    type: 'ask_approval',
    reason: title,
    requested_action: { type: 'run_command', command: title, cwd },
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
