/**
 * reasonCodes.ts — stable, machine-readable decision reason codes for the
 * authority PDP (V2). Codes are stable identifiers — do not rename; new codes
 * are additive. Consumers (CLI, logs, harness adapters) match on code strings.
 */

export type PolicyOutcome = 'allow' | 'verify' | 'ask' | 'deny';

export const REASON_CODES = [
  // ALLOW
  'ALLOW_SAFE_LOCAL',
  'ALLOW_BOUNDED_PUBLICATION',
  // VERIFY
  'VERIFY_BEFORE_PUBLICATION',
  // ASK
  'ASK_PROTECTED_BRANCH',
  'ASK_MERGE',
  'ASK_RELEASE',
  'ASK_DEPLOY',
  'ASK_ADMIN',
  'ASK_SECURITY_CHANGE',
  'ASK_SCOPE_ESCALATION',
  'ASK_PR_READY',
  'ASK_PUBLIC_VISIBILITY',
  // DENY
  'DENY_CREDENTIAL_READ',
  'DENY_FORCE_PUSH_POLICY',
  'DENY_HISTORY_REWRITE',
  'DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT',
  'DENY_LEASE_MISMATCH',
  'DENY_BUDGET_EXHAUSTED',
  'DENY_POLICY_SELF_MUTATION',
  'DENY_VERIFICATION_MISMATCH',
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
  ASK_PUBLIC_VISIBILITY: 'ask',
  DENY_CREDENTIAL_READ: 'deny',
  DENY_FORCE_PUSH_POLICY: 'deny',
  DENY_HISTORY_REWRITE: 'deny',
  DENY_UNKNOWN_EXTERNAL_SIDE_EFFECT: 'deny',
  DENY_LEASE_MISMATCH: 'deny',
  DENY_BUDGET_EXHAUSTED: 'deny',
  DENY_POLICY_SELF_MUTATION: 'deny',
  DENY_VERIFICATION_MISMATCH: 'deny',
};

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}
