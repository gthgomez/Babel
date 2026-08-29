import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  buildCausalAttributionReport,
  type CausalRunWhyReport,
} from "./causalAttribution.js";
import {
  inspectSessionEventLogFromDir,
  type SessionEventLog,
} from "../agent/sessionEvents.js";

export const LEGACY_CALIBRATION_CORPUS_VERSION =
  "legacy-calibration-v1" as const;
export const HISTORICAL_ANALYZER_VERSION = "causal-analyzer-v1" as const;

export type HistoricalFactClassification =
  | "DERIVABLE_FROM_EXISTING_EVIDENCE"
  | "NOT_RECORDED_AT_RUNTIME"
  | "AMBIGUOUS"
  | "CONTRADICTORY";

export interface HistoricalFactAssessment {
  fact: string;
  classification: HistoricalFactClassification;
  reason: string;
}

export interface HistoricalCorpusSource {
  path: string;
  sha256: string;
  bytes: number;
  role: "session_events" | "metadata" | "report" | "unknown";
}

export interface HistoricalCorpusEntry {
  entry_id: string;
  source_files: HistoricalCorpusSource[];
  original_babel_sha: string | null;
  model: string | null;
  provider: string | null;
  task_id: string | null;
  baseline_sha: string | null;
  run_id: string | null;
  session_id: string | null;
  evidence_schema: string | null;
  timestamp: string | null;
  outcome: string | null;
  evidence_complete: boolean;
  analyzer_can_fully_interpret: boolean;
  old_causal_classification: string | null;
  derived_analysis_path: string | null;
  derived_analysis_sha256: string | null;
}

export interface HistoricalDerivedAnalysis {
  schema_version: 1;
  kind: "babel_historical_causal_reanalysis";
  analyzer_version: typeof HISTORICAL_ANALYZER_VERSION;
  corpus_version: typeof LEGACY_CALIBRATION_CORPUS_VERSION;
  entry_id: string;
  derived_at: string;
  source_schema_version: string | null;
  source_sha256: string[];
  directly_recorded_facts: string[];
  derived_facts: string[];
  impossible_or_unknown_facts: HistoricalFactAssessment[];
  old_causal_classification: string | null;
  new_causal_report: CausalRunWhyReport;
}

export interface HistoricalCalibrationCorpus {
  schema_version: 1;
  kind: "babel_historical_calibration_corpus";
  corpus_version: typeof LEGACY_CALIBRATION_CORPUS_VERSION;
  analyzer_version: typeof HISTORICAL_ANALYZER_VERSION;
  created_at: string;
  source_roots: string[];
  raw_sources_readonly: true;
  entries: HistoricalCorpusEntry[];
}

export interface HistoricalCalibrationBuild {
  corpus: HistoricalCalibrationCorpus;
  analyses: HistoricalDerivedAnalysis[];
}

const FACTS = [
  "information_existed",
  "route_correct",
  "context_preserved",
  "capability_authorized",
  "capability_effective",
  "execution_valid",
  "result_delivered",
  "verification_valid",
  "task_feasible",
] as const;

function sha256(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function stringField(value: unknown, keys: string[]): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].length > 0)
      return record[key] as string;
  }
  return null;
}

function selectedFiles(root: string): string[] {
  const found: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist", ".cache", "cache"]);
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const isSession = lower === "session-events.jsonl";
      const isCandidate =
        isSession ||
        ([".json", ".jsonl"].includes(extname(lower)) &&
          /(causal|canary|validity|verifier|route|improvement|baseline|receipt|cli)/i.test(
            lower,
          ));
      if (isCandidate) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

function sourceRole(path: string): HistoricalCorpusSource["role"] {
  const lower = basename(path).toLowerCase();
  if (lower === "session-events.jsonl") return "session_events";
  if (
    /causal|canary|validity|verifier|route|improvement|baseline|receipt|cli/i.test(
      lower,
    )
  ) {
    return "report";
  }
  return "metadata";
}

function sourceDescriptor(path: string): HistoricalCorpusSource {
  const raw = readFileSync(path);
  return {
    path: resolve(path),
    sha256: sha256(raw),
    bytes: raw.byteLength,
    role: sourceRole(path),
  };
}

function parseMetadata(paths: string[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const path of paths) {
    if (extname(path).toLowerCase() !== ".json") continue;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        records.push(value as Record<string, unknown>);
      }
    } catch {
      // A malformed historical sidecar is preserved as a source, but cannot
      // be treated as structured metadata or silently repaired.
    }
  }
  return records;
}

function sessionFor(path: string): {
  log: SessionEventLog | null;
  error?: string;
} {
  const loaded = inspectSessionEventLogFromDir(dirname(path));
  if (loaded.kind === "valid") return { log: loaded.log };
  if (loaded.kind === "invalid")
    return { log: null, error: loaded.error.message };
  return { log: null, error: "session event log missing" };
}

function eventFacts(log: SessionEventLog | null): {
  directlyRecorded: string[];
  derived: string[];
  assessments: HistoricalFactAssessment[];
} {
  if (!log) {
    return {
      directlyRecorded: [],
      derived: [],
      assessments: FACTS.map((fact) => ({
        fact,
        classification: "NOT_RECORDED_AT_RUNTIME",
        reason: "No valid canonical session event log was available.",
      })),
    };
  }
  const kinds = new Set(log.events.map((event) => event.kind));
  const inputs = log.events.filter(
    (event) => event.kind === "model_input_receipt",
  );
  const bindings = log.events.filter(
    (event) => event.kind === "capability_binding_receipt",
  );
  const directlyRecorded = [
    ...(kinds.has("user_submitted") ? ["information_existed"] : []),
    ...(bindings.length > 0 &&
    bindings.every(
      (binding) =>
        binding.kind === "capability_binding_receipt" &&
        binding.authorized !== null,
    )
      ? ["capability_authorized"]
      : []),
    ...(bindings.length > 0 &&
    bindings.every(
      (binding) =>
        binding.kind === "capability_binding_receipt" &&
        binding.effective !== null,
    )
      ? ["capability_effective"]
      : []),
    ...(kinds.has("verifier_attempt") ? ["verification_valid"] : []),
  ];
  const derived = [
    ...(inputs.length > 0 &&
    inputs.every(
      (input) =>
        input.kind === "model_input_receipt" &&
        input.requested_model_id === input.normalized_model_id &&
        input.normalized_model_id === input.sent_model_id,
    )
      ? ["route_correct"]
      : []),
    ...(kinds.has("model_input_receipt") && kinds.has("model_result_delivery")
      ? ["result_delivered"]
      : []),
    ...(kinds.has("tool_proposed") &&
    (kinds.has("tool_started") ||
      kinds.has("tool_cancelled") ||
      kinds.has("tool_failed") ||
      kinds.has("tool_completed"))
      ? ["execution_valid"]
      : []),
    ...(kinds.has("compaction_summary") || kinds.has("compaction_committed")
      ? ["context_preserved"]
      : []),
  ];
  const known = new Set([...directlyRecorded, ...derived]);
  const assessments = FACTS.filter((fact) => !known.has(fact)).map(
    (fact) =>
      ({
        fact,
        classification:
          fact === "task_feasible" ? "NOT_RECORDED_AT_RUNTIME" : "AMBIGUOUS",
        reason:
          fact === "task_feasible"
            ? "Task feasibility requires an independent baseline or validity artifact; session events do not prove it."
            : "The historical stream lacks the complete prerequisite receipt needed to distinguish competing causes.",
      }) satisfies HistoricalFactAssessment,
  );
  return { directlyRecorded, derived: [...new Set(derived)], assessments };
}

function reportMetadata(
  log: SessionEventLog | null,
  metadata: Record<string, unknown>[],
) {
  const user = log?.events.find((event) => event.kind === "user_submitted");
  const input = log?.events.find(
    (event) => event.kind === "model_input_receipt",
  );
  const firstMeta = metadata[0];
  return {
    model:
      input?.kind === "model_input_receipt"
        ? input.sent_model_id
        : stringField(firstMeta, ["model", "model_id"]),
    provider:
      input?.kind === "model_input_receipt"
        ? input.provider
        : stringField(firstMeta, ["provider"]),
    taskId: stringField(firstMeta, ["task_id", "taskId", "case_id", "cell_id"]),
    baselineSha: stringField(firstMeta, [
      "baseline_sha",
      "baselineSha",
      "base_sha",
    ]),
    originalBabelSha: stringField(firstMeta, [
      "babel_sha",
      "harness_sha",
      "original_babel_sha",
      "commit_sha",
    ]),
    runId: stringField(firstMeta, ["run_id", "runId", "cell_id"]),
    timestamp:
      user?.ts ??
      stringField(firstMeta, ["timestamp", "created_at", "started_at"]),
    outcome: stringField(firstMeta, ["outcome", "status", "result"]),
    taskPreview: user?.kind === "user_submitted" ? user.task_preview : null,
  };
}

function oldClassification(metadata: Record<string, unknown>[]): string | null {
  for (const record of metadata) {
    const attribution =
      record.attribution ??
      record.causal_attribution ??
      record.causalAttribution;
    const family = stringField(attribution, ["family"]);
    const code = stringField(attribution, ["code"]);
    if (family || code) return [family, code].filter(Boolean).join(":");
    const direct = stringField(record, [
      "classification",
      "causal_classification",
    ]);
    if (direct) return direct;
  }
  return null;
}

function entryId(path: string, digest: string): string {
  return `legacy_${sha256(`${resolve(path)}:${digest}`).slice(0, 16)}`;
}

function assertSafeOutput(outputDir: string, roots: string[]): void {
  const output = resolve(outputDir);
  for (const root of roots) {
    const rootPath = resolve(root);
    const relation = relative(rootPath, output);
    if (
      relation === "" ||
      (relation && !relation.startsWith("..") && !isAbsolute(relation))
    ) {
      throw new Error(
        `Historical corpus output must be outside raw evidence root: ${output}`,
      );
    }
  }
}

export function buildHistoricalCalibrationCorpus(input: {
  sourceRoots: string[];
  now?: string;
}): HistoricalCalibrationBuild {
  const roots = [
    ...new Set(input.sourceRoots.map((root) => resolve(root))),
  ].filter((root) => existsSync(root));
  const createdAt = input.now ?? new Date().toISOString();
  const analyses: HistoricalDerivedAnalysis[] = [];
  const entries: HistoricalCorpusEntry[] = [];
  for (const root of roots) {
    const candidates = selectedFiles(root);
    const candidatesByDir = new Map<string, string[]>();
    for (const candidate of candidates) {
      const directory = dirname(candidate);
      const current = candidatesByDir.get(directory) ?? [];
      current.push(candidate);
      candidatesByDir.set(directory, current);
    }
    const sessionPaths = candidates.filter(
      (path) => sourceRole(path) === "session_events",
    );
    const sessionDirs = new Set(sessionPaths.map((path) => dirname(path)));
    for (const sessionPath of sessionPaths) {
      const siblingFiles = (
        candidatesByDir.get(dirname(sessionPath)) ?? []
      ).filter((path) => path !== sessionPath);
      const sourcePaths = [sessionPath, ...siblingFiles];
      const sources = sourcePaths.map(sourceDescriptor);
      const { log, error } = sessionFor(sessionPath);
      const metadata = parseMetadata(siblingFiles);
      const facts = eventFacts(log);
      const report = buildCausalAttributionReport({
        log,
        runDir: dirname(sessionPath),
        ...(error ? { loadError: error } : {}),
      });
      const id = entryId(sessionPath, sources[0]!.sha256);
      const old = oldClassification(metadata);
      const analysis: HistoricalDerivedAnalysis = {
        schema_version: 1,
        kind: "babel_historical_causal_reanalysis",
        analyzer_version: HISTORICAL_ANALYZER_VERSION,
        corpus_version: LEGACY_CALIBRATION_CORPUS_VERSION,
        entry_id: id,
        derived_at: createdAt,
        source_schema_version: log ? "session-event-v1" : null,
        source_sha256: sources.map((source) => source.sha256),
        directly_recorded_facts: facts.directlyRecorded,
        derived_facts: facts.derived,
        impossible_or_unknown_facts: facts.assessments,
        old_causal_classification: old,
        new_causal_report: report,
      };
      analyses.push(analysis);
      const meta = reportMetadata(log, metadata);
      entries.push({
        entry_id: id,
        source_files: sources,
        original_babel_sha: meta.originalBabelSha,
        model: meta.model,
        provider: meta.provider,
        task_id: meta.taskId,
        baseline_sha: meta.baselineSha,
        run_id: meta.runId,
        session_id: log?.session_id ?? null,
        evidence_schema: log ? "session-event-v1" : null,
        timestamp: meta.timestamp,
        outcome: report.terminal_outcome ?? meta.outcome,
        evidence_complete:
          report.status === "ok" && report.attribution.unknowns.length === 0,
        analyzer_can_fully_interpret:
          report.status === "ok" && report.attribution.unknowns.length === 0,
        old_causal_classification: old,
        derived_analysis_path: null,
        derived_analysis_sha256: null,
      });
    }
    // Preserve report-only historical bundles as entries too. They cannot be
    // causally re-scored without the canonical event stream, so the derived
    // report remains UNKNOWN rather than silently dropping the evidence.
    const reportOnlyDirs = new Set(
      candidates
        .filter(
          (path) =>
            sourceRole(path) !== "session_events" &&
            !sessionDirs.has(dirname(path)),
        )
        .map((path) => dirname(path)),
    );
    for (const reportOnlyDir of [...reportOnlyDirs].sort()) {
      const artifactPaths = (candidatesByDir.get(reportOnlyDir) ?? []).filter(
        (path) => sourceRole(path) !== "session_events",
      );
      const sources = artifactPaths.map(sourceDescriptor);
      const metadata = parseMetadata(artifactPaths);
      const id = entryId(
        reportOnlyDir,
        sources.map((source) => source.sha256).join(":"),
      );
      const report = buildCausalAttributionReport({
        log: null,
        runDir: reportOnlyDir,
        loadError:
          "canonical session event log was not recorded with this historical artifact",
      });
      const facts = eventFacts(null);
      const old = oldClassification(metadata);
      analyses.push({
        schema_version: 1,
        kind: "babel_historical_causal_reanalysis",
        analyzer_version: HISTORICAL_ANALYZER_VERSION,
        corpus_version: LEGACY_CALIBRATION_CORPUS_VERSION,
        entry_id: id,
        derived_at: createdAt,
        source_schema_version: null,
        source_sha256: sources.map((source) => source.sha256),
        directly_recorded_facts: facts.directlyRecorded,
        derived_facts: facts.derived,
        impossible_or_unknown_facts: facts.assessments,
        old_causal_classification: old,
        new_causal_report: report,
      });
      const meta = reportMetadata(null, metadata);
      entries.push({
        entry_id: id,
        source_files: sources,
        original_babel_sha: meta.originalBabelSha,
        model: meta.model,
        provider: meta.provider,
        task_id: meta.taskId,
        baseline_sha: meta.baselineSha,
        run_id: meta.runId,
        session_id: null,
        evidence_schema: null,
        timestamp: meta.timestamp,
        outcome: meta.outcome,
        evidence_complete: false,
        analyzer_can_fully_interpret: false,
        old_causal_classification: old,
        derived_analysis_path: null,
        derived_analysis_sha256: null,
      });
    }
  }
  return {
    corpus: {
      schema_version: 1,
      kind: "babel_historical_calibration_corpus",
      corpus_version: LEGACY_CALIBRATION_CORPUS_VERSION,
      analyzer_version: HISTORICAL_ANALYZER_VERSION,
      created_at: createdAt,
      source_roots: roots,
      raw_sources_readonly: true,
      entries,
    },
    analyses,
  };
}

/** Write only derived outputs; source roots are never opened for writing. */
export function writeHistoricalCalibrationCorpus(
  build: HistoricalCalibrationBuild,
  outputDir: string,
  sourceRoots: string[],
): { manifestPath: string; analysisPaths: string[] } {
  assertSafeOutput(outputDir, sourceRoots);
  const output = resolve(outputDir);
  const analysisDir = join(output, "derived");
  mkdirSync(analysisDir, { recursive: true });
  const analysisPaths: string[] = [];
  const entries = build.corpus.entries.map((entry) => {
    const analysis = build.analyses.find(
      (candidate) => candidate.entry_id === entry.entry_id,
    );
    if (!analysis) return entry;
    const path = join(analysisDir, `${entry.entry_id}.json`);
    const serialized = `${JSON.stringify(analysis, null, 2)}\n`;
    writeFileSync(path, serialized, "utf8");
    analysisPaths.push(path);
    return {
      ...entry,
      derived_analysis_path: path,
      derived_analysis_sha256: sha256(serialized),
    };
  });
  const corpus = { ...build.corpus, entries };
  const manifestPath = join(
    output,
    `${LEGACY_CALIBRATION_CORPUS_VERSION}.manifest.json`,
  );
  writeFileSync(manifestPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  return { manifestPath, analysisPaths };
}
