#!/usr/bin/env node
// Drift detection only. Runtime enforcement and the base-rooted merge gate
// remain authoritative; this manifest grants no authorization.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "POLICY_MANIFEST.json");
// Deliberately bounded snapshot, not the complete host-protected surface.
// Reconcile with the promoted PR271 policy before combining or merging.
const coveredPaths = [
  "AGENTS.md",
  "docs/AUTONOMY_POLICY.md",
  "docs/AUTONOMY_POLICY_CHANGELOG.md",
  "docs/guides/AGENT_GIT_OPERATIONS.md",
  "scripts/agent-pr-gate.ps1",
  "scripts/agent-pr-gate-common.psm1",
  "scripts/agent-review-evidence.ps1",
  "scripts/trusted-merge-gate.ps1",
  "babel-cli/src/authority/lease.ts",
  "babel-cli/src/config/autonomyPolicy.ts",
  "babel-cli/src/agent/autonomyEnforcement.ts",
  ".agents/rules/10-independent-review-policy.md",
  "tools/policy-integrity-manifest.mjs",
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
