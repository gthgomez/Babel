import { hashCanonical } from "./hash.js";
import type {
  AggregateMetric,
  CampaignCircuitBreakerSnapshot,
  CampaignFailureSignature,
  CampaignReadiness,
  CircuitBreakerState,
  FailureAttribution,
} from "./types.js";

export interface CampaignCircuitBreakerOptions {
  transientFailureThreshold?: number;
  transientWindowMs?: number;
  recoveryCondition?: string;
}

export type CampaignPreflightState =
  | "PRE_FLIGHT_PROVIDER_VALIDATED"
  | "PRE_FLIGHT_REQUIRED"
  | "PRE_FLIGHT_INVALID"
  | "NOT_REQUIRED";

export interface CampaignPreflightResult {
  state: CampaignPreflightState;
  exactEnvelopeHash?: string;
  reason?: string;
}

/** Require the exact campaign provider path to pass a representative smoke before paid fan-out. */
export function validateCampaignPreflight(input: {
  paidCellCount: number;
  exactEnvelopeHash: string;
  smokeEnvelopeHash?: string;
  checks?: {
    auth: boolean;
    affordability: boolean;
    routing: boolean;
    modelIdentity: boolean;
    requiredParameters: boolean;
    serialization: boolean;
    receipts: boolean;
  };
}): CampaignPreflightResult {
  if (input.paidCellCount <= 2)
    return {
      state: "NOT_REQUIRED",
      exactEnvelopeHash: input.exactEnvelopeHash,
    };
  if (!input.smokeEnvelopeHash) {
    return {
      state: "PRE_FLIGHT_REQUIRED",
      exactEnvelopeHash: input.exactEnvelopeHash,
      reason: "representative smoke is missing",
    };
  }
  if (input.smokeEnvelopeHash !== input.exactEnvelopeHash) {
    return {
      state: "PRE_FLIGHT_INVALID",
      exactEnvelopeHash: input.exactEnvelopeHash,
      reason: "smoke used a different execution envelope",
    };
  }
  const checks = input.checks;
  if (!checks || Object.values(checks).some((passed) => passed !== true)) {
    return {
      state: "PRE_FLIGHT_INVALID",
      exactEnvelopeHash: input.exactEnvelopeHash,
      reason: "representative provider checks did not all pass",
    };
  }
  return {
    state: "PRE_FLIGHT_PROVIDER_VALIDATED",
    exactEnvelopeHash: input.exactEnvelopeHash,
  };
}

/** Campaign-level cost guard that stops shared deterministic failures before fan-out. */
export class CampaignCircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private triggeringFailure: CampaignFailureSignature | undefined;
  private readonly failureTimes = new Map<string, number[]>();
  private readonly affectedExecutionEnvelopeHashes = new Set<string>();
  private readonly affectedModels = new Set<string>();
  private affectedProvider: string | undefined;
  private cellsPrevented = 0;
  private estimatedSpendAvoided = 0;
  private readonly transientFailureThreshold: number;
  private readonly transientWindowMs: number;
  private readonly recoveryCondition: string;

  constructor(options: CampaignCircuitBreakerOptions = {}) {
    this.transientFailureThreshold = Math.max(
      1,
      options.transientFailureThreshold ?? 2,
    );
    this.transientWindowMs = Math.max(1, options.transientWindowMs ?? 60_000);
    this.recoveryCondition =
      options.recoveryCondition ??
      "manual reset after shared failure is resolved";
  }

  /** Throw before dispatching a cell while the campaign lane is open. */
  assertCanDispatch(): void {
    if (this.state === "OPEN") {
      throw new Error(
        "Campaign circuit breaker is OPEN; matching cells are not dispatched.",
      );
    }
  }

  /** Observe one failure and open immediately for deterministic account/configuration failures. */
  observeFailure(input: {
    failure: CampaignFailureSignature;
    model?: string;
    estimatedCellCostUsd?: number;
    observedAt?: number;
  }): CampaignCircuitBreakerSnapshot {
    const now = input.observedAt ?? Date.now();
    const key = hashCanonical(input.failure);
    const prior = this.failureTimes.get(key) ?? [];
    const recent = prior.filter(
      (timestamp) => now - timestamp <= this.transientWindowMs,
    );
    recent.push(now);
    this.failureTimes.set(key, recent);
    if (input.failure.executionEnvelopeHash) {
      this.affectedExecutionEnvelopeHashes.add(
        input.failure.executionEnvelopeHash,
      );
    }
    if (input.model) this.affectedModels.add(input.model);
    this.affectedProvider = input.failure.provider;

    const transientThresholdReached =
      input.failure.retryableWithoutChange &&
      recent.length >= this.transientFailureThreshold;
    if (input.failure.configurationRelevant || transientThresholdReached) {
      this.state = "OPEN";
      this.triggeringFailure = input.failure;
    }
    return this.snapshot();
  }

  /** Count a scheduled cell prevented by an already-open shared failure. */
  recordPreventedCell(estimatedCostUsd = 0): void {
    this.cellsPrevented += 1;
    if (Number.isFinite(estimatedCostUsd) && estimatedCostUsd > 0) {
      this.estimatedSpendAvoided += estimatedCostUsd;
    }
  }

  /** Explicitly enter half-open recovery after an operator or controller check. */
  beginRecovery(): void {
    if (this.state === "OPEN") this.state = "HALF_OPEN";
  }

  /** Close the lane after a representative recovery smoke succeeds. */
  close(): void {
    this.state = "CLOSED";
    this.triggeringFailure = undefined;
    this.failureTimes.clear();
  }

  snapshot(): CampaignCircuitBreakerSnapshot {
    return {
      state: this.state,
      ...(this.triggeringFailure === undefined
        ? {}
        : { triggeringFailure: this.triggeringFailure }),
      affectedExecutionEnvelopeHashes: [
        ...this.affectedExecutionEnvelopeHashes,
      ],
      ...(this.affectedProvider === undefined
        ? {}
        : { affectedProvider: this.affectedProvider }),
      affectedModels: [...this.affectedModels],
      cellsPrevented: this.cellsPrevented,
      ...(this.estimatedSpendAvoided > 0
        ? { estimatedSpendAvoided: this.estimatedSpendAvoided }
        : {}),
      recoveryCondition: this.recoveryCondition,
    };
  }
}

/** Classify a campaign without allowing instrumentation success to imply comparability. */
export function buildCampaignReadiness(input: {
  telemetryComplete: boolean;
  providerFailures: number;
  cleanComparableCells: number;
  publicationEvidenceComplete?: boolean;
}): CampaignReadiness {
  const instrumentation = input.telemetryComplete ? "READY" : "UNKNOWN";
  const execution = input.providerFailures === 0 ? "READY" : "INVALID";
  const comparison = input.cleanComparableCells > 0 ? "READY" : "INVALID";
  const publication =
    input.cleanComparableCells > 0 && input.publicationEvidenceComplete === true
      ? "READY"
      : input.telemetryComplete
        ? "DIAGNOSTIC_ONLY"
        : "BLOCKED";
  return {
    instrumentation: { status: instrumentation },
    execution: {
      status: execution,
      ...(input.providerFailures > 0 ? { reason: "PROVIDER_FAILURE" } : {}),
    },
    comparison: {
      status: comparison,
      ...(input.cleanComparableCells === 0
        ? { reason: "NO_CLEAN_COMPARABLE_CELLS" }
        : {}),
    },
    publication: { status: publication },
  };
}

/** Performance metrics are null/diagnostic when the contributing cells are contaminated. */
export function buildAggregateMetric<T>(input: {
  value?: T;
  comparable: boolean;
  includedCells: readonly string[];
  excludedCells?: readonly string[];
}): AggregateMetric<T> {
  const includedCells = [...input.includedCells];
  const excludedCells = [...(input.excludedCells ?? [])];
  if (input.comparable && includedCells.length > 0) {
    return {
      value: input.value ?? null,
      validity: "performance_comparable",
      includedCells,
      excludedCells,
    };
  }
  if (includedCells.length > 0 || excludedCells.length > 0) {
    return {
      value: input.value ?? null,
      validity: "diagnostic_only",
      includedCells,
      excludedCells,
    };
  }
  return {
    value: null,
    validity: "insufficient_data",
    includedCells,
    excludedCells,
  };
}

/** A solved task is not automatically attributable to the model. */
export function modelSuccessAttributable(input: {
  taskSolved: boolean;
  cleanComparable: boolean;
  attribution?: FailureAttribution;
}): boolean {
  return (
    input.taskSolved &&
    input.cleanComparable &&
    input.attribution?.kind !== "UNKNOWN"
  );
}
