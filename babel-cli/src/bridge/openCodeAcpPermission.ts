import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import type { AgentAction } from '../agent/actions.js';

function toolCallRecord(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = params.toolCall;
  if (direct && typeof direct === 'object') return direct as Record<string, unknown>;
  return undefined;
}

function digestHex(material: string): string {
  return createHash('sha256').update(material).digest('hex');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function absolutePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Vendor shell rawInput: inject session cwd only when neither cwd nor workdir is set. */
export function effectiveShellExecution(
  rawInput: unknown,
  sessionCwd: string,
): { command: string; effectiveCwd: string; rawInput: Record<string, unknown> } | null {
  if (typeof rawInput === 'string') {
    const command = rawInput.trim();
    if (!command) return null;
    return { command, effectiveCwd: sessionCwd, rawInput: { command } };
  }
  if (!rawInput || typeof rawInput !== 'object') return null;
  const input = rawInput as Record<string, unknown>;
  const command = stringValue(input.command) ?? stringValue(input.cmd);
  if (!command) return null;
  const workdir = stringValue(input.workdir) ?? stringValue(input.cwd);
  const effectiveCwd = workdir ? absolutePath(workdir, sessionCwd) : sessionCwd;
  return { command, effectiveCwd, rawInput: input };
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

function acpToolCallLabel(toolCall: Record<string, unknown> | undefined): string | undefined {
  return stringValue(toolCall?.name) ?? stringValue(toolCall?.title);
}

/** Matches pinned OpenCode `canonicalName` V1 aliases (e.g. apply_patch → patch). */
const ACP_TOOL_V1_ALIASES = new Map<string, string>([
  ['bash', 'shell'],
  ['task', 'subagent'],
  ['apply_patch', 'patch'],
]);

export function canonicalAcpToolName(toolName: string): string {
  const lower = toolName.toLocaleLowerCase();
  return ACP_TOOL_V1_ALIASES.get(lower) ?? lower;
}

/** Pinned OpenCode emits patch operations as `kind:edit` with `name`/`title: patch` (or `apply_patch`). */
export function isAcpPatchOperation(
  kind: string | undefined,
  toolCall: Record<string, unknown> | undefined,
): boolean {
  if (kind === 'patch') return true;
  const label = acpToolCallLabel(toolCall);
  if (kind === 'edit' && label && canonicalAcpToolName(label) === 'patch') return true;
  return false;
}

/** Non-empty `patchText` string on a structured rawInput object (vendor ToolInput shape). */
export function verifiedPatchTextRawInput(rawInput: unknown): string | null {
  if (rawInput === undefined || rawInput === null) return null;
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return null;
  const patchText = stringValue((rawInput as Record<string, unknown>).patchText);
  if (patchText === undefined) return null;
  const trimmed = patchText.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasSubstantivePatchRawInput(rawInput: unknown): boolean {
  return verifiedPatchTextRawInput(rawInput) !== null;
}

function stableRawInputMaterial(rawInput: unknown): string | null {
  if (rawInput === undefined) return null;
  if (typeof rawInput === 'string') return `raw:string:${rawInput}`;
  if (typeof rawInput === 'object' && rawInput) {
    try {
      return `raw:json:${JSON.stringify(rawInput)}`;
    } catch {
      return null;
    }
  }
  return null;
}

function editWriteBindingMaterial(
  kind: string,
  rawInput: unknown,
  toolCall: Record<string, unknown> | undefined,
): string | null {
  const patchOperation = isAcpPatchOperation(kind, toolCall);
  const bindingKind = patchOperation ? 'patch' : kind;
  const parts: string[] = [`kind:${bindingKind}`];
  if (patchOperation && !hasSubstantivePatchRawInput(rawInput)) return null;
  const rawMaterial = stableRawInputMaterial(rawInput);
  if (rawMaterial) parts.push(rawMaterial);
  const preview = diffPreviewMaterial(toolCall?.content);
  if (preview) parts.push(`preview:\n${preview}`);

  if (patchOperation) {
    if (!rawMaterial || !verifiedPatchTextRawInput(rawInput)) return null;
    return parts.join('\n');
  }

  if (kind === 'edit' || kind === 'write') {
    const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : null;
    const path = input ? stringValue(input.path) ?? stringValue(input.filePath) : undefined;
    const hasExplicitContent = Boolean(input && 'content' in input);
    if (!preview && !hasExplicitContent) return null;
    if (!preview && !path) return null;
    if (parts.length <= 1) return null;
    return parts.join('\n');
  }

  return parts.length > 1 ? parts.join('\n') : null;
}

function readFilePath(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const input = rawInput as Record<string, unknown>;
  const path = stringValue(input.path) ?? stringValue(input.filePath);
  return path ?? null;
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
    const path = readFilePath(rawInput);
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
    const command = `acp:${kind}\n---\n${material}`;
    return {
      type: 'ask_approval',
      reason: `${title} — ${kind} [sha256=${digest}]${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'run_command', command, cwd },
    };
  }
  if (kind === 'delete') {
    const path = readFilePath(rawInput);
    if (!path) return null;
    return {
      type: 'ask_approval',
      reason: `${title} — delete ${path}${toolCallId ? ` (${toolCallId})` : ''}`,
      requested_action: { type: 'run_command', command: `acp:delete:${path}`, cwd },
    };
  }
  if (kind === 'execute' || kind === 'bash' || kind === 'run_command' || kind === 'shell') {
    const shell = effectiveShellExecution(rawInput, cwd);
    if (!shell) return null;
    const material = [
      'shell',
      `command:${shell.command}`,
      `effectiveCwd:${shell.effectiveCwd}`,
      stableRawInputMaterial(shell.rawInput) ?? '',
    ].join('\n');
    const digest = digestHex(material);
    return {
      type: 'ask_approval',
      reason: `${title}${toolCallId ? ` (${toolCallId})` : ''} [sha256=${digest}]`,
      requested_action: { type: 'run_command', command: shell.command, cwd: shell.effectiveCwd },
    };
  }

  return null;
}

export function brokerInputFromPermissionAction(
  action: AgentAction,
  sessionCwd: string,
): { action: AgentAction; cwd: string } | null {
  if (action.type !== 'ask_approval') return null;
  const inner = action.requested_action;
  if (inner.type === 'run_command') {
    return { action: inner, cwd: inner.cwd ?? sessionCwd };
  }
  if (inner.type === 'read_file') {
    return { action: inner, cwd: sessionCwd };
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
