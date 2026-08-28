import {
  createHash,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { canonicalJson, sha256Canonical } from "../acceptance/canonical.js";

export const INDEPENDENT_REVIEW_SCHEMA_VERSION = 2 as const;
export const REVIEW_CHALLENGE_TTL_MS = 15 * 60 * 1000;
export const REVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type IndependentReviewerClassV1 =
  | "independent_readonly"
  | "independent_breaker";
export type IndependentReviewModeV1 = "exact_head" | "exact_revision";
export type ReviewVerdictV1 = "APPROVE" | "BLOCK" | "UNKNOWN";

export interface ReviewChallengeV1 {
  challenge_id: string;
  task_id: string;
  run_id: string;
  contract_hash: string;
  base_sha: string;
  head_sha: string;
  builder_id: string;
  issued_at: string;
  expires_at: string;
}

export interface IndependentReviewReceiptV2 {
  schema_version: typeof INDEPENDENT_REVIEW_SCHEMA_VERSION;
  kind: "independent_review_receipt_v2";
  repository: string;
  pr_number?: number;
  task_id: string;
  run_id: string;
  contract_hash: string;
  base_sha: string;
  head_sha: string;
  reviewer_id: string;
  reviewer_class: IndependentReviewerClassV1;
  review_mode: IndependentReviewModeV1;
  reviewed_at: string;
  challenge_id: string;
  builder_id: string;
  reviewed_scope: { kind: "files"; paths: string[] } | { kind: "repository" };
  verdict: ReviewVerdictV1;
  blocking_findings: string[];
  authority_provenance: {
    issuer: "supervisor_review_lane";
    key_id: string;
    challenge_id: string;
  };
  signature: {
    algorithm: "ed25519";
    key_id: string;
    value: string;
  };
}

export interface ReviewValidationExpectationV1 {
  repository: string;
  pr_number?: number;
  task_id: string;
  run_id: string;
  contract_hash: string;
  base_sha: string;
  head_sha: string;
  builder_id: string;
  now?: number;
  maxAgeMs?: number;
}

function payload(
  receipt: IndependentReviewReceiptV2,
): Omit<IndependentReviewReceiptV2, "signature"> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function signingBytes(receipt: IndependentReviewReceiptV2): Buffer {
  return Buffer.from(canonicalJson(payload(receipt)), "utf8");
}

function challengeDigest(challenge: ReviewChallengeV1): string {
  return sha256Canonical(challenge);
}

function assertScope(
  scope: IndependentReviewReceiptV2["reviewed_scope"],
): void {
  if (scope.kind === "files") {
    if (scope.paths.length === 0)
      throw new Error("Independent review scope cannot be empty.");
    const normalized = scope.paths.map((entry) => entry.replaceAll("\\", "/"));
    if (new Set(normalized).size !== normalized.length)
      throw new Error("Independent review scope contains duplicates.");
    if (
      normalized.some(
        (entry) =>
          entry.startsWith("/") ||
          /^[A-Za-z]:/.test(entry) ||
          entry === ".." ||
          entry.startsWith("../"),
      )
    )
      throw new Error("Independent review scope contains an unsafe path.");
  }
}

function assertChallenge(
  challenge: ReviewChallengeV1,
  expected: ReviewValidationExpectationV1,
  now: number,
): void {
  for (const key of [
    "task_id",
    "run_id",
    "contract_hash",
    "base_sha",
    "head_sha",
    "builder_id",
  ] as const) {
    const expectedKey = key === "builder_id" ? "builder_id" : key;
    if (challenge[key] !== expected[expectedKey])
      throw new Error(`Review challenge ${key} mismatch.`);
  }
  if (Date.parse(challenge.expires_at) < now)
    throw new Error("Review challenge is expired.");
}

/** Create a supervisor-held challenge and signer for an independent reviewer lane. */
export function createIndependentReviewAuthorityV1(input: {
  key_id: string;
  private_key: KeyObject | string;
}): {
  issueChallenge(
    input: Omit<ReviewChallengeV1, "challenge_id">,
  ): ReviewChallengeV1;
  issueReceipt(input: {
    challenge: ReviewChallengeV1;
    reviewer_id: string;
    reviewer_class: IndependentReviewerClassV1;
    review_mode: IndependentReviewModeV1;
    reviewed_at?: string;
    reviewed_scope: IndependentReviewReceiptV2["reviewed_scope"];
    verdict: ReviewVerdictV1;
    blocking_findings?: string[];
    repository: string;
    pr_number?: number;
  }): IndependentReviewReceiptV2;
} {
  if (!input.key_id.trim())
    throw new Error("Review authority key_id is required.");
  const outstanding = new Map<string, ReviewChallengeV1>();
  return Object.freeze({
    issueChallenge(
      challengeInput: Omit<ReviewChallengeV1, "challenge_id">,
    ): ReviewChallengeV1 {
      const challenge: ReviewChallengeV1 = {
        ...challengeInput,
        challenge_id: `challenge:${randomBytes(16).toString("hex")}`,
      };
      outstanding.set(challengeDigest(challenge), challenge);
      return Object.freeze(challenge);
    },
    issueReceipt(receiptInput): IndependentReviewReceiptV2 {
      const challenge = outstanding.get(
        challengeDigest(receiptInput.challenge),
      );
      if (!challenge)
        throw new Error("Review challenge is unknown or already consumed.");
      outstanding.delete(challengeDigest(challenge));
      if (receiptInput.reviewer_id === challenge.builder_id)
        throw new Error("Reviewer must be independent from builder.");
      assertScope(receiptInput.reviewed_scope);
      const receipt: IndependentReviewReceiptV2 = {
        schema_version: INDEPENDENT_REVIEW_SCHEMA_VERSION,
        kind: "independent_review_receipt_v2",
        repository: receiptInput.repository,
        ...(receiptInput.pr_number !== undefined
          ? { pr_number: receiptInput.pr_number }
          : {}),
        task_id: challenge.task_id,
        run_id: challenge.run_id,
        contract_hash: challenge.contract_hash,
        base_sha: challenge.base_sha,
        head_sha: challenge.head_sha,
        reviewer_id: receiptInput.reviewer_id,
        reviewer_class: receiptInput.reviewer_class,
        review_mode: receiptInput.review_mode,
        reviewed_at: receiptInput.reviewed_at ?? new Date().toISOString(),
        challenge_id: challenge.challenge_id,
        builder_id: challenge.builder_id,
        reviewed_scope: receiptInput.reviewed_scope,
        verdict: receiptInput.verdict,
        blocking_findings: [...(receiptInput.blocking_findings ?? [])],
        authority_provenance: {
          issuer: "supervisor_review_lane",
          key_id: input.key_id,
          challenge_id: challenge.challenge_id,
        },
        signature: { algorithm: "ed25519", key_id: input.key_id, value: "" },
      };
      receipt.signature.value = sign(
        null,
        signingBytes(receipt),
        input.private_key,
      ).toString("base64url");
      return Object.freeze(receipt);
    },
  });
}

/** Verify signed independent-review provenance and all semantic bindings. */
export function validateIndependentReviewReceiptV1(
  receipt: unknown,
  publicKeys: ReadonlyMap<string, KeyObject | string>,
  expected: ReviewValidationExpectationV1,
): string[] {
  const errors: string[] = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    return ["receipt_shape"];
  const candidate = receipt as Partial<IndependentReviewReceiptV2>;
  if (candidate.schema_version !== INDEPENDENT_REVIEW_SCHEMA_VERSION)
    errors.push("schema_version");
  if (candidate.kind !== "independent_review_receipt_v2") errors.push("kind");
  for (const key of [
    "repository",
    "task_id",
    "run_id",
    "contract_hash",
    "base_sha",
    "head_sha",
    "builder_id",
    "challenge_id",
    "reviewed_at",
  ] as const) {
    const expectedValue =
      key === "repository"
        ? expected.repository
        : key === "builder_id"
          ? expected.builder_id
          : key === "task_id"
            ? expected.task_id
            : key === "run_id"
              ? expected.run_id
              : key === "contract_hash"
                ? expected.contract_hash
                : key === "base_sha"
                  ? expected.base_sha
                  : key === "head_sha"
                    ? expected.head_sha
                    : undefined;
    if (key === "reviewed_at" || key === "challenge_id") {
      if (typeof candidate[key] !== "string") errors.push(key);
    } else if (
      typeof candidate[key] !== "string" ||
      candidate[key] !== expectedValue
    )
      errors.push(key);
  }
  if (
    expected.pr_number !== undefined &&
    candidate.pr_number !== expected.pr_number
  )
    errors.push("pr_number");
  if (candidate.reviewer_id === expected.builder_id)
    errors.push("reviewer_not_independent");
  if (
    candidate.reviewer_class !== "independent_readonly" &&
    candidate.reviewer_class !== "independent_breaker"
  )
    errors.push("reviewer_class");
  if (
    candidate.review_mode !== "exact_head" &&
    candidate.review_mode !== "exact_revision"
  )
    errors.push("review_mode");
  const reviewedAt = Date.parse(candidate.reviewed_at ?? "");
  const now = expected.now ?? Date.now();
  if (
    !Number.isFinite(reviewedAt) ||
    reviewedAt > now + 5 * 60 * 1000 ||
    reviewedAt < now - (expected.maxAgeMs ?? REVIEW_MAX_AGE_MS)
  )
    errors.push("reviewed_at");
  if (!candidate.reviewed_scope) errors.push("reviewed_scope");
  else {
    try {
      assertScope(candidate.reviewed_scope);
    } catch {
      errors.push("reviewed_scope");
    }
  }
  if (
    !candidate.authority_provenance ||
    candidate.authority_provenance.issuer !== "supervisor_review_lane" ||
    candidate.authority_provenance.challenge_id !== candidate.challenge_id
  )
    errors.push("authority_provenance");
  const keyId = candidate.signature?.key_id;
  const key = typeof keyId === "string" ? publicKeys.get(keyId) : undefined;
  if (
    !key ||
    candidate.signature?.algorithm !== "ed25519" ||
    typeof candidate.signature?.value !== "string"
  )
    errors.push("signature");
  else if (
    !verify(
      null,
      signingBytes(candidate as IndependentReviewReceiptV2),
      key,
      Buffer.from(candidate.signature.value, "base64url"),
    )
  )
    errors.push("signature_invalid");
  if (candidate.authority_provenance?.key_id !== keyId)
    errors.push("authority_key_mismatch");
  if (
    candidate.verdict !== "APPROVE" &&
    candidate.verdict !== "BLOCK" &&
    candidate.verdict !== "UNKNOWN"
  )
    errors.push("verdict");
  if (
    candidate.verdict === "APPROVE" &&
    (candidate.blocking_findings?.length ?? 0) > 0
  )
    errors.push("approval_has_blocking_findings");
  return errors;
}

/** Stable fingerprint helper for an externally managed reviewer public key. */
export function reviewerKeyFingerprint(publicKey: KeyObject | string): string {
  const key =
    typeof publicKey === "string"
      ? publicKey
      : publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(key).digest("hex");
}
