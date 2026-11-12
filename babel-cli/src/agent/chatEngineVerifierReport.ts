import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';
import type { BlockedReport } from '../schemas/agentContracts.js';
import type { WorkingState } from './codingLoop/index.js';
import { recoveryBindingUnavailableReason } from './codingLoop/recoveryIdentity.js';

export interface VerifierBlockedReportHost {
  workingState: WorkingState;
  lastVerifierReceipt: BoundChatVerifierReceipt | null;
  hasAnyWrites(): boolean;
}

/** Build the harness-origin blocked report with real checked evidence. */
export function buildVerifierBlockedReport(host: VerifierBlockedReportHost, reason: string): BlockedReport {
  // R0-A: a harness-origin block must carry REAL checked evidence, never an
  // empty `checked` array (BlockedReportSchema requires >=1) and never a fake
  // placeholder. Prefer the actual verifier attempt when one ran red; else the
  // completion gate's own rejection is the evidence of record.
  const gate = host.workingState.recoveryGate;
  if (gate) {
    const records = gate.readRecords ?? [];
    const failed = host.workingState.settledFailedVerifier;
    return { schema_version: 1, status: "BLOCKED", reason, reason_code: "verification_failed", cause_class: "verification",
      missing: recoveryBindingUnavailableReason() ?? (gate.failureSignature === "unbound-red-verifier" || !gate.binding
        ? "Re-observe the exact failed verifier through its governed execution context to bind the current failure."
        : records.length ? "A concrete repair plan referencing current delivered reads for every existing edit target, followed by verification."
          : "Fresh delivered reads of the failure and relevant implementation; diagnostic candidates are inspection hints."),
      checked: records.length ? records.slice(-4).map(record => ({ action: record.tool, target: record.target,
        finding: `Retained read ${record.id}: lines ${record.window.startLine}-${record.window.endLine} of ${record.window.totalLines}; full file=${record.window.completeFile}.` }))
        : [{ action: failed ? "test_run" : "recovery_gate", target: failed?.command ?? host.workingState.lastVerifier?.identity ?? "failure",
          finding: failed ? `Started verifier settled with exit ${failed.exitCode}; this execution history is not a completion receipt.` : gate.requiredEvidence }],
    };
  }
  const receipt = host.lastVerifierReceipt;
  const redReceipt =
    receipt && receipt.exit_code !== 0 && receipt.stale !== true
      ? receipt
      : null;
  if (redReceipt) {
    const finding = (
      redReceipt.summary && redReceipt.summary.trim() !== ""
        ? redReceipt.summary
        : `exit ${redReceipt.exit_code}`
    ).slice(0, 500);
    return {
      schema_version: 1,
      status: "BLOCKED",
      reason,
      missing:
        "A passing authoritative verifier for the current workspace revision.",
      reason_code: "verification_failed",
      cause_class: "verification",
      checked: [
        {
          action: "run_command",
          target: redReceipt.command || "verifier",
          finding,
        },
      ],
    };
  }
  return {
    schema_version: 1,
    status: "BLOCKED",
    reason,
    missing:
      "A completion that satisfies the artifact and verifier honesty gate.",
    reason_code: "recovery_exhausted",
    cause_class: "harness",
    checked: [
      {
        action: "completion_gate",
        target: host.hasAnyWrites() ? "verifier_honesty" : "zero_successful_writes",
        finding: reason.slice(0, 500),
      },
    ],
  };
}
