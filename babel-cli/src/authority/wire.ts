/**
 * wire.ts — lease-aware decision composite for the tool dispatch PEP.
 *
 * Combines the legacy preset decision (decideAction) with the authority PDP:
 * deny-overrides-allow; ask beats allow; PDP 'verify' maps to 'allow' at
 * dispatch (the completion gate enforces the verify requirement — iteration
 * continues while checks are red). Emits agent audit events with the stable
 * reason code for every PDP decision.
 *
 * Additive: with no active lease, behavior is byte-identical to legacy
 * decideAction.
 */

import type { AgentAction } from '../agent/actions.js';
import { emitAgentEvent } from '../agent/events.js';
import { decideAction, type PermissionDecision, type PermissionPreset } from '../agent/policy.js';
import type { AutonomyLease } from './lease.js';
import { decideActionRequest, type ActionRequest } from './pdp.js';
import { parseGitCommand } from './gitCommand.js';
import type { ReasonCode } from './reasonCodes.js';
import { isGovernancePath } from './integrity.js';

export interface LeaseContext {
  lease: AutonomyLease | null;
  /** Optional baseline manifest for policy-integrity checks (session-start snapshot). */
  baseline?: { repoRoot: string; manifest: import('./integrity.js').BaselineManifest };
}

/** Convert a shell command action into a structured ActionRequest (best-effort). */
export function actionRequestFromAction(action: AgentAction): ActionRequest | null {
  if (action.type === 'run_command' || action.type === 'test_run') {
    const parsed = parseGitCommand(action.command);
    return {
      capability: parsed.capability,
      ...(parsed.remote !== undefined ? { remote: parsed.remote } : {}),
      ...(parsed.destinationBranch !== undefined ? { destinationBranch: parsed.destinationBranch } : {}),
      ...(parsed.sourceBranch !== undefined ? { sourceBranch: parsed.sourceBranch } : {}),
      ...(parsed.visibility !== undefined ? { visibility: parsed.visibility } : {}),
      force: parsed.force,
      delete: parsed.delete,
    };
  }
  return null;
}

/**
 * Lease-aware decision. Returns the final PermissionDecision plus the reason
 * code ('' when the legacy path decided, i.e. no lease influence).
 */
export function decideWithLease(
  action: AgentAction,
  preset: PermissionPreset,
  ctx: LeaseContext,
): { decision: PermissionDecision; reasonCode: ReasonCode | '' } {
  const legacy = decideAction(action, preset);

  // Policy self-mutation guard: mutating a governance path is denied outright
  // (DENY_POLICY_SELF_MUTATION) whenever a lease is active — even if the
  // legacy preset would allow it.
  if (ctx.lease && (action.type === 'write_file' || action.type === 'apply_patch')) {
    const path = action.type === 'write_file' ? action.path : action.patch;
    if (path && isGovernancePath(path)) {
      emitAgentEvent({
        type: 'policy_decision',
        action: action.type,
        decision: 'deny',
        preset,
        rule: 'DENY_POLICY_SELF_MUTATION',
      });
      return { decision: 'deny', reasonCode: 'DENY_POLICY_SELF_MUTATION' };
    }
  }

  if (!ctx.lease) {
    return { decision: legacy, reasonCode: '' };
  }

  const req = actionRequestFromAction(action);
  if (!req) {
    return { decision: legacy, reasonCode: '' };
  }

  const pdp = decideActionRequest(req, ctx.lease);

  emitAgentEvent({
    type: 'policy_decision',
    action: `${action.type}:${req.capability}`,
    // Event decision space is allow/ask/deny; 'verify' is carried by the
    // reason code (VERIFY_BEFORE_PUBLICATION).
    decision: pdp.outcome === 'verify' ? 'allow' : pdp.outcome,
    preset,
    rule: pdp.reasonCode,
  });

  // Map PDP outcome onto the legacy decision space (deny > ask > allow).
  switch (pdp.outcome) {
    case 'deny':
      return { decision: 'deny', reasonCode: pdp.reasonCode };
    case 'ask':
      return { decision: 'ask', reasonCode: pdp.reasonCode };
    case 'verify':
      // Iteration continues; completion gate enforces VERIFY_BEFORE_PUBLICATION.
      return { decision: legacy === 'deny' ? 'deny' : 'allow', reasonCode: pdp.reasonCode };
    case 'allow':
      return { decision: legacy === 'deny' ? 'deny' : 'allow', reasonCode: pdp.reasonCode };
  }
}
