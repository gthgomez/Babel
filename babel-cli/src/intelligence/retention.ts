export type RetentionFieldStatus =
  | "PRESENT_VALID"
  | "PRESENT_UNVERIFIED"
  | "MISSING_EXPECTED"
  | "NOT_APPLICABLE";

export interface RetentionField {
  field: string;
  status: RetentionFieldStatus;
  reason?: string;
}

export interface RetentionMatrix {
  schemaVersion: 1;
  cellId: string;
  fields: RetentionField[];
  criticalExpected: number;
  criticalRetained: number;
  criticalValid: number;
  status: "RETENTION_CERTIFIED" | "RETENTION_PARTIAL" | "RETENTION_FAILED";
}

export const CRITICAL_RETENTION_FIELDS = [
  "wireModelId",
  "resolvedExecutionEnvelopeHash",
  "generationPolicy",
  "finishReason",
  "taskResult",
  "verificationEvidence",
  "failureAttribution",
] as const;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** Evaluate canonical cell evidence without treating absent optional provider data as failure. */
export function buildRetentionMatrix(input: {
  cellId: string;
  evidence: Readonly<Record<string, unknown>>;
  optionalFields?: Readonly<Record<string, RetentionFieldStatus>>;
  validators?: Readonly<Record<string, (value: unknown) => boolean>>;
}): RetentionMatrix {
  const optional = input.optionalFields ?? {};
  const validators = input.validators ?? {};
  const fieldNames = [
    ...new Set([...CRITICAL_RETENTION_FIELDS, ...Object.keys(optional)]),
  ];
  const fields = fieldNames.map((field): RetentionField => {
    const value = input.evidence[field];
    if (!isPresent(value)) {
      return optional[field]
        ? {
            field,
            status: optional[field]!,
            reason: "Provider-dependent or explicitly optional.",
          }
        : {
            field,
            status: "MISSING_EXPECTED",
            reason: "Canonical evidence is absent.",
          };
    }
    const validator = validators[field];
    if (validator && !validator(value)) {
      return {
        field,
        status: "PRESENT_UNVERIFIED",
        reason: "Value is present but failed its consistency validator.",
      };
    }
    return { field, status: "PRESENT_VALID" };
  });
  const critical = fields.filter((field) =>
    (CRITICAL_RETENTION_FIELDS as readonly string[]).includes(field.field),
  );
  const criticalRetained = critical.filter(
    (field) => field.status !== "MISSING_EXPECTED",
  ).length;
  const criticalValid = critical.filter(
    (field) => field.status === "PRESENT_VALID",
  ).length;
  const status =
    criticalValid === critical.length
      ? "RETENTION_CERTIFIED"
      : criticalRetained === critical.length
        ? "RETENTION_PARTIAL"
        : "RETENTION_FAILED";
  return {
    schemaVersion: 1,
    cellId: input.cellId,
    fields,
    criticalExpected: critical.length,
    criticalRetained,
    criticalValid,
    status,
  };
}

/** Check the cross-artifact equalities required before a cell can be comparable. */
export function validateRetentionConsistency(input: {
  manifestWireModelId: string;
  requestWireModelId: string;
  effectiveOutputBudget: number | null;
  serializedOutputBudget?: number;
  finishReason: string;
  terminalFinishReason: string;
  taskResult: string;
  verificationResult: string;
  failureAttribution?: string;
}): string[] {
  const errors: string[] = [];
  if (input.manifestWireModelId !== input.requestWireModelId)
    errors.push("manifest wire model differs from request receipt");
  if (
    input.serializedOutputBudget !== undefined &&
    input.serializedOutputBudget !== input.effectiveOutputBudget
  ) {
    errors.push(
      "effective output budget differs from serialized provider value",
    );
  }
  if (input.finishReason !== input.terminalFinishReason)
    errors.push("finish reason differs from terminal classification");
  if (!input.taskResult || !input.verificationResult)
    errors.push("task result or verification evidence is empty");
  if (!input.failureAttribution) errors.push("failure attribution is missing");
  return errors;
}
