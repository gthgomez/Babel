/**
 * pdp.ts — Policy Decision Point (V2 authority).
 *
 * Pure, deterministic decision function: ActionRequest × AutonomyLease →
 * { outcome, reasonCode, rulesTriggered }. Fail-closed: unknown capability,
 * constraint violation, or lease mismatch → DENY with a reason code.
 * Privileged capabilities require explicit lease membership and
 * capability-specific constraints — they never ASK. Publication capabilities
 * → VERIFY (dispatch treats as allow; the completion gate enforces verify).
 * No I/O; fully unit-testable.
 */

import { AutonomyLease } from './lease.js';
import { evaluateLeaseTemporalValidity } from './leaseTime.js';
import {
  CapabilityId,
  CAPABILITY_KINDS,
  isAllowedBranchPrefix,
  isPrivilegedCapability,
  isProtectedBranch,
  requestRequiresIsolation,
} from './capabilities.js';
import { PolicyOutcome, ReasonCode } from './reasonCodes.js';
import {
  branchAllowed,
  environmentAllowed,
  normalizePrNumber,
} from './targetBinding.js';

export interface ActionRequest {
  capability: CapabilityId;
  repository?: string;
  remote?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  force?: boolean;
  delete?: boolean;
  /** Current branch of the agent's worktree (used for task-branch checks). */
  currentBranch?: string;
  /** Deploy/target environment when the action names one. */
  environment?: string;
  /** Concrete target (PR number, path, branch) when not a dest branch. */
  target?: string;
  /**
   * True only when an OS-level sandbox (currently Docker isolation) will
   * actually wrap the child. Host-user execution is not isolation.
   */
  isolationAvailable?: boolean;
  /**
   * Decoder-set when the command executes repository-controlled code even
   * if the capability label is local (package scripts, some runners).
   */
  requiresIsolation?: boolean;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasonCode: ReasonCode;
  rulesTriggered: string[];
}

/** @deprecated ASK is no longer a PDP outcome. Retained for compatibility tests. */
export function askCodeForCapability(capability: CapabilityId): ReasonCode {
  switch (capability) {
    case 'merge':
      return 'ASK_MERGE';
    case 'pr_mark_ready':
      return 'ASK_PR_READY';
    case 'release':
      return 'ASK_RELEASE';
    case 'production_deploy':
      return 'ASK_DEPLOY';
    case 'repo_admin':
      return 'ASK_ADMIN';
    case 'security_policy_change':
      return 'ASK_SECURITY_CHANGE';
    case 'credential_access':
      return 'ASK_ADMIN';
    case 'destructive_data_delete':
      return 'ASK_SCOPE_ESCALATION';
    case 'scope_expansion':
      return 'ASK_SCOPE_ESCALATION';
    default:
      return 'ASK_SCOPE_ESCALATION';
  }
}

export function decideActionRequest(
  request: ActionRequest,
  lease: AutonomyLease,
  now: Date | number = Date.now(),
): PolicyDecision {
  const triggered: string[] = [];

  const temporal = evaluateLeaseTemporalValidity(lease, now);
  if (!temporal.ok) {
    return { outcome: 'deny', reasonCode: temporal.reasonCode, rulesTriggered: ['lease.expiresAt'] };
  }

  // 1. Forbidden (Class D) — always deny, regardless of lease contents.
  if (request.capability === 'expose_credentials') {
    return { outcome: 'deny', reasonCode: 'DENY_CREDENTIAL_READ', rulesTriggered: ['lease.forbidden'] };
  }

  // 2. Unknown capability — fail closed.
  if (request.capability === 'unknown') {
    return {
      outcome: 'deny',
      reasonCode: 'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT',
      rulesTriggered: ['pdp.unknown_capability'],
    };
  }

  // 3. Lease constraints.
  if (request.force && lease.constraints.forcePush === false) {
    triggered.push('lease.constraints.forcePush');
    return { outcome: 'deny', reasonCode: 'DENY_FORCE_PUSH_POLICY', rulesTriggered: triggered };
  }
  if (request.delete && lease.constraints.remoteRefDelete === false) {
    triggered.push('lease.constraints.remoteRefDelete');
    return { outcome: 'deny', reasonCode: 'DENY_HISTORY_REWRITE', rulesTriggered: triggered };
  }

  // 4. Repository / remote mismatch.
  if (request.repository && request.repository !== lease.scope.repository) {
    triggered.push('pdp.repository_mismatch');
    return { outcome: 'deny', reasonCode: 'DENY_LEASE_MISMATCH', rulesTriggered: triggered };
  }
  if (request.remote && request.remote !== lease.scope.remote) {
    triggered.push('pdp.remote_mismatch');
    return { outcome: 'deny', reasonCode: 'DENY_LEASE_MISMATCH', rulesTriggered: triggered };
  }

  // 5. Capability kind + lease membership — fail-closed: a capability the
  // lease never granted is DENIED, never promoted to an approval path.
  const kind = CAPABILITY_KINDS[request.capability];

  if (kind === 'forbidden') {
    return { outcome: 'deny', reasonCode: 'DENY_CREDENTIAL_READ', rulesTriggered: ['capability.forbidden'] };
  }

  if (!lease.allowedCapabilities.includes(request.capability)) {
    triggered.push('pdp.not_in_lease');
    if (kind === 'gated' || isPrivilegedCapability(request.capability)) {
      return { outcome: 'deny', reasonCode: 'DENY_MISSING_AUTHORITY', rulesTriggered: triggered };
    }
    return {
      outcome: 'deny',
      reasonCode: 'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT',
      rulesTriggered: triggered,
    };
  }

  if (requestRequiresIsolation(request) && request.isolationAvailable !== true) {
    return denyConstraint(
      triggered,
      request.capability === 'run_arbitrary_code'
        ? 'pdp.arbitrary_code_requires_isolation'
        : 'pdp.project_code_requires_isolation',
    );
  }

  // 6. Protected-branch write — machine policy, never ASK.
  const dest = request.destinationBranch;
  if (dest && isProtectedBranch(dest, lease.constraints.protectedBranches)) {
    triggered.push('lease.constraints.protectedBranches');
    const allowedTargets = lease.constraints.allowedProtectedTargets;
    const destAllowed = allowedTargets.some((t) => t === dest);
    if (
      (request.capability === 'push_feature_branch' || request.capability === 'force_push' || request.capability === 'merge') &&
      !destAllowed
    ) {
      return { outcome: 'deny', reasonCode: 'DENY_PROTECTED_BRANCH', rulesTriggered: triggered };
    }
  }

  // 7. Branch-prefix check — the lease's task-branch contract: pushes must
  // land on an allowed prefix (`feat/`, `fix/`, …). Denied before any
  // verify/allow so a non-task branch can never publish. Protected dests
  // already authorized above skip this prefix check.
  if (
    dest &&
    !isProtectedBranch(dest, lease.constraints.protectedBranches) &&
    !isAllowedBranchPrefix(dest, lease.branchPrefixes)
  ) {
    triggered.push('lease.branchPrefixes');
    return {
      outcome: 'deny',
      reasonCode: 'DENY_BRANCH_PREFIX',
      rulesTriggered: triggered,
    };
  }

  // 8. Privileged capability resolution — membership already checked.
  if (kind === 'gated' || isPrivilegedCapability(request.capability)) {
    const constraint = privilegedConstraintDecision(request, lease, triggered);
    if (constraint) return constraint;
    triggered.push(`lease.allowedCapabilities.${request.capability}`);
    return { outcome: 'verify', reasonCode: 'VERIFY_BEFORE_PUBLICATION', rulesTriggered: triggered };
  }

  if (kind === 'publication') {
    triggered.push('lease.allowedCapabilities');
    return {
      outcome: 'verify',
      reasonCode: 'VERIFY_BEFORE_PUBLICATION',
      rulesTriggered: triggered,
    };
  }

  triggered.push('lease.allowedCapabilities');
  return { outcome: 'allow', reasonCode: 'ALLOW_SAFE_LOCAL', rulesTriggered: triggered };
}

function denyConstraint(triggered: string[], rule: string): PolicyDecision {
  triggered.push(rule);
  return { outcome: 'deny', reasonCode: 'DENY_CAPABILITY_CONSTRAINT', rulesTriggered: triggered };
}

/**
 * Targetable privileged capabilities require: concrete target + non-empty
 * allowlist + match. Empty allowlist is deny-all, never a wildcard.
 *
 * Gated capability audit:
 *   A bind: merge, pr_mark_ready, force_push, production_deploy,
 *           shared_history_rewrite, scope_expansion+delete
 *   C repo-wide flag only: release, repo_admin, security_policy_change,
 *           credential_access, destructive_data_delete (no narrower
 *           target is reliably extractable without brittle parsing)
 *   D fail-closed: run_arbitrary_code requires an OS sandbox; host-user
 *           execution is never a grant path
 */
function requireBoundTarget(
  raw: string | undefined,
  allowed: readonly string[],
  triggered: string[],
  rules: { missingTarget: string; missingAllowlist: string; mismatch: string },
  match: (actual: string, allowed: readonly string[]) => boolean,
): PolicyDecision | null {
  if (!raw) return denyConstraint(triggered, rules.missingTarget);
  if (allowed.length === 0) return denyConstraint(triggered, rules.missingAllowlist);
  if (!match(raw, allowed)) return denyConstraint(triggered, rules.mismatch);
  return null;
}

/**
 * Capability-specific privileged constraints. Returns a deny decision when
 * the lease grants the capability but the structured constraint is not met.
 * Null means the constraint set is satisfied.
 */
function privilegedConstraintDecision(
  request: ActionRequest,
  lease: AutonomyLease,
  triggered: string[],
): PolicyDecision | null {
  const c = lease.constraints;
  switch (request.capability) {
    case 'merge':
    case 'pr_mark_ready': {
      if (request.repository && request.repository !== lease.scope.repository) {
        return { outcome: 'deny', reasonCode: 'DENY_LEASE_MISMATCH', rulesTriggered: [...triggered, 'pdp.repository_mismatch'] };
      }
      const allowedPrs = c.allowedPullRequests ?? [];
      if (allowedPrs.length === 0) {
        return denyConstraint(triggered, 'pdp.missing_pr_allowlist');
      }
      if (!request.target) {
        return denyConstraint(triggered, 'pdp.missing_pr_target');
      }
      const pr = normalizePrNumber(request.target);
      if (pr === null || !allowedPrs.includes(pr)) {
        return denyConstraint(triggered, 'lease.constraints.allowedPullRequests');
      }
      return null;
    }
    case 'release':
      if (c.releasePublish !== true) return denyConstraint(triggered, 'lease.constraints.releasePublish');
      return null;
    case 'production_deploy':
      if (c.productionDeploy !== true) return denyConstraint(triggered, 'lease.constraints.productionDeploy');
      if ((c.allowedEnvironments ?? []).length === 0) {
        return denyConstraint(triggered, 'pdp.missing_environment_allowlist');
      }
      if (!request.environment) return denyConstraint(triggered, 'pdp.missing_environment');
      if (!environmentAllowed(request.environment, c.allowedEnvironments)) {
        return denyConstraint(triggered, 'lease.constraints.allowedEnvironments');
      }
      return null;
    case 'repo_admin':
      if (c.repositoryAdmin !== true) return denyConstraint(triggered, 'lease.constraints.repositoryAdmin');
      return null;
    case 'security_policy_change':
      if (c.securityPolicyChange !== true) return denyConstraint(triggered, 'lease.constraints.securityPolicyChange');
      return null;
    case 'credential_access':
      if (c.secretsAccess !== true) return denyConstraint(triggered, 'lease.constraints.secretsAccess');
      return null;
    case 'destructive_data_delete':
      if (c.destructiveDb !== true) return denyConstraint(triggered, 'lease.constraints.destructiveDb');
      return null;
    case 'shared_history_rewrite': {
      if (c.historyRewrite !== true) return denyConstraint(triggered, 'lease.constraints.historyRewrite');
      return requireBoundTarget(
        request.destinationBranch ?? request.target ?? request.currentBranch,
        c.allowedRewriteTargets ?? [],
        triggered,
        {
          missingTarget: 'pdp.missing_rewrite_target',
          missingAllowlist: 'pdp.missing_rewrite_allowlist',
          mismatch: 'lease.constraints.allowedRewriteTargets',
        },
        branchAllowed,
      );
    }
    case 'force_push': {
      if (c.forcePush !== true) {
        triggered.push('lease.constraints.forcePush');
        return { outcome: 'deny', reasonCode: 'DENY_FORCE_PUSH_POLICY', rulesTriggered: triggered };
      }
      return requireBoundTarget(
        request.destinationBranch,
        c.allowedForcePushBranches ?? [],
        triggered,
        {
          missingTarget: 'pdp.missing_branch',
          missingAllowlist: 'pdp.missing_force_push_allowlist',
          mismatch: 'lease.constraints.allowedForcePushBranches',
        },
        branchAllowed,
      );
    }
    case 'run_arbitrary_code':
      return null;
    case 'scope_expansion': {
      if (c.scopeExpansion !== true) return denyConstraint(triggered, 'lease.constraints.scopeExpansion');
      if (request.delete) {
        if (c.remoteRefDelete !== true) {
          triggered.push('lease.constraints.remoteRefDelete');
          return { outcome: 'deny', reasonCode: 'DENY_HISTORY_REWRITE', rulesTriggered: triggered };
        }
        return requireBoundTarget(
          request.destinationBranch ?? request.target,
          c.allowedRemoteDeleteTargets ?? [],
          triggered,
          {
            missingTarget: 'pdp.missing_delete_target',
            missingAllowlist: 'pdp.missing_delete_allowlist',
            mismatch: 'lease.constraints.allowedRemoteDeleteTargets',
          },
          branchAllowed,
        );
      }
      return null;
    }
    default:
      return null;
  }
}
