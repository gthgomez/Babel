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
import { evaluateLeaseTemporalValidity } from './leaseTime.js';
import { decideActionRequest } from './pdp.js';
import { actionRequestFromAction, isControlAgentAction } from './actionRequest.js';
import { decodeCommand, isGatedGitPush, type CommandSemanticClass } from './commandDecoder.js';
import type { ReasonCode } from './reasonCodes.js';
import { checkBaseline, isAuthorityStatePath, isGovernancePath, repoRelativeFromCwd } from './integrity.js';
import {
  CAPABILITY_KINDS,
  isPrivilegedCapability,
  isProtectedBranch,
  requestRequiresIsolation,
} from './capabilities.js';

const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'] as const;

const NO_LEASE_DENIED_SEMANTICS = new Set<CommandSemanticClass>([
  'create_pr',
  'external_message',
  'deploy',
  'infrastructure_mutation',
  'delete_destructive',
  'git_history_rewrite',
  'financial_external_effect',
  'credential_access',
]);
import { extractPatchRawTargets } from './patchTargets.js';
import { markSessionInvalidated, type AuthoritySessionContext } from './sessionContext.js';

export interface LeaseContext {
  lease: AutonomyLease | null;
  /** Session-start baseline. Required when a lease is active. */
  baseline?: { repoRoot: string; manifest: import('./integrity.js').BaselineManifest };
  /** Execution cwd for relative action paths (defaults to baseline.repoRoot). */
  cwd?: string;
  authoritySession?: AuthoritySessionContext;
  /** Injectable clock for lease expiry. */
  now?: Date | number;
  /**
   * True only when an OS sandbox will wrap arbitrary code. Defaults to false
   * (fail closed). Host-user env stripping is not isolation.
   */
  isolationAvailable?: boolean;
}

export { actionRequestFromAction } from './actionRequest.js';

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

  const now = ctx.now ?? Date.now();

  if (ctx.authoritySession?.resumeFailure) {
    emitAgentEvent({
      type: 'policy_decision',
      action: `${action.type}:authority_resume`,
      decision: 'deny',
      preset,
      rule: 'DENY_AUTHORITY_RESUME_MISMATCH',
    });
    return { decision: 'deny', reasonCode: 'DENY_AUTHORITY_RESUME_MISMATCH' };
  }

  // Permanent drift lock: an invalidated lease denies every subsequent
  // decision, before anything else is evaluated.
  if (
    ctx.lease &&
    (isLeaseInvalidated(ctx.lease.leaseId) || ctx.authoritySession?.invalidated === true)
  ) {
    if (ctx.authoritySession && !ctx.authoritySession.invalidated) {
      markSessionInvalidated(ctx.authoritySession);
    }
    if (ctx.lease) invalidateLease(ctx.lease.leaseId);
    return { decision: 'deny', reasonCode: 'DENY_POLICY_INTEGRITY_DRIFT' };
  }

  if (ctx.lease) {
    const temporal = evaluateLeaseTemporalValidity(ctx.lease, now);
    if (!temporal.ok) {
      emitAgentEvent({
        type: 'policy_decision',
        action: `${action.type}:lease_time`,
        decision: 'deny',
        preset,
        rule: temporal.reasonCode,
      });
      return { decision: 'deny', reasonCode: temporal.reasonCode };
    }
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
      if (ctx.authoritySession) markSessionInvalidated(ctx.authoritySession);
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

  // Policy / authority-state self-mutation: denied on the agent write surface
  // even when no lease is present. apply_patch targets come from diff headers,
  // never the raw patch body.
  if (action.type === 'write_file' || action.type === 'apply_patch') {
    const rawTargets =
      action.type === 'apply_patch' ? extractPatchRawTargets(action.patch) : [action.path];
    const repoRoot = ctx.baseline?.repoRoot;
    const cwd = ctx.cwd ?? repoRoot;
    const targets =
      repoRoot && cwd
        ? rawTargets.map((t) => repoRelativeFromCwd(cwd, repoRoot, t))
        : rawTargets;
    const governanceTarget = targets.find((t) => t && (isGovernancePath(t) || isAuthorityStatePath(t)));
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
    const privilegedReq = actionRequestFromAction(action);
    if (privilegedReq) {
      const kind = CAPABILITY_KINDS[privilegedReq.capability];
      if (kind === 'forbidden' || isPrivilegedCapability(privilegedReq.capability)) {
        return {
          decision: 'deny',
          reasonCode:
            privilegedReq.capability === 'expose_credentials'
              ? 'DENY_CREDENTIAL_READ'
              : 'DENY_MISSING_AUTHORITY',
        };
      }
      const dest = privilegedReq.destinationBranch;
      if (dest && isProtectedBranch(dest, DEFAULT_PROTECTED_BRANCHES)) {
        return { decision: 'deny', reasonCode: 'DENY_PROTECTED_BRANCH' };
      }
    }
    if (action.type === 'run_command' || action.type === 'test_run') {
      if (isGatedGitPush(action.command)) {
        return { decision: 'deny', reasonCode: 'DENY_MISSING_AUTHORITY' };
      }
      const decoded = decodeCommand(action.command);
      if (decoded.capability === 'run_arbitrary_code') {
        return { decision: 'deny', reasonCode: 'DENY_MISSING_AUTHORITY' };
      }
      if (
        decoded.capability !== 'unknown' &&
        requestRequiresIsolation({
          capability: decoded.capability,
          ...(decoded.requiresIsolation === true ? { requiresIsolation: true } : {}),
        }) &&
        ctx.isolationAvailable !== true
      ) {
        return { decision: 'deny', reasonCode: 'DENY_CAPABILITY_CONSTRAINT' };
      }
      if (NO_LEASE_DENIED_SEMANTICS.has(decoded.semantic)) {
        return {
          decision: 'deny',
          reasonCode:
            decoded.semantic === 'credential_access'
              ? 'DENY_CREDENTIAL_READ'
              : 'DENY_MISSING_AUTHORITY',
        };
      }
    }
    return { decision: legacy, reasonCode: '' };
  }

  const req = actionRequestFromAction(action);
  if (!req) {
    if (isControlAgentAction(action)) {
      return { decision: legacy, reasonCode: '' };
    }
    emitAgentEvent({
      type: 'policy_decision',
      action: `${action.type}:unmapped`,
      decision: 'deny',
      preset,
      rule: 'DENY_MISSING_AUTHORITY',
    });
    return { decision: 'deny', reasonCode: 'DENY_MISSING_AUTHORITY' };
  }

  const pdp = decideActionRequest(
    {
      ...req,
      isolationAvailable: ctx.isolationAvailable === true,
    },
    ctx.lease,
    now,
  );

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
