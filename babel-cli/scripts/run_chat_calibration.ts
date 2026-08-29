/**
 * Execute the frozen 24-cell Chat calibration only after explicit operator
 * authorization. Without --dry-run and --i-authorize-live this command never
 * invokes a provider.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CANARY_TASKS } from "../src/eval/canary/tasks.js";
import { runCodingCanary } from "../src/eval/canary/runner.js";
import {
  buildChatCalibrationManifest,
  buildChatCalibrationSchedule,
  CHAT_CALIBRATION_CAMPAIGN_ID,
  type ChatCalibrationCampaignId,
  type CampaignClassification,
  writeChatCalibrationManifest,
} from "../src/services/chatCalibration.js";
import { redactSecrets } from "../src/utils/secretRedaction.js";

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function parseArgs(argv: string[]): {
  authorize: boolean;
  dryRun: boolean;
  evidenceDir: string;
  babelSha: string;
  help: boolean;
  campaignId: ChatCalibrationCampaignId;
  developmentExperiment: boolean;
} {
  const result: {
    authorize: boolean;
    dryRun: boolean;
    evidenceDir: string;
    babelSha: string;
    help: boolean;
    campaignId: ChatCalibrationCampaignId;
    developmentExperiment: boolean;
  } = {
    authorize: false,
    dryRun: false,
    evidenceDir: "",
    babelSha: "",
    help: false,
    campaignId: CHAT_CALIBRATION_CAMPAIGN_ID,
    developmentExperiment: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--i-authorize-live") result.authorize = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--evidence-dir")
      result.evidenceDir = resolve(argv[++index] ?? "");
    else if (arg === "--babel-sha") result.babelSha = argv[++index] ?? "";
    else if (arg === "--campaign-id") {
      const campaignId = argv[++index] ?? "";
      if (
        ![
          "chat-calibration-v1",
          "chat-calibration-v2",
          "chat-calibration-v2-repair-validation",
          "chat-calibration-v3-canonical",
        ].includes(campaignId)
      )
        throw new Error(`Unsupported campaign id: ${campaignId}`);
      result.campaignId = campaignId as ChatCalibrationCampaignId;
    } else if (arg === "--development-experiment")
      result.developmentExperiment = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage(): void {
  process.stdout.write(
    [
      "Usage: npx tsx scripts/run_chat_calibration.ts --dry-run",
      "   or: npx tsx scripts/run_chat_calibration.ts --i-authorize-live --campaign-id <id> --babel-sha <sha> --evidence-dir <dir>",
      "   add --development-experiment only for a deliberately dirty development run",
      "",
      "Runs exactly 4 tasks × 2 OpenRouter models × 3 trials, each from a fresh canary workspace.",
    ].join("\n") + "\n",
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fileDigest(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function sourceDigest(repoRoot: string, paths: string[]): string {
  const hash = createHash("sha256");
  for (const relativePath of [...paths].sort()) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(join(repoRoot, relativePath)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function buildCampaignProvenance(
  repoRoot: string,
  babelSha: string,
  developmentExperiment: boolean,
): {
  provenance: import("../src/services/chatCalibration.js").CampaignProvenance;
  classification: CampaignClassification;
} {
  const status = git(repoRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const dirty = status.length > 0;
  const gitSha = git(repoRoot, ["rev-parse", "HEAD"]);
  const gitTreeSha = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  if (gitSha !== babelSha)
    throw new Error(
      `canonical preflight failed: HEAD ${gitSha} does not match --babel-sha ${babelSha}`,
    );
  if (dirty && !developmentExperiment) {
    throw new Error(
      "canonical preflight failed: worktree is dirty; use a clean committed checkout or explicitly pass --development-experiment",
    );
  }
  const classification: CampaignClassification = developmentExperiment
    ? "DEVELOPMENT_EXPERIMENT"
    : "CANONICAL_CALIBRATION";
  const diffSha = dirty
    ? createHash("sha256")
        .update(
          execFileSync("git", ["diff", "--binary"], {
            cwd: repoRoot,
            encoding: "buffer",
          }),
        )
        .digest("hex")
    : null;
  const packageLockSha = fileDigest(
    join(repoRoot, "babel-cli", "package-lock.json"),
  );
  if (!packageLockSha)
    throw new Error("canonical preflight failed: package-lock.json is missing");
  const runnerSha = sourceDigest(repoRoot, [
    "babel-cli/src/runners/base.ts",
    "babel-cli/src/runners/deepInfraApi.ts",
    "babel-cli/src/runners/openRouterApi.ts",
    "babel-cli/src/runners/providerFailureReceipt.ts",
  ]);
  const analyzerSha = sourceDigest(repoRoot, [
    "babel-cli/scripts/analyze_chat_calibration.ts",
    "babel-cli/src/services/chatCalibration.ts",
    "babel-cli/src/services/chatCalibrationOutcome.ts",
  ]);
  const buildArtifactSha = fileDigest(
    join(repoRoot, "babel-cli", "dist", "index.js"),
  );
  const composite = createHash("sha256")
    .update(
      JSON.stringify({
        gitSha,
        gitTreeSha,
        packageLockSha,
        buildArtifactSha,
        runnerSha,
        analyzerSha,
        dirty,
        classification,
        diffSha,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    classification,
    provenance: {
      git_sha: gitSha,
      git_tree_sha: gitTreeSha,
      package_lock_sha256: packageLockSha,
      build_artifact_sha256: buildArtifactSha,
      runner_source_sha256: runnerSha,
      analyzer_source_sha256: analyzerSha,
      source_composite_sha256: composite,
      dirty,
      classification,
      diff_sha256: diffSha,
    },
  };
}

function writeEvidenceManifest(root: string): string {
  const manifestName = "calibration-evidence-manifest.json";
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const fullPath = join(directory, name);
      if (fullPath === join(root, manifestName)) continue;
      const stat = statSync(fullPath);
      if (stat.isDirectory()) visit(fullPath);
      else if (stat.isFile()) {
        const bytes = readFileSync(fullPath);
        files.push({
          path: fullPath.slice(root.length + 1).replaceAll("\\", "/"),
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  visit(root);
  const path = join(root, manifestName);
  writeFileSync(
    path,
    `${JSON.stringify({ schema_version: 1, kind: "babel_calibration_evidence_manifest", files }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

function writeLaunchResults(
  root: string,
  manifestPath: string,
  results: readonly Record<string, unknown>[],
): string {
  const summary = {
    completed: results.filter((result) => result.status === "completed").length,
    provider_attempted: results.filter(
      (result) => result.provider_attempted === true,
    ).length,
    blocked_before_inference: results.filter(
      (result) => result.status === "blocked_before_inference",
    ).length,
    errors: results.filter((result) => result.status === "error").length,
  };
  const resultPath = join(root, "calibration-launch-results.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    campaign_id?: string;
  };
  writeFileSync(
    resultPath,
    `${JSON.stringify({ campaign_id: manifest.campaign_id ?? null, manifest_path: manifestPath, summary, results }, null, 2)}\n`,
    "utf8",
  );
  return resultPath;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!args.dryRun && !args.authorize) {
    throw new Error(
      "Refusing live calibration: pass --i-authorize-live or use --dry-run",
    );
  }
  if (!args.dryRun && (!args.babelSha || !args.evidenceDir)) {
    throw new Error("Live calibration requires --babel-sha and --evidence-dir");
  }
  const schedule = buildChatCalibrationSchedule();
  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ campaign_id: args.campaignId, cells: schedule }, null, 2)}\n`,
    );
    return;
  }

  // This is deliberately before evidence creation and before the first paid
  // provider call. Canonical campaigns must be reproducible from one exact
  // committed tree; dirty development runs must opt into their diff receipt.
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const { provenance } = buildCampaignProvenance(
    repoRoot,
    args.babelSha,
    args.developmentExperiment,
  );

  const taskVersions = Object.fromEntries(
    CANARY_TASKS.filter((task) =>
      ["C01", "C02", "C04", "C08"].includes(task.id),
    ).map((task) => [task.id, digest(task)]),
  );
  const manifest = buildChatCalibrationManifest({
    campaignId: args.campaignId,
    babelSha: args.babelSha,
    taskVersions,
    verifierVersions: { canary_validity: "v1", clean_room: "v1" },
    inferenceSettings: {
      temperature: 0,
      top_p: null,
      max_output_tokens: null,
      native_tool_calling: true,
      retry_policy: "provider-bounded; no model substitution",
      timeout_ms: 600000,
    },
    isolationMode: "host_explicit",
    hostFallbackPolicy: "explicit_only",
    provenance,
  });
  mkdirSync(args.evidenceDir, { recursive: true });
  const manifestPath = writeChatCalibrationManifest(args.evidenceDir, manifest);
  const results: Array<Record<string, unknown>> = [];
  for (const cell of schedule) {
    const cellDir = join(args.evidenceDir, "cells", cell.cell_id);
    try {
      const report = runCodingCanary({
        provider: "live",
        authorizeLive: true,
        taskId: cell.task_id,
        trials: 1,
        model: cell.model.exact_model_id,
        evidenceDir: cellDir,
        openRouterRouting: { allowFallbacks: false, requireParameters: true },
        // Keep disposable workspaces beside the campaign evidence. This is
        // explicit host-fallback policy: it avoids inaccessible OS temp roots
        // while retaining one fresh, uniquely named workspace per cell.
        tempRoot: args.evidenceDir,
      });
      writeFileSync(
        join(cellDir, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
      );
      const reportRecord = report as unknown as Record<string, unknown>;
      const trials = Array.isArray(reportRecord.trials)
        ? reportRecord.trials
        : [];
      const invalidTask =
        (Array.isArray(reportRecord.invalid_task_ids) &&
          reportRecord.invalid_task_ids.includes(cell.task_id)) ||
        trials.some(
          (trial) => (trial as Record<string, unknown>).invalid_task === true,
        );
      results.push({
        cell_id: cell.cell_id,
        status: invalidTask ? "blocked_before_inference" : "completed",
        provider_attempted: !invalidTask,
        invalid_task: invalidTask,
        report_path: join(cellDir, "report.json"),
      });
      writeLaunchResults(args.evidenceDir, manifestPath, results);
    } catch (error) {
      const message = redactSecrets(
        error instanceof Error ? error.message : String(error),
      );
      results.push({ cell_id: cell.cell_id, status: "error", error: message });
      writeLaunchResults(args.evidenceDir, manifestPath, results);
      // Preserve partial evidence and stop before launching another paid cell.
      break;
    }
  }
  const resultPath = writeLaunchResults(
    args.evidenceDir,
    manifestPath,
    results,
  );
  const launchResults = JSON.parse(readFileSync(resultPath, "utf8")) as {
    summary: Record<string, number>;
  };
  const evidenceManifestPath = writeEvidenceManifest(args.evidenceDir);
  process.stdout.write(
    `${JSON.stringify({ manifest_path: manifestPath, result_path: resultPath, evidence_manifest_path: evidenceManifestPath, summary: launchResults.summary, completed_or_attempted: results.length }, null, 2)}\n`,
  );
}

main();
