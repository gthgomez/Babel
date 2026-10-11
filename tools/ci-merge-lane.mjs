#!/usr/bin/env node
// Classify a Public Release Gate run as the fast docs lane or the full matrix.
// Docs-only pull requests skip the heavy jobs. The installer runs on main
// and on pull requests labeled full-ci. Anything unrecognized stays full.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FAST_PREFIXES = ["docs/", "skills/", "02_Skills/", ".agents/skills/"];
const FAST_FILES = new Set(["README.md", "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md"]);

export function classifyMergeLane({ event, labels = [], files = [] }) {
  const labelSet = new Set(labels.map((label) => String(label).trim()).filter(Boolean));
  if (event !== "pull_request") return { full: true, installer: true };
  const meaningful = files.filter((file) => file && !file.endsWith("/"));
  const docsOnly = meaningful.length > 0 && meaningful.every((file) =>
    FAST_FILES.has(file) || FAST_PREFIXES.some((prefix) => file.startsWith(prefix)));
  const fullCi = labelSet.has("full-ci");
  return { full: fullCi || !docsOnly, installer: fullCi };
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
