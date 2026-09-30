#!/usr/bin/env node
// Policy integrity manifest for gthgomez/Babel — drift detection, not authorization.
//
// Detects post-hoc drift between the reviewed policy/trust surface text and the
// files on disk (the "prompt-to-runtime debt" recorded in
// docs/AUTONOMY_POLICY_CHANGELOG.md). It is NOT a signing root and grants no
// authority; the runtime enforcement and the base-rooted merge gate remain the
// authoritative trust anchors. Integration of verify into
// scripts/trusted-merge-gate.ps1 is a deliberate follow-up so this change does
// not touch the hostProtected trust root while #271 is in flight.
//
// Usage:
//   node tools/policy-integrity-manifest.mjs verify    # exit 1 on drift
//   node tools/policy-integrity-manifest.mjs generate  # rewrite the manifest

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "POLICY_MANIFEST.json");

// The covered trust surface: policy text, rules, review/authority config, and
// the gate scripts. Paths are repo-relative POSIX.
const coveredPaths = [
  "AGENTS.md",
  "docs/AUTONOMY_POLICY.md",
  "docs/AUTONOMY_POLICY_CHANGELOG.md",
  "docs/guides/AGENT_GIT_OPERATIONS.md",
  // "config/review-risk-policy.json", // added by PR #271 — register when it merges
  "scripts/agent-pr-gate.ps1",
  "scripts/agent-pr-gate-common.psm1",
  "scripts/agent-review-evidence.ps1",
  "scripts/trusted-merge-gate.ps1",
  "babel-cli/src/authority/lease.ts",
  "babel-cli/src/config/autonomyPolicy.ts",
  "babel-cli/src/agent/autonomyEnforcement.ts",
];

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildManifest() {
  const files = {};
  const bundleLines = [];
  for (const rel of coveredPaths) {
    const hash = hashFile(join(repoRoot, rel));
    files[rel] = hash;
    bundleLines.push(`${rel}:${hash}`);
  }
  const policyBundleId = createHash("sha256")
    .update(bundleLines.sort().join("\n"))
    .digest("hex");
  return {
    schema_version: 1,
    algorithm: "sha256",
    purpose: "drift_detection_not_authorization",
    policy_bundle_id: policyBundleId,
    files,
  };
}

const mode = process.argv[2] ?? "verify";
if (mode === "generate") {
  writeFileSync(manifestPath, JSON.stringify(buildManifest(), null, 2) + "\n");
  console.log(
    JSON.stringify({ status: "GENERATED", manifest: "POLICY_MANIFEST.json", covered: coveredPaths.length }),
  );
  process.exit(0);
}

if (mode !== "verify") {
  console.error(`unknown mode: ${mode} (use verify or generate)`);
  process.exit(2);
}

const problems = [];
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.log(JSON.stringify({ status: "FAIL", reason: "manifest_unreadable", error: String(error) }));
  process.exit(1);
}
if (manifest.schema_version !== 1) problems.push("schema_version_mismatch");

for (const rel of coveredPaths) {
  if (!manifest.files?.[rel]) {
    problems.push(`unregistered:${rel}`);
    continue;
  }
  let actual;
  try {
    actual = hashFile(join(repoRoot, rel));
  } catch {
    problems.push(`missing:${rel}`);
    continue;
  }
  if (actual !== manifest.files[rel]) problems.push(`drift:${rel}`);
}
for (const rel of Object.keys(manifest.files ?? {})) {
  if (!coveredPaths.includes(rel)) problems.push(`stale_registration:${rel}`);
}

if (problems.length > 0) {
  console.log(
    JSON.stringify({
      status: "FAIL",
      policy_bundle_id: manifest.policy_bundle_id,
      problems,
      remediation: "node tools/policy-integrity-manifest.mjs generate  # then commit after the change is reviewed",
    }),
  );
  process.exit(1);
}
console.log(
  JSON.stringify({ status: "VERIFIED", policy_bundle_id: manifest.policy_bundle_id, covered: coveredPaths.length }),
);
