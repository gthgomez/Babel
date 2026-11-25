// License: Apache-2.0
// Offline diagnostic only: this accepts JSON, not authenticated evidence.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sha = /^[0-9a-f]{40}$/;
const repo = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function classifyMergeDecisionShadow(receipt, expected) {
  const result = reasons => ({
    status: reasons.length ? "would_block" : "would_pass", authoritative: false, reasons,
  });
  if (typeof expected?.repository !== "string" || !repo.test(expected.repository)
      || !Number.isSafeInteger(expected.pullRequest) || expected.pullRequest < 1
      || typeof expected.head !== "string" || !sha.test(expected.head)
      || typeof expected.base !== "string" || !sha.test(expected.base)) {
    return result(["expected_identity_invalid"]);
  }
  if (receipt?.kind !== "babel_agent_pr_gate" || receipt.schemaVersion !== 4 || !Array.isArray(receipt.blockers)) {
    return result(["receipt_invalid"]);
  }
  const reasons = [];
  if (receipt.status !== "MERGE_READY" || receipt.mergeReady !== true || receipt.blockers.length) {
    reasons.push("existing_gate_blocked");
  }
  if (receipt.repository !== expected.repository || receipt.pr?.number !== expected.pullRequest
      || ["reviewedHead", "prHead", "remoteHead", "ciHead"].some(key => receipt.sha?.[key] !== expected.head)
      || ["baseHead", "liveTargetHead", "trustedPolicySha"].some(key => receipt.sha?.[key] !== expected.base)) {
    reasons.push("candidate_identity_mismatch");
  }
  if (receipt.reviewPolicy?.independentReviewSatisfied !== true) reasons.push("independent_review_missing");
  const lane = receipt.reviewPolicy?.effectiveRiskLane;
  if (lane === "BLACK") reasons.push("protected_scope");
  else if (lane === "YELLOW" || lane === "RED") reasons.push("outside_routine_pilot");
  else if (lane !== "GREEN") reasons.push("unknown_risk_lane");
  return result(reasons);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, repository, number, head, base, ...extra] = process.argv.slice(2);
  if (!file || !/^[1-9][0-9]*$/.test(number ?? "") || extra.length) {
    console.error("Usage: node tools/merge-decision-shadow.mjs <gate.json> <owner/repo> <pr> <head> <base>");
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(readFileSync(file, "utf8"));
      console.log(JSON.stringify(classifyMergeDecisionShadow(input, { repository, pullRequest: Number(number), head, base })));
    } catch {
      console.error("Cannot read merge-gate receipt.");
      process.exitCode = 2;
    }
  }
}
