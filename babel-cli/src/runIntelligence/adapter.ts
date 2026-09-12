import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  type ExtractedArtifact,
  type ExtractedRun,
  type ExtractionWarning,
  type FailureCandidate,
  opaqueId,
  type ModelRoutingObservation,
  type OutcomeObservation,
  type UsageObservation,
  type VerifierObservation,
} from "./contracts.js";

// v2: canonical-grade TEST_CORRECTNESS admission (64-hex revision binding,
// typed verifier authority source, deterministic-verifier receipt fields) and
// streaming JSONL/digest ingestion for large runs. Catalog uniqueness keys on
// adapter_version, so rows extracted by v1 are preserved, never rewritten.
export const RUN_INTELLIGENCE_ADAPTER_VERSION = "2.0.0";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
// Bounded total budget for one session-events.jsonl extraction. Long runs are
// streamed line-by-line within this budget instead of being dropped wholesale.
const SESSION_EVENTS_MAX_BYTES = 64 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
// Canonical revision-bound receipt law (mirrors the canonical producer's
// validator; BRI must not admit anything the canonical validator rejects).
const CANONICAL_TREE_HASH = /^[0-9a-f]{64}$/;
const VERIFIER_AUTHORITY_SOURCES = new Set([
  "project_discovery",
  "dataset_contract",
  "explicit_user_command",
  "built_in_runner",
]);
const PROVIDER_FAILURE_CATEGORIES = new Set([
  "TRANSPORT",
  "TIMEOUT",
  "RATE_LIMIT",
  "SERVER_ERROR",
  "STREAM_IDLE",
  "RESPONSE_NORMALIZATION",
  "PROVIDER_FAILURE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Values in these fields are operational identifiers, never bodies or commands. */
function metadata(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/@-]{1,160}$/.test(value)
    ? value
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJson(
  path: string,
  warnings: ExtractionWarning[],
): Record<string, unknown> | null {
  try {
    if (lstatSync(path).size > MAX_JSON_BYTES) {
      warnings.push({
        code: "JSON_TRUNCATED",
        message: `${basename(path)} exceeds bounded parser size`,
        availability: "TRUNCATED",
      });
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) {
      warnings.push({
        code: "JSON_INVALID_SHAPE",
        message: `${basename(path)} is not an object`,
        availability: "INVALID",
      });
      return null;
    }
    return parsed;
  } catch {
    warnings.push({
      code: "JSON_PARSE_FAILED",
      message: `${basename(path)} could not be parsed`,
      availability: "INVALID",
    });
    return null;
  }
}

function boundedDigest(path: string): string | null {
  // Stream in bounded chunks: identical sha256 to a whole-file hash, but
  // memory stays flat for arbitrarily large run artifacts.
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
  const descriptor = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, STREAM_CHUNK_BYTES, null);
      if (read === 0) break;
      hash.update(read === STREAM_CHUNK_BYTES ? buffer : buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * Stream a JSONL file line-by-line within a bounded byte budget. Memory stays
 * flat for arbitrarily long runs; a malformed or truncated tail is reported
 * explicitly with its line number instead of silently disappearing, and lines
 * beyond the budget produce an explicit truncation warning.
 */
function* streamJsonlLines(
  path: string,
  warnings: ExtractionWarning[],
): Generator<[number, string]> {
  const buffer = Buffer.alloc(STREAM_CHUNK_BYTES);
  let carry = "";
  let bytesReadTotal = 0;
  let lineNumber = 0;
  let truncated = false;
  const descriptor = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, STREAM_CHUNK_BYTES, null);
      if (read === 0) break;
      bytesReadTotal += read;
      if (bytesReadTotal > SESSION_EVENTS_MAX_BYTES) {
        truncated = true;
        break;
      }
      carry += buffer.toString("utf8", 0, read);
      let newline = carry.indexOf("\n");
      while (newline !== -1) {
        const line = carry.slice(0, newline).replace(/\r$/, "");
        carry = carry.slice(newline + 1);
        if (line.length > 0) yield [lineNumber, line];
        lineNumber += 1;
        newline = carry.indexOf("\n");
      }
      if (carry.length > MAX_LINE_BYTES) {
        truncated = true;
        break;
      }
    }
    if (!truncated && carry.replace(/\r$/, "").length > 0) {
      yield [lineNumber, carry.replace(/\r$/, "")];
      lineNumber += 1;
    }
  } finally {
    closeSync(descriptor);
  }
  if (truncated) {
    warnings.push({
      code: "SESSION_EVENTS_TRUNCATED",
      message: `session-events.jsonl extraction stopped at the bounded budget after ${lineNumber} complete lines`,
      availability: "TRUNCATED",
    });
  }
}

function sourceDigest(
  entries: readonly string[],
  runDir: string,
): string | null {
  const digest = createHash("sha256");
  for (const name of entries) {
    const path = join(runDir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const content = boundedDigest(path);
      if (!content) return null;
      digest.update(`${name}\u0000${stat.size}\u0000${content}\n`);
    } catch {
      return null;
    }
  }
  return digest.digest("hex");
}

function sessionEvents(
  path: string,
  warnings: ExtractionWarning[],
): {
  sessionId: string | null;
  model: string | null;
  failures: FailureCandidate[];
  routing: ModelRoutingObservation[];
  verifiers: VerifierObservation[];
  outcomes: OutcomeObservation[];
} {
  let sessionId: string | null = null;
  let model: string | null = null;
  const failures: FailureCandidate[] = [];
  const routing = new Map<string, ModelRoutingObservation>();
  const verifiers: VerifierObservation[] = [];
  const outcomes: OutcomeObservation[] = [];
  for (const [index, line] of streamJsonlLines(path, warnings)) {
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error("not record");
      if (!sessionId && typeof value["session_id"] === "string")
        sessionId = value["session_id"];
      if (!model && typeof value["model"] === "string")
        model = "MODEL_OBSERVED";
      if (!model && typeof value["observed_model_id"] === "string")
        model = "MODEL_OBSERVED";
      const evidenceRef = `session-events.jsonl#${String(index + 1)}`;
      if (process.env['BRI_DEBUG']) console.error('DEBUG line', index, String(value["kind"]), evidenceRef)
      const inferenceId = metadata(value["inference_id"]);
      if (value["kind"] === "model_input_receipt" && inferenceId) {
        const token = opaqueId("inference", inferenceId);
        const observation: ModelRoutingObservation = {
          inferenceToken: token,
          provider: metadata(value["provider"]),
          requestedModel: metadata(value["requested_model_id"]),
          normalizedModel: metadata(value["normalized_model_id"]),
          sentModel: metadata(value["sent_model_id"]),
          observedModel: null,
          evidenceRef,
          availability: "PRESENT",
        };
        routing.set(token, observation);
        model = model ?? observation.sentModel;
      }
      if (value["kind"] === "model_result_delivery" && inferenceId) {
        const token = opaqueId("inference", inferenceId);
        const prior = routing.get(token);
        const observed = metadata(value["observed_model_id"]);
        const sent = metadata(value["model"]);
        routing.set(token, {
          inferenceToken: token,
          provider: metadata(value["provider"]) ?? prior?.provider ?? null,
          requestedModel: prior?.requestedModel ?? null,
          normalizedModel: prior?.normalizedModel ?? null,
          sentModel: prior?.sentModel ?? sent,
          observedModel: observed,
          evidenceRef: prior?.evidenceRef ?? evidenceRef,
          availability: "PRESENT",
        });
        model = model ?? observed ?? sent;
      }
      if (value["kind"] === "verifier_attempt") {
        const exitCode = finiteNumber(value["exit_code"]);
        const result =
          exitCode === null ? "UNKNOWN" : exitCode === 0 ? "PASS" : "FAIL";
        verifiers.push({
          verifierIdentity: null,
          authoritative: value["authoritative"] === true,
          result,
          freshness: "UNKNOWN",
          independence: "UNKNOWN",
          evidenceRef,
          availability: "PRESENT",
          observedAt: metadata(value["ts"]),
        });
        outcomes.push({
          dimension: "VERIFIER_RESULT",
          value: result,
          observer: "session_verifier_attempt",
          evidenceRef,
          validity: result === "UNKNOWN" ? "UNKNOWN" : "VALID",
          availability: "PRESENT",
          observedAt: metadata(value["ts"]),
          authority: "CONTROL_RECEIPT",
          revision: "TARGET_UNKNOWN",
          revisionToken: null,
        });
        const receipt = isRecord(value["receipt"]) ? value["receipt"] : null;
        const bound =
          receipt && isRecord(receipt["boundRevision"])
            ? receipt["boundRevision"]
            : null;
        // Canonical revision binding: exactly a 64-hex composite tree hash.
        const rawTree = bound ? bound["compositeTreeHash"] : null;
        const tree =
          typeof rawTree === "string" && CANONICAL_TREE_HASH.test(rawTree)
            ? rawTree
            : null;
        const receiptExit = receipt
          ? finiteNumber(receipt["exit_code"] ?? receipt["exitCode"])
          : null;
        const isAuthoritative = receipt?.["authority"] === true;
        const authoritySourceRaw = receipt
          ? (receipt["authoritySource"] ?? receipt["authority_source"])
          : null;
        const hasCanonicalAuthority =
          typeof authoritySourceRaw === "string" &&
          VERIFIER_AUTHORITY_SOURCES.has(authoritySourceRaw);
        const scope = receipt ? metadata(receipt["scope"]) : null;
        // Fail-closed parity with the canonical verifier conversion: unknown
        // schema versions, timed-out/signalled runs, or skip-heavy greens are
        // never converted into task-correctness observations.
        const receiptSchemaVersion = receipt ? receipt["schema_version"] : null;
        const knownSchema =
          receiptSchemaVersion === undefined || receiptSchemaVersion === null || receiptSchemaVersion === 1;
        const deterministicRun =
          receipt?.["timed_out"] !== true &&
          (receipt?.["signal"] === undefined || receipt?.["signal"] === null);
        const testsFailed = finiteNumber(receipt?.["tests_failed"]);
        const noFailedTests = testsFailed === null || testsFailed === 0;
        if (
          tree &&
          receiptExit !== null &&
          isAuthoritative &&
          hasCanonicalAuthority &&
          knownSchema &&
          deterministicRun &&
          noFailedTests &&
          scope === "full_suite"
        ) {
          outcomes.push({
            dimension: "TEST_CORRECTNESS",
            value: receiptExit === 0 ? "PASS" : "FAIL",
            observer: "revision_bound_verifier_receipt",
            evidenceRef,
            validity: receipt["stale"] === true ? "UNKNOWN" : "VALID",
            availability: "PRESENT",
            observedAt: metadata(value["ts"]),
            authority: "DETERMINISTIC_VERIFICATION",
            revision: receipt["stale"] === true ? "STALE" : "BOUND",
            revisionToken: opaqueId("revision", tree),
          });
        }
      }
      if (value["kind"] === "completion_decision") {
        // This is a control-plane claim, not independent task-success evidence.
        outcomes.push({
          dimension: "CONTROL_DECISION",
          value: value["allowed"] === true ? "ALLOWED" : "DENIED",
          observer: "completion_decision",
          evidenceRef,
          validity: "VALID",
          availability: "PRESENT",
          observedAt: metadata(value["ts"]),
          authority: "AGENT_CLAIM",
          revision: "NOT_APPLICABLE",
          revisionToken: null,
        });
      }
      if (
        value["kind"] === "tool_failed" &&
        typeof value["tool_name"] === "string"
      ) {
        failures.push({
          subsystem: "tool",
          category: "TOOL_CALL_ERROR",
          ...(typeof value["ts"] === "string"
            ? { occurredAt: value["ts"] }
            : {}),
        });
      }
      if (
        value["kind"] === "provider_failure_receipt" &&
        isRecord(value["receipt"])
      ) {
        const observedCategory =
          typeof value["receipt"]["failure_class"] === "string"
            ? value["receipt"]["failure_class"]
            : "PROVIDER_FAILURE";
        const category = PROVIDER_FAILURE_CATEGORIES.has(observedCategory)
          ? observedCategory
          : "PROVIDER_FAILURE";
        failures.push({
          subsystem: "provider",
          category,
          ...(typeof value["ts"] === "string"
            ? { occurredAt: value["ts"] }
            : {}),
        });
      }
    } catch {
      warnings.push({
        code: "SESSION_EVENT_INVALID",
        message:
          "A session event line could not be parsed; it was not normalized",
        availability: "INVALID",
      });
    }
  }
  if (process.env['BRI_DEBUG']) console.error('DEBUG routing', JSON.stringify([...routing.values()]))
  return {
    sessionId,
    model,
    failures,
    routing: [...routing.values()],
    verifiers,
    outcomes,
  };
}

function verifierSummary(summary: Record<string, unknown>): {
  verifiers: VerifierObservation[];
  outcomes: OutcomeObservation[];
} {
  const verifiers: VerifierObservation[] = [];
  const outcomes: OutcomeObservation[] = [];
  const entries = Array.isArray(summary["verifiers"])
    ? summary["verifiers"]
    : [];
  for (const [index, item] of entries.entries()) {
    if (!isRecord(item)) continue;
    const state = item["state"];
    const result =
      state === "passed"
        ? "PASS"
        : state === "failed"
          ? "FAIL"
          : state === "missing"
            ? "MISSING"
            : "UNKNOWN";
    const required = item["required"] === true;
    const evidenceRef = `verifier_execution_summary.json#${String(index + 1)}`;
    // `required` makes this a completion control, not an independent correctness oracle.
    verifiers.push({
      verifierIdentity: metadata(item["id"]),
      authoritative: required,
      result,
      // A contract summary carries no target-revision binding, so freshness is unknown.
      freshness: "UNKNOWN",
      independence: "IMPLEMENTOR",
      evidenceRef,
      availability: "PRESENT",
      observedAt: metadata(item["endedAt"]),
    });
    outcomes.push({
      dimension: "VERIFIER_RESULT",
      value: result,
      observer: "verifier_execution_summary",
      evidenceRef,
      validity: result === "PASS" || result === "FAIL" ? "VALID" : "UNKNOWN",
      availability: "PRESENT",
      observedAt: metadata(item["endedAt"]),
      authority: "CONTROL_RECEIPT",
      revision: "TARGET_UNKNOWN",
      revisionToken: null,
    });
  }
  return { verifiers, outcomes };
}

function costLedger(ledger: Record<string, unknown>): {
  routing: ModelRoutingObservation[];
  usage: UsageObservation[];
} {
  const routing: ModelRoutingObservation[] = [];
  const usage: UsageObservation[] = [];
  const entries = Array.isArray(ledger["entries"]) ? ledger["entries"] : [];
  for (const [index, item] of entries.entries()) {
    if (!isRecord(item)) continue;
    const provider = metadata(item["provider"]);
    const model = metadata(item["model_id"]);
    const evidenceRef = `cost_ledger.json#${String(index + 1)}`;
    if (provider || model)
      routing.push({
        inferenceToken: opaqueId(
          "ledger_entry",
          metadata(item["entry_id"]) ?? String(index),
        ),
        provider,
        requestedModel: null,
        normalizedModel: null,
        sentModel: model,
        observedModel: null,
        evidenceRef,
        availability: "PRESENT",
      });
    usage.push({
      provider,
      model,
      inputTokens: finiteNumber(item["prompt_tokens"]),
      outputTokens: finiteNumber(item["completion_tokens"]),
      costUsd: finiteNumber(item["estimated_cost_usd"]),
      costBasis: "ESTIMATED",
      evidenceRef,
      availability: "PRESENT",
    });
  }
  return { routing, usage };
}

function terminalSummary(
  summary: Record<string, unknown>,
): OutcomeObservation | null {
  const status = metadata(summary["status"]);
  if (!status) return null;
  // A terminal status is execution/control evidence only. It is never task correctness.
  return {
    dimension: "TERMINAL_EXECUTION_STATUS",
    value: status,
    observer: "terminal_status_summary",
    evidenceRef: "terminal_status_summary.json#status",
    validity: "VALID",
    availability: "PRESENT",
    observedAt: null,
    authority: "EXECUTION_STATUS",
    revision: "TARGET_UNKNOWN",
    revisionToken: null,
  };
}

/** Read a current or historical evidence-bundle directory without changing it. */
export function extractRunDirectory(runDirectory: string): ExtractedRun {
  const runDir = resolve(runDirectory);
  const warnings: ExtractionWarning[] = [];
  let entries: string[] = [];
  try {
    const directory = lstatSync(runDir);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("not a local directory");
    entries = readdirSync(runDir).sort();
  } catch {
    return unavailableRun(
      runDir,
      "SOURCE_UNAVAILABLE",
      "Evidence directory could not be read safely",
    );
  }
  const artifacts: ExtractedArtifact[] = [];
  let sessionLegacyId: string | null = null;
  let model: string | null = null;
  const failures: FailureCandidate[] = [];
  const routing: ModelRoutingObservation[] = [];
  const verifiers: VerifierObservation[] = [];
  const outcomes: OutcomeObservation[] = [];
  const usage: UsageObservation[] = [];
  let sourceSchema: string | null = null;
  let capturedAt: string | null = null;

  for (const name of entries) {
    const path = join(runDir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      warnings.push({
        code: "ARTIFACT_UNAVAILABLE",
        message: "An artifact could not be inspected",
        availability: "UNAVAILABLE",
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      warnings.push({
        code: "SYMLINK_REJECTED",
        message: "An artifact link was not read",
        availability: "UNSUPPORTED",
      });
      continue;
    }
    if (!stat.isFile()) continue;
    let digest: string | null;
    try {
      digest = boundedDigest(path);
    } catch {
      warnings.push({
        code: "ARTIFACT_UNAVAILABLE",
        message: "An artifact could not be read",
        availability: "UNAVAILABLE",
      });
      continue;
    }
    artifacts.push({
      name,
      byteLength: stat.size,
      contentDigest: digest,
      availability: digest ? "PRESENT" : "TRUNCATED",
    });
    if (name === "session-events.jsonl") {
      let extracted: ReturnType<typeof sessionEvents>;
      try {
        extracted = sessionEvents(path, warnings);
      } catch {
        warnings.push({
          code: "SESSION_EVENTS_UNAVAILABLE",
          message: "Session event log could not be read",
          availability: "UNAVAILABLE",
        });
        continue;
      }
      sessionLegacyId = extracted.sessionId;
      model = extracted.model;
      failures.push(...extracted.failures);
      routing.push(...extracted.routing);
      verifiers.push(...extracted.verifiers);
      outcomes.push(...extracted.outcomes);
      sourceSchema = sourceSchema ?? "session-events.v1";
    }
    if (name === "01_manifest.json" || name === "manifest.json") {
      const manifest = readJson(path, warnings);
      if (manifest) {
        sourceSchema =
          typeof manifest["schema_version"] === "number" &&
          Number.isSafeInteger(manifest["schema_version"]) &&
          manifest["schema_version"] >= 0
            ? `manifest.v${String(manifest["schema_version"])}`
            : sourceSchema;
        capturedAt =
          typeof manifest["created_at"] === "string"
            ? manifest["created_at"]
            : capturedAt;
      }
    }
    if (name === "verifier_execution_summary.json") {
      const summary = readJson(path, warnings);
      if (summary) {
        const extracted = verifierSummary(summary);
        verifiers.push(...extracted.verifiers);
        outcomes.push(...extracted.outcomes);
        sourceSchema = sourceSchema ?? "verifier-execution-summary.v1";
      }
    }
    if (name === "cost_ledger.json") {
      const ledger = readJson(path, warnings);
      if (ledger) {
        const extracted = costLedger(ledger);
        routing.push(...extracted.routing);
        usage.push(...extracted.usage);
      }
    }
    if (name === "terminal_status_summary.json") {
      const summary = readJson(path, warnings);
      if (summary) {
        const observation = terminalSummary(summary);
        if (observation) outcomes.push(observation);
      }
    }
  }
  if (!entries.includes("session-events.jsonl")) {
    warnings.push({
      code: "SESSION_EVENTS_ABSENT",
      message: "No durable session event log was present",
      availability: "ABSENT",
    });
  }
  return {
    sourceNamespace: "babel.local",
    sourceRole: "evidence_bundle",
    sourceLocator: runDir,
    sourceDigest: sourceDigest(entries, runDir),
    sourceSchema,
    capturedAt,
    adapterName: "evidence-bundle-read-only",
    adapterVersion: RUN_INTELLIGENCE_ADAPTER_VERSION,
    sessionLegacyId,
    model,
    routing,
    verifiers,
    outcomes,
    usage,
    // A run report or model terminal text is deliberately not an OutcomeObservation.
    outcome: "UNKNOWN",
    outcomeAvailability: "UNKNOWN",
    artifacts,
    failures,
    warnings,
  };
}

/** Enumerate only immediate evidence-bundle children; it never follows or writes sources. */
export function extractRunRoot(root: string): ExtractedRun[] {
  const absoluteRoot = resolve(root);
  const runs: ExtractedRun[] = [];
  let names: string[];
  try {
    names = readdirSync(absoluteRoot).sort();
  } catch {
    return [
      unavailableRun(
        absoluteRoot,
        "SOURCE_ROOT_UNAVAILABLE",
        "Evidence root could not be read safely",
      ),
    ];
  }
  for (const name of names) {
    const candidate = join(absoluteRoot, name);
    try {
      const entry = lstatSync(candidate);
      if (entry.isSymbolicLink()) {
        runs.push(
          unavailableRun(
            candidate,
            "SYMLINK_REJECTED",
            "Evidence link was not followed",
          ),
        );
        continue;
      }
      if (entry.isDirectory()) runs.push(extractRunDirectory(candidate));
    } catch {
      runs.push(
        unavailableRun(
          candidate,
          "SOURCE_UNAVAILABLE",
          "Evidence entry could not be inspected",
        ),
      );
    }
  }
  return runs;
}

function unavailableRun(
  sourceLocator: string,
  code: string,
  message: string,
): ExtractedRun {
  return {
    sourceNamespace: "babel.local",
    sourceRole: "evidence_bundle",
    sourceLocator,
    sourceDigest: null,
    sourceSchema: null,
    capturedAt: null,
    adapterName: "evidence-bundle-read-only",
    adapterVersion: RUN_INTELLIGENCE_ADAPTER_VERSION,
    sessionLegacyId: null,
    model: null,
    routing: [],
    verifiers: [],
    outcomes: [],
    usage: [],
    outcome: "UNKNOWN",
    outcomeAvailability: "UNAVAILABLE",
    artifacts: [],
    failures: [],
    warnings: [{ code, message, availability: "UNAVAILABLE" }],
  };
}
