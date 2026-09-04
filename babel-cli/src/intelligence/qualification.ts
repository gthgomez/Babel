import { randomUUID } from "node:crypto";
import { hashCanonical } from "./hash.js";
import type {
  CapabilityEvidence,
  ModelQualificationRecord,
  QualificationProbeResult,
  QualificationProbeSpec,
  ProtocolId,
} from "./types.js";

/** Bounded qualification plan. Paid probes are never dispatched by this module implicitly. */
export const QUALIFICATION_PROBE_SPECS: readonly QualificationProbeSpec[] =
  Object.freeze([
    {
      id: "Q0-metadata",
      purpose: "Import and reconcile provider metadata without inference.",
      paid: false,
      maxCalls: 0,
      maxOutputTokens: 0,
      requiredCapabilities: [],
      expectedBehavior: { kind: "metadata_snapshot" },
      stopOnFailure: true,
    },
    {
      id: "Q1-transport",
      purpose:
        "Verify auth, exact model identity, routing, serialization, stream termination, and usage.",
      paid: true,
      maxCalls: 1,
      maxOutputTokens: 1024,
      requiredCapabilities: ["streaming", "router_metadata"],
      expectedBehavior: { kind: "deterministic_structured_response" },
      stopOnFailure: true,
    },
    {
      id: "Q2-basic-tools",
      purpose:
        "Verify one required synthetic tool round trip and sequential replay.",
      paid: true,
      maxCalls: 2,
      maxOutputTokens: 2048,
      requiredCapabilities: ["basic_tools", "sequential_tools"],
      expectedBehavior: { kind: "tool_result_required" },
      stopOnFailure: true,
    },
    {
      id: "Q3-reasoning-control",
      purpose:
        "Compare at most two declared reasoning settings without inferring semantics from HTTP 200.",
      paid: true,
      maxCalls: 2,
      maxOutputTokens: 4096,
      requiredCapabilities: ["reasoning_effort"],
      expectedBehavior: { kind: "reasoning_sensitivity" },
      stopOnFailure: true,
    },
    {
      id: "Q4-structured-output",
      purpose:
        "Probe the strongest declared JSON mode and schema enforcement separately.",
      paid: true,
      maxCalls: 1,
      maxOutputTokens: 2048,
      requiredCapabilities: ["structured_output"],
      expectedBehavior: { kind: "structured_output" },
      stopOnFailure: false,
    },
    {
      id: "Q5-reasoning-tools",
      purpose:
        "Verify reasoning/tool state continuity across two dependent tool rounds.",
      paid: true,
      maxCalls: 3,
      maxOutputTokens: 4096,
      requiredCapabilities: [
        "reasoning_tool_interleave",
        "reasoning_replay",
        "multiple_tool_rounds",
      ],
      expectedBehavior: { kind: "dependent_two_tool_rounds" },
      stopOnFailure: true,
    },
    {
      id: "Q6-output-budget",
      purpose:
        "Test 8192 first, escalating only after explicit budget exhaustion evidence.",
      paid: true,
      maxCalls: 3,
      maxOutputTokens: 32768,
      requiredCapabilities: ["output_budget_attribution"],
      expectedBehavior: {
        kind: "adaptive_budget",
        tiers: [8192, 16384, 32768],
      },
      stopOnFailure: true,
    },
    {
      id: "Q7-context-position",
      purpose: "Measure task-dependent context usefulness at modest positions.",
      paid: true,
      maxCalls: 3,
      maxOutputTokens: 2048,
      requiredCapabilities: ["effective_context"],
      expectedBehavior: {
        kind: "context_position",
        tiers: [8192, 32768, 65536],
      },
      stopOnFailure: false,
    },
  ]);

/** Maximum provider calls for the selected qualification stages. */
export function qualificationCallCeiling(
  specs: readonly QualificationProbeSpec[] = QUALIFICATION_PROBE_SPECS,
): number {
  return specs.reduce((total, spec) => total + spec.maxCalls, 0);
}

export interface QualificationProbeExecutor {
  execute(spec: QualificationProbeSpec): Promise<QualificationProbeResult>;
}

/** Run local probes and optionally authorized paid probes in order, stopping on gate failure. */
export async function runQualificationProbes(input: {
  specs?: readonly QualificationProbeSpec[];
  executor: QualificationProbeExecutor;
  allowPaid?: boolean;
}): Promise<QualificationProbeResult[]> {
  const specs = input.specs ?? QUALIFICATION_PROBE_SPECS;
  const results: QualificationProbeResult[] = [];
  for (const spec of specs) {
    if (spec.paid && input.allowPaid !== true) {
      results.push({
        probeId: spec.id,
        requestArtifactId: `blocked-${spec.id}`,
        capabilityEvidence: [],
        status: "blocked",
      });
      if (spec.stopOnFailure) break;
      continue;
    }
    const result = await input.executor.execute(spec);
    if (result.probeId !== spec.id) {
      throw new Error(
        `Qualification executor returned ${result.probeId}; expected ${spec.id}.`,
      );
    }
    results.push(result);
    if (
      (result.status === "fail" || result.status === "blocked") &&
      spec.stopOnFailure
    )
      break;
  }
  return results;
}

function declaredCapabilitiesHash(
  evidence: readonly CapabilityEvidence[],
): string {
  return hashCanonical(
    evidence
      .filter(
        (item) => item.state === "declared" || item.state === "api_advertised",
      )
      .map((item) => ({
        capability: item.capability,
        state: item.state,
        provider: item.provider,
        model: item.model,
      }))
      .sort((a, b) =>
        `${a.capability}:${a.state}`.localeCompare(
          `${b.capability}:${b.state}`,
        ),
      ),
  );
}

/** Build a versioned qualification artifact from immutable profiles and probe evidence. */
export function createModelQualificationRecord(input: {
  modelProfileHash: string;
  providerProfileHash: string;
  protocol: ProtocolId;
  upstream?: string;
  harnessVersion: string;
  declaredEvidence: readonly CapabilityEvidence[];
  probes: readonly QualificationProbeResult[];
  qualificationId?: string;
  createdAt?: string;
}): ModelQualificationRecord {
  const probes = input.probes.map((probe) => ({
    ...probe,
    capabilityEvidence: probe.capabilityEvidence.map((evidence) => ({
      ...evidence,
    })),
  }));
  const hasBlocked = probes.some((probe) => probe.status === "blocked");
  const hasFailure = probes.some((probe) => probe.status === "fail");
  const hasInconclusive = probes.some(
    (probe) => probe.status === "inconclusive",
  );
  const overallStatus = hasBlocked
    ? "blocked"
    : hasFailure
      ? "failed"
      : hasInconclusive
        ? "partially_qualified"
        : probes.length > 0 && probes.every((probe) => probe.status === "pass")
          ? "qualified"
          : "partially_qualified";
  return {
    schemaVersion: 1,
    qualificationId: input.qualificationId ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    modelProfileHash: input.modelProfileHash,
    providerProfileHash: input.providerProfileHash,
    protocol: input.protocol,
    ...(input.upstream === undefined ? {} : { upstream: input.upstream }),
    harnessVersion: input.harnessVersion,
    probes,
    declaredCapabilitiesHash: declaredCapabilitiesHash(input.declaredEvidence),
    overallStatus,
  };
}

/** Return the identity hash used by campaign manifests and drift checks. */
export function qualificationRecordHash(
  record: ModelQualificationRecord,
): string {
  return hashCanonical(record);
}

/** A campaign may depend only on a current, successfully qualified record. */
export function assertQualificationUsable(
  record: ModelQualificationRecord,
  expected: {
    modelProfileHash: string;
    providerProfileHash: string;
    protocol: ProtocolId;
    upstream?: string;
  },
): void {
  if (record.overallStatus !== "qualified") {
    throw new Error(
      `Qualification ${record.qualificationId} is ${record.overallStatus}, not qualified.`,
    );
  }
  if (record.modelProfileHash !== expected.modelProfileHash)
    throw new Error("Qualification model profile is stale.");
  if (record.providerProfileHash !== expected.providerProfileHash)
    throw new Error("Qualification provider profile is stale.");
  if (record.protocol !== expected.protocol)
    throw new Error("Qualification protocol does not match.");
  if (
    expected.upstream !== undefined &&
    record.upstream !== expected.upstream
  ) {
    throw new Error(
      "Qualification upstream does not match the campaign treatment.",
    );
  }
}
