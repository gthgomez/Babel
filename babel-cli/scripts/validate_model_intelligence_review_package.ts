import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : "";
}

function walk(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  visit(root);
  return paths;
}

function tar(zip: string, args: string[]): Buffer {
  const result = spawnSync("tar", args, { maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(
      result.stderr?.toString("utf8") ?? `tar failed for ${args.join(" ")}`,
    );
  return result.stdout;
}

function validateDirectory(root: string): { entries: number; bad: string[] } {
  const manifestPath = join(root, "MANIFEST.sha256");
  const bad: string[] = [];
  if (!existsSync(manifestPath))
    return { entries: 0, bad: ["MANIFEST.sha256 missing"] };
  let entries = 0;
  for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) continue;
    entries += 1;
    const path = join(root, match[2]!);
    if (!existsSync(path)) bad.push(`missing: ${match[2]}`);
    else if (sha256(readFileSync(path)) !== match[1]!.toLowerCase())
      bad.push(`hash: ${match[2]}`);
  }
  return { entries, bad };
}

function validateZip(zip: string): {
  entries: number;
  bad: string[];
  root: string;
} {
  const names = tar(zip, ["-tf", zip])
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const root =
    names
      .find((name) => name.endsWith("/MANIFEST.sha256"))
      ?.slice(0, -"MANIFEST.sha256".length) ?? "";
  const bad: string[] = [];
  if (!root) return { entries: 0, bad: ["MANIFEST.sha256 missing"], root };
  const manifest = tar(zip, ["-xOf", zip, `${root}MANIFEST.sha256`]).toString(
    "utf8",
  );
  let entries = 0;
  for (const line of manifest.split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) continue;
    entries += 1;
    const entry = `${root}${match[2]}`;
    if (!names.includes(entry)) bad.push(`missing: ${match[2]}`);
    else if (sha256(tar(zip, ["-xOf", zip, entry])) !== match[1]!.toLowerCase())
      bad.push(`hash: ${match[2]}`);
  }
  for (const required of [
    "README.md",
    "FINAL_REPORT.md",
    "INVENTORY.json",
    "source-evidence/model-intelligence-implementation.diff",
    "historical-reconciliation/mapping.json",
    "retention-audit/summary.json",
  ]) {
    if (!names.includes(`${root}${required}`))
      bad.push(`required: ${required}`);
  }
  const diff = tar(zip, [
    "-xOf",
    zip,
    `${root}source-evidence/model-intelligence-implementation.diff`,
  ]).toString("utf8");
  if (!diff.includes("src/intelligence/"))
    bad.push("implementation diff does not include src/intelligence/");
  for (const name of names.filter((name) => !name.endsWith("/"))) {
    const body = tar(zip, ["-xOf", zip, name]).toString("utf8");
    if (
      /(sk-or-v1-[a-z0-9]{20,}|authorization\s*[:=]\s*bearer\s+(?!\[redacted\])[a-z0-9._-]{16,}|api[_-]?key\s*[:=]\s*(?!\[redacted\])(?:sk-[a-z0-9-]{16,}|[a-z0-9+/]{24,}))/i.test(
        body,
      )
    )
      bad.push(`secret-pattern: ${name}`);
  }
  return { entries, bad, root };
}

const input = resolve(argument("--input"));
if (!input || !existsSync(input))
  throw new Error(
    "Usage: validate_model_intelligence_review_package.ts --input <dir-or-zip>",
  );
const result = statSync(input).isDirectory()
  ? validateDirectory(input)
  : validateZip(input);
process.stdout.write(
  JSON.stringify(
    {
      input,
      ...result,
      status: result.bad.length === 0 ? "ZIP_VALIDATED" : "ZIP_INVALID",
    },
    null,
    2,
  ) + "\n",
);
if (result.bad.length > 0) process.exitCode = 1;
