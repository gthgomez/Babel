/**
 * pdp.ts — Policy Decision Point (V2 authority).
 *
 * Pure, deterministic decision function: ActionRequest × AutonomyLease →
 * { outcome, reasonCode, rulesTriggered }. Fail-closed: unknown capability,
 * constraint violation, or lease mismatch → DENY with a reason code. Gated
 * capabilities → ASK with a specific code. Publication capabilities → VERIFY
 * (dispatch treats as allow; the completion gate enforces the verify
 * requirement). No I/O; fully unit-testable.
 */

import { AutonomyLease } from './lease.js';
import { CapabilityId, CAPABILITY_KINDS, isProtectedBranch } from './capabilities.js';
import { PolicyOutcome, ReasonCode } from './reasonCodes.js';

export interface ActionRequest {
  capability: CapabilityId;
  repository?: string;
  remote?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  force?: boolean;
  delete?: boolean;
  /** Repo visibility for repo_create (public/internal → deterministic ASK). */
  visibility?: 'public' | 'private' | 'internal';
  /** Current branch of the agent's worktree (used for task-branch checks). */
  currentBranch?: string;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasonCode: ReasonCode;
  rulesTriggered: string[];
}

/** Map a gated capability to its ASK reason code. */
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
): PolicyDecision {
  const triggered: string[] = [];

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

  // 5. Protected-branch write — ASK (human gate), never silent.
  const dest = request.destinationBranch;
  if (dest && isProtectedBranch(dest, lease.constraints.protectedBranches)) {
    triggered.push('lease.constraints.protectedBranches');
    if (request.capability === 'push_feature_branch' || request.capability === 'force_push') {
      return { outcome: 'ask', reasonCode: 'ASK_PROTECTED_BRANCH', rulesTriggered: triggered };
    }
  }

  // 5b. Repo creation visibility gate: public/internal = making material
  // public (Class C) — deterministic ASK regardless of lease membership.
  if (
    request.capability === 'repo_create' &&
    (request.visibility === 'public' || request.visibility === 'internal')
  ) {
    triggered.push('pdp.public_visibility');
    return { outcome: 'ask', reasonCode: 'ASK_PUBLIC_VISIBILITY', rulesTriggered: triggered };
  }

  // 6. Capability kind resolution.
  const kind = CAPABILITY_KINDS[request.capability];

  if (kind === 'forbidden') {
    return { outcome: 'deny', reasonCode: 'DENY_CREDENTIAL_READ', rulesTriggered: ['capability.forbidden'] };
  }

  if (kind === 'gated') {
    triggered.push(`lease.gates.${request.capability}`);
    return { outcome: 'ask', reasonCode: askCodeForCapability(request.capability), rulesTriggered: triggered };
  }

  // 7. Lease membership for local/publication capabilities.
  if (!lease.allowedCapabilities.includes(request.capability)) {
    triggered.push('pdp.not_in_lease');
    return {
      outcome: 'deny',
      reasonCode: 'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT',
      rulesTriggered: triggered,
    };
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
