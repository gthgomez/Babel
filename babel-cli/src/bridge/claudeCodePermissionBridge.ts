import { createHash } from 'node:crypto';

import type { AgentAction } from '../agent/actions.js';
import type { RemoteApprovalBroker } from './remoteApproval.js';
import type { ClaudeCanUseToolDecision, ClaudeCanUseToolRequest } from './claudeCodeSdkPort.js';

function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

function toolToAction(req: ClaudeCanUseToolRequest, cwd: string): AgentAction | null {
  const name = req.toolName;
  const input = req.input;
  if (name === 'Read' || name === 'Glob' || name === 'Grep') {
    const path =
      typeof input.path === 'string'
        ? input.path
        : typeof input.file_path === 'string'
          ? input.file_path
          : '';
    if (!path) return null;
    return {
      type: 'ask_approval',
      reason: `Claude ${name} ${path}`,
      requested_action: { type: 'read_file', path },
    };
  }
  if (name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) return null;
    return {
      type: 'ask_approval',
      reason: `Claude Bash: ${command.slice(0, 200)}`,
      requested_action: { type: 'run_command', command, cwd },
    };
  }
  if (name === 'Write') {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    if (!path) return null;
    const content = typeof input.content === 'string' ? input.content : '';
    return {
      type: 'ask_approval',
      reason: `Claude Write ${path}`,
      requested_action: {
        type: 'write_file',
        path,
        content,
      },
    };
  }
  if (name === 'Edit') {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    const oldString = typeof input.old_string === 'string' ? input.old_string : '';
    const newString = typeof input.new_string === 'string' ? input.new_string : '';
    if (!path) return null;
    const payload = stableJson({ file_path: path, old_string: oldString, new_string: newString });
    return {
      type: 'ask_approval',
      reason: `Claude Edit ${path}`,
      requested_action: {
        type: 'run_command',
        command: `claude-sdk:Edit:${path}\n---\n${payload}`,
        cwd,
      },
    };
  }
  return null;
}

export async function bridgeClaudeCanUseTool(input: {
  req: ClaudeCanUseToolRequest;
  cwd: string;
  threadId: string;
  turnId: string;
  broker: RemoteApprovalBroker;
  generation: number;
  activeGeneration: () => number;
  notify?: (notification: unknown) => void;
}): Promise<ClaudeCanUseToolDecision> {
  if (input.req.signal?.aborted) {
    return { behavior: 'deny', message: 'aborted' };
  }
  if (input.activeGeneration() !== input.generation) {
    return { behavior: 'deny', message: 'stale_generation' };
  }
  const action = toolToAction(input.req, input.cwd);
  if (!action) {
    return { behavior: 'deny', message: 'unknown_tool_representation' };
  }
  const toolTag = input.req.toolUseID ? ` toolUseID=${input.req.toolUseID}` : '';
  const digest = sha256Utf8(
    stableJson({
      toolName: input.req.toolName,
      toolUseID: input.req.toolUseID ?? null,
      input: input.req.input,
    }),
  );
  const allowed = await input.broker.requestAllowOnce({
    action:
      action.type === 'ask_approval'
        ? {
            ...action,
            reason: `${action.reason}${toolTag} digest=${digest.slice(0, 16)}`,
          }
        : action,
    thread_id: input.threadId,
    turn_id: input.turnId,
    cwd: input.cwd,
    ...(input.notify ? { notify: input.notify } : {}),
  });
  if (!allowed) {
    return { behavior: 'deny', message: 'remote_denied_or_stale' };
  }
  if (input.req.signal?.aborted) {
    return { behavior: 'deny', message: 'aborted_after_approval' };
  }
  if (input.activeGeneration() !== input.generation) {
    return { behavior: 'deny', message: 'stale_generation_after_approval' };
  }
  return { behavior: 'allow', updatedInput: input.req.input };
}
