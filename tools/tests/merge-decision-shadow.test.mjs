import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyMergeDecisionShadow } from "../merge-decision-shadow.mjs";

const head = "1".repeat(40);
const base = "2".repeat(40);
const expected = { repository: "gthgomez/Babel", pullRequest: 42, head, base };
const receipt = () => ({
  kind: "babel_agent_pr_gate", schemaVersion: 4,
  repository: expected.repository, pr: { number: expected.pullRequest },
  status: "MERGE_READY", mergeReady: true, blockers: [],
  sha: { reviewedHead: head, prHead: head, remoteHead: head, ciHead: head, baseHead: base, liveTargetHead: base, trustedPolicySha: base },
  reviewPolicy: { independentReviewSatisfied: true, effectiveRiskLane: "GREEN" },
});

test("green, exact-head receipt only yields a non-authoritative shadow result", () => {
  assert.deepEqual(classifyMergeDecisionShadow(receipt(), expected), {
    status: "would_pass", authoritative: false, reasons: [],
  });
});

test("writer-controlled or incomplete inputs cannot turn a shadow result into authority", () => {
  for (const input of [null, {}, { ...receipt(), schemaVersion: 5 }, { ...receipt(), blockers: null }]) {
    const decision = classifyMergeDecisionShadow(input, expected);
    assert.equal(decision.status, "would_block");
    assert.equal(decision.authoritative, false);
  }
});

test("ineligible, mismatched, or unreviewed receipts cannot pass in shadow", () => {
  const changes = [
    [r => { r.blockers = ["pr_is_draft"]; }, "existing_gate_blocked"],
    [r => { r.mergeReady = false; }, "existing_gate_blocked"],
    [r => { r.pr.number = 99; }, "candidate_identity_mismatch"],
    [r => { r.sha.remoteHead = base; }, "candidate_identity_mismatch"],
    [r => { r.sha.trustedPolicySha = head; }, "candidate_identity_mismatch"],
    [r => { r.sha.baseHead = head; }, "candidate_identity_mismatch"],
    [r => { r.reviewPolicy.independentReviewSatisfied = false; }, "independent_review_missing"],
    [r => { r.reviewPolicy.effectiveRiskLane = "BLACK"; }, "protected_scope"],
    [r => { r.reviewPolicy.effectiveRiskLane = "YELLOW"; }, "outside_routine_pilot"],
    [r => { r.reviewPolicy.effectiveRiskLane = "RED"; }, "outside_routine_pilot"],
    [r => { delete r.reviewPolicy.effectiveRiskLane; }, "unknown_risk_lane"],
  ];
  for (const [change, reason] of changes) {
    const candidate = receipt();
    change(candidate);
    const decision = classifyMergeDecisionShadow(candidate, expected);
    assert.equal(decision.status, "would_block");
    assert.ok(decision.reasons.includes(reason));
  }
});

test("ambiguous expected identity is blocked", () => {
  assert.equal(classifyMergeDecisionShadow(receipt(), { ...expected, head: "HEAD" }).status, "would_block");
});

test("the diagnostic CLI refuses absent or unreadable inputs", () => {
  const script = fileURLToPath(new URL("../merge-decision-shadow.mjs", import.meta.url));
  const usage = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  const invalid = spawnSync(process.execPath, [
    script, script, expected.repository, String(expected.pullRequest), head, base,
  ], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Cannot read merge-gate receipt/);
});
