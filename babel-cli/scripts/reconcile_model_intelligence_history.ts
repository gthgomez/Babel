import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

type Classification = "PRESERVED" | "GENERALIZED" | "REPLACED" | "DEPRECATED";

const mechanisms: Array<{
  name: string;
  archivePattern: RegExp;
  currentPaths: string[];
}> = [
  {
    name: "campaign manifests",
    archivePattern: /campaign-manifest|calibration-evidence-manifest/i,
    currentPaths: [
      "babel-cli/src/intelligence/qualification.ts",
      "babel-cli/src/intelligence/campaignGuards.ts",
    ],
  },
  {
    name: "model route receipts",
    archivePattern: /route-receipt|model-route/i,
    currentPaths: ["babel-cli/src/agent/modelRouteReceipt.ts"],
  },
  {
    name: "context manifests",
    archivePattern: /context-manifest/i,
    currentPaths: ["babel-cli/src/agent/contextManifest.ts"],
  },
  {
    name: "tool lifecycle receipts",
    archivePattern: /tool.*receipt|tool-events/i,
    currentPaths: ["babel-cli/src/agent/sessionEvents.ts"],
  },
  {
    name: "provider retry receipts",
    archivePattern: /retry/i,
    currentPaths: ["babel-cli/src/intelligence/retryPolicy.ts"],
  },
  {
    name: "model policy routing",
    archivePattern: /model-policy|model.*routing/i,
    currentPaths: [
      "babel-cli/src/modelPolicy.ts",
      "babel-cli/src/intelligence/resolver.ts",
    ],
  },
  {
    name: "compaction routing",
    archivePattern: /compaction/i,
    currentPaths: ["babel-cli/src/agent/chatCompaction.ts"],
  },
  {
    name: "critic routing",
    archivePattern: /critic/i,
    currentPaths: ["babel-cli/src/intelligence/inferenceInventory.ts"],
  },
  {
    name: "readiness calculations",
    archivePattern: /readiness/i,
    currentPaths: ["babel-cli/src/intelligence/campaignGuards.ts"],
  },
  {
    name: "model-comparison validity",
    archivePattern: /model-comparison/i,
    currentPaths: ["babel-cli/src/intelligence/campaignGuards.ts"],
  },
  {
    name: "failure attribution",
    archivePattern: /failure|attribution/i,
    currentPaths: ["babel-cli/src/intelligence/attribution.ts"],
  },
  {
    name: "schedule hashing",
    archivePattern: /schedule|campaign.*hash/i,
    currentPaths: ["babel-cli/src/intelligence/treatment.ts"],
  },
  {
    name: "campaign provenance",
    archivePattern: /provenance|manifest/i,
    currentPaths: [
      "babel-cli/src/intelligence/treatment.ts",
      "babel-cli/src/intelligence/providerEvidence.ts",
    ],
  },
];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function args(): { archive: string; output: string; repo: string } {
  const values = process.argv.slice(2);
  const value = (name: string, fallback?: string): string => {
    const index = values.indexOf(name);
    return index >= 0 && values[index + 1]
      ? values[index + 1]!
      : (fallback ?? "");
  };
  const archive = value("--archive");
  const output = value(
    "--output",
    join(
      process.cwd(),
      "artifacts",
      "model-intelligence",
      "historical-reconciliation",
    ),
  );
  if (!archive)
    throw new Error(
      "Usage: reconcile_model_intelligence_history.ts --archive <zip> --output <dir>",
    );
  return {
    archive: resolve(archive),
    output: resolve(output),
    repo: resolve(value("--repo", join(process.cwd(), ".."))),
  };
}

function tar(archive: string, operation: string, entry?: string): Buffer {
  const argumentsList =
    operation === "list" ? ["-tf", archive] : ["-xOf", archive, entry!];
  return execFileSync("tar", argumentsList, { maxBuffer: 64 * 1024 * 1024 });
}

function verifyManifest(
  archive: string,
  entries: string[],
): { present: boolean; verified: number; failed: string[] } {
  if (!entries.includes("MANIFEST.sha256"))
    return { present: false, verified: 0, failed: ["MANIFEST.sha256 missing"] };
  const manifest = tar(archive, "extract", "MANIFEST.sha256").toString("utf8");
  const failed: string[] = [];
  let verified = 0;
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) continue;
    const [, expected, path] = match;
    if (!entries.includes(path!)) {
      failed.push(`${path}: missing from archive`);
      continue;
    }
    const actual = sha256(tar(archive, "extract", path));
    if (actual !== expected!.toLowerCase())
      failed.push(`${path}: expected ${expected}, got ${actual}`);
    else verified += 1;
  }
  return { present: true, verified, failed };
}

async function main(): Promise<void> {
  const input = args();
  if (!existsSync(input.archive))
    throw new Error(`Archive not found: ${input.archive}`);
  const entries = tar(input.archive, "list")
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const checksum = verifyManifest(input.archive, entries);
  const mapping = mechanisms.map((mechanism) => {
    const historicalArtifacts = entries.filter((entry) =>
      mechanism.archivePattern.test(entry),
    );
    const currentEvidence = mechanism.currentPaths.filter((path) =>
      existsSync(join(input.repo, path)),
    );
    const classification: Classification =
      currentEvidence.length === 0
        ? "DEPRECATED"
        : historicalArtifacts.length === 0
          ? "REPLACED"
          : "GENERALIZED";
    return {
      mechanism: mechanism.name,
      classification,
      historicalArtifacts,
      currentEvidence,
      notes:
        classification === "GENERALIZED"
          ? "Historical artifacts were inspected and the behavior is represented by the current typed intelligence/runtime evidence lane."
          : classification === "REPLACED"
            ? "No matching historical artifact name was found; current implementation is the replacement evidence path."
            : "No current evidence path was found; retained only as historical evidence.",
    };
  });
  const report = [
    "# Historical Model Intelligence reconciliation",
    "",
    `- archive: ${input.archive}`,
    `- archive_sha256: ${sha256(readFileSync(input.archive))}`,
    `- archive_entries: ${entries.length}`,
    `- checksum_manifest_present: ${checksum.present}`,
    `- checksum_entries_verified: ${checksum.verified}`,
    `- checksum_failures: ${checksum.failed.length}`,
    "",
    "| Mechanism | Classification | Historical evidence | Current evidence |",
    "|---|---|---|---|",
    ...mapping.map(
      (item) =>
        `| ${item.mechanism} | ${item.classification} | ${item.historicalArtifacts.join("<br>") || "—"} | ${item.currentEvidence.join("<br>") || "—"} |`,
    ),
    "",
    checksum.failed.length > 0
      ? "## Checksum failures\n\n" +
        checksum.failed.map((item) => `- ${item}`).join("\n")
      : "## Checksum verification\n\nAll manifest entries verified.",
    "",
    "Historical ZIP contents were read only; no source archive entry was modified.",
    "",
  ].join("\n");
  await mkdir(input.output, { recursive: true });
  await writeFile(
    join(input.output, "mapping.json"),
    `${JSON.stringify({ schemaVersion: 1, archive: input.archive, archiveSha256: sha256(readFileSync(input.archive)), checksum, mechanisms: mapping }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(input.output, "report.md"), report, "utf8");
  process.stdout.write(
    JSON.stringify(
      { output: input.output, archiveEntries: entries.length, checksum },
      null,
      2,
    ) + "\n",
  );
}

await main();
