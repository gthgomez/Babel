/**
 * wire.ts — lease-aware decision composite for the tool dispatch PEP.
 *
 * Combines the legacy preset decision (decideAction) with the authority PDP
 * in a single precedence order — deny > ask > allow — so the strictest
 * outcome wins from either layer: a read_only preset deny is never
 * downgraded to an approval prompt, and an ask_before_mutation preset ask
 * is never dropped by a PDP allow. PDP 'verify' maps to 'allow' at
 * dispatch (the completion gate enforces the verify requirement —
 * iteration continues while checks are red). Emits agent audit events with
 * the stable reason code for every PDP decision.
 *
 * Integrity (MERGE_AND_FIX_P0):
 *  - When a lease AND a session-start baseline manifest are supplied, drift
 *    is evaluated BEFORE any privileged decision. Drift → deterministic deny
 *    with DENY_POLICY_INTEGRITY_DRIFT, and the lease is PERMANENTLY
 *    invalidated (every later decision denies) — a single drift event cannot
 *    be papered over by one denied call.
 *  - The self-mutation guard inspects REAL patch targets (shared
 *    patchTargets extractor), never the raw diff body.
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
import { checkBaseline, isGovernancePath, repoRelativeFromCwd } from './integrity.js';
import { extractPatchRawTargets } from './patchTargets.js';

export interface LeaseContext {
  lease: AutonomyLease | null;
  /** Session-start baseline. Required when a lease is active. */
  baseline?: { repoRoot: string; manifest: import('./integrity.js').BaselineManifest };
  /** Execution cwd for relative action paths (defaults to baseline.repoRoot). */
  cwd?: string;
}

// ─── Permanent drift invalidation ───────────────────────────────────────────

/** Lease ids that have seen baseline drift — permanently denied. */
const invalidatedLeases = new Set<string>();

/** Permanently invalidate a lease after drift (fail-closed, no recovery path). */
export function invalidateLease(leaseId: string): void {
  invalidatedLeases.add(leaseId);
}

/** True once a lease has been invalidated by baseline drift. */
export function isLeaseInvalidated(leaseId: string): boolean {
  return invalidatedLeases.has(leaseId);
}

/** Test hook: clear the invalidation set (never call from runtime paths). */
export function resetLeaseInvalidations(): void {
  invalidatedLeases.clear();
}

// ─── Decision composite ─────────────────────────────────────────────────────

/** Convert a shell command action into a structured ActionRequest (best-effort). */
export function actionRequestFromAction(action: AgentAction): ActionRequest | null {
  if (action.type === 'run_command' || action.type === 'test_run') {
    const parsed = parseGitCommand(action.command);
    return {
      capability: parsed.capability,
      ...(parsed.remote !== undefined ? { remote: parsed.remote } : {}),
      ...(parsed.destinationBranch !== undefined ? { destinationBranch: parsed.destinationBranch } : {}),
      ...(parsed.sourceBranch !== undefined ? { sourceBranch: parsed.sourceBranch } : {}),
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

  // Permanent drift lock: an invalidated lease denies every subsequent
  // decision, before anything else is evaluated.
  if (ctx.lease && isLeaseInvalidated(ctx.lease.leaseId)) {
    return { decision: 'deny', reasonCode: 'DENY_POLICY_INTEGRITY_DRIFT' };
  }

  // Active lease requires a session-start baseline. Missing context is
  // fail-closed — callers must not authorize after omitting capture.
  if (ctx.lease && !ctx.baseline) {
    emitAgentEvent({
      type: 'policy_decision',
      action: `${action.type}:authority_context`,
      decision: 'deny',
      preset,
      rule: 'DENY_AUTHORITY_CONTEXT_INCOMPLETE',
    });
    return { decision: 'deny', reasonCode: 'DENY_AUTHORITY_CONTEXT_INCOMPLETE' };
  }

  // Baseline drift evaluation before ANY privileged decision (fail-closed).
  // The baseline is the immutable session-start snapshot — never recaptured.
  if (ctx.lease && ctx.baseline) {
    const drift = checkBaseline(ctx.baseline.repoRoot, ctx.baseline.manifest);
    if (!drift.ok) {
      invalidateLease(ctx.lease.leaseId);
      emitAgentEvent({
        type: 'policy_decision',
        action: `${action.type}:integrity`,
        decision: 'deny',
        preset,
        rule: 'DENY_POLICY_INTEGRITY_DRIFT',
      });
      return { decision: 'deny', reasonCode: 'DENY_POLICY_INTEGRITY_DRIFT' };
    }
  }

  // Policy self-mutation guard: mutating a governance path is denied outright
  // (DENY_POLICY_SELF_MUTATION) whenever a lease is active — even if the
  // legacy preset would allow it. apply_patch targets are extracted from the
  // diff headers via the shared extractor; the raw patch body is never fed to
  // isGovernancePath. Relative targets are resolved against execution cwd.
  if (ctx.lease && (action.type === 'write_file' || action.type === 'apply_patch')) {
    const rawTargets =
      action.type === 'apply_patch' ? extractPatchRawTargets(action.patch) : [action.path];
    const repoRoot = ctx.baseline?.repoRoot;
    const cwd = ctx.cwd ?? repoRoot;
    const targets =
      repoRoot && cwd
        ? rawTargets.map((t) => repoRelativeFromCwd(cwd, repoRoot, t))
        : rawTargets;
    const governanceTarget = targets.find((t) => t && isGovernancePath(t));
    if (governanceTarget) {
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

  // Combine legacy and PDP outcomes in a single precedence order
  // (deny > ask > allow): the strictest outcome wins, so a read_only
  // preset deny cannot be downgraded to an approval prompt by the PDP,
  // and an ask_before_mutation preset ask is not silently dropped by a
  // PDP allow. 'verify' maps to 'allow' at dispatch — the completion
  // gate enforces the verify requirement.
  const pdpDecision: PermissionDecision = pdp.outcome === 'verify' ? 'allow' : pdp.outcome;
  if (legacy === 'deny' || pdpDecision === 'deny') {
    return { decision: 'deny', reasonCode: pdp.reasonCode };
  }
  if (legacy === 'ask' || pdpDecision === 'ask') {
    return { decision: 'ask', reasonCode: pdp.reasonCode };
  }
  return { decision: 'allow', reasonCode: pdp.reasonCode };
}
