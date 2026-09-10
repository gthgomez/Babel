import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractRunDirectory } from "./adapter.js";
import { RunIntelligenceCatalog } from "./catalog.js";
import { failureSignature } from "./contracts.js";
import { rewriteArgv } from "../cli/argv.js";
import { assertCatalogOutsideEvidence } from "../commands/runIntelligenceCommands.js";

function fixture(): { root: string; run: string; catalog: string } {
  const root = mkdtempSync(join(tmpdir(), "babel-bri-"));
  const run = join(root, "run-one");
  mkdirSync(run);
  writeFileSync(
    join(run, "01_manifest.json"),
    JSON.stringify({
      schema_version: 1,
      created_at: "2026-09-09T00:00:00.000Z",
    }),
  );
  writeFileSync(
    join(run, "session-events.jsonl"),
    [
      JSON.stringify({
        schema_version: 1,
        event_id: "event-1",
        session_id: "legacy-session",
        turn_id: "turn",
        seq: 0,
        ts: "2026-09-09T00:00:00.000Z",
        kind: "model_started",
        model: "model-a",
      }),
      JSON.stringify({
        schema_version: 1,
        event_id: "event-2",
        session_id: "legacy-session",
        turn_id: "turn",
        seq: 1,
        ts: "2026-09-09T00:00:01.000Z",
        kind: "tool_failed",
        tool_call_id: "tool-1",
        tool_name: "test_run",
        idempotency_key: "id-1",
        exit_code: 1,
      }),
      JSON.stringify({
        schema_version: 1,
        event_id: "event-3",
        session_id: "legacy-session",
        turn_id: "turn",
        seq: 2,
        ts: "2026-09-09T00:00:02.000Z",
        kind: "model_input_receipt",
        inference_id: "inference-1",
        provider: "openai",
        requested_model_id: "requested-model",
        normalized_model_id: "normalized-model",
        sent_model_id: "sent-model",
        input_digest: "digest",
        input_ref: "ref",
      }),
      JSON.stringify({
        schema_version: 1,
        event_id: "event-4",
        session_id: "legacy-session",
        turn_id: "turn",
        seq: 3,
        ts: "2026-09-09T00:00:03.000Z",
        kind: "model_result_delivery",
        inference_id: "inference-1",
        provider: "openai",
        model: "sent-model",
        observed_model_id: "observed-model",
        status: "delivered",
      }),
    ].join("\n"),
  );
  writeFileSync(
    join(run, "verifier_execution_summary.json"),
    JSON.stringify({
      schema_version: 1,
      artifact_type: "babel_verifier_execution_summary",
      verifiers: [
        {
          id: "verifier_01",
          required: true,
          state: "passed",
          endedAt: "2026-09-09T00:00:04.000Z",
        },
        { id: "verifier_02", required: true, state: "missing", endedAt: null },
      ],
    }),
  );
  writeFileSync(
    join(run, "cost_ledger.json"),
    JSON.stringify({
      schema_version: 1,
      artifact_type: "babel_cost_ledger",
      entries: [
        {
          entry_id: "entry-1",
          provider: "openai",
          model_id: "observed-model",
          prompt_tokens: 11,
          completion_tokens: 7,
          estimated_cost_usd: 0.001,
        },
      ],
    }),
  );
  return { root, run, catalog: join(root, "derived", "bri.sqlite") };
}

function cleanup(root: string): void {
  // Windows can retain a transient WAL handle after DatabaseSync.close(); test
  // correctness must not depend on opportunistic temp-directory cleanup.
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    // The OS will collect a locked per-test temporary directory.
  }
}

test("ingests evidence idempotently without treating unknown outcome as failure", () => {
  const paths = fixture();
  try {
    const catalog = new RunIntelligenceCatalog(paths.catalog);
    const extracted = extractRunDirectory(paths.run);
    assert.equal(extracted.outcome, "UNKNOWN");
    const sessionRoute = extracted.routing.find(
      (route) => route.evidenceRef === "session-events.jsonl#3",
    );
    assert.deepEqual(sessionRoute, {
      inferenceToken: sessionRoute?.inferenceToken,
      provider: "openai",
      requestedModel: "requested-model",
      normalizedModel: "normalized-model",
      sentModel: "sent-model",
      observedModel: "observed-model",
      evidenceRef: "session-events.jsonl#3",
      availability: "PRESENT",
    });
    catalog.ingest(extracted);
    catalog.ingest(extracted);
    assert.equal(catalog.coverage().extractedRuns, 1);
    const rate = catalog.query("failure-rate-by-model");
    assert.equal(rate.status, "NOT_ESTABLISHED");
    assert.equal(rate.eligibleDenominator, 0);
    assert.equal(catalog.query("failure-clusters").rows.length, 1);
    const verifierCoverage = catalog.query("verifier-coverage");
    assert.equal(verifierCoverage.status, "SUPPORTED");
    assert.equal(verifierCoverage.eligibleDenominator, 1);
    assert.equal(verifierCoverage.numerator, 1);
    assert.equal(catalog.query("outcome-evidence-summary").rows.length, 2);
    const modelCoverage = catalog.query("model-evidence-coverage");
    assert.equal(modelCoverage.status, "SUPPORTED");
    assert.equal(modelCoverage.eligibleDenominator, 1);
    assert.match(JSON.stringify(modelCoverage.rows), /observed-model/);
    catalog.ingest({
      ...extracted,
      sourceLocator: `${paths.run}-unavailable-outcome`,
      outcome: "FAILURE",
      outcomeAvailability: "UNKNOWN",
      failures: [
        {
          subsystem: "tool",
          category: "TOOL_CALL_ERROR",
          stableDetail: "secret-token-value",
        },
      ],
    });
    assert.equal(catalog.query("failure-rate-by-model").eligibleDenominator, 0);
    const signatureId = failureSignature({
      subsystem: "tool",
      category: "TOOL_CALL_ERROR",
      stableDetail: "secret-token-value",
    });
    assert.doesNotMatch(
      JSON.stringify(catalog.show(signatureId)),
      /secret-token-value/,
    );
    const caseVersion = catalog.createCaseVersion({
      definitionHash: "case-definition",
      taskContractRef: "task-digest",
    });
    const datasetVersion = catalog.createDatasetVersion({
      membershipHash: "frozen-member-set",
    });
    const experiment = catalog.createExperiment({
      datasetVersionId: datasetVersion.datasetVersionId,
      rubricIdentity: "reviewer",
      rubricVersion: "v1",
    });
    assert.ok(
      catalog
        .addLineageEdge({
          fromId: caseVersion.caseVersionId,
          toId: experiment.experimentId,
          relation: "derived_from",
        })
        .startsWith("edge_"),
    );
    assert.deepEqual(catalog.verify(), {
      ok: true,
      foreignKeyViolations: 0,
      schemaVersion: 4,
    });
    catalog.close();
  } finally {
    cleanup(paths.root);
  }
});

test("records terminal execution state without converting it into task success", () => {
  const paths = fixture();
  try {
    writeFileSync(
      join(paths.run, "terminal_status_summary.json"),
      JSON.stringify({ schema_version: 1, status: "EXECUTOR_HALTED" }),
    );
    const catalog = new RunIntelligenceCatalog(paths.catalog);
    const extracted = extractRunDirectory(paths.run);
    assert.equal(extracted.outcome, "UNKNOWN");
    assert.ok(
      extracted.outcomes.some(
        (item) =>
          item.dimension === "TERMINAL_EXECUTION_STATUS" &&
          item.value === "EXECUTOR_HALTED",
      ),
    );
    catalog.ingest(extracted);
    const summary = catalog.query("outcome-evidence-summary");
    assert.match(JSON.stringify(summary.rows), /TERMINAL_EXECUTION_STATUS/);
    assert.equal(
      catalog.query("failure-rate-by-model").status,
      "NOT_ESTABLISHED",
    );
    catalog.close();
  } finally {
    cleanup(paths.root);
  }
});

test("derives task outcome only from revision-bound task-correctness evidence and retains conflicts", () => {
  const paths = fixture();
  try {
    const catalog = new RunIntelligenceCatalog(paths.catalog);
    const extracted = extractRunDirectory(paths.run);
    const authority = {
      dimension: "TASK_CORRECTNESS" as const,
      observer: "deterministic_fixture",
      evidenceRef: "fixture#task",
      validity: "VALID" as const,
      availability: "PRESENT" as const,
      observedAt: null,
      authority: "DETERMINISTIC_VERIFICATION" as const,
      revision: "BOUND" as const,
      revisionToken: "revision_fixture",
    };
    catalog.ingest({
      ...extracted,
      sourceLocator: `${paths.run}-pass`,
      outcomes: [{ ...authority, value: "PASS" }],
    });
    catalog.ingest({
      ...extracted,
      sourceLocator: `${paths.run}-conflict`,
      outcomes: [
        { ...authority, value: "PASS" },
        { ...authority, evidenceRef: "fixture#task-fail", value: "FAIL" },
      ],
    });
    const coverage = catalog.query("task-outcome-coverage");
    assert.equal(coverage.status, "SUPPORTED");
    assert.equal(coverage.numerator, 1);
    assert.equal(coverage.eligibleDenominator, 2);
    assert.match(JSON.stringify(coverage.rows), /CONFLICTED/);
    assert.match(
      JSON.stringify(catalog.query("task-outcome-summary").rows),
      /DETERMINISTIC_VERIFICATION/,
    );
    catalog.close();
  } finally {
    cleanup(paths.root);
  }
});

test("does not promote a stale revision-bound verifier receipt to task correctness", () => {
  const paths = fixture();
  try {
    writeFileSync(
      join(paths.run, "session-events.jsonl"),
      JSON.stringify({
        schema_version: 1,
        event_id: "receipt",
        session_id: "legacy-session",
        turn_id: "turn",
        seq: 0,
        ts: "2026-09-09T00:00:00.000Z",
        kind: "verifier_attempt",
        authoritative: true,
        exit_code: 0,
        receipt: {
          authority: true,
          exit_code: 0,
          scope: "full_suite",
          stale: true,
          boundRevision: {
            compositeTreeHash: "tree-123",
            gitCommitHash: null,
            fileHashes: {},
            capturedAt: 1,
          },
        },
      }),
    );
    const extracted = extractRunDirectory(paths.run);
    const testObservation = extracted.outcomes.find(
      (item) => item.dimension === "TEST_CORRECTNESS",
    );
    assert.equal(testObservation?.revision, "STALE");
    assert.equal(testObservation?.validity, "UNKNOWN");
    assert.ok(
      !extracted.outcomes.some((item) => item.dimension === "TASK_CORRECTNESS"),
    );
  } finally {
    cleanup(paths.root);
  }
});

test("keeps agent completion claims separate from independently established task success", () => {
  const paths = fixture();
  try {
    writeFileSync(
      join(paths.run, "session-events.jsonl"),
      JSON.stringify({
        schema_version: 1,
        event_id: "claim-only",
        session_id: "legacy-session",
        turn_id: "turn",
        seq: 0,
        ts: "2026-09-09T00:00:00.000Z",
        kind: "completion_decision",
        requested_outcome: "SUCCESS",
        final_outcome: "SUCCESS",
        allowed: true,
        reason: "withheld",
        evidence_refs: [],
        policy_version: "v1",
      }),
    );
    const catalog = new RunIntelligenceCatalog(paths.catalog);
    const extracted = extractRunDirectory(paths.run);
    assert.equal(extracted.outcome, "UNKNOWN");
    assert.ok(
      extracted.outcomes.some((item) => item.dimension === "CONTROL_DECISION"),
    );
    assert.doesNotMatch(JSON.stringify(extracted.outcomes), /TASK_SUCCESS/);
    catalog.ingest(extracted);
    assert.equal(
      catalog.query("failure-rate-by-model").status,
      "NOT_ESTABLISHED",
    );
    catalog.close();
  } finally {
    cleanup(paths.root);
  }
});

test("keeps deterministic failure signatures stable across run-specific noise", () => {
  const first = failureSignature({
    subsystem: "tool",
    category: "TOOL_CALL_ERROR",
    stableDetail: "test_run",
    occurredAt: "2026-01-01T00:00:00Z",
  });
  const second = failureSignature({
    subsystem: "tool",
    category: "TOOL_CALL_ERROR",
    stableDetail: "test_run",
    occurredAt: "2026-09-09T12:00:00Z",
  });
  assert.equal(first, second);
});

test("records malformed session lines as unavailable evidence instead of facts", () => {
  const paths = fixture();
  try {
    writeFileSync(join(paths.run, "session-events.jsonl"), "{not json}\n");
    const extracted = extractRunDirectory(paths.run);
    assert.equal(extracted.failures.length, 0);
    assert.ok(
      extracted.warnings.some((warning) => warning.availability === "INVALID"),
    );
  } finally {
    cleanup(paths.root);
  }
});

test("does not normalize arbitrary provider failure text into a visible category", () => {
  const paths = fixture();
  try {
    writeFileSync(
      join(paths.run, "session-events.jsonl"),
      JSON.stringify({
        schema_version: 1,
        event_id: "event-3",
        session_id: "legacy-session",
        turn_id: "turn",
        seq: 2,
        ts: "2026-09-09T00:00:02.000Z",
        kind: "provider_failure_receipt",
        receipt: { failure_class: "private-token-value" },
      }),
    );
    assert.equal(
      extractRunDirectory(paths.run).failures[0]?.category,
      "PROVIDER_FAILURE",
    );
  } finally {
    cleanup(paths.root);
  }
});

test("preserves runs as a top-level command instead of rewriting it to run", () => {
  assert.deepEqual(rewriteArgv(["node", "babel", "runs", "coverage"]), [
    "node",
    "babel",
    "runs",
    "coverage",
  ]);
});

test("rejects a catalog inside the selected historical evidence tree", () => {
  const paths = fixture();
  try {
    assert.throws(() =>
      assertCatalogOutsideEvidence(
        paths.root,
        join(paths.root, ".bri", "catalog.sqlite"),
      ),
    );
  } finally {
    cleanup(paths.root);
  }
});
