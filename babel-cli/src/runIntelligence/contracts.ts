import { createHash } from "node:crypto";

/** Explicit state for a field that could not be reconstructed safely. */
export type FieldAvailability =
  | "PRESENT"
  | "ABSENT"
  | "UNSUPPORTED"
  | "REDACTED"
  | "TRUNCATED"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE"
  | "INVALID"
  | "UNKNOWN";

export type OutcomeKind = "SUCCESS" | "FAILURE" | "HALTED" | "UNKNOWN";

export interface ExtractionWarning {
  code: string;
  message: string;
  availability: FieldAvailability;
}

export interface FailureCandidate {
  subsystem: string;
  category: string;
  stableDetail?: string;
  occurredAt?: string;
}
export interface ModelRoutingObservation {
  inferenceToken: string;
  provider: string | null;
  requestedModel: string | null;
  normalizedModel: string | null;
  sentModel: string | null;
  observedModel: string | null;
  evidenceRef: string;
  availability: FieldAvailability;
}
export interface VerifierObservation {
  verifierIdentity: string | null;
  authoritative: boolean;
  result: "PASS" | "FAIL" | "MISSING" | "UNKNOWN";
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  independence: "INDEPENDENT" | "IMPLEMENTOR" | "UNKNOWN";
  evidenceRef: string;
  availability: FieldAvailability;
  observedAt: string | null;
}
export interface OutcomeObservation {
  dimension:
    | "VERIFIER_RESULT"
    | "CONTROL_DECISION"
    | "TERMINAL_EXECUTION_STATUS";
  value: string;
  observer: string;
  evidenceRef: string;
  validity: "VALID" | "INVALID" | "UNKNOWN";
  availability: FieldAvailability;
  observedAt: string | null;
}
export interface UsageObservation {
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costBasis: "OBSERVED" | "ESTIMATED" | "UNKNOWN";
  evidenceRef: string;
  availability: FieldAvailability;
}

export interface ExtractedArtifact {
  name: string;
  byteLength: number;
  contentDigest: string | null;
  availability: FieldAvailability;
}

export interface ExtractedRun {
  sourceNamespace: string;
  sourceRole: string;
  sourceLocator: string;
  sourceDigest: string | null;
  sourceSchema: string | null;
  capturedAt: string | null;
  adapterName: string;
  adapterVersion: string;
  sessionLegacyId: string | null;
  model: string | null;
  routing: ModelRoutingObservation[];
  verifiers: VerifierObservation[];
  outcomes: OutcomeObservation[];
  usage: UsageObservation[];
  outcome: OutcomeKind;
  outcomeAvailability: FieldAvailability;
  artifacts: ExtractedArtifact[];
  failures: FailureCandidate[];
  warnings: ExtractionWarning[];
}

export interface ExtractionReceipt {
  receiptId: string;
  sourceNamespace: string;
  sourceRole: string;
  sourceLocatorDigest: string;
  sourceDigest: string | null;
  sourceSchema: string | null;
  adapterName: string;
  adapterVersion: string;
  extractedAt: string;
  entitiesEmitted: number;
  unavailableFields: FieldAvailability[];
  warnings: ExtractionWarning[];
}

export type SavedQueryName =
  | "inventory"
  | "coverage"
  | "failure-rate-by-model"
  | "verifier-coverage"
  | "outcome-evidence-summary"
  | "model-evidence-coverage"
  | "failure-clusters"
  | "halt-frequency-by-subsystem"
  | "scope-violations-over-time"
  | "success-versus-cost-latency"
  | "same-case-across-babel-versions"
  | "same-case-across-models"
  | "checkpoint-volume-by-session"
  | "artifact-completeness-by-era"
  | "new-failure-signatures-after-build"
  | "failures-disappearing-after-commit"
  | "benchmark-result-distributions"
  | "repeated-trial-variance"
  | "insufficient-comparison-provenance";

export type QuerySupport =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "NOT_ESTABLISHED";

export interface SavedQueryDefinition {
  name: SavedQueryName;
  support: QuerySupport;
  requiredRelations: string[];
  requiredProvenance: string[];
  denominator: string;
  exclusions: string[];
}

export interface QueryResult {
  query: SavedQueryName;
  status: QuerySupport;
  numerator: number | null;
  eligibleDenominator: number | null;
  unknownCount: number;
  invalidCount: number;
  excludedCount: number;
  cohortDefinition: string;
  extractionCoverage: { extractedRuns: number; receiptCount: number };
  rows: Array<Record<string, unknown>>;
  warnings: string[];
}

/** Return an opaque, stable logical identifier without exposing an input locator. */
export function opaqueId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

/** Versioned, deterministic failure signature with volatile values intentionally excluded. */
export function failureSignature(candidate: FailureCandidate): string {
  const stable = [
    "bri.failure-signature.v1",
    candidate.subsystem.trim().toLowerCase(),
    candidate.category.trim().toLowerCase(),
  ];
  return opaqueId("fs", ...stable);
}

export const SAVED_QUERY_DEFINITIONS: readonly SavedQueryDefinition[] = [
  {
    name: "inventory",
    support: "SUPPORTED",
    requiredRelations: ["run_containers"],
    requiredProvenance: ["receipt"],
    denominator: "all extracted run containers",
    exclusions: [],
  },
  {
    name: "coverage",
    support: "SUPPORTED",
    requiredRelations: ["extraction_receipts", "run_containers"],
    requiredProvenance: ["adapter version"],
    denominator: "all cataloged sources",
    exclusions: [],
  },
  {
    name: "failure-rate-by-model",
    support: "PARTIALLY_SUPPORTED",
    requiredRelations: ["trials", "failure_occurrences"],
    requiredProvenance: ["model", "outcome observation"],
    denominator: "trials with independently observed outcome",
    exclusions: ["UNKNOWN outcome", "INVALID source"],
  },
  {
    name: "verifier-coverage",
    support: "SUPPORTED",
    requiredRelations: ["trials", "verifier_observations"],
    requiredProvenance: ["verifier execution summary"],
    denominator: "trials with a parsed verifier execution summary",
    exclusions: ["runs without a verifier summary artifact"],
  },
  {
    name: "outcome-evidence-summary",
    support: "SUPPORTED",
    requiredRelations: ["outcome_observations"],
    requiredProvenance: ["dimension-scoped observer evidence"],
    denominator: "observations, not a universal task-success rate",
    exclusions: [],
  },
  {
    name: "model-evidence-coverage",
    support: "SUPPORTED",
    requiredRelations: ["trials", "model_routing_observations"],
    requiredProvenance: ["routing or usage ledger model evidence"],
    denominator: "trials with a parsed routing or usage source",
    exclusions: ["runs with no parseable routing or usage source"],
  },
  {
    name: "failure-clusters",
    support: "SUPPORTED",
    requiredRelations: ["failure_signatures", "failure_occurrences"],
    requiredProvenance: ["receipt"],
    denominator: "not a rate",
    exclusions: [],
  },
  {
    name: "halt-frequency-by-subsystem",
    support: "PARTIALLY_SUPPORTED",
    requiredRelations: ["trials", "failure_occurrences"],
    requiredProvenance: ["halt classification"],
    denominator: "trials with typed halt evidence",
    exclusions: ["UNKNOWN outcome"],
  },
  {
    name: "scope-violations-over-time",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["policy observations"],
    requiredProvenance: ["policy version", "timestamp"],
    denominator: "eligible policy observations",
    exclusions: ["missing policy evidence"],
  },
  {
    name: "success-versus-cost-latency",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["trials", "outcomes", "usage"],
    requiredProvenance: ["outcome", "cost", "latency"],
    denominator: "trials with all measurements",
    exclusions: ["unknown measurement"],
  },
  {
    name: "same-case-across-babel-versions",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["case_versions", "trials"],
    requiredProvenance: ["case version", "Babel commit"],
    denominator: "comparable case trials",
    exclusions: ["different initial state"],
  },
  {
    name: "same-case-across-models",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["case_versions", "trials"],
    requiredProvenance: ["case version", "model route"],
    denominator: "comparable case trials",
    exclusions: ["different rubric"],
  },
  {
    name: "checkpoint-volume-by-session",
    support: "PARTIALLY_SUPPORTED",
    requiredRelations: ["artifacts", "sessions"],
    requiredProvenance: ["artifact receipt"],
    denominator: "extracted sessions",
    exclusions: ["unknown schemas"],
  },
  {
    name: "artifact-completeness-by-era",
    support: "PARTIALLY_SUPPORTED",
    requiredRelations: ["artifacts", "run_containers"],
    requiredProvenance: ["source schema"],
    denominator: "extracted run containers",
    exclusions: ["unavailable directories"],
  },
  {
    name: "new-failure-signatures-after-build",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["failure_signatures", "build provenance"],
    requiredProvenance: ["Babel commit", "exposure"],
    denominator: "comparable exposure",
    exclusions: ["missing build provenance"],
  },
  {
    name: "failures-disappearing-after-commit",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["failure_occurrences", "exposure"],
    requiredProvenance: ["comparable exposure"],
    denominator: "comparable exposure",
    exclusions: ["absence without exposure"],
  },
  {
    name: "benchmark-result-distributions",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["evaluations", "trials"],
    requiredProvenance: ["grader/rubric"],
    denominator: "graded trials",
    exclusions: ["unversioned grader"],
  },
  {
    name: "repeated-trial-variance",
    support: "NOT_ESTABLISHED",
    requiredRelations: ["case_versions", "trials"],
    requiredProvenance: ["case version", "environment"],
    denominator: "independent comparable trials",
    exclusions: ["retries and resumes"],
  },
  {
    name: "insufficient-comparison-provenance",
    support: "SUPPORTED",
    requiredRelations: ["trials"],
    requiredProvenance: ["case/environment/model/grader"],
    denominator: "comparison candidates",
    exclusions: [],
  },
] as const;

export function savedQueryDefinition(
  name: string,
): SavedQueryDefinition | null {
  return (
    SAVED_QUERY_DEFINITIONS.find((definition) => definition.name === name) ??
    null
  );
}
