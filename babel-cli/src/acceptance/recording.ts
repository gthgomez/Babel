import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AcceptanceInputSnapshotV0,
  AcceptanceSystemHealthV0,
  ClaimEvidenceLinkV0,
  ExecutableAcceptanceContractV0,
  OraclePlanV0,
  SufficiencyResultV0,
} from "./types.js";
import type { TaskContractV1 } from "../agent/taskContract.js";
import { buildAcceptanceInputSnapshot } from "./artifacts.js";
import { compileAcceptance } from "./compiler.js";
import { planOracles } from "./oraclePlanner.js";
import { evaluateSufficiency } from "./sufficiency.js";
import { validateClaimEvidenceLinkV0 } from "./validation.js";

export const ACCEPTANCE_RECORDING_ENV = "BABEL_ACCEPTANCE_V0" as const;
export const ACCEPTANCE_RECORDING_ENV_ALIAS =
  "BABEL_EXECUTABLE_ACCEPTANCE" as const;
export const ACCEPTANCE_ARTIFACT_DIRECTORY = "acceptance-v0" as const;
export const MAX_ACCEPTANCE_ARTIFACT_BYTES = 64 * 1024;

export interface AcceptanceRecordingBundleV0 {
  snapshot: AcceptanceInputSnapshotV0;
  contract: ExecutableAcceptanceContractV0;
  oraclePlan: OraclePlanV0;
  evidenceLinks: readonly ClaimEvidenceLinkV0[];
  sufficiency: SufficiencyResultV0;
}

export interface AcceptanceRecordingResultV0 {
  enabled: boolean;
  directory?: string;
  files: string[];
  bytes: number;
  error?: string;
}

export interface FinalizeAcceptanceRecordingInputV0 {
  bundle: AcceptanceRecordingBundleV0;
  evidenceLinks: readonly ClaimEvidenceLinkV0[];
  systemHealth?: Partial<AcceptanceSystemHealthV0>;
}

export interface PrepareAcceptanceRecordingInputV0 {
  taskContract: TaskContractV1;
  userRequest?: string;
  baselineGitHead?: string;
  baselineVerifiers?: Array<{
    command: string;
    exitCode: number;
    digest?: string;
  }>;
  createdAt?: string;
}

export function isAcceptanceRecordingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw =
    env[ACCEPTANCE_RECORDING_ENV] ?? env[ACCEPTANCE_RECORDING_ENV_ALIAS];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/** Prepare all acceptance artifacts before implementation begins. */
export function prepareAcceptanceRecording(
  input: PrepareAcceptanceRecordingInputV0,
): AcceptanceRecordingBundleV0 {
  const taskContract = input.taskContract;
  const baselineVerifiers =
    input.baselineVerifiers ??
    (taskContract.baseline_verifier_state?.command
      ? [
          {
            command: taskContract.baseline_verifier_state.command,
            exitCode: taskContract.baseline_verifier_state.exit_code ?? 1,
          },
        ]
      : taskContract.verifier_requirements.map((command) => ({
          command,
          exitCode: 1,
        })));
  const snapshot = buildAcceptanceInputSnapshot({
    taskContract,
    ...(input.userRequest ? { userRequest: input.userRequest } : {}),
    ...(input.baselineGitHead
      ? { baseline: { gitHead: input.baselineGitHead } }
      : {}),
    baselineVerifiers,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
  const contract = compileAcceptance(snapshot);
  const oraclePlan = planOracles(contract, {
    // A verifier command is not semantically bound to every claim merely
    // because it appears in the baseline. Explicit bindings belong to a
    // preregistered experiment input; recording stays conservative.
    baselineVerifiers,
    createdAt: snapshot.createdAt,
  });
  const sufficiency = evaluateSufficiency(contract, []);
  return { snapshot, contract, oraclePlan, evidenceLinks: [], sufficiency };
}

/**
 * Attach already-admitted evidence after a run without re-planning or
 * changing the frozen snapshot, contract, or OraclePlan.
 */
export function finalizeAcceptanceRecording(
  input: FinalizeAcceptanceRecordingInputV0,
): AcceptanceRecordingBundleV0 {
  const errors = input.evidenceLinks.flatMap((link) =>
    validateClaimEvidenceLinkV0(link),
  );
  if (errors.length > 0)
    throw new Error(`invalid acceptance evidence links: ${errors.join(", ")}`);
  const evidenceLinks = [...input.evidenceLinks];
  const sufficiency = evaluateSufficiency({
    contract: input.bundle.contract,
    links: evidenceLinks,
    ...(input.systemHealth ? { systemHealth: input.systemHealth } : {}),
  });
  return Object.freeze({
    ...input.bundle,
    evidenceLinks: Object.freeze(evidenceLinks),
    sufficiency,
  });
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(
      /\b(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "[REDACTED_SECRET]",
    )
    .slice(0, 8_000);
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|[_ -])(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie|credential|password|private[_ -]?key|secret|token)(?:$|[_ -])/i.test(
    key,
  );
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (depth > 8) return "[REDACTED_DEPTH_LIMIT]";
  if (Array.isArray(value))
    return value.slice(0, 256).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSensitiveKey(key)
        ? "[REDACTED_SECRET]"
        : redactValue(child, depth + 1);
    }
    return result;
  }
  return "[REDACTED_UNSUPPORTED_VALUE]";
}

function boundedJson(value: unknown): string {
  const text = `${JSON.stringify(redactValue(value), null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_ACCEPTANCE_ARTIFACT_BYTES) {
    throw new Error(
      `acceptance artifact exceeds ${MAX_ACCEPTANCE_ARTIFACT_BYTES} bytes`,
    );
  }
  return text;
}

/**
 * Persist acceptance artifacts next to a run only when explicitly enabled.
 * The write is bounded and fail-soft; it never alters completion state.
 */
export function recordAcceptanceArtifacts(
  runDir: string,
  bundle: AcceptanceRecordingBundleV0,
  env: NodeJS.ProcessEnv = process.env,
): AcceptanceRecordingResultV0 {
  if (!isAcceptanceRecordingEnabled(env))
    return { enabled: false, files: [], bytes: 0 };
  const directory = join(runDir, ACCEPTANCE_ARTIFACT_DIRECTORY);
  const artifacts: Array<[string, unknown]> = [
    ["acceptance_input_snapshot.json", bundle.snapshot],
    ["executable_acceptance_contract.json", bundle.contract],
    ["oracle_plan.json", bundle.oraclePlan],
    ["claim_evidence_links.json", bundle.evidenceLinks],
    ["sufficiency_result.json", bundle.sufficiency],
  ];
  try {
    mkdirSync(directory, { recursive: true });
    const files: string[] = [];
    let bytes = 0;
    for (const [name, value] of artifacts) {
      const text = boundedJson(value);
      writeFileSync(join(directory, name), text, "utf8");
      files.push(name);
      bytes += Buffer.byteLength(text, "utf8");
    }
    const manifest = boundedJson({
      schemaVersion: 0,
      kind: "babel_acceptance_v0_recording",
      redacted: true,
      boundedBytesPerArtifact: MAX_ACCEPTANCE_ARTIFACT_BYTES,
      files,
    });
    writeFileSync(join(directory, "manifest.json"), manifest, "utf8");
    files.push("manifest.json");
    bytes += Buffer.byteLength(manifest, "utf8");
    return { enabled: true, directory, files, bytes };
  } catch (error: unknown) {
    return {
      enabled: true,
      directory,
      files: [],
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read only the bounded acceptance bundle for inspect/diagnose integrations. */
export function readAcceptanceArtifacts(
  runDir: string,
): Record<string, unknown> | null {
  const directory = join(runDir, ACCEPTANCE_ARTIFACT_DIRECTORY);
  if (!existsSync(directory)) return null;
  const output: Record<string, unknown> = {};
  for (const name of [
    "manifest.json",
    "acceptance_input_snapshot.json",
    "executable_acceptance_contract.json",
    "oracle_plan.json",
    "claim_evidence_links.json",
    "sufficiency_result.json",
  ]) {
    const file = join(directory, name);
    if (!existsSync(file)) continue;
    try {
      output[name] = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      output[name] = { error: "invalid_json" };
    }
  }
  return output;
}
