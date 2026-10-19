import { createHash } from 'node:crypto';

import type { AgentAction } from '../agent/actions.js';

function toolCallRecord(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = params.toolCall;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  return undefined;
}

function digestHex(material: string): string {
  return createHash('sha256').update(material).digest('hex');
}

function diffPreviewMaterial(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const row = block as {
      type?: string;
      path?: string;
      oldText?: string | null;
      newText?: string;
      content?: { type?: string; text?: string };
    };
    if (row.type === 'diff' && typeof row.path === 'string') {
      const oldText = row.oldText ?? '';
      const newText = row.newText ?? '';
      parts.push(`diff:${row.path}\n---OLD---\n${oldText}\n---NEW---\n${newText}`);
      continue;
    }
    if (row.type === 'content' && row.content?.type === 'text' && typeof row.content.text === 'string') {
      parts.push(`content:text\n${row.content.text}`);
    }
  }
  if (parts.length === 0) return null;
  return parts.sort().join('\n===\n');
}

function editWriteBindingMaterial(
  kind: string,
  rawInput: unknown,
  toolCall: Record<string, unknown> | undefined,
): string | null {
  const preview = diffPreviewMaterial(toolCall?.content);
  if (preview) return preview;

  if (kind === 'patch') {
    if (!rawInput || typeof rawInput !== 'object') return null;
    return `patch:${JSON.stringify(rawInput)}`;
  }

  if (!rawInput || typeof rawInput !== 'object') return null;
  const input = rawInput as { path?: unknown; content?: unknown };
  const path = typeof input.path === 'string' ? input.path : '';
  if (!path) return null;
  if (!('content' in input)) {
    return null;
  }
  const content = typeof input.content === 'string' ? input.content : String(input.content ?? '');
  return `acp:${kind}:${path}\n---\n${content}`;
}

/** Returns null when the operation cannot be represented safely (fail closed before broker). */
export function permissionActionFromAcpParams(
  params: Record<string, unknown>,
  cwd: string,
): AgentAction | null {
  const title = typeof params.title === 'string' ? params.title : 'OpenCode permission';
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
    if (!path) return null;
    return {
      type: 'ask_approval',
      reason: `${title}${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'read_file', path },
    };
  }
  if (kind === 'edit' || kind === 'write' || kind === 'patch') {
    const material = editWriteBindingMaterial(kind, rawInput, toolCall);
    if (!material) return null;
    const digest = digestHex(material);
    const pathMatch = material.match(/^acp:(?:edit|write):([^\n]+)/) ?? material.match(/^diff:([^\n]+)/);
    const pathLabel = pathMatch?.[1] ?? kind;
    const command = `acp:${kind}:${pathLabel}\n---\n${material}`;
    return {
      type: 'ask_approval',
      reason: `${title} — ${kind} ${pathLabel} [sha256=${digest}]${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'run_command', command, cwd },
    };
  }
  if (kind === 'delete') {
    const path =
      typeof rawInput === 'object' && rawInput && 'path' in (rawInput as object)
        ? String((rawInput as { path?: unknown }).path ?? '')
        : '';
    if (!path) return null;
    return {
      type: 'ask_approval',
      reason: `${title} — delete ${path}${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'run_command', command: `acp:delete:${path}`, cwd },
    };
  }
  if (kind === 'execute' || kind === 'bash' || kind === 'run_command') {
    const command =
      typeof rawInput === 'object' && rawInput && 'command' in (rawInput as object)
        ? String((rawInput as { command?: unknown }).command ?? '')
        : typeof rawInput === 'string'
          ? rawInput
          : '';
    if (!command) return null;
    return {
      type: 'ask_approval',
      reason: `${title}${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'run_command', command, cwd },
    };
  }

  return null;
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
