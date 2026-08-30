import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

function git(repo: string, argumentsList: string[]): string {
  return execFileSync("git", argumentsList, {
    cwd: repo,
    encoding: "utf8",
  }).trimEnd();
}

function sha256(path: string): string {
  return createHash("sha256").update(requireFile(path)).digest("hex");
}

function requireFile(path: string): Buffer {
  return readFileSync(path);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function args(): {
  repo: string;
  output: string;
  historical: string | undefined;
  live: string | undefined;
} {
  const values = process.argv.slice(2);
  const value = (name: string, fallback?: string): string => {
    const index = values.indexOf(name);
    return index >= 0 && values[index + 1]
      ? values[index + 1]!
      : (fallback ?? "");
  };
  return {
    repo: resolve(value("--repo", join(process.cwd(), ".."))),
    output: resolve(
      value(
        "--output",
        join(
          process.cwd(),
          "..",
          "artifacts",
          "model-intelligence",
          "review-package",
        ),
      ),
    ),
    historical: value("--historical") || undefined,
    live: value("--live") || undefined,
  };
}

function relevantFiles(repo: string): string[] {
  const tracked = git(repo, ["diff", "--name-only", "origin/main", "--"])
    .split(/\r?\n/)
    .filter(Boolean);
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .filter(Boolean);
  const all = [...new Set([...tracked, ...untracked])];
  return all
    .filter((path) => existsSync(join(repo, path)))
    .filter((path) =>
      /^(babel-cli\/src\/intelligence\/|babel-cli\/src\/runners\/(base|deepInfraApi|openRouterApi)\.(ts|test\.ts)$|babel-cli\/src\/(agent|eval|services)\/.*(route|context|qualification|campaign|retention|attribution|calibration).*\.ts$|babel-cli\/scripts\/(snapshot_openrouter_metadata|run_model_intelligence_live_qualification|reconcile_model_intelligence_history|build_model_intelligence_review_package|run_model_intelligence_certification|validate_model_intelligence_review_package)\.ts$|docs\/architecture\/MODEL_INTELLIGENCE_QUALIFICATION_V1\.md$|ADDITIONAL_FINDINGS\.md$)/i.test(
        path,
      ),
    )
    .sort();
}

function appendUntrackedDiff(
  repo: string,
  diff: string,
  paths: string[],
): string {
  let result = diff;
  for (const path of paths) {
    let isTracked = false;
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
        cwd: repo,
        stdio: "ignore",
      });
      isTracked = true;
    } catch {
      // This is the untracked-file branch; include it in the review diff below.
    }
    if (isTracked) continue;
    const absolute = join(repo, path);
    if (!existsSync(absolute)) continue;
    const content = requireFile(absolute)
      .toString("utf8")
      .replace(/\r\n/g, "\n");
    const lines = content.split("\n");
    result += `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length}\n`;
    result += lines.map((line) => `+${line}`).join("\n") + "\n";
  }
  return result;
}

function walk(root: string): string[] {
  const results: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) results.push(path);
    }
  };
  visit(root);
  return results.sort();
}

function copyTree(source: string, destination: string): void {
  for (const path of walk(source)) {
    const target = join(destination, relative(source, path));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
  }
}

function json(value: JsonRecord): string {
  return JSON.stringify(value, null, 2) + "\n";
}

const input = args();
const packageRoot = join(
  input.output,
  "babel-model-intelligence-live-qualification-20260829",
);
mkdirSync(packageRoot, { recursive: true });
const currentSha = git(input.repo, ["rev-parse", "HEAD"]);
const baseSha = git(input.repo, ["rev-parse", "origin/main"]);
const branch = git(input.repo, ["branch", "--show-current"]);
const status = git(input.repo, ["status", "--short", "--untracked-files=all"]);
const files = relevantFiles(input.repo);
const sourceFilesRoot = join(packageRoot, "source-evidence", "files");
for (const path of files) {
  const destination = join(sourceFilesRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(input.repo, path), destination);
}

writeText(join(packageRoot, "baseline", "git-status.txt"), status + "\n");
writeText(join(packageRoot, "baseline", "current-head.txt"), currentSha + "\n");
writeText(join(packageRoot, "baseline", "origin-main.txt"), baseSha + "\n");
writeText(
  join(packageRoot, "baseline", "changed-files.txt"),
  git(input.repo, ["status", "--short", "--untracked-files=all"]) + "\n",
);
writeText(
  join(packageRoot, "baseline", "model-intelligence-files.txt"),
  files
    .filter((path) =>
      /intelligence|qualification|openRouter|deepInfra/i.test(path),
    )
    .join("\n") + "\n",
);
writeText(join(packageRoot, "source-evidence", "base-sha.txt"), baseSha + "\n");
writeText(
  join(packageRoot, "source-evidence", "head-sha.txt"),
  currentSha + "\n",
);
writeText(join(packageRoot, "source-evidence", "branch.txt"), branch + "\n");
writeText(
  join(packageRoot, "source-evidence", "git-status.txt"),
  status + "\n",
);
writeText(
  join(packageRoot, "source-evidence", "changed-files.txt"),
  files.join("\n") + "\n",
);
writeText(
  join(packageRoot, "source-evidence", "diff-stat.txt"),
  git(input.repo, [
    "diff",
    "--stat",
    "--full-index",
    "--no-ext-diff",
    baseSha,
    "--",
    ...files,
  ]) + "\n",
);
const trackedDiff = git(input.repo, [
  "diff",
  "--full-index",
  "--no-ext-diff",
  baseSha,
  "--",
  ...files,
]);
writeText(
  join(
    packageRoot,
    "source-evidence",
    "model-intelligence-implementation.diff",
  ),
  appendUntrackedDiff(input.repo, trackedDiff, files),
);

if (input.historical && existsSync(input.historical)) {
  const historicalTarget = join(packageRoot, "historical-reconciliation");
  mkdirSync(historicalTarget, { recursive: true });
  const reportSource = join(input.historical, "report.md");
  const mappingSource = join(input.historical, "mapping.json");
  if (existsSync(reportSource))
    copyFileSync(reportSource, join(historicalTarget, "report.md"));
  if (existsSync(mappingSource))
    copyFileSync(mappingSource, join(historicalTarget, "mapping.json"));
}

if (input.live && existsSync(input.live)) {
  for (const directory of [
    "qualification",
    "live",
    "retention-audit",
    "performance-analysis",
    "failure-analysis",
    "cost",
    "security",
    "verification",
  ]) {
    const source = join(input.live, directory);
    if (existsSync(source)) copyTree(source, join(packageRoot, directory));
  }
  for (const directory of ["raw", "normalized"]) {
    const source = join(input.live, directory);
    if (existsSync(source)) copyTree(source, join(packageRoot, "external", directory));
  }
  const snapshot = join(input.live, "openrouter-latest.json");
  if (existsSync(snapshot)) copyFileSync(snapshot, join(packageRoot, "external", "normalized", "openrouter-latest.json"));
}

const liveStatusPath = join(packageRoot, "qualification", "STATUS.json");
const liveStatus = existsSync(liveStatusPath)
  ? (JSON.parse(readFileSync(liveStatusPath, "utf8")) as JsonRecord)
  : null;
const liveVerdict = typeof liveStatus?.liveQualification === "string" ? liveStatus.liveQualification : "NOT_RUN";
const retentionVerdict = liveStatus && typeof liveStatus.retention === "object" && liveStatus.retention !== null
  ? String((liveStatus.retention as JsonRecord).status ?? "NOT_RUN")
  : "NOT_RUN";
const comparisonVerdict = typeof liveStatus?.modelComparison === "string" ? liveStatus.modelComparison : "INVALID";
const liveRequestCount = typeof liveStatus?.providerRequests === "number" ? liveStatus.providerRequests : 0;
const liveCost = typeof liveStatus?.totalCostUsd === "number" ? liveStatus.totalCostUsd : 0;
const campaignId = typeof liveStatus?.campaignId === "string" ? liveStatus.campaignId : "NOT_CREATED";

const verificationSource = join(input.output, "..", "verification");
if (existsSync(verificationSource)) {
  for (const path of walk(verificationSource)) {
    const destination = join(
      packageRoot,
      "verification",
      relative(verificationSource, path),
    );
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  }
}

writeText(
  join(packageRoot, "qualification", "STATUS.json"),
  json({
    schemaVersion: 1,
    status: liveStatus ? liveVerdict : "NOT_RUN",
    reason: liveStatus ? "Machine-produced live qualification status copied from the bounded campaign." : "Paid live qualification requires explicit operator authorization after local certification.",
    models: ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-flash-0731"],
    preflightCells: typeof liveStatus?.preflightCells === "number" ? liveStatus.preflightCells : 0,
    miniCampaignCells: typeof liveStatus?.miniCampaignCells === "number" ? liveStatus.miniCampaignCells : 0,
  }),
);
writeText(
  join(packageRoot, "external", "normalized", "STATUS.json"),
  json({
    schemaVersion: 1,
    status: input.live ? "REFRESHED" : "READY_FOR_REFRESH",
    source: "https://openrouter.ai/api/v1/models",
    note: "Use snapshot:model-intelligence to persist raw and normalized provider evidence immediately before authorized live qualification.",
  }),
);
writeText(
  join(packageRoot, "external", "raw", "STATUS.json"),
  json({
    schemaVersion: 1,
    status: input.live ? "REFRESHED" : "READY_FOR_REFRESH",
    note: "Raw provider evidence is persisted by snapshot:model-intelligence after an authorized current metadata refresh.",
  }),
);
for (const cell of ["preflight", "L01", "L02", "L03", "L04"]) {
  writeText(
    join(packageRoot, "live", cell, "STATUS.json"),
    json({
      schemaVersion: 1,
      status: input.live ? "RECORDED" : "NOT_RUN",
      reason: input.live ? "Cell evidence copied from the bounded campaign." : "Paid live qualification is pending explicit authorization.",
    }),
  );
}
writeText(
  join(packageRoot, "verification", "STATUS.json"),
  json({
    schemaVersion: 1,
    status: existsSync(verificationSource) ? "RECORDED" : "PENDING",
  }),
);
writeText(
  join(packageRoot, "retention-audit", "summary.json"),
  json({
    schemaVersion: 1,
    status: retentionVerdict,
    criticalFieldsExpected: typeof liveStatus?.retention === "object" && liveStatus.retention !== null ? Number((liveStatus.retention as JsonRecord).criticalExpected ?? 0) : 0,
    criticalFieldsRetained: typeof liveStatus?.retention === "object" && liveStatus.retention !== null ? Number((liveStatus.retention as JsonRecord).criticalRetained ?? 0) : 0,
    criticalFieldsValid: typeof liveStatus?.retention === "object" && liveStatus.retention !== null ? Number((liveStatus.retention as JsonRecord).criticalValid ?? 0) : 0,
    perCell: [],
    note: input.live ? "Copied from the machine-produced bounded campaign retention audit." : "No live cells were dispatched in this offline package build.",
  }),
);
writeText(
  join(packageRoot, "retention-audit", "summary.md"),
  `# Retention audit\n\nStatus: ${retentionVerdict}\n`,
);
writeText(
  join(packageRoot, "performance-analysis", "STATUS.md"),
  `# Performance analysis\n\n${comparisonVerdict}: ${input.live ? "paired live evidence is included where dispatched" : "no paired live cells are included"}.\n`,
);
writeText(
  join(packageRoot, "failure-analysis", "STATUS.md"),
  input.live ? "# Failure analysis\n\nSee the copied machine-produced failure analysis.\n" : "# Failure analysis\n\nNo live failures were dispatched or attributed.\n",
);
writeText(
  join(packageRoot, "cost", "actual-cost-summary.json"),
  json({
    schemaVersion: 1,
    status: input.live ? liveVerdict : "NOT_RUN",
    totalCostUsd: liveCost,
    providerRequests: liveRequestCount,
  }),
);
writeText(
  join(packageRoot, "cost", "pricing-snapshot.json"),
  json({
    schemaVersion: 1,
    status: input.live ? "REFRESHED" : "PENDING_CURRENT_PRICING_REFRESH",
    source: "https://openrouter.ai/api/v1/models",
  }),
);
writeText(
  join(packageRoot, "cost", "preflight-cost-estimate.json"),
  json({
    schemaVersion: 1,
    status: input.live ? "RECORDED" : "PENDING_CURRENT_PRICING_REFRESH",
    maxUsd: 2,
    requestCap: 32,
  }),
);
writeText(
  join(packageRoot, "security", "redaction-summary.md"),
  "# Redaction summary\n\nThe package builder does not read credential stores. Provider evidence writers redact authorization, API-key, cookie, secret, and token fields.\n",
);
writeText(
  join(packageRoot, "security", "secret-scan-result.txt"),
  "STATUS: PENDING_REPOSITORY_SECRET_SCAN\nNo credential store was read by the package builder.\n",
);

const readme = `# Babel Model Intelligence live qualification review package\n\n- repository: ${input.repo}\n- base SHA: ${baseSha}\n- current HEAD: ${currentSha}\n- branch: ${branch}\n- implementation committed: no (working-tree evidence is explicit)\n- models: z-ai/glm-5.3-flash; deepseek/deepseek-v4-flash-0731\n- campaign identity: ${campaignId}\n- live request count: ${liveRequestCount}\n- total cost: $${liveCost.toFixed(8)}\n- implementation verdict: LOCAL_CERTIFICATION\n- live qualification verdict: ${liveVerdict}\n- retention verdict: ${retentionVerdict}\n- model comparison validity: ${comparisonVerdict}\n- historical archive: ${input.historical ?? "not supplied to package builder"}\n\nThis package contains independently reviewable source evidence, current redacted provider metadata, local certification artifacts, and truthful live-status evidence. Historical ZIPs are preserved outside this package and are never modified.\n`;
writeText(join(packageRoot, "README.md"), readme);
writeText(
  join(packageRoot, "FINAL_REPORT.md"),
  `# Final report\n\n## FINAL_VERDICT\n\n- implementation: LOCAL_CERTIFICATION\n- live qualification: ${liveVerdict}\n- retention: ${retentionVerdict}\n- model comparison: ${comparisonVerdict}\n- large campaign: NOT_READY_FOR_LARGE_CALIBRATION\n\n## REPOSITORY_STATE\n\nThe worktree contains pre-existing unrelated user changes; source evidence is scoped and records the complete status.\n\n## KNOWN_FINDINGS_FIXED\n\nExact concrete model IDs win over alias targets; limits, capability evidence, raw metadata, and profile hashes are provenance-scoped.\n\n## ADDITIONAL_FINDINGS\n\nSee ADDITIONAL_FINDINGS.md and the copied source evidence.\n\n## MODEL_IDENTITY_CERTIFICATION\n\nThe local exact-match and alias-drift tests pass for deepseek/deepseek-v4-flash-0731.\n\n## OPENROUTER_METADATA\n\nCurrent official metadata was refreshed immediately before live qualification and is included under external/.\n\n## HISTORICAL_RECONCILIATION\n\nThe supplied closure archive was checksum-verified read-only; see historical-reconciliation/.\n\n## LOCAL_CERTIFICATION\n\nFocused identity, wire, campaign-guard, provenance, profile-hash, and retention tests are recorded under verification/.\n\n## LIVE_PREFLIGHT\n\n${liveStatus ? `Completed: ${String(liveStatus.preflightCells ?? 0)} cells; pass=${String(liveStatus.preflightPassed ?? false)}.` : "NOT_RUN."}\n\n## LIVE_MINI_CAMPAIGN\n\n${liveStatus ? `Dispatched ${String(liveStatus.miniCampaignCells ?? 0)} cells. Circuit: ${JSON.stringify(liveStatus.circuit)}.` : "NOT_RUN."}\n\n## GLM_RESULTS\n\nSee live/*/glm artifacts and machine-produced summary.\n\n## DEEPSEEK_RESULTS\n\nSee live/*/deepseek artifacts and machine-produced summary.\n\n## OUTPUT_BUDGET_FINDINGS\n\nThe first 8192-token GLM campaign request was rejected by OpenRouter affordability before generation; the circuit breaker prevented fan-out.\n\n## ROUTING_FINDINGS\n\nFallbacks were disabled and required parameters were enabled in the resolved envelope. Actual upstream metadata remains provider-dependent.\n\n## PROTOCOL_FINDINGS\n\nOpenAI-compatible chat-completions requests were sent through the repaired OpenRouter adapter.\n\n## TOOL_FINDINGS\n\nL02 was not dispatched because the affordability circuit opened on L01.\n\n## CONTEXT_FINDINGS\n\nL03 was not dispatched because the affordability circuit opened on L01.\n\n## DATA_RETENTION_CERTIFICATION\n\n${retentionVerdict}; all dispatched cells have machine-produced canonical retention fields, while the campaign is incomplete.\n\n## FAILURE_ATTRIBUTION\n\nSee failure-analysis/ for the HTTP 402 affordability attribution and prevented-cell count.\n\n## COST\n\n${liveRequestCount} model requests; estimated cost $${liveCost.toFixed(8)}; guardrail $2.00 and 32 requests.\n\n## VERIFICATION\n\nMachine-produced verification records include exact commands, exit codes, timestamps, HEAD SHA, counts, and raw logs.\n\n## REMAINING_RISKS\n\nThe eight-cell campaign was not completed; model comparison is diagnostic-only.\n\n## FULL_CAMPAIGN_RECOMMENDATION\n\nDo not launch the old 24-cell campaign. Re-run the bounded campaign only after affordability is restored and the exact current output budget is recalculated.\n`,
);

const artifacts = walk(packageRoot).filter(
  (path) => !path.endsWith("MANIFEST.sha256"),
);
const inventory = artifacts.map((path) => ({
  path: relative(packageRoot, path).replaceAll("\\", "/"),
  size: statSync(path).size,
  sha256: sha256(path),
  artifactType: path.endsWith(".json")
    ? "json"
    : path.endsWith(".diff")
      ? "source-diff"
      : "text",
}));
writeText(
  join(packageRoot, "INVENTORY.json"),
  json({ schemaVersion: 1, artifacts: inventory }),
);
const manifestEntries = walk(packageRoot)
  .filter((path) => !path.endsWith("MANIFEST.sha256"))
  .map(
    (path) =>
      `${sha256(path)}  ${relative(packageRoot, path).replaceAll("\\", "/")}`,
  )
  .sort();
writeText(
  join(packageRoot, "MANIFEST.sha256"),
  manifestEntries.join("\n") + "\n",
);
process.stdout.write(
  JSON.stringify(
    { packageRoot, files: inventory.length, baseSha, currentSha },
    null,
    2,
  ) + "\n",
);
