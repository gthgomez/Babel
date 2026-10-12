#!/usr/bin/env node
// Classify a Public Release Gate run as the fast docs lane or the full matrix.
// Docs-only pull requests skip the heavy jobs. The installer runs on main,
// on pull requests labeled full-ci, and when installer-sensitive paths change.
// On pull requests the candidate classifier is unioned with the merge-base copy
// of this module so a PR cannot weaken lane requirements by editing this file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "babel-desktop/scripts/install-windows.ps1",
  "babel-desktop/scripts/uninstall-windows.ps1",
  "babel-desktop/package.json",
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

export function combineMergeLanes(headLane, baseLane) {
  return {
    full: Boolean(headLane.full || baseLane.full),
    installer: Boolean(headLane.installer || baseLane.installer),
  };
}

export function changedFilesForLane({ event, baseSha }) {
  if (event !== "pull_request") return [];
  if (!/^[0-9a-f]{40}$/i.test(baseSha || "")) {
    throw new Error("pull_request lane classification requires a 40-character BASE_SHA");
  }
  const out = execFileSync("git", ["diff", "--no-renames", "--name-only", `${baseSha}...HEAD`], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function classifyFromBaseSha(baseSha, input) {
  const src = execFileSync("git", ["show", `${baseSha}:tools/ci-merge-lane.mjs`], { encoding: "utf8" });
  const dir = mkdtempSync(join(tmpdir(), "babel-base-lane-"));
  const modulePath = join(dir, "ci-merge-lane.mjs");
  writeFileSync(modulePath, src);
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.classifyMergeLane !== "function") {
    throw new Error("Base merge-lane module is missing classifyMergeLane");
  }
  return mod.classifyMergeLane(input);
}

async function main() {
  const event = process.env.EVENT_NAME || "";
  const labels = (process.env.LABELS || "").split(",").map((label) => label.trim()).filter(Boolean);
  const baseSha = process.env.BASE_SHA || "";
  const files = changedFilesForLane({ event, baseSha });
  const input = { event, labels, files };
  const headLane = classifyMergeLane(input);
  let lane = headLane;
  if (event === "pull_request" && /^[0-9a-f]{40}$/i.test(baseSha)) {
    try {
      const baseLane = await classifyFromBaseSha(baseSha, input);
      lane = combineMergeLanes(headLane, baseLane);
      if (lane.full !== headLane.full || lane.installer !== headLane.installer) {
        process.stderr.write(`merge lane base binding raised head=${JSON.stringify(headLane)} base=${JSON.stringify(baseLane)}\n`);
      }
    } catch (error) {
      if (error?.status !== 128 && !String(error?.message || "").includes("exists on disk")) {
        throw error;
      }
    }
  }
  const lines = [`full=${lane.full}`, `installer=${lane.installer}`];
  process.stderr.write(`merge lane ${lines.join(" ")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
