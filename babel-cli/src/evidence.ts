/**
 * evidence.ts — Evidence Bundle Manager
 *
 * Every pipeline run creates an isolated, timestamped directory under
 * `<BABEL_ROOT>/runs/`. Artifacts are written synchronously to disk as each
 * stage completes, so a crash mid-pipeline never loses prior work and the run
 * can be resumed or replayed from the last written file.
 *
 * Directory format:
 *   runs/YYYYMMDD_HHMMSS_<task-slug>/
 *     01_manifest.json          ← Orchestrator output
 *     02_swe_plan_v1.json       ← SWE plan, attempt 1
 *     03_qa_verdict_v1.json     ← QA verdict, attempt 1
 *     02_swe_plan_v2.json       ← SWE retry (if QA rejected)
 *     03_qa_verdict_v2.json     ← QA verdict, attempt 2
 *     04_execution_report.json  ← CLI Executor final report
 *     00_ctx_<stage>.md         ← Compiled context snapshots (debug)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join }                      from 'node:path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYYMMDD_HHMMSS` from a Date object. */
function formatTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}_` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`
  );
}

/**
 * Converts a raw task string into a URL/filesystem-safe slug.
 * Max 48 chars so the directory name stays readable in a terminal.
 */
function taskToSlug(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

// ─── EvidenceBundle ───────────────────────────────────────────────────────────

export class EvidenceBundle {
  /** Absolute path to this run's artifact directory. */
  readonly runDir: string;

  /** Accumulated waterfall outcomes — flushed to disk by `writeWaterfallTelemetry()`. */
  private readonly _waterfallLog: object[] = [];

  /**
   * Creates the run directory immediately. Throws if the filesystem is
   * not writable — better to fail fast here than after a 30-second LLM call.
   *
   * @param task    - The raw task string (used to generate the slug).
   * @param baseDir - Parent directory for all runs (e.g., `<BABEL_ROOT>/runs`).
   */
  constructor(task: string, baseDir: string) {
    const dirName  = `${formatTimestamp(new Date())}_${taskToSlug(task)}`;
    this.runDir    = join(baseDir, dirName);
    mkdirSync(this.runDir, { recursive: true });
  }

  /**
   * Attaches to an existing run directory without creating a new one.
   * Used by `resume` flows that continue from a prior manual-bridge run.
   */
  static fromExistingRun(runDir: string): EvidenceBundle {
    const bundle = Object.create(EvidenceBundle.prototype) as EvidenceBundle;
    (bundle as unknown as { runDir: string }).runDir = runDir;
    (bundle as unknown as { _waterfallLog: object[] })._waterfallLog = [];
    return bundle;
  }

  // ── Private write helper ──────────────────────────────────────────────────

  private write(filename: string, data: unknown): void {
    const content =
      typeof data === 'string'
        ? data
        : JSON.stringify(data, null, 2);
    writeFileSync(join(this.runDir, filename), content, 'utf-8');
  }

  // ── Public artifact writers ───────────────────────────────────────────────

  /** Stage 1 — Orchestrator manifest (`01_manifest.json`). */
  writeManifest(data: unknown): void {
    this.write('01_manifest.json', data);
  }

  /** Runtime telemetry snapshot (`06_runtime_telemetry.json`). */
  writeRuntimeTelemetry(data: unknown): void {
    this.write('06_runtime_telemetry.json', data);
  }

  /** OpenTelemetry trace context summary (`07_trace_context.json`). */
  writeTraceContext(data: unknown): void {
    this.write('07_trace_context.json', data);
  }

  /** Routing confidence gate decision (`08_routing_decision.json`). */
  writeRoutingDecision(data: unknown): void {
    this.write('08_routing_decision.json', data);
  }

  /**
   * Stage 2 — SWE Agent plan. Filename includes the attempt number so all
   * iterations survive in the bundle for replay/audit.
   * e.g., `02_swe_plan_v1.json`, `02_swe_plan_v2.json`.
   */
  writeSwePlan(data: unknown, attemptNum: number): void {
    this.write(`02_swe_plan_v${attemptNum}.json`, data);
  }

  /**
   * Stage 3 — QA Reviewer verdict. Mirrors the attempt numbering from
   * `writeSwePlan` so pairs are trivially identifiable.
   * e.g., `03_qa_verdict_v1.json`.
   */
  writeQaVerdict(data: unknown, attemptNum: number): void {
    this.write(`03_qa_verdict_v${attemptNum}.json`, data);
  }

  /** Stage 4 — CLI Executor terminal report (`04_execution_report.json`). */
  writeExecutionLog(data: unknown): void {
    this.write('04_execution_report.json', data);
  }

  /** Manual bridge artifact: full Stage 2 SWE prompt for human completion. */
  writeManualSwePrompt(content: string): void {
    this.write('02_manual_swe_prompt.md', content);
  }

  /** Manual bridge artifact: schema-repair prompt for invalid manual plans. */
  writeManualPlanRepair(content: string): void {
    this.write('02_manual_plan_repair.md', content);
  }

  /**
   * Optional: write the compiled context string for a named stage.
   * Useful for post-mortem debugging — not part of the standard audit trail.
   * e.g., `00_ctx_orchestrator.md`, `00_ctx_swe_v2.md`.
   */
  writeCompiledContext(stage: string, content: string): void {
    this.write(`00_ctx_${stage}.md`, content);
  }

  /**
   * Write an arbitrary debug file with exactly the given filename.
   * Used by `execute.ts` to persist raw CLI stdout/stderr and Zod errors
   * when JSON extraction or schema validation fails.
   *
   * e.g., `debug_cli_raw_stdout.log`, `debug_zod_error.json`.
   */
  writeDebugFile(filename: string, content: string): void {
    this.write(filename, content);
  }

  /**
   * Appends one `WaterfallOutcome` record to the in-memory log.
   * Called by `execute.ts` after every successful `runWithFallback` call.
   * Accepts `object` to avoid a circular import with execute.ts.
   */
  appendWaterfallLog(entry: object): void {
    this._waterfallLog.push(entry);
  }

  /**
   * Flushes the accumulated waterfall log to `05_waterfall_telemetry.json`.
   * Call this from every `finalizeResult` / `finalizeError` path in pipeline.ts
   * so the file is always written even if the run crashes mid-pipeline.
   * No-op if no waterfall calls have been recorded yet.
   */
  writeWaterfallTelemetry(): void {
    if (this._waterfallLog.length === 0) return;
    this.write('05_waterfall_telemetry.json', this._waterfallLog);
  }
}
