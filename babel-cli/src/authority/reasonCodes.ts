/**
 * reasonCodes.ts — stable, machine-readable decision reason codes for the
 * authority PDP (V2). Codes are stable identifiers — do not rename; new codes
 * are additive. Consumers (CLI, logs, harness adapters) match on code strings.
 */

/** PDP outcomes. `ask` is deprecated and unreachable from the default coding path. */
export type PolicyOutcome = 'allow' | 'verify' | 'deny' | 'ask';

export const REASON_CODES = [
  // ALLOW
  'ALLOW_SAFE_LOCAL',
  'ALLOW_BOUNDED_PUBLICATION',
  // VERIFY
  'VERIFY_BEFORE_PUBLICATION',
  // ASK (deprecated compatibility codes — PDP no longer emits these)
  'ASK_PROTECTED_BRANCH',
  'ASK_MERGE',
  'ASK_RELEASE',
  'ASK_DEPLOY',
  'ASK_ADMIN',
  'ASK_SECURITY_CHANGE',
  'ASK_SCOPE_ESCALATION',
  'ASK_PR_READY',
  // DENY
  'DENY_CREDENTIAL_READ',
  'DENY_FORCE_PUSH_POLICY',
  'DENY_HISTORY_REWRITE',
  'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT',
  'DENY_LEASE_MISMATCH',
  'DENY_BUDGET_EXHAUSTED',
  'DENY_POLICY_SELF_MUTATION',
  'DENY_POLICY_INTEGRITY_DRIFT',
  'DENY_AUTHORITY_CONTEXT_INCOMPLETE',
  'DENY_AUTHORITY_RESUME_MISMATCH',
  'DENY_MISSING_AUTHORITY',
  'DENY_PROTECTED_BRANCH',
  'DENY_CAPABILITY_CONSTRAINT',
  'DENY_BRANCH_PREFIX',
  'DENY_VERIFICATION_MISMATCH',
  'DENY_LEASE_EXPIRED',
  'DENY_LEASE_INVALID_TIME',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_CODE_OUTCOMES: Record<ReasonCode, PolicyOutcome> = {
  ALLOW_SAFE_LOCAL: 'allow',
  ALLOW_BOUNDED_PUBLICATION: 'allow',
  VERIFY_BEFORE_PUBLICATION: 'verify',
  ASK_PROTECTED_BRANCH: 'ask',
  ASK_MERGE: 'ask',
  ASK_RELEASE: 'ask',
  ASK_DEPLOY: 'ask',
  ASK_ADMIN: 'ask',
  ASK_SECURITY_CHANGE: 'ask',
  ASK_SCOPE_ESCALATION: 'ask',
  ASK_PR_READY: 'ask',
  DENY_CREDENTIAL_READ: 'deny',
  DENY_FORCE_PUSH_POLICY: 'deny',
  DENY_HISTORY_REWRITE: 'deny',
  DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT: 'deny',
  DENY_LEASE_MISMATCH: 'deny',
  DENY_BUDGET_EXHAUSTED: 'deny',
  DENY_POLICY_SELF_MUTATION: 'deny',
  DENY_POLICY_INTEGRITY_DRIFT: 'deny',
  DENY_AUTHORITY_CONTEXT_INCOMPLETE: 'deny',
  DENY_AUTHORITY_RESUME_MISMATCH: 'deny',
  DENY_MISSING_AUTHORITY: 'deny',
  DENY_PROTECTED_BRANCH: 'deny',
  DENY_CAPABILITY_CONSTRAINT: 'deny',
  DENY_BRANCH_PREFIX: 'deny',
  DENY_VERIFICATION_MISMATCH: 'deny',
  DENY_LEASE_EXPIRED: 'deny',
  DENY_LEASE_INVALID_TIME: 'deny',
};

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}
