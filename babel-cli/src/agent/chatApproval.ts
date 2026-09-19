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
import { getRemoteSurface } from '../bridge/remoteApproval.js';
import { getExecutionContext } from './executionContext.js';

function asConversationalRenderer(
  renderer: ReturnType<typeof getActiveRenderer>,
): ConversationalRenderer | null {
  if (!renderer || !('showApprovalPending' in renderer)) {
    return null;
  }
  return renderer as ConversationalRenderer;
}

/**
 * Startup / REPL approval session. This is a *fallback* only: when an
 * execution context is bound (S04/#214), the context's approval session is
 * authoritative and the global is never read.
 */
let _approvalSession: ApprovalSessionState = createApprovalSession('chat-default');
/** Startup turn id fallback. Execution context turn ids win when bound. */
let _approvalTurnId: string | null = null;

/** S04/#214: cross-scope mutation of the fallback is refused while bound. */
function assertNoBoundExecutionContext(fn: string): void {
  if (getExecutionContext()) {
    throw new Error(
      `S04/#214: ${fn} must not mutate global approval state inside a bound execution context; ` +
        'derive/bind an execution context instead.',
    );
  }
}

export function getChatApprovalSession(): ApprovalSessionState {
  return getExecutionContext()?.approvalSession ?? _approvalSession;
}

export function resetChatApprovalSession(threadId = 'chat-default'): void {
  _approvalSession = createApprovalSession(threadId);
  _approvalTurnId = null;
}

/**
 * Compatibility adapter. Only mutates the startup fallback and is inert-refusing
 * when an execution context is bound, so it cannot silently cross ownership.
 */
export function bindChatApprovalSession(session: ApprovalSessionState): void {
  assertNoBoundExecutionContext('bindChatApprovalSession');
  _approvalSession = session;
}

/**
 * Compatibility adapter for the startup turn id. Refuses while a context is
 * bound (the owning context carries its own turn id); this fixes the
 * never-restored global that two engines could overwrite.
 */
export function setChatApprovalTurnId(turnId: string | null): void {
  assertNoBoundExecutionContext('setChatApprovalTurnId');
  _approvalTurnId = turnId;
}

function currentApprovalTurnId(): string {
  return getExecutionContext()?.turnId ?? _approvalTurnId ?? `turn-${Date.now()}`;
}

function effectiveApprovalRoot(): string {
  return (
    getExecutionContext()?.root ?? process.env['BABEL_PROJECT_ROOT'] ?? process.cwd()
  );
}

function effectiveApprovalSession(): ApprovalSessionState {
  return getExecutionContext()?.approvalSession ?? _approvalSession;
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
  const remote = getRemoteSurface();
  if (remote) {
    // Default remote supervision is clarification/lease, not ALLOW_ONCE.
    // Optional operator mode keeps the digest-bound broker.
    if (process.env['BABEL_REMOTE_OPERATOR_APPROVAL'] === '1') {
      return remote.broker.requestAllowOnce({
        action,
        thread_id: remote.threadId,
        turn_id: remote.turnId,
        cwd: remote.cwd,
        ...(remote.notify ? { notify: remote.notify } : {}),
      });
    }
    return false;
  }

  const permissionAction = agentActionToPermissionAction(action);
  if (!permissionAction) {
    return false;
  }

  // S04/#214: resolve the effective context ONCE so thread/turn/session/root
  // stay consistent across the async approval window.
  const session = effectiveApprovalSession();
  const turnId = currentApprovalTurnId();
  const cwd = effectiveApprovalRoot();
  const operation = approvalOperationFromAgentAction(action, {
    thread_id: session.thread_id,
    turn_id: turnId,
    cwd,
  });
  const operationDigest = digestApprovalOperation(operation);
  const proposedScope = operation.target_path
    ? `${capabilityForAction(action)}:${operation.target_path}:${operation.payload_sha256 ?? 'nopayload'}`
    : `${capabilityForAction(action)}:${operation.command ?? action.type}:${operation.payload_sha256 ?? 'nopayload'}`;
  const req = buildApprovalRequest({
    thread_id: session.thread_id,
    turn_id: turnId,
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
        thread_id: session.thread_id,
        turn_id: turnId,
        cwd,
      }),
    );

  if (isPreApproved(session, req) && liveStillMatches()) {
    applyApprovalDecision(session, req, 'allow_once');
    return true;
  }

  // #88 P0-4: both AUTO_APPROVE and MODE are required. CI/headless never
  // establish benchmark authority. #90: live operation must still match
  // the digest bound to this approval.
  if (benchmarkAutoApproveEnabled() && liveStillMatches()) {
    applyApprovalDecision(session, req, 'allow_once');
    return true;
  }

  const headless =
    isBabelHeadlessEnv() || !process.stdout.isTTY || process.env['CI'] === 'true';

  if (headless) {
    if (!liveStillMatches()) {
      applyApprovalDecision(session, req, 'deny');
      return false;
    }
    const res = resolveApprovalHeadless(session, req);
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
        applyApprovalDecision(session, req, 'deny');
        return false;
      }
      const decision: ApprovalDecision =
        allowed && process.env['BABEL_APPROVAL_SESSION'] === '1'
          ? 'allow_session'
          : allowed
            ? 'allow_once'
            : 'deny';
      applyApprovalDecision(session, req, decision);
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
  const remote = getRemoteSurface();
  if (remote?.failClosedMcp) {
    return false;
  }
  const server = action.server;
  const permissionAction = {
    type: 'mcp_call' as const,
    toolName: server,
    arguments: JSON.stringify(action, null, 2),
  };
  const session = effectiveApprovalSession();
  const turnId = currentApprovalTurnId();
  const cwd = effectiveApprovalRoot();
  const operation = approvalOperationFromChatTool(action, {
    thread_id: session.thread_id,
    turn_id: turnId,
    cwd,
  });
  const operationDigest = digestApprovalOperation(operation);
  const req = buildApprovalRequest({
    thread_id: session.thread_id,
    turn_id: turnId,
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
        thread_id: session.thread_id,
        turn_id: turnId,
        cwd,
      }),
    );
  if (isPreApproved(session, req) && liveStillMatches()) return true;
  if (isBabelHeadlessEnv() || !process.stdout.isTTY || process.env['CI'] === 'true') {
    return resolveApprovalHeadless(session, req).decision !== 'deny';
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
        applyApprovalDecision(session, req, 'deny');
        return false;
      }
      applyApprovalDecision(session, req, allowed ? 'allow_once' : 'deny');
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
