import { randomUUID } from "node:crypto";
import type {
  AcceptanceClaimV0,
  AcceptanceInputSnapshotV0,
  ClaimEvidenceLinkV0,
  ExecutableAcceptanceContractV0,
  OraclePlanV0,
} from "./types.js";
import { omitKeys, sha256Canonical } from "./canonical.js";

export const ACCEPTANCE_ID_PREFIXES = {
  snapshot: "as0:",
  claim: "ac0:",
  contract: "eac0:",
  plan: "op0:",
  link: "cel0:",
} as const;

export function contentHashSnapshot(
  value: AcceptanceInputSnapshotV0 | Record<string, unknown>,
): string {
  return sha256Canonical(
    omitKeys(value as Record<string, unknown>, ["snapshotId", "snapshotHash"]),
  );
}

export function contentHashClaim(
  value: AcceptanceClaimV0 | Record<string, unknown>,
): string {
  return sha256Canonical(
    omitKeys(value as Record<string, unknown>, ["claimId"]),
  );
}

export function contentHashContract(
  value: ExecutableAcceptanceContractV0 | Record<string, unknown>,
): string {
  return sha256Canonical(
    omitKeys(value as Record<string, unknown>, [
      "contractId",
      "contractHash",
      "frozen",
    ]),
  );
}

export function contentHashOraclePlan(
  value: OraclePlanV0 | Record<string, unknown>,
): string {
  return sha256Canonical(
    omitKeys(value as Record<string, unknown>, [
      "planId",
      "planHash",
      "frozen",
    ]),
  );
}

export function contentHashEvidenceLink(
  value: ClaimEvidenceLinkV0 | Record<string, unknown>,
): string {
  return sha256Canonical(
    omitKeys(value as Record<string, unknown>, ["linkId"]),
  );
}

export function makeIdentity(
  prefix: string,
  hash: string,
  suffix = randomUUID().slice(0, 8),
): string {
  return `${prefix}${hash.slice(0, 16)}:${suffix}`;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function hasIdentityPrefix(
  value: unknown,
  prefix: string,
  hash: string,
): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(`${prefix}${hash.slice(0, 16)}:`) &&
    value.length > prefix.length + 17
  );
}
