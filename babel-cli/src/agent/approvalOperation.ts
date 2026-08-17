/**
 * Operation identity for approvals. Digest must be recomputed from the live
 * action immediately before execution; a mismatch is a deny.
 */

import { createHash } from 'node:crypto';

import type { AgentAction } from './actions.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { isMcpChatAction } from './chatToolDefinitions.js';

export interface ApprovalOperation {
  thread_id: string;
  turn_id: string;
  action_type: string;
  canonical_cwd: string;
  command?: string;
  target_path?: string;
  payload_sha256?: string;
  mcp_server?: string;
  mcp_tool?: string;
  mcp_arguments_sha256?: string;
}

function sha256Utf8(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export function canonicalizeApprovalOperation(op: ApprovalOperation): string {
  const ordered: ApprovalOperation = {
    thread_id: op.thread_id,
    turn_id: op.turn_id,
    action_type: op.action_type,
    canonical_cwd: op.canonical_cwd,
    ...(op.command !== undefined ? { command: op.command } : {}),
    ...(op.target_path !== undefined ? { target_path: op.target_path } : {}),
    ...(op.payload_sha256 !== undefined ? { payload_sha256: op.payload_sha256 } : {}),
    ...(op.mcp_server !== undefined ? { mcp_server: op.mcp_server } : {}),
    ...(op.mcp_tool !== undefined ? { mcp_tool: op.mcp_tool } : {}),
    ...(op.mcp_arguments_sha256 !== undefined
      ? { mcp_arguments_sha256: op.mcp_arguments_sha256 }
      : {}),
  };
  return stableJson(ordered);
}

export function digestApprovalOperation(op: ApprovalOperation): string {
  return sha256Utf8(canonicalizeApprovalOperation(op));
}

export function approvalOperationFromAgentAction(
  action: AgentAction,
  ctx: { thread_id: string; turn_id: string; cwd: string },
): ApprovalOperation {
  const base: ApprovalOperation = {
    thread_id: ctx.thread_id,
    turn_id: ctx.turn_id,
    action_type: action.type,
    canonical_cwd: ctx.cwd,
  };
  if (action.type === 'run_command' || action.type === 'test_run') {
    return {
      ...base,
      command: action.command,
      ...(action.cwd ? { target_path: action.cwd } : {}),
    };
  }
  if (action.type === 'write_file') {
    return {
      ...base,
      target_path: action.path,
      payload_sha256: sha256Utf8(action.content),
    };
  }
  if (action.type === 'apply_patch') {
    return {
      ...base,
      command: 'apply_patch',
      payload_sha256: sha256Utf8(action.patch),
    };
  }
  return base;
}

export function approvalOperationFromChatTool(
  action: ChatToolAction,
  ctx: { thread_id: string; turn_id: string; cwd: string },
): ApprovalOperation {
  if (isMcpChatAction(action)) {
    const query = 'query' in action ? action.query : undefined;
    return {
      thread_id: ctx.thread_id,
      turn_id: ctx.turn_id,
      action_type: action.type,
      canonical_cwd: ctx.cwd,
      mcp_server: action.server,
      mcp_arguments_sha256: sha256Utf8(stableJson(query ?? {})),
    };
  }
  return approvalOperationFromAgentAction(action as AgentAction, ctx);
}

export function operationDigestMatches(expected: string, live: ApprovalOperation): boolean {
  return expected === digestApprovalOperation(live);
}
