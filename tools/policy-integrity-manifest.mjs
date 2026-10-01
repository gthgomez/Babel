#!/usr/bin/env node
// Drift detection only. Runtime enforcement and the base-rooted merge gate
// remain authoritative; this manifest grants no authorization.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "POLICY_MANIFEST.json");
// Explicit snapshot reconciled with the promoted host-protected prefixes.
// New protected files require a reviewed registration and regeneration.
const coveredPaths = [
  ".agents/rules/10-independent-review-policy.md",
  ".github/workflows/public-pr-metadata.yml",
  ".github/workflows/trusted-control-plane.yml",
  ".github/workflows/typecheck.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "babel-cli/src/agent/autonomyEnforcement.ts",
  "babel-cli/src/authority/actionRequest.ts",
  "babel-cli/src/authority/authority.test.ts",
  "babel-cli/src/authority/authorityMapping.test.ts",
  "babel-cli/src/authority/capabilities.ts",
  "babel-cli/src/authority/ciRepair.ts",
  "babel-cli/src/authority/commandDecoder.ts",
  "babel-cli/src/authority/commandSpec.test.ts",
  "babel-cli/src/authority/commandSpec.ts",
  "babel-cli/src/authority/convergence-integrity.regression-gate.test.ts",
  "babel-cli/src/authority/convergence-parser.regression-gate.test.ts",
  "babel-cli/src/authority/gitCommand.ts",
  "babel-cli/src/authority/governanceReconcile.ts",
  "babel-cli/src/authority/governanceRestore.test.ts",
  "babel-cli/src/authority/governanceSubprocess.test.ts",
  "babel-cli/src/authority/integrity.ts",
  "babel-cli/src/authority/lease.ts",
  "babel-cli/src/authority/leaseTime.ts",
  "babel-cli/src/authority/patchTargets.test.ts",
  "babel-cli/src/authority/patchTargets.ts",
  "babel-cli/src/authority/pdp.ts",
  "babel-cli/src/authority/privilegedTargetBinding.test.ts",
  "babel-cli/src/authority/reasonCodes.ts",
  "babel-cli/src/authority/remoteClarification.test.ts",
  "babel-cli/src/authority/scriptPrivilegeEscape.test.ts",
  "babel-cli/src/authority/sessionContext.test.ts",
  "babel-cli/src/authority/sessionContext.ts",
  "babel-cli/src/authority/sessionLifecycle.test.ts",
  "babel-cli/src/authority/targetBinding.ts",
  "babel-cli/src/authority/taskClarity.test.ts",
  "babel-cli/src/authority/taskClarity.ts",
  "babel-cli/src/authority/trustedExecutionPort.architecture.test.ts",
  "babel-cli/src/authority/trustedExecutionPort.ts",
  "babel-cli/src/authority/trustedExecutionSupervisor.ts",
  "babel-cli/src/authority/unprivilegedChildEnv.ts",
  "babel-cli/src/authority/wire.ts",
  "babel-cli/src/config/autonomyPolicy.test.ts",
  "babel-cli/src/config/autonomyPolicy.ts",
  "babel-cli/src/services/babelChatReview.test.ts",
  "babel-cli/src/services/babelChatReview.ts",
  "babel-cli/src/services/babelChatReviewParity.test.ts",
  "babel-cli/src/services/babelReviewObserver.test.ts",
  "babel-cli/src/services/babelReviewObserver.ts",
  "babel-cli/src/services/babelReviewQueue.test.ts",
  "babel-cli/src/services/babelReviewQueue.ts",
  "babel-cli/src/services/babelReviewSnapshot.test.ts",
  "babel-cli/src/services/babelReviewSnapshot.ts",
  "babel-cli/src/services/candidateCollector.test.ts",
  "babel-cli/src/services/candidateCollector.ts",
  "babel-cli/src/services/candidateCollectorCli.ts",
  "babel-cli/src/services/codexHarnessReview.test.ts",
  "babel-cli/src/services/codexHarnessReview.ts",
  "babel-cli/src/services/controllerMediatedHarnessReview.test.ts",
  "babel-cli/src/services/controllerMediatedHarnessReview.ts",
  "babel-cli/src/services/harnessReviewProtocol.test.ts",
  "babel-cli/src/services/harnessReviewProtocol.ts",
  "babel-cli/src/services/hostReviewController.test.ts",
  "babel-cli/src/services/hostReviewController.ts",
  "babel-cli/src/services/hostReviewV3Publication.test.ts",
  "babel-cli/src/services/hostReviewV3Publication.ts",
  "babel-cli/src/services/hostReviewWorker.test.ts",
  "babel-cli/src/services/hostReviewWorker.ts",
  "babel-cli/src/services/independentReviewBroker.test.ts",
  "babel-cli/src/services/independentReviewBroker.ts",
  "babel-cli/src/services/independentReviewController.test.ts",
  "babel-cli/src/services/independentReviewController.ts",
  "babel-cli/src/services/independentReviewEvidenceV3.test.ts",
  "babel-cli/src/services/independentReviewEvidenceV3.ts",
  "babel-cli/src/services/independentReviewPolicy.test.ts",
  "babel-cli/src/services/independentReviewPolicy.ts",
  "babel-cli/src/services/independentReviewProvider.test.ts",
  "babel-cli/src/services/independentReviewProvider.ts",
  "babel-cli/src/services/mergeReadinessBroker.test.ts",
  "babel-cli/src/services/mergeReadinessBroker.ts",
  "babel-cli/src/services/openCodeHarnessReview.test.ts",
  "babel-cli/src/services/openCodeHarnessReview.ts",
  "babel-cli/src/services/orchestratorReviewAdapter.test.ts",
  "babel-cli/src/services/orchestratorReviewAdapter.ts",
  "babel-cli/src/services/reviewControlPlaneParity.test.ts",
  "babel-cli/src/services/reviewCoverage.test.ts",
  "babel-cli/src/services/reviewCoverage.ts",
  "babel-cli/src/services/reviewCustody.test.ts",
  "babel-cli/src/services/reviewIndependence.test.ts",
  "babel-cli/src/services/reviewIndependence.ts",
  "babel-cli/src/services/reviewOrchestrator.test.ts",
  "babel-cli/src/services/reviewOrchestrator.ts",
  "babel-cli/src/services/reviewPolicy.test.ts",
  "babel-cli/src/services/reviewPolicy.ts",
  "babel-cli/src/services/reviewProcessContainment.test.ts",
  "babel-cli/src/services/reviewProcessContainment.ts",
  "babel-cli/src/services/reviewProvenance.ts",
  "babel-cli/src/services/reviewServiceTransport.test.ts",
  "babel-cli/src/services/reviewServiceTransport.ts",
  "babel-cli/src/services/reviewSupervisor.test.ts",
  "babel-cli/src/services/reviewSupervisor.ts",
  "babel-cli/src/services/reviewTrustedAuthority.ts",
  "babel-cli/src/services/structuredFinding.test.ts",
  "babel-cli/src/services/structuredFinding.ts",
  "babel-cli/src/services/trustedReviewInstallation.test.ts",
  "babel-cli/src/services/trustedReviewInstallation.ts",
  "config/review-risk-policy.json",
  "docs/AUTONOMY_POLICY.md",
  "docs/AUTONOMY_POLICY_CHANGELOG.md",
  "docs/BABEL_PR_REVIEW.md",
  "docs/architecture/MERGE_CONTROL_PLANE_V1.md",
  "docs/guides/AGENT_GIT_OPERATIONS.md",
  "scripts/agent-git-common.psm1",
  "scripts/agent-pr-gate-common.psm1",
  "scripts/agent-pr-gate.ps1",
  "scripts/agent-pr-merge.ps1",
  "scripts/agent-review-evidence.ps1",
  "scripts/materialize-independent-review-receipt.ps1",
  "scripts/trusted-merge-gate.ps1",
  "scripts/verify-independent-review.mjs",
  "scripts/verify-trust-root-upgrade.mjs",
  "tools/agent-host-review.ps1",
  "tools/babel-pr-orchestrate-opencode.mts",
  "tools/babel-pr-orchestrate.mts",
  "tools/host-review-worker.mts",
  "tools/policy-integrity-manifest.mjs"
].sort();
const hashPattern = /^[a-f0-9]{64}$/;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");
// Preserve BOM, lone CR, whitespace and final-newline distinctions. Only CRLF
// varies legitimately across clean checkouts, including *.ps1 eol=crlf.
function hashFile(path) {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(readFileSync(path));
  return sha256(text.replace(/\r\n/g, "\n"));
}
function bundleId(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((path) => `${path}:${files[path]}`)
      .join("\n"),
  );
}
function failure(problems) {
  console.log(JSON.stringify({ status: "FAIL", problems }));
  process.exitCode = 1;
}
function buildManifest() {
  const files = {};
  const problems = [];
  for (const path of coveredPaths) {
    try {
      files[path] = hashFile(join(repoRoot, path));
    } catch {
      problems.push(`file_unreadable_or_invalid_utf8:${path}`);
    }
  }
  if (problems.length) {
    failure(problems);
    return null;
  }
  return {
    schema_version: 2,
    algorithm: "sha256",
    purpose: "drift_detection_not_authorization",
    normalization: "utf8_crlf_to_lf",
    policy_bundle_id: bundleId(files),
    files,
  };
}
function verify() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    failure(["manifest_unreadable"]);
    return;
  }
  if (!isObject(manifest)) {
    failure(["manifest_shape_invalid"]);
    return;
  }
  const problems = [];
  for (const [key, expected] of Object.entries({
    schema_version: 2,
    algorithm: "sha256",
    purpose: "drift_detection_not_authorization",
    normalization: "utf8_crlf_to_lf",
  })) {
    if (manifest[key] !== expected) problems.push(`${key}_mismatch`);
  }
  if (
    typeof manifest.policy_bundle_id !== "string" ||
    !hashPattern.test(manifest.policy_bundle_id)
  )
    problems.push("policy_bundle_id_invalid");
  if (!isObject(manifest.files)) problems.push("files_shape_invalid");
  else {
    const files = manifest.files;
    let validHashes = true;
    for (const path of Object.keys(files)) {
      if (!coveredPaths.includes(path))
        problems.push(`stale_registration:${path}`);
      if (typeof files[path] !== "string" || !hashPattern.test(files[path])) {
        problems.push(`hash_invalid:${path}`);
        validHashes = false;
      }
    }
    for (const path of coveredPaths) {
      if (!Object.hasOwn(files, path)) problems.push(`unregistered:${path}`);
      try {
        const actual = hashFile(join(repoRoot, path));
        if (Object.hasOwn(files, path) && actual !== files[path])
          problems.push(`drift:${path}`);
      } catch {
        problems.push(`file_unreadable_or_invalid_utf8:${path}`);
      }
    }
    if (validHashes && manifest.policy_bundle_id !== bundleId(files))
      problems.push("policy_bundle_id_mismatch");
  }
  if (problems.length) {
    failure(problems);
    return;
  }
  console.log(
    JSON.stringify({
      status: "VERIFIED",
      policy_bundle_id: manifest.policy_bundle_id,
      covered: coveredPaths.length,
    }),
  );
}
const mode = process.argv[2] ?? "verify";
if (mode === "generate") {
  const manifest = buildManifest();
  if (manifest) {
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      console.log(
        JSON.stringify({
          status: "GENERATED",
          manifest: "POLICY_MANIFEST.json",
          covered: coveredPaths.length,
        }),
      );
    } catch {
      failure(["manifest_write_failed"]);
    }
  }
} else if (mode === "verify") verify();
else {
  console.log(JSON.stringify({ status: "FAIL", problems: ["unknown_mode"] }));
  process.exitCode = 2;
}
