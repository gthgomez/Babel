import type { AgentAction } from '../agent/actions.js';
import type { RemoteApprovalBroker } from './remoteApproval.js';
import type { ClaudeCanUseToolDecision, ClaudeCanUseToolRequest } from './claudeCodeSdkPort.js';

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
  if (name === 'Write' || name === 'Edit') {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    if (!path) return null;
    const content = typeof input.content === 'string' ? input.content : '';
    return {
      type: 'ask_approval',
      reason: `Claude ${name} ${path}`,
      requested_action: {
        type: 'run_command',
        command: `claude-sdk:${name}:${path}\n---\n${content}`,
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
  if (input.activeGeneration() !== input.generation) {
    return { behavior: 'deny', message: 'stale_generation' };
  }
  const action = toolToAction(input.req, input.cwd);
  if (!action) {
    return { behavior: 'deny', message: 'unknown_tool_representation' };
  }
  const allowed = await input.broker.requestAllowOnce({
    action,
    thread_id: input.threadId,
    turn_id: input.turnId,
    cwd: input.cwd,
    ...(input.notify ? { notify: input.notify } : {}),
  });
  if (!allowed) {
    return { behavior: 'deny', message: 'remote_denied_or_stale' };
  }
  if (input.activeGeneration() !== input.generation) {
    return { behavior: 'deny', message: 'stale_generation_after_approval' };
  }
  return { behavior: 'allow', updatedInput: input.req.input };
}
