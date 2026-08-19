/**
 * Inline JIT approval flow for chat-mode tool execution.
 * Routes through ApprovalRequest (deny / once / session / narrow_rule).
 */

import type { AgentAction } from './actions.js';
import {
  InputCoordinator,
  agentActionToPermissionAction,
  promptPermissionDialog,
  dispatchInputArbiter,
} from '../ui/inputCoordinator.js';
import { getActiveRenderer } from '../ui/waterfall.js';
import type { ConversationalRenderer } from '../ui/waterfall.js';
import { chatActionTarget } from './chatToolDefinitions.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { isMcpChatAction } from './chatToolDefinitions.js';
import { isBabelHeadlessEnv } from '../utils/envFlags.js';
import { benchmarkAutoApproveEnabled } from './autonomyEnforcement.js';
import {
  buildApprovalRequest,
  resolveApprovalHeadless,
  applyApprovalDecision,
  isPreApproved,
  inferCapabilityFromCommand,
  createApprovalSession,
  type ApprovalSessionState,
  type ApprovalDecision,
  type ApprovalCapability,
} from './approvalRequests.js';
import {
  approvalOperationFromAgentAction,
  approvalOperationFromChatTool,
  digestApprovalOperation,
  operationDigestMatches,
} from './approvalOperation.js';

function asConversationalRenderer(
  renderer: ReturnType<typeof getActiveRenderer>,
): ConversationalRenderer | null {
  if (!renderer || !('showApprovalPending' in renderer)) {
    return null;
  }
  return renderer as ConversationalRenderer;
}

/** Process-wide approval session (REPL / chat). Subagents get derived ceilings. */
let _approvalSession: ApprovalSessionState = createApprovalSession('chat-default');
/** Current parity turn id for ApprovalRequest correlation with thread_events. */
let _approvalTurnId: string | null = null;

export function getChatApprovalSession(): ApprovalSessionState {
  return _approvalSession;
}

export function resetChatApprovalSession(threadId = 'chat-default'): void {
  _approvalSession = createApprovalSession(threadId);
  _approvalTurnId = null;
}

export function bindChatApprovalSession(session: ApprovalSessionState): void {
  _approvalSession = session;
}

/** Bind the active parity turn id so approvals join the event-log timeline. */
export function setChatApprovalTurnId(turnId: string | null): void {
  _approvalTurnId = turnId;
}

function currentApprovalTurnId(): string {
  return _approvalTurnId ?? `turn-${Date.now()}`;
}

function commandForAction(action: AgentAction): string {
  if (action.type === 'run_command') return action.command;
  if (action.type === 'write_file') return `write ${action.path}`;
  if (action.type === 'apply_patch') return 'apply_patch';
  if (action.type === 'test_run') return action.command;
  return action.type;
}

function capabilityForAction(action: AgentAction): ApprovalCapability {
  if (action.type === 'run_command' || action.type === 'test_run') {
    return inferCapabilityFromCommand(
      action.type === 'run_command' ? action.command : action.command,
    );
  }
  if (action.type === 'write_file' || action.type === 'apply_patch') return 'write';
  return 'other';
}

/**
 * Resolve approval for an agent action using the P1-D ApprovalRequest path.
 * Interactive: maps dialog allow/deny to allow_once / deny (session grant via
 * BABEL_APPROVAL_SESSION=1 → allow_session).
 * Headless: deterministic deny unless pre-approved.
 */
export async function requestChatActionApproval(action: AgentAction): Promise<boolean> {
  const permissionAction = agentActionToPermissionAction(action);
  if (!permissionAction) {
    return false;
  }

  const cwd = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  const operation = approvalOperationFromAgentAction(action, {
    thread_id: _approvalSession.thread_id,
    turn_id: currentApprovalTurnId(),
    cwd,
  });
  const operationDigest = digestApprovalOperation(operation);
  const proposedScope = operation.target_path
    ? `${capabilityForAction(action)}:${operation.target_path}:${operation.payload_sha256 ?? 'nopayload'}`
    : `${capabilityForAction(action)}:${operation.command ?? action.type}:${operation.payload_sha256 ?? 'nopayload'}`;
  const req = buildApprovalRequest({
    thread_id: _approvalSession.thread_id,
    turn_id: currentApprovalTurnId(),
    command: commandForAction(action),
    cwd,
    capability: capabilityForAction(action),
    proposed_scope: proposedScope,
    reason: `Policy requires approval for ${action.type}`,
    operation_digest: operationDigest,
  });

  const liveStillMatches = (): boolean =>
    operationDigestMatches(
      operationDigest,
      approvalOperationFromAgentAction(action, {
        thread_id: _approvalSession.thread_id,
        turn_id: currentApprovalTurnId(),
        cwd,
      }),
    );

  if (isPreApproved(_approvalSession, req) && liveStillMatches()) {
    applyApprovalDecision(_approvalSession, req, 'allow_once');
    return true;
  }

  // #88 P0-4: both AUTO_APPROVE and MODE are required. CI/headless never
  // establish benchmark authority. #90: live operation must still match
  // the digest bound to this approval.
  if (benchmarkAutoApproveEnabled() && liveStillMatches()) {
    applyApprovalDecision(_approvalSession, req, 'allow_once');
    return true;
  }

  const headless =
    isBabelHeadlessEnv() || !process.stdout.isTTY || process.env['CI'] === 'true';

  if (headless) {
    if (!liveStillMatches()) {
      applyApprovalDecision(_approvalSession, req, 'deny');
      return false;
    }
    const res = resolveApprovalHeadless(_approvalSession, req);
    return res.decision !== 'deny';
  }

  const coordinator = InputCoordinator.getInstance();
  const target =
    action.type === 'run_command'
      ? action.command
      : action.type === 'write_file'
        ? action.path
        : action.type === 'apply_patch'
          ? 'patch'
          : action.type;

  return coordinator.withLock('jit', async () => {
    dispatchInputArbiter({ type: 'approval_open' });
    const renderer = getActiveRenderer();
    const conv = asConversationalRenderer(renderer);
    renderer?.pauseTicks();
    coordinator.startBuffering();
    try {
      conv?.showApprovalPending(action.type, target);
      const allowed = await promptPermissionDialog(permissionAction);
      if (allowed && !liveStillMatches()) {
        applyApprovalDecision(_approvalSession, req, 'deny');
        return false;
      }
      const decision: ApprovalDecision =
        allowed && process.env['BABEL_APPROVAL_SESSION'] === '1'
          ? 'allow_session'
          : allowed
            ? 'allow_once'
            : 'deny';
      applyApprovalDecision(_approvalSession, req, decision);
      return allowed;
    } finally {
      conv?.clearApprovalPending();
      const flushed = coordinator.stopBuffering();
      if (flushed) {
        process.stdout.write(flushed);
      }
      renderer?.resumeTicks();
      dispatchInputArbiter({ type: 'approval_close' });
    }
  });
}

/** Approval helper when only the chat tool shape is available at the call site. */
export async function requestChatToolApproval(action: ChatToolAction): Promise<boolean> {
  if (action.type === 'write_file' || action.type === 'apply_patch') {
    return requestChatActionApproval(action as unknown as AgentAction);
  }
  if (action.type === 'run_command') {
    return requestChatActionApproval({ type: 'run_command', command: action.command });
  }
  return false;
}

export function approvalTargetForChatAction(action: ChatToolAction): string {
  return chatActionTarget(action);
}

/** JIT approval for MCP tool calls in chat mode. */
export async function requestMcpApproval(action: ChatToolAction): Promise<boolean> {
  if (!isMcpChatAction(action)) {
    return false;
  }
  const server = action.server;
  const permissionAction = {
    type: 'mcp_call' as const,
    toolName: server,
    arguments: JSON.stringify(action, null, 2),
  };
  const cwd = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd();
  const operation = approvalOperationFromChatTool(action, {
    thread_id: _approvalSession.thread_id,
    turn_id: currentApprovalTurnId(),
    cwd,
  });
  const operationDigest = digestApprovalOperation(operation);
  const req = buildApprovalRequest({
    thread_id: _approvalSession.thread_id,
    turn_id: currentApprovalTurnId(),
    command: `mcp:${server}`,
    cwd,
    capability: 'mcp',
    proposed_scope: `mcp:${server}:${operation.mcp_arguments_sha256 ?? 'noargs'}`,
    reason: `MCP call to ${server}`,
    operation_digest: operationDigest,
  });
  const liveStillMatches = (): boolean =>
    operationDigestMatches(
      operationDigest,
      approvalOperationFromChatTool(action, {
        thread_id: _approvalSession.thread_id,
        turn_id: currentApprovalTurnId(),
        cwd,
      }),
    );
  if (isPreApproved(_approvalSession, req) && liveStillMatches()) return true;
  if (isBabelHeadlessEnv() || !process.stdout.isTTY || process.env['CI'] === 'true') {
    return resolveApprovalHeadless(_approvalSession, req).decision !== 'deny';
  }
  const coordinator = InputCoordinator.getInstance();
  const conv = asConversationalRenderer(getActiveRenderer());
  return coordinator.withLock('jit', async () => {
    dispatchInputArbiter({ type: 'approval_open' });
    const renderer = getActiveRenderer();
    renderer?.pauseTicks();
    coordinator.startBuffering();
    try {
      conv?.showApprovalPending(action.type, server);
      const allowed = await promptPermissionDialog(permissionAction);
      if (allowed && !liveStillMatches()) {
        applyApprovalDecision(_approvalSession, req, 'deny');
        return false;
      }
      applyApprovalDecision(
        _approvalSession,
        req,
        allowed ? 'allow_once' : 'deny',
      );
      return allowed;
    } finally {
      conv?.clearApprovalPending();
      const flushed = coordinator.stopBuffering();
      if (flushed) {
        process.stdout.write(flushed);
      }
      renderer?.resumeTicks();
      dispatchInputArbiter({ type: 'approval_close' });
    }
  });
}
