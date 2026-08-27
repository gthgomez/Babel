import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { canonicalJson, sha256Canonical } from "../acceptance/canonical.js";
import type { CompletionStatusV1 } from "../evidence/evidenceGraph.js";
import { redactSecrets } from "../utils/redaction.js";
import {
  FAILURE_CATEGORIES,
  type FailureCategoryV1,
} from "./failureAttribution.js";

export const REPLAY_MANIFEST_VERSION = 1 as const;
export const REPLAY_MANIFEST_MAX_BYTES = 64 * 1024;

export interface ReplayManifestV1 {
  schema_version: typeof REPLAY_MANIFEST_VERSION;
  manifest_id: string;
  task_id: string;
  contract_hash: string;
  repository: string;
  base_sha: string | null;
  candidate_sha: string | null;
  model: string | null;
  harness: string | null;
  tool_profile: string | null;
  feature_flags: Record<string, boolean | number | string | null>;
  verification_commands: string[];
  verification_result: CompletionStatusV1 | null;
  failure_classification: FailureCategoryV1 | null;
  environment: Record<string, string | number | boolean | null>;
  created_at: string;
  manifest_hash: string;
}

const scalar = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const manifestSchema = z
  .object({
    schema_version: z.literal(REPLAY_MANIFEST_VERSION),
    manifest_id: z.string().min(1),
    task_id: z.string().min(1),
    contract_hash: z.string().regex(/^[0-9a-f]{32,64}$/),
    repository: z.string().min(1),
    base_sha: z.string().nullable(),
    candidate_sha: z.string().nullable(),
    model: z.string().nullable(),
    harness: z.string().nullable(),
    tool_profile: z.string().nullable(),
    feature_flags: z.record(z.string(), scalar),
    verification_commands: z.array(z.string()),
    verification_result: z
      .enum(["UNVERIFIED", "PARTIAL", "FAILED", "VERIFIED", "UNKNOWN"])
      .nullable(),
    failure_classification: z
      .enum(FAILURE_CATEGORIES as unknown as [string, ...string[]])
      .nullable(),
    environment: z.record(z.string(), scalar),
    created_at: z.string().datetime(),
    manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const SECRET_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE =
  /(?:^|\b)(?:sk|rk)-[A-Za-z0-9_-]{12,}|(?:bearer\s+)[A-Za-z0-9._-]{12,}/i;

function redactScalar(
  key: string,
  value: unknown,
): string | number | boolean | null {
  if (
    SECRET_KEY.test(key) ||
    (typeof value === "string" && SECRET_VALUE.test(value))
  )
    return "[REDACTED]";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  return "[UNSUPPORTED]";
}

function stableManifestBody(
  manifest: ReplayManifestV1,
): Omit<ReplayManifestV1, "manifest_id" | "manifest_hash"> {
  const { manifest_id: _id, manifest_hash: _hash, ...body } = manifest;
  return body;
}

export function buildReplayManifestV1(input: {
  task_id: string;
  contract_hash: string;
  repository: string;
  base_sha?: string | null;
  candidate_sha?: string | null;
  model?: string | null;
  harness?: string | null;
  tool_profile?: string | null;
  feature_flags?: Record<string, boolean | number | string | null>;
  verification_commands?: string[];
  verification_result?: CompletionStatusV1 | null;
  failure_classification?: FailureCategoryV1 | null;
  environment?: Record<string, unknown>;
  created_at?: string;
}): ReplayManifestV1 {
  const environment: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input.environment ?? {}))
    environment[key] = redactScalar(key, value);
  const featureFlags: Record<string, boolean | number | string | null> = {};
  for (const [key, value] of Object.entries(input.feature_flags ?? {}))
    featureFlags[key] = redactScalar(key, value);
  const base = {
    schema_version: REPLAY_MANIFEST_VERSION,
    task_id: input.task_id,
    contract_hash: input.contract_hash,
    repository: input.repository,
    base_sha: input.base_sha ?? null,
    candidate_sha: input.candidate_sha ?? null,
    model: input.model ?? null,
    harness: input.harness ?? null,
    tool_profile: input.tool_profile ?? null,
    feature_flags: featureFlags,
    verification_commands: [...(input.verification_commands ?? [])].map(
      (command) => redactSecrets(command),
    ),
    verification_result: input.verification_result ?? null,
    failure_classification: input.failure_classification ?? null,
    environment,
    created_at: input.created_at ?? new Date().toISOString(),
  };
  const manifestHash = sha256Canonical(base);
  return {
    ...base,
    manifest_id: `rm1:${manifestHash.slice(0, 16)}`,
    manifest_hash: manifestHash,
  };
}

export type ReplayManifestParseResult =
  | { ok: true; manifest: ReplayManifestV1 }
  | { ok: false; error: string };

export function parseReplayManifestV1(
  value: unknown,
): ReplayManifestParseResult {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues
        .map((issue) => issue.path.join(".") || "$")
        .join(", "),
    };
  const manifest = parsed.data as ReplayManifestV1;
  const errors: string[] = [];
  if (
    manifest.verification_commands.some(
      (command) => redactSecrets(command) !== command,
    )
  )
    errors.push("durable_secret");
  if (sha256Canonical(stableManifestBody(manifest)) !== manifest.manifest_hash)
    errors.push("manifest_hash");
  if (
    !manifest.manifest_id.startsWith(
      `rm1:${manifest.manifest_hash.slice(0, 16)}`,
    )
  )
    errors.push("manifest_id");
  if (errors.length > 0) return { ok: false, error: errors.join(", ") };
  return { ok: true, manifest };
}

export function serializeReplayManifestV1(manifest: ReplayManifestV1): string {
  const parsed = parseReplayManifestV1(manifest);
  if (!parsed.ok) throw new Error(`Invalid replay manifest: ${parsed.error}`);
  const serialized = `${canonicalJson(manifest)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > REPLAY_MANIFEST_MAX_BYTES)
    throw new Error("Replay manifest exceeds size limit.");
  return serialized;
}

export function writeReplayManifestV1(
  path: string,
  manifest: ReplayManifestV1,
): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporaryPath, serializeReplayManifestV1(manifest), "utf8");
    renameSync(temporaryPath, path);
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      /* original error wins */
    }
  }
}

export function loadReplayManifestV1(path: string): ReplayManifestParseResult {
  try {
    return parseReplayManifestV1(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
