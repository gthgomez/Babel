#!/usr/bin/env node
// Classify a Public Release Gate run as the fast docs lane or the full matrix.
// Docs-only pull requests skip the heavy jobs. The installer runs on main,
// on pull requests labeled full-ci, and when installer-sensitive paths change.
// On pull requests the candidate classifier is unioned with the merge-base copy
// of this module so a PR cannot weaken lane requirements by editing this file.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

/**
 * Changes here require installer-lifecycle on pull requests. Single-sourced in
 * config/review-risk-policy.json (shared with the PowerShell gate). A missing
 * or unreadable policy fails closed to a catch-all so lane classification can
 * never silently skip the installer.
 */
const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "review-risk-policy.json");
const INSTALLER_SENSITIVE_FALLBACK = [""];

export const INSTALLER_SENSITIVE_PREFIXES = (() => {
  try {
    const prefixes = JSON.parse(readFileSync(POLICY_PATH, "utf8")).installerSensitivePrefixes;
    if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.some((p) => typeof p !== "string" || !p)) {
      return INSTALLER_SENSITIVE_FALLBACK;
    }
    return prefixes;
  } catch {
    return INSTALLER_SENSITIVE_FALLBACK;
  }
})();

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

export async function classifyFromBaseSha(baseSha, input, root = process.cwd()) {
  if (!/^[0-9a-f]{40}$/i.test(baseSha || "")) throw new Error("Exact base commit required");
  const read = (path) => execFileSync("git", ["show", `${baseSha}:${path}`], { cwd: root, encoding: "utf8", windowsHide: true });
  const src = read("tools/ci-merge-lane.mjs");
  const policy = read("config/review-risk-policy.json");
  const dir = mkdtempSync(join(tmpdir(), "babel-base-lane-"));
  try {
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "config"));
    const modulePath = join(dir, "tools", "ci-merge-lane.mjs");
    writeFileSync(modulePath, src);
    writeFileSync(join(dir, "config", "review-risk-policy.json"), policy);
    const mod = await import(pathToFileURL(modulePath).href);
    if (typeof mod.classifyMergeLane !== "function") {
      throw new Error("Base merge-lane module is missing classifyMergeLane");
    }
    return mod.classifyMergeLane(input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    } catch {
      lane = { full: true, installer: true };
      process.stderr.write("Trusted base classification unavailable; requiring full qualification\n");
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
