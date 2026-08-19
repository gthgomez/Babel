/**
 * Map Babel machine evidence to a remote verification status.
 * Absence of failure is never PASS / VERIFIED.
 */

export const VERIFICATION_STATUSES = [
  'PASS',
  'FAILED',
  'NOT_RUN',
  'NOT_VERIFIED',
  'UNKNOWN',
  'UNSUPPORTED',
  'BLOCKED',
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface VerificationEvidence {
  /** Present only when a real command/verifier produced an exit code. */
  commandExitCode?: number | null;
  /** True only when a stored machine receipt/log backs the claim. */
  hasMachineEvidence: boolean;
  blocked?: boolean;
  unsupported?: boolean;
  notRun?: boolean;
  /** Explicit failure recorded by Babel (gate, verifier, test). */
  failed?: boolean;
}

export interface VerificationSnapshot {
  status: VerificationStatus;
  reason: string;
  has_machine_evidence: boolean;
}

export function mapVerificationEvidence(input: VerificationEvidence): VerificationSnapshot {
  if (input.unsupported) {
    return {
      status: 'UNSUPPORTED',
      reason: 'Verifier or evidence source is unsupported on this host',
      has_machine_evidence: input.hasMachineEvidence,
    };
  }
  if (input.blocked) {
    return {
      status: 'BLOCKED',
      reason: 'Verification is blocked by policy or environment',
      has_machine_evidence: input.hasMachineEvidence,
    };
  }
  if (!input.hasMachineEvidence) {
    return {
      status: 'NOT_VERIFIED',
      reason: 'No machine evidence is stored; absence of failure is not PASS',
      has_machine_evidence: false,
    };
  }
  if (input.failed) {
    return {
      status: 'FAILED',
      reason: 'Stored machine evidence records failure',
      has_machine_evidence: true,
    };
  }
  if (input.notRun) {
    return {
      status: 'NOT_RUN',
      reason: 'Verifier was not run',
      has_machine_evidence: true,
    };
  }
  if (input.commandExitCode === undefined || input.commandExitCode === null) {
    return {
      status: 'UNKNOWN',
      reason: 'Machine evidence exists but has no decisive exit code',
      has_machine_evidence: true,
    };
  }
  if (input.commandExitCode === 0) {
    return {
      status: 'PASS',
      reason: 'Command exit code 0 recorded by Babel',
      has_machine_evidence: true,
    };
  }
  return {
    status: 'FAILED',
    reason: `Command exit code ${input.commandExitCode} recorded by Babel`,
    has_machine_evidence: true,
  };
}

export function verificationFromModelProse(_text: string): VerificationSnapshot {
  return mapVerificationEvidence({ hasMachineEvidence: false });
}
