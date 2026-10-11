#!/usr/bin/env node
// Classify a Public Release Gate run as the fast docs lane or the full matrix.
// Docs-only pull requests skip the heavy jobs. The installer runs on main,
// on pull requests labeled full-ci, and when installer-sensitive paths change.
// Anything unrecognized stays full. Trusted path rules cannot be weakened by
// edits to this classifier alone on the candidate branch.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FAST_PREFIXES = ["docs/", "skills/", "02_Skills/", ".agents/skills/"];
const FAST_FILES = new Set(["README.md", "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md"]);

/** Paths that always force the full matrix (trusted; evaluated before lane logic). */
export const TRUSTED_ALWAYS_FULL_PREFIXES = [
  ".github/",
  "config/review-risk-policy.json",
  "POLICY_MANIFEST.json",
  "scripts/agent-pr-gate",
  "scripts/trusted-merge-gate",
  "tools/ci-merge-lane",
  "tools/ci-workflow-coverage",
  "tools/run-public-secret-scan",
  "tools/check-public-content-policy",
  "babel-cli/src/",
  "babel-desktop/",
  "prompt_catalog.yaml",
];

/** Changes here require installer-lifecycle on pull requests. */
export const INSTALLER_SENSITIVE_PREFIXES = [
  "babel-desktop/test/installer-lifecycle/",
  "babel-desktop/scripts/package-windows",
  "babel-desktop/scripts/package-windows-setup",
  ".github/workflows/release.yml",
];

function fileMatchesPrefix(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(prefix));
}

export function trustedPathForcesFullLane(files) {
  const meaningful = files.filter((file) => file && !file.endsWith("/"));
  return meaningful.some((file) => fileMatchesPrefix(file, TRUSTED_ALWAYS_FULL_PREFIXES));
}

export function installerSensitiveChange(files) {
  const meaningful = files.filter((file) => file && !file.endsWith("/"));
  return meaningful.some((file) => fileMatchesPrefix(file, INSTALLER_SENSITIVE_PREFIXES));
}

export function classifyMergeLane({ event, labels = [], files = [] }) {
  const labelSet = new Set(labels.map((label) => String(label).trim()).filter(Boolean));
  if (event !== "pull_request") return { full: true, installer: true };
  const meaningful = files.filter((file) => file && !file.endsWith("/"));
  const fullCi = labelSet.has("full-ci");
  const installerFromPaths = installerSensitiveChange(meaningful);
  if (trustedPathForcesFullLane(meaningful)) {
    return { full: true, installer: fullCi || installerFromPaths };
  }
  const docsOnly = meaningful.length > 0 && meaningful.every((file) =>
    FAST_FILES.has(file) || FAST_PREFIXES.some((prefix) => file.startsWith(prefix)));
  return { full: fullCi || !docsOnly, installer: fullCi || installerFromPaths };
}

function changedFiles() {
  if ((process.env.EVENT_NAME || "") !== "pull_request") return [];
  const base = process.env.BASE_SHA || "";
  if (!/^[0-9a-f]{40}$/i.test(base)) {
    throw new Error("pull_request lane classification requires a 40-character BASE_SHA");
  }
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

function main() {
  const labels = (process.env.LABELS || "").split(",").map((label) => label.trim()).filter(Boolean);
  const lane = classifyMergeLane({
    event: process.env.EVENT_NAME || "",
    labels,
    files: changedFiles(),
  });
  const lines = [`full=${lane.full}`, `installer=${lane.installer}`];
  process.stderr.write(`merge lane ${lines.join(" ")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
