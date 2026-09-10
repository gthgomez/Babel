import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  failureSignature,
  opaqueId,
  savedQueryDefinition,
  type ExtractedRun,
  type ExtractionReceipt,
  type QueryResult,
  type SavedQueryName,
  TASK_OUTCOME_POLICY_VERSION,
  type TaskOutcomeAssessment,
} from "./contracts.js";

const SCHEMA_VERSION = 4;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS bri_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS identity_registry (
  source_namespace TEXT NOT NULL, source_role TEXT NOT NULL, legacy_locator TEXT NOT NULL,
  identity_epoch TEXT NOT NULL, logical_entity_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (source_namespace, source_role, legacy_locator, identity_epoch)
);
CREATE TABLE IF NOT EXISTS extraction_receipts (
  receipt_id TEXT PRIMARY KEY, source_namespace TEXT NOT NULL, source_role TEXT NOT NULL,
  source_locator TEXT NOT NULL, source_locator_digest TEXT NOT NULL, source_digest TEXT,
  source_schema TEXT, adapter_name TEXT NOT NULL, adapter_version TEXT NOT NULL,
  extracted_at TEXT NOT NULL, entities_emitted INTEGER NOT NULL, unavailable_fields_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL, UNIQUE(source_locator, source_digest, adapter_version)
);
CREATE TABLE IF NOT EXISTS run_containers (
  logical_id TEXT PRIMARY KEY, source_namespace TEXT NOT NULL, source_locator TEXT NOT NULL UNIQUE,
  source_digest TEXT, source_schema TEXT, captured_at TEXT, receipt_id TEXT NOT NULL,
  FOREIGN KEY(receipt_id) REFERENCES extraction_receipts(receipt_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  logical_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, legacy_session_id TEXT,
  FOREIGN KEY(run_id) REFERENCES run_containers(logical_id)
);
CREATE TABLE IF NOT EXISTS trials (
  logical_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT, model TEXT,
  outcome TEXT NOT NULL, outcome_availability TEXT NOT NULL, case_version_id TEXT,
  FOREIGN KEY(run_id) REFERENCES run_containers(logical_id), FOREIGN KEY(session_id) REFERENCES sessions(logical_id)
);
CREATE TABLE IF NOT EXISTS content_blobs (digest TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, availability TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_instances (
  logical_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, artifact_name TEXT NOT NULL, byte_length INTEGER NOT NULL,
  content_digest TEXT, availability TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES run_containers(logical_id),
  FOREIGN KEY(content_digest) REFERENCES content_blobs(digest), UNIQUE(run_id, artifact_name)
);
CREATE TABLE IF NOT EXISTS failure_signatures (signature_id TEXT PRIMARY KEY, algorithm_version TEXT NOT NULL, subsystem TEXT NOT NULL, category TEXT NOT NULL, stable_detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS failure_occurrences (
  logical_id TEXT PRIMARY KEY, trial_id TEXT NOT NULL, signature_id TEXT NOT NULL, occurred_at TEXT,
  FOREIGN KEY(trial_id) REFERENCES trials(logical_id), FOREIGN KEY(signature_id) REFERENCES failure_signatures(signature_id),
  UNIQUE(trial_id, signature_id, occurred_at)
);
CREATE TABLE IF NOT EXISTS failure_clusters (cluster_id TEXT PRIMARY KEY, signature_id TEXT NOT NULL, first_seen TEXT, last_seen TEXT, adjudication TEXT, suspected_cause TEXT, candidate_fix TEXT, validated_fix TEXT, supersedes_cluster_id TEXT, FOREIGN KEY(signature_id) REFERENCES failure_signatures(signature_id));
CREATE TABLE IF NOT EXISTS cases (case_id TEXT PRIMARY KEY, purpose_policy TEXT NOT NULL DEFAULT 'EVALUATION_ONLY');
CREATE TABLE IF NOT EXISTS case_versions (case_version_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, definition_hash TEXT NOT NULL, task_contract_ref TEXT, starting_state_ref TEXT, success_criteria_ref TEXT, immutable INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(case_id) REFERENCES cases(case_id));
CREATE TABLE IF NOT EXISTS datasets (dataset_id TEXT PRIMARY KEY, purpose_policy TEXT NOT NULL DEFAULT 'EVALUATION_ONLY');
CREATE TABLE IF NOT EXISTS dataset_versions (dataset_version_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, membership_hash TEXT NOT NULL, frozen_at TEXT NOT NULL, FOREIGN KEY(dataset_id) REFERENCES datasets(dataset_id));
CREATE TABLE IF NOT EXISTS evaluations (evaluation_id TEXT PRIMARY KEY, rubric_identity TEXT NOT NULL, rubric_version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS experiments (experiment_id TEXT PRIMARY KEY, dataset_version_id TEXT, evaluation_id TEXT, created_at TEXT NOT NULL, FOREIGN KEY(dataset_version_id) REFERENCES dataset_versions(dataset_version_id), FOREIGN KEY(evaluation_id) REFERENCES evaluations(evaluation_id));
CREATE TABLE IF NOT EXISTS annotations (annotation_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, annotation_type TEXT NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exposure_records (exposure_id TEXT PRIMARY KEY, case_version_id TEXT NOT NULL, purpose TEXT NOT NULL, occurred_at TEXT NOT NULL, FOREIGN KEY(case_version_id) REFERENCES case_versions(case_version_id));
CREATE TABLE IF NOT EXISTS lineage_edges (edge_id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('suspected_fix','validated_fix','regression_of','recurred_after','supersedes','derived_from')), created_at TEXT NOT NULL, UNIQUE(from_id,to_id,relation));
CREATE INDEX IF NOT EXISTS idx_bri_trials_model ON trials(model);
CREATE INDEX IF NOT EXISTS idx_bri_failure_occurrences_signature ON failure_occurrences(signature_id);
CREATE INDEX IF NOT EXISTS idx_bri_artifacts_run ON artifact_instances(run_id);
`;

// V2 deliberately leaves V1 registry values in place. Existing development
// catalogs retain resolvable identities; newly observed entities use random
// local IDs rather than a digest of a predictable locator.
const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS execution_segments (
  segment_id TEXT PRIMARY KEY, trial_id TEXT NOT NULL, run_id TEXT NOT NULL,
  segment_kind TEXT NOT NULL, attribution_strength TEXT NOT NULL,
  source_event_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(trial_id) REFERENCES trials(logical_id),
  FOREIGN KEY(run_id) REFERENCES run_containers(logical_id)
);
CREATE TABLE IF NOT EXISTS model_routing_observations (
  observation_id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, inference_token TEXT NOT NULL,
  provider TEXT, requested_model TEXT, normalized_model TEXT, sent_model TEXT, observed_model TEXT,
  availability TEXT NOT NULL, evidence_ref TEXT NOT NULL,
  FOREIGN KEY(segment_id) REFERENCES execution_segments(segment_id)
);
CREATE TABLE IF NOT EXISTS usage_observations (
  observation_id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, provider TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, currency TEXT,
  cost_basis TEXT NOT NULL, availability TEXT NOT NULL, evidence_ref TEXT NOT NULL,
  FOREIGN KEY(segment_id) REFERENCES execution_segments(segment_id)
);
CREATE TABLE IF NOT EXISTS verifier_observations (
  observation_id TEXT PRIMARY KEY, segment_id TEXT NOT NULL, verifier_identity TEXT,
  authoritative INTEGER NOT NULL, result TEXT NOT NULL, freshness TEXT NOT NULL,
  independence TEXT NOT NULL, availability TEXT NOT NULL, evidence_ref TEXT NOT NULL,
  FOREIGN KEY(segment_id) REFERENCES execution_segments(segment_id)
);
CREATE TABLE IF NOT EXISTS outcome_observations (
  observation_id TEXT PRIMARY KEY, trial_id TEXT NOT NULL, segment_id TEXT,
  dimension TEXT NOT NULL, value TEXT NOT NULL, observer TEXT NOT NULL,
  evidence_ref TEXT NOT NULL, validity TEXT NOT NULL, availability TEXT NOT NULL, observed_at TEXT,
  FOREIGN KEY(trial_id) REFERENCES trials(logical_id), FOREIGN KEY(segment_id) REFERENCES execution_segments(segment_id)
);
CREATE INDEX IF NOT EXISTS idx_bri_outcome_trial ON outcome_observations(trial_id, dimension);
CREATE INDEX IF NOT EXISTS idx_bri_verifier_segment ON verifier_observations(segment_id);
`;

// Failure rows predate segments. Preserve them and add evidence binding without
// rewriting historical observations.
const MIGRATION_3 = `
ALTER TABLE failure_occurrences ADD COLUMN segment_id TEXT REFERENCES execution_segments(segment_id);
ALTER TABLE failure_occurrences ADD COLUMN evidence_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_bri_failure_segment ON failure_occurrences(segment_id);
`;

const MIGRATION_4 = `
ALTER TABLE outcome_observations ADD COLUMN authority TEXT NOT NULL DEFAULT 'CONTROL_RECEIPT';
ALTER TABLE outcome_observations ADD COLUMN revision_binding TEXT NOT NULL DEFAULT 'TARGET_UNKNOWN';
ALTER TABLE outcome_observations ADD COLUMN revision_token TEXT;
CREATE TABLE IF NOT EXISTS task_outcome_assessments (
  trial_id TEXT PRIMARY KEY, policy_version TEXT NOT NULL, assessment TEXT NOT NULL,
  reason TEXT NOT NULL, input_observation_count INTEGER NOT NULL, conflict_count INTEGER NOT NULL,
  FOREIGN KEY(trial_id) REFERENCES trials(logical_id)
);
CREATE INDEX IF NOT EXISTS idx_bri_assessment ON task_outcome_assessments(assessment);
`;

function now(): string {
  return new Date().toISOString();
}
function toJson(value: unknown): string {
  return JSON.stringify(value);
}
function rows(
  db: DatabaseSync,
  sql: string,
  ...parameters: Array<string | number | null>
): Array<Record<string, unknown>> {
  return db.prepare(sql).all(...parameters) as Array<Record<string, unknown>>;
}

/** Local SQLite catalog for derived BRI facts. It does not open historical databases. */
export class RunIntelligenceCatalog {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS bri_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const [version, sql] of [
      [1, MIGRATION_1],
      [2, MIGRATION_2],
      [3, MIGRATION_3],
      [4, MIGRATION_4],
    ] as const) {
      const applied = rows(
        this.db,
        "SELECT version FROM bri_schema_migrations WHERE version = ?",
        version,
      );
      if (applied.length) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(sql);
        this.db
          .prepare(
            "INSERT INTO bri_schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(version, now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  ingest(run: ExtractedRun): ExtractionReceipt {
    const locatorToken = opaqueId("locator", run.sourceLocator);
    const receiptId = opaqueId(
      "receipt",
      run.sourceNamespace,
      run.sourceRole,
      locatorToken,
      run.sourceDigest ?? "unavailable",
      run.adapterVersion,
    );
    const runId = this.identity(
      run.sourceNamespace,
      run.sourceRole,
      locatorToken,
      "v1",
      "run",
    );
    const unavailable = [
      ...new Set(
        run.warnings
          .map((warning) => warning.availability)
          .filter((value) => value !== "PRESENT"),
      ),
    ];
    const receipt: ExtractionReceipt = {
      receiptId,
      sourceNamespace: run.sourceNamespace,
      sourceRole: run.sourceRole,
      sourceLocatorDigest: locatorToken,
      sourceDigest: run.sourceDigest,
      sourceSchema: run.sourceSchema,
      adapterName: run.adapterName,
      adapterVersion: run.adapterVersion,
      extractedAt: now(),
      entitiesEmitted:
        3 +
        run.artifacts.length +
        run.failures.length +
        run.routing.length +
        run.verifiers.length +
        run.outcomes.length +
        run.usage.length,
      unavailableFields: unavailable,
      warnings: run.warnings,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO extraction_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receiptId,
          run.sourceNamespace,
          run.sourceRole,
          locatorToken,
          receipt.sourceLocatorDigest,
          run.sourceDigest,
          run.sourceSchema,
          run.adapterName,
          run.adapterVersion,
          receipt.extractedAt,
          receipt.entitiesEmitted,
          toJson(unavailable),
          toJson(run.warnings),
        );
      this.db
        .prepare(
          `INSERT INTO run_containers(logical_id,source_namespace,source_locator,source_digest,source_schema,captured_at,receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_locator) DO UPDATE SET source_digest=excluded.source_digest,source_schema=excluded.source_schema,captured_at=excluded.captured_at,receipt_id=excluded.receipt_id`,
        )
        .run(
          runId,
          run.sourceNamespace,
          locatorToken,
          run.sourceDigest,
          run.sourceSchema,
          run.capturedAt,
          receiptId,
        );
      const sessionToken = run.sessionLegacyId
        ? opaqueId("session_locator", run.sessionLegacyId)
        : null;
      const sessionId = sessionToken
        ? this.identity(
            run.sourceNamespace,
            "session",
            sessionToken,
            "v1",
            "session",
          )
        : null;
      if (sessionId)
        this.db
          .prepare(
            "INSERT OR IGNORE INTO sessions(logical_id,run_id,legacy_session_id) VALUES (?, ?, ?)",
          )
          .run(sessionId, runId, sessionToken);
      const trialId = this.identity(
        run.sourceNamespace,
        "trial",
        opaqueId("trial_locator", locatorToken, "primary"),
        "v2",
        "trial",
      );
      this.db
        .prepare(
          `INSERT INTO trials(logical_id,run_id,session_id,model,outcome,outcome_availability,case_version_id) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(logical_id) DO UPDATE SET session_id=excluded.session_id,model=excluded.model,outcome=excluded.outcome,outcome_availability=excluded.outcome_availability`,
        )
        .run(
          trialId,
          runId,
          sessionId,
          run.model,
          run.outcome,
          run.outcomeAvailability,
        );
      const segmentId = this.identity(
        run.sourceNamespace,
        "execution_segment",
        opaqueId("segment_locator", locatorToken, "run-container"),
        "v2",
        "segment",
      );
      this.db
        .prepare(
          `INSERT INTO execution_segments(segment_id,trial_id,run_id,segment_kind,attribution_strength,source_event_count)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(segment_id) DO UPDATE SET source_event_count=excluded.source_event_count`,
        )
        .run(
          segmentId,
          trialId,
          runId,
          "RUN_CONTAINER",
          "DIRECT",
          run.routing.length + run.verifiers.length + run.outcomes.length,
        );
      for (const route of run.routing) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO model_routing_observations(observation_id,segment_id,inference_token,provider,requested_model,normalized_model,sent_model,observed_model,availability,evidence_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            opaqueId(
              "route",
              segmentId,
              route.inferenceToken,
              route.evidenceRef,
            ),
            segmentId,
            route.inferenceToken,
            route.provider,
            route.requestedModel,
            route.normalizedModel,
            route.sentModel,
            route.observedModel,
            route.availability,
            route.evidenceRef,
          );
      }
      for (const usage of run.usage) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO usage_observations(observation_id,segment_id,provider,model,input_tokens,output_tokens,cost_usd,currency,cost_basis,availability,evidence_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            opaqueId("usage", segmentId, usage.evidenceRef),
            segmentId,
            usage.provider,
            usage.model,
            usage.inputTokens,
            usage.outputTokens,
            usage.costUsd,
            "USD",
            usage.costBasis,
            usage.availability,
            usage.evidenceRef,
          );
      }
      for (const verifier of run.verifiers) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO verifier_observations(observation_id,segment_id,verifier_identity,authoritative,result,freshness,independence,availability,evidence_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            opaqueId(
              "verifier",
              segmentId,
              verifier.evidenceRef,
              verifier.result,
            ),
            segmentId,
            verifier.verifierIdentity,
            verifier.authoritative ? 1 : 0,
            verifier.result,
            verifier.freshness,
            verifier.independence,
            verifier.availability,
            verifier.evidenceRef,
          );
      }
      for (const outcome of run.outcomes) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO outcome_observations(observation_id,trial_id,segment_id,dimension,value,observer,evidence_ref,validity,availability,observed_at,authority,revision_binding,revision_token)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            opaqueId(
              "outcome",
              trialId,
              outcome.dimension,
              outcome.observer,
              outcome.evidenceRef,
              outcome.value,
            ),
            trialId,
            segmentId,
            outcome.dimension,
            outcome.value,
            outcome.observer,
            outcome.evidenceRef,
            outcome.validity,
            outcome.availability,
            outcome.observedAt,
            outcome.authority,
            outcome.revision,
            outcome.revisionToken,
          );
      }
      this.assessTrial(trialId);
      for (const artifact of run.artifacts) {
        if (artifact.contentDigest)
          this.db
            .prepare(
              "INSERT OR IGNORE INTO content_blobs(digest,byte_length,availability) VALUES (?, ?, ?)",
            )
            .run(
              artifact.contentDigest,
              artifact.byteLength,
              artifact.availability,
            );
        this.db
          .prepare(
            `INSERT INTO artifact_instances(logical_id,run_id,artifact_name,byte_length,content_digest,availability) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id,artifact_name) DO UPDATE SET byte_length=excluded.byte_length,content_digest=excluded.content_digest,availability=excluded.availability`,
          )
          .run(
            opaqueId("artifact", runId, artifact.name),
            runId,
            opaqueId("artifact_name", artifact.name),
            artifact.byteLength,
            artifact.contentDigest,
            artifact.availability,
          );
      }
      for (const failure of run.failures) {
        const signatureId = failureSignature(failure);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO failure_signatures(signature_id,algorithm_version,subsystem,category,stable_detail) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            signatureId,
            "v1",
            failure.subsystem,
            failure.category,
            "withheld",
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO failure_occurrences(logical_id,trial_id,signature_id,occurred_at,segment_id,evidence_ref) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            opaqueId(
              "failure",
              trialId,
              signatureId,
              failure.occurredAt ?? "unknown",
            ),
            trialId,
            signatureId,
            failure.occurredAt ?? null,
            segmentId,
            "session-events.jsonl",
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO failure_clusters(cluster_id,signature_id,first_seen,last_seen,adjudication,suspected_cause,candidate_fix,validated_fix,supersedes_cluster_id) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
          )
          .run(
            opaqueId("cluster", signatureId),
            signatureId,
            failure.occurredAt ?? null,
            failure.occurredAt ?? null,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return receipt;
  }

  /** Derive task correctness from revision-bound task-correctness observations only. */
  private assessTrial(trialId: string): void {
    const observations = rows(
      this.db,
      `SELECT value,validity,authority,revision_binding FROM outcome_observations
       WHERE trial_id=? AND dimension='TASK_CORRECTNESS'`,
      trialId,
    );
    const valid = observations.filter(
      (row) =>
        row["validity"] === "VALID" &&
        (row["authority"] === "DETERMINISTIC_VERIFICATION" ||
          row["authority"] === "INDEPENDENT_VERIFICATION") &&
        row["revision_binding"] === "BOUND" &&
        (row["value"] === "PASS" || row["value"] === "FAIL"),
    );
    const values = new Set(valid.map((row) => String(row["value"])));
    let assessment: TaskOutcomeAssessment = "UNKNOWN";
    let reason = "no revision-bound task-correctness observation";
    if (values.size > 1) {
      assessment = "CONFLICTED";
      reason = "conflicting revision-bound task-correctness observations";
    } else if (values.has("FAIL")) {
      assessment = "ESTABLISHED_FAIL";
      reason =
        "revision-bound deterministic or independent task-correctness evidence failed";
    } else if (values.has("PASS")) {
      assessment = "ESTABLISHED_PASS";
      reason =
        "revision-bound deterministic or independent task-correctness evidence passed";
    } else if (observations.some((row) => row["validity"] === "INVALID")) {
      assessment = "INVALID_EVIDENCE";
      reason = "task-correctness evidence was invalid";
    }
    this.db
      .prepare(
        `INSERT INTO task_outcome_assessments(trial_id,policy_version,assessment,reason,input_observation_count,conflict_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(trial_id) DO UPDATE SET policy_version=excluded.policy_version,assessment=excluded.assessment,reason=excluded.reason,input_observation_count=excluded.input_observation_count,conflict_count=excluded.conflict_count`,
      )
      .run(
        trialId,
        TASK_OUTCOME_POLICY_VERSION,
        assessment,
        reason,
        observations.length,
        values.size > 1 ? 1 : 0,
      );
  }

  private identity(
    namespace: string,
    role: string,
    locator: string,
    epoch: string,
    prefix: string,
  ): string {
    const existing = this.db
      .prepare(
        "SELECT logical_entity_id FROM identity_registry WHERE source_namespace=? AND source_role=? AND legacy_locator=? AND identity_epoch=?",
      )
      .get(namespace, role, locator, epoch) as
      | { logical_entity_id?: string }
      | undefined;
    if (existing?.logical_entity_id) return existing.logical_entity_id;
    const id = `${prefix}_${randomUUID()}`;
    this.db
      .prepare("INSERT OR IGNORE INTO identity_registry VALUES (?, ?, ?, ?, ?)")
      .run(namespace, role, locator, epoch, id);
    return id;
  }

  query(name: SavedQueryName): QueryResult {
    const definition = savedQueryDefinition(name);
    if (!definition) throw new Error(`Unknown saved BRI query: ${name}`);
    const coverage = this.coverage();
    const base: QueryResult = {
      query: name,
      status: definition.support,
      numerator: null,
      eligibleDenominator: null,
      unknownCount: 0,
      invalidCount: 0,
      excludedCount: 0,
      cohortDefinition: definition.denominator,
      extractionCoverage: coverage,
      rows: [],
      warnings: [],
    };
    if (name === "inventory") {
      const result = rows(
        this.db,
        `SELECT logical_id AS run_id, source_schema, captured_at, source_digest IS NOT NULL AS digest_available FROM run_containers ORDER BY captured_at DESC`,
      );
      return {
        ...base,
        numerator: result.length,
        eligibleDenominator: result.length,
        rows: result,
      };
    }
    if (name === "coverage")
      return {
        ...base,
        numerator: coverage.extractedRuns,
        eligibleDenominator: coverage.extractedRuns,
        rows: [{ ...coverage }],
      };
    if (name === "task-outcome-coverage") {
      const values = rows(
        this.db,
        `SELECT assessment,COUNT(*) AS count FROM task_outcome_assessments GROUP BY assessment`,
      );
      const total = values.reduce(
        (sum, row) => sum + Number(row["count"] ?? 0),
        0,
      );
      const byAssessment = Object.fromEntries(
        values.map((row) => [
          String(row["assessment"]),
          Number(row["count"] ?? 0),
        ]),
      );
      const established =
        Number(byAssessment["ESTABLISHED_PASS"] ?? 0) +
        Number(byAssessment["ESTABLISHED_FAIL"] ?? 0);
      const conflicted = Number(byAssessment["CONFLICTED"] ?? 0);
      const invalid = Number(byAssessment["INVALID_EVIDENCE"] ?? 0);
      return total === 0
        ? {
            ...base,
            status: "NOT_ESTABLISHED",
            warnings: ["No trials have a derived task outcome assessment."],
          }
        : {
            ...base,
            numerator: established,
            eligibleDenominator: total,
            unknownCount: Number(byAssessment["UNKNOWN"] ?? 0),
            invalidCount: invalid,
            excludedCount: Number(byAssessment["NOT_APPLICABLE"] ?? 0),
            rows: [
              {
                policyVersion: TASK_OUTCOME_POLICY_VERSION,
                established,
                conflicted,
                invalid,
                coveragePercent: (established / total) * 100,
                assessments: byAssessment,
              },
            ],
          };
    }
    if (name === "task-outcome-summary") {
      const assessments = rows(
        this.db,
        `SELECT assessment,COUNT(*) AS trials FROM task_outcome_assessments GROUP BY assessment ORDER BY assessment`,
      );
      const authorities = rows(
        this.db,
        `SELECT authority,COUNT(*) AS observations FROM outcome_observations GROUP BY authority ORDER BY authority`,
      );
      const total = assessments.reduce(
        (sum, row) => sum + Number(row["trials"] ?? 0),
        0,
      );
      return total === 0
        ? {
            ...base,
            status: "NOT_ESTABLISHED",
            warnings: ["No trials have a derived task outcome assessment."],
          }
        : {
            ...base,
            numerator: total,
            eligibleDenominator: total,
            unknownCount: Number(
              assessments.find((row) => row["assessment"] === "UNKNOWN")?.[
                "trials"
              ] ?? 0,
            ),
            invalidCount: Number(
              assessments.find(
                (row) => row["assessment"] === "INVALID_EVIDENCE",
              )?.["trials"] ?? 0,
            ),
            rows: [
              {
                policyVersion: TASK_OUTCOME_POLICY_VERSION,
                assessments,
                authorityCoverage: authorities,
              },
            ],
          };
    }
    if (name === "verifier-coverage") {
      const values =
        rows(
          this.db,
          `WITH per_trial AS (
          SELECT s.trial_id,
            MAX(CASE WHEN v.result IN ('PASS','FAIL') AND v.availability='PRESENT' THEN 1 ELSE 0 END) AS valid_evidence,
            MAX(CASE WHEN v.result='MISSING' THEN 1 ELSE 0 END) AS missing_evidence,
            MAX(CASE WHEN v.availability='INVALID' THEN 1 ELSE 0 END) AS invalid_evidence,
            MAX(CASE WHEN v.freshness='STALE' THEN 1 ELSE 0 END) AS stale_evidence,
            MAX(CASE WHEN v.result='UNKNOWN' OR v.freshness='UNKNOWN' THEN 1 ELSE 0 END) AS unknown_evidence
          FROM execution_segments s JOIN verifier_observations v ON v.segment_id=s.segment_id
          GROUP BY s.trial_id
        )
        SELECT SUM(valid_evidence) AS valid, SUM(missing_evidence) AS missing,
          SUM(invalid_evidence) AS invalid, SUM(stale_evidence) AS stale,
          SUM(unknown_evidence) AS unknown, COUNT(*) AS eligible FROM per_trial`,
        )[0] ?? {};
      const eligible = Number(values["eligible"] ?? 0);
      return eligible === 0
        ? {
            ...base,
            status: "NOT_ESTABLISHED",
            eligibleDenominator: null,
            rows: [],
            warnings: [
              "No parsed verifier evidence defines an eligible cohort.",
            ],
          }
        : {
            ...base,
            numerator: Number(values["valid"] ?? 0),
            eligibleDenominator: eligible,
            unknownCount: Number(values["unknown"] ?? 0),
            invalidCount: Number(values["invalid"] ?? 0),
            excludedCount: coverage.extractedRuns - eligible,
            rows: [
              {
                validVerifierEvidence: Number(values["valid"] ?? 0),
                missingVerifierEvidence: Number(values["missing"] ?? 0),
                invalidVerifierEvidence: Number(values["invalid"] ?? 0),
                staleVerifierEvidence: Number(values["stale"] ?? 0),
                coveragePercent:
                  (Number(values["valid"] ?? 0) / eligible) * 100,
                attribution:
                  "one trial is eligible only when BRI parsed verifier evidence for it",
              },
            ],
          };
    }
    if (name === "outcome-evidence-summary") {
      const result = rows(
        this.db,
        `SELECT dimension,value,validity,availability,COUNT(*) AS observations,COUNT(DISTINCT trial_id) AS trials
         FROM outcome_observations
         GROUP BY dimension,value,validity,availability
         ORDER BY dimension,value`,
      );
      const known = result.reduce(
        (total, row) => total + Number(row["observations"] ?? 0),
        0,
      );
      return known === 0
        ? {
            ...base,
            status: "NOT_ESTABLISHED",
            warnings: [
              "No dimension-scoped outcome observations are currently extracted.",
            ],
          }
        : {
            ...base,
            numerator: known,
            eligibleDenominator: known,
            unknownCount: result
              .filter((row) => row["validity"] === "UNKNOWN")
              .reduce(
                (total, row) => total + Number(row["observations"] ?? 0),
                0,
              ),
            rows: result,
          };
    }
    if (name === "model-evidence-coverage") {
      const result = rows(
        this.db,
        `SELECT COALESCE(provider,'UNKNOWN') AS provider,
           COALESCE(observed_model,sent_model,normalized_model,requested_model,'UNKNOWN') AS model,
           COUNT(*) AS inferences, COUNT(DISTINCT s.trial_id) AS participating_trials,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM outcome_observations o WHERE o.trial_id=s.trial_id AND o.validity='VALID') THEN 1 ELSE 0 END) AS inferences_with_valid_dimension_evidence,
           SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM outcome_observations o WHERE o.trial_id=s.trial_id AND o.validity='VALID') THEN 1 ELSE 0 END) AS inferences_without_valid_dimension_evidence
         FROM model_routing_observations m JOIN execution_segments s ON s.segment_id=m.segment_id
         WHERE m.availability='PRESENT'
         GROUP BY provider,model ORDER BY participating_trials DESC,inferences DESC`,
      );
      const eligible = rows(
        this.db,
        "SELECT COUNT(DISTINCT s.trial_id) AS count FROM execution_segments s JOIN model_routing_observations m ON m.segment_id=s.segment_id WHERE m.availability='PRESENT'",
      )[0];
      const denominator = Number(eligible?.["count"] ?? 0);
      return denominator === 0
        ? {
            ...base,
            status: "NOT_ESTABLISHED",
            warnings: [
              "No parseable model-routing or usage-ledger evidence is available.",
            ],
          }
        : {
            ...base,
            numerator: denominator,
            eligibleDenominator: denominator,
            excludedCount: coverage.extractedRuns - denominator,
            cohortDefinition:
              "ANY_PARTICIPATING_MODEL: each routing observation is retained; trials are not collapsed to one model",
            rows: result,
          };
    }
    if (name === "failure-clusters") {
      const result = rows(
        this.db,
        `SELECT c.cluster_id, s.subsystem, s.category, COUNT(o.logical_id) AS occurrences, MIN(o.occurred_at) AS first_seen, MAX(o.occurred_at) AS last_seen FROM failure_clusters c JOIN failure_signatures s ON s.signature_id=c.signature_id LEFT JOIN failure_occurrences o ON o.signature_id=s.signature_id GROUP BY c.cluster_id,s.subsystem,s.category ORDER BY occurrences DESC`,
      );
      return {
        ...base,
        numerator: result.length,
        eligibleDenominator: null,
        rows: result,
      };
    }
    if (name === "failure-rate-by-model") {
      const values = rows(
        this.db,
        `SELECT model, SUM(CASE WHEN outcome_availability='PRESENT' THEN 1 ELSE 0 END) AS eligible, SUM(CASE WHEN outcome='FAILURE' AND outcome_availability='PRESENT' THEN 1 ELSE 0 END) AS numerator, SUM(CASE WHEN outcome_availability<>'PRESENT' THEN 1 ELSE 0 END) AS unknown_count FROM trials GROUP BY model`,
      );
      const eligible = values.reduce(
        (total, row) => total + Number(row["eligible"] ?? 0),
        0,
      );
      const numerator = values.reduce(
        (total, row) => total + Number(row["numerator"] ?? 0),
        0,
      );
      const unknown = values.reduce(
        (total, row) => total + Number(row["unknown_count"] ?? 0),
        0,
      );
      return eligible === 0
        ? {
            ...base,
            status: "NOT_ESTABLISHED",
            numerator: null,
            eligibleDenominator: 0,
            unknownCount: unknown,
            rows: [],
            warnings: [
              "No independently observed outcomes are currently extracted; zero is not a rate.",
            ],
          }
        : {
            ...base,
            numerator,
            eligibleDenominator: eligible,
            unknownCount: unknown,
            rows: values,
          };
    }
    return {
      ...base,
      status: "NOT_ESTABLISHED",
      warnings: [
        "The required provenance is not yet available from current read-only adapters.",
      ],
    };
  }

  coverage(): { extractedRuns: number; receiptCount: number } {
    return {
      extractedRuns: Number(
        rows(this.db, "SELECT COUNT(*) AS count FROM run_containers")[0]?.[
          "count"
        ] ?? 0,
      ),
      receiptCount: Number(
        rows(this.db, "SELECT COUNT(*) AS count FROM extraction_receipts")[0]?.[
          "count"
        ] ?? 0,
      ),
    };
  }

  show(entityId: string): Record<string, unknown> | null {
    const run = this.db
      .prepare(
        "SELECT logical_id,source_namespace,source_schema,captured_at,source_digest IS NOT NULL AS digest_available FROM run_containers WHERE logical_id=?",
      )
      .get(entityId) as Record<string, unknown> | undefined;
    if (run) return run;
    return (
      (this.db
        .prepare(
          "SELECT signature_id,algorithm_version,subsystem,category,stable_detail FROM failure_signatures WHERE signature_id=?",
        )
        .get(entityId) as Record<string, unknown> | undefined) ?? null
    );
  }

  /** Create an immutable, content-minimized evaluation case definition. */
  createCaseVersion(input: {
    caseId?: string;
    definitionHash: string;
    taskContractRef?: string;
    startingStateRef?: string;
    successCriteriaRef?: string;
    purposePolicy?: string;
  }): { caseId: string; caseVersionId: string } {
    const caseId = input.caseId ?? opaqueId("case", input.definitionHash);
    const caseVersionId = opaqueId(
      "case_version",
      caseId,
      input.definitionHash,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO cases(case_id,purpose_policy) VALUES (?, ?)",
        )
        .run(caseId, input.purposePolicy ?? "EVALUATION_ONLY");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO case_versions(case_version_id,case_id,definition_hash,task_contract_ref,starting_state_ref,success_criteria_ref,immutable) VALUES (?, ?, ?, ?, ?, ?, 1)",
        )
        .run(
          caseVersionId,
          caseId,
          input.definitionHash,
          input.taskContractRef ?? null,
          input.startingStateRef ?? null,
          input.successCriteriaRef ?? null,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { caseId, caseVersionId };
  }

  /** Freeze a deterministic membership hash for a dataset version. */
  createDatasetVersion(input: {
    datasetId?: string;
    membershipHash: string;
    purposePolicy?: string;
  }): { datasetId: string; datasetVersionId: string } {
    const datasetId =
      input.datasetId ?? opaqueId("dataset", input.membershipHash);
    const datasetVersionId = opaqueId(
      "dataset_version",
      datasetId,
      input.membershipHash,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO datasets(dataset_id,purpose_policy) VALUES (?, ?)",
        )
        .run(datasetId, input.purposePolicy ?? "EVALUATION_ONLY");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO dataset_versions(dataset_version_id,dataset_id,membership_hash,frozen_at) VALUES (?, ?, ?, ?)",
        )
        .run(datasetVersionId, datasetId, input.membershipHash, now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { datasetId, datasetVersionId };
  }

  /** Register versioned evaluator identity and bind it to an experiment. */
  createExperiment(input: {
    datasetVersionId?: string;
    rubricIdentity: string;
    rubricVersion: string;
  }): { evaluationId: string; experimentId: string } {
    const evaluationId = opaqueId(
      "evaluation",
      input.rubricIdentity,
      input.rubricVersion,
    );
    const experimentId = opaqueId(
      "experiment",
      input.datasetVersionId ?? "none",
      evaluationId,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO evaluations(evaluation_id,rubric_identity,rubric_version) VALUES (?, ?, ?)",
        )
        .run(evaluationId, input.rubricIdentity, input.rubricVersion);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO experiments(experiment_id,dataset_version_id,evaluation_id,created_at) VALUES (?, ?, ?, ?)",
        )
        .run(experimentId, input.datasetVersionId ?? null, evaluationId, now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { evaluationId, experimentId };
  }

  /** Add a non-destructive, typed improvement-lineage assertion. */
  addLineageEdge(input: {
    fromId: string;
    toId: string;
    relation:
      | "suspected_fix"
      | "validated_fix"
      | "regression_of"
      | "recurred_after"
      | "supersedes"
      | "derived_from";
  }): string {
    const edgeId = opaqueId("edge", input.fromId, input.toId, input.relation);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO lineage_edges(edge_id,from_id,to_id,relation,created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(edgeId, input.fromId, input.toId, input.relation, now());
    return edgeId;
  }

  /** Attach reviewed cluster semantics without overwriting automated observations. */
  reviewFailureCluster(input: {
    signatureId: string;
    adjudication?: string;
    suspectedCause?: string;
    candidateFix?: string;
    validatedFix?: string;
    supersedesClusterId?: string;
  }): string {
    const clusterId = opaqueId("cluster", input.signatureId);
    this.db
      .prepare(
        `UPDATE failure_clusters SET adjudication=COALESCE(?,adjudication), suspected_cause=COALESCE(?,suspected_cause), candidate_fix=COALESCE(?,candidate_fix), validated_fix=COALESCE(?,validated_fix), supersedes_cluster_id=COALESCE(?,supersedes_cluster_id) WHERE cluster_id=?`,
      )
      .run(
        input.adjudication ?? null,
        input.suspectedCause ?? null,
        input.candidateFix ?? null,
        input.validatedFix ?? null,
        input.supersedesClusterId ?? null,
        clusterId,
      );
    return clusterId;
  }

  verify(): {
    ok: boolean;
    foreignKeyViolations: number;
    schemaVersion: number;
  } {
    const issues = rows(this.db, "PRAGMA foreign_key_check");
    return {
      ok: issues.length === 0,
      foreignKeyViolations: issues.length,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  close(): void {
    this.db.close();
  }
}
