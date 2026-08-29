/**
 * Build the immutable legacy calibration corpus and honest offline reports.
 *
 * Usage:
 *   npx tsx scripts/build_historical_calibration.ts \
 *     --source-root ../runs --output ../derived/legacy-calibration-v1
 *
 * This command never writes below a source root and never claims live
 * calibration results. It is intentionally independent of provider keys.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildHistoricalCalibrationCorpus,
  writeHistoricalCalibrationCorpus,
} from "../src/services/historicalCalibration.js";
import {
  buildChatCalibrationSchedule,
  CHAT_CALIBRATION_CAMPAIGN_ID,
  CHAT_CALIBRATION_CELL_COUNT,
  CHAT_CALIBRATION_MODELS,
} from "../src/services/chatCalibration.js";

function parseArgs(argv: string[]): {
  roots: string[];
  output: string;
  help: boolean;
} {
  const roots: string[] = [];
  let output = "";
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--source-root") roots.push(resolve(argv[++index] ?? ""));
    else if (arg === "--output") output = resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { roots, output, help };
}

function writeReport(output: string, name: string, value: unknown): string {
  const path = resolve(output, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function usage(): void {
  process.stdout.write(
    [
      "Usage: npx tsx scripts/build_historical_calibration.ts --source-root <raw-root> [--source-root <raw-root> ...] --output <derived-dir>",
      "",
      "Reads and hashes legacy evidence, then writes derived analysis and honest status reports.",
    ].join("\n") + "\n",
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.roots.length === 0 || !args.output) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (args.roots.some((root) => !existsSync(root))) {
    throw new Error(
      `One or more source roots do not exist: ${args.roots.join(", ")}`,
    );
  }

  const build = buildHistoricalCalibrationCorpus({ sourceRoots: args.roots });
  const written = writeHistoricalCalibrationCorpus(
    build,
    args.output,
    args.roots,
  );
  const recovery = {
    schema_version: 1,
    kind: "babel_historical_recovery_report",
    corpus_version: build.corpus.corpus_version,
    analyzer_version: build.corpus.analyzer_version,
    recovered_runs: build.corpus.entries.length,
    runs: build.corpus.entries.map((entry) => ({
      entry_id: entry.entry_id,
      source_files: entry.source_files,
      old_classification: entry.old_causal_classification,
      new_classification:
        build.analyses.find((analysis) => analysis.entry_id === entry.entry_id)
          ?.new_causal_report.attribution ?? null,
      evidence_complete: entry.evidence_complete,
      analyzer_can_fully_interpret: entry.analyzer_can_fully_interpret,
    })),
    raw_sources_readonly: true,
    note:
      build.corpus.entries.length === 0
        ? "No canonical session-events.jsonl historical runs were found in the supplied roots; no historical result was fabricated."
        : "Raw source files were read and hashed only; all analysis is derived.",
  };
  const gapCounts = new Map<
    string,
    { count: number; classifications: Record<string, number> }
  >();
  for (const analysis of build.analyses) {
    for (const fact of analysis.impossible_or_unknown_facts) {
      const current = gapCounts.get(fact.fact) ?? {
        count: 0,
        classifications: {},
      };
      current.count += 1;
      current.classifications[fact.classification] =
        (current.classifications[fact.classification] ?? 0) + 1;
      gapCounts.set(fact.fact, current);
    }
  }
  const observability = {
    schema_version: 1,
    kind: "babel_observability_gap_report",
    analyzer_version: build.corpus.analyzer_version,
    gaps: [...gapCounts.entries()].map(([fact, value]) => ({ fact, ...value })),
    instrumentation_status: {
      context_manifest: "implemented_and_validated",
      model_route_receipt: "implemented_and_validated",
      deterministic_causal_fixtures: "implemented_and_validated",
      normal_chat_lifecycle: "wired_and_regression_tested",
    },
    note: "Historical gaps are not backfilled from model text; NOT_RECORDED_AT_RUNTIME remains unavailable.",
  };
  const familyCounts: Record<string, number> = {};
  for (const analysis of build.analyses) {
    const family = analysis.new_causal_report.attribution.family;
    familyCounts[family] = (familyCounts[family] ?? 0) + 1;
  }
  const reconciliation = {
    schema_version: 1,
    kind: "babel_runtime_error_reconciliation",
    source: "offline historical corpus",
    observed_attribution_families: familyCounts,
    classifications: [
      {
        class: "spawn_error",
        status: "environment_observed_during_local_verification",
        live_cells: 0,
      },
      {
        class: "temp_cleanup_error",
        status: "environment_observed_during_local_verification",
        live_cells: 0,
      },
      {
        class: "dataset_or_fixture_issue",
        status: "not_observed_in_corpus",
        live_cells: 0,
      },
      {
        class: "route_failure",
        status: "requires_route_receipt_or_unknown",
        live_cells: 0,
      },
      {
        class: "stale_snapshot",
        status: "not_observed_in_corpus",
        live_cells: 0,
      },
      {
        class: "environment_failure",
        status: "reported_only_when_directly_evidenced",
        live_cells: 0,
      },
      {
        class: "regression",
        status: "not_claimed_without_before_after_evidence",
        live_cells: 0,
      },
    ],
    note: "This report does not convert host test-runner failures into model or provider blame.",
  };
  const calibration = {
    schema_version: 1,
    kind: "babel_chat_calibration_report",
    status: "NOT_RUN",
    campaign_id: CHAT_CALIBRATION_CAMPAIGN_ID,
    planned_cells: CHAT_CALIBRATION_CELL_COUNT,
    tasks: ["C01", "C02", "C04", "C08"],
    models: CHAT_CALIBRATION_MODELS,
    schedule: buildChatCalibrationSchedule(),
    cells: [],
    blockers: [
      "live provider execution was not requested by this offline command",
    ],
  };
  const comparison = {
    schema_version: 1,
    kind: "babel_model_comparison",
    status: "NOT_RUN",
    model_behavior: [],
    babel_behavior: [],
    provider_behavior: [],
    environment_behavior: [],
    note: "No GLM-vs-DeepSeek claim is emitted without paired live evidence and complete causal prerequisites.",
  };
  const ledger = {
    schema_version: 1,
    kind: "babel_improvement_ledger",
    status:
      build.corpus.entries.length > 0
        ? "DERIVED_FROM_HISTORICAL_EVIDENCE"
        : "NO_HISTORICAL_EVIDENCE",
    recommendations: [],
    note: "Recommendations require source-backed recurring evidence; this offline run does not invent them.",
  };
  const reportPaths = [
    writeReport(args.output, "historical-recovery-report.json", recovery),
    writeReport(args.output, "observability-gap-report.json", observability),
    writeReport(
      args.output,
      "runtime-error-reconciliation.json",
      reconciliation,
    ),
    writeReport(args.output, "chat-calibration-report.json", calibration),
    writeReport(args.output, "model-comparison.json", comparison),
    writeReport(args.output, "babel-improvement-ledger.json", ledger),
  ];
  process.stdout.write(
    `${JSON.stringify({ manifest: written.manifestPath, analyses: written.analysisPaths.length, reports: reportPaths }, null, 2)}\n`,
  );
}

main();
