import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";

function canonicalize(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function parseArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value, allowed, required) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") &&
    !/^[A-Za-z]:/.test(normalized) &&
    normalized !== ".." &&
    !normalized.startsWith("../");
}

const receiptPath = parseArg("--receipt");
const keysPath = parseArg("--keys");
const ledgerPath = parseArg("--ledger");
const supervisorKeysPath = parseArg("--supervisor-keys");
if (!receiptPath || !keysPath || !ledgerPath || !supervisorKeysPath) {
  console.log(JSON.stringify({ valid: false, errors: ["receipt_key_registry_or_ledger_or_supervisor_registry_missing"] }));
  process.exit(1);
}

const errors = [];
let receipt;
let registry;
let ledger;
let supervisorRegistry;
try { receipt = JSON.parse(readFileSync(receiptPath, "utf8")); }
catch { errors.push("receipt_malformed"); }
try { registry = JSON.parse(readFileSync(keysPath, "utf8")); }
catch { errors.push("review_key_registry_malformed"); }
try { ledger = JSON.parse(readFileSync(ledgerPath, "utf8")); }
catch { errors.push("review_challenge_ledger_malformed"); }
try { supervisorRegistry = JSON.parse(readFileSync(supervisorKeysPath, "utf8")); }
catch { errors.push("supervisor_key_registry_malformed"); }
if (!receipt || !registry || !ledger || !supervisorRegistry) {
  console.log(JSON.stringify({ valid: false, errors }));
  process.exit(1);
}

const receiptFields = new Set([
  "schema_version", "kind", "repository", "pr_number", "task_id", "run_id",
  "contract_hash", "base_sha", "head_sha", "reviewer_id", "reviewer_class",
  "review_mode", "reviewed_at", "challenge_id", "builder_id", "reviewed_scope",
  "verdict", "blocking_findings", "authority_provenance", "signature",
]);
const receiptRequiredFields = [...receiptFields].filter((field) => field !== "pr_number");
if (!hasExactFields(receipt, receiptFields, receiptRequiredFields)) {
  errors.push("review_receipt_schema_invalid");
} else {
  if (receipt.schema_version !== 2) errors.push("review_receipt_schema_version_invalid");
  if (receipt.kind !== "independent_review_receipt_v2") errors.push("review_receipt_kind_invalid");
  for (const field of [
    "repository", "task_id", "run_id", "contract_hash", "base_sha", "head_sha",
    "reviewer_id", "reviewed_at", "challenge_id", "builder_id",
  ]) {
    if (typeof receipt[field] !== "string" || receipt[field].length === 0)
      errors.push(`review_receipt_${field}_invalid`);
  }
  if (receipt.pr_number !== undefined && (!Number.isInteger(receipt.pr_number) || receipt.pr_number < 1))
    errors.push("review_receipt_pr_number_invalid");
  if (!['independent_readonly', 'independent_breaker'].includes(receipt.reviewer_class))
    errors.push("review_receipt_reviewer_class_invalid");
  if (!['exact_head', 'exact_revision'].includes(receipt.review_mode))
    errors.push("review_receipt_review_mode_invalid");
  if (!['APPROVE', 'BLOCK', 'UNKNOWN'].includes(receipt.verdict))
    errors.push("review_receipt_verdict_invalid");
  if (receipt.reviewer_id === receipt.builder_id)
    errors.push("review_receipt_reviewer_not_independent");
  const reviewedAt = Date.parse(receipt.reviewed_at);
  const now = Date.now();
  if (!Number.isFinite(reviewedAt) || reviewedAt > now + 5 * 60 * 1000 || reviewedAt < now - 24 * 60 * 60 * 1000)
    errors.push("review_receipt_reviewed_at_invalid");
  if (!Array.isArray(receipt.blocking_findings) || receipt.blocking_findings.some((finding) => typeof finding !== "string"))
    errors.push("review_receipt_blocking_findings_invalid");
  else if (receipt.verdict === "APPROVE" && receipt.blocking_findings.length > 0)
    errors.push("review_receipt_approval_has_blocking_findings");

  const scope = receipt.reviewed_scope;
  if (!isRecord(scope) || !['files', 'repository'].includes(scope.kind)) {
    errors.push("review_receipt_scope_invalid");
  } else if (scope.kind === "repository") {
    if (!hasExactFields(scope, new Set(["kind"]), ["kind"]))
      errors.push("review_receipt_scope_invalid");
  } else {
    if (!hasExactFields(scope, new Set(["kind", "paths"]), ["kind", "paths"]) ||
        !Array.isArray(scope.paths) || scope.paths.length === 0 ||
        scope.paths.some((entry) => !isSafeRelativePath(entry))) {
      errors.push("review_receipt_scope_invalid");
    } else {
      const normalized = scope.paths.map((entry) => entry.replaceAll("\\", "/"));
      if (new Set(normalized).size !== normalized.length)
        errors.push("review_receipt_scope_duplicate_path");
    }
  }

  const authorityFields = new Set(["issuer", "key_id", "challenge_id"]);
  if (!hasExactFields(receipt.authority_provenance, authorityFields, [...authorityFields]) ||
      receipt.authority_provenance.issuer !== "supervisor_review_lane" ||
      typeof receipt.authority_provenance.key_id !== "string" ||
      receipt.authority_provenance.key_id.length === 0 ||
      receipt.authority_provenance.challenge_id !== receipt.challenge_id) {
    errors.push("review_receipt_authority_provenance_invalid");
  }
  const signatureFields = new Set(["algorithm", "key_id", "value"]);
  if (!hasExactFields(receipt.signature, signatureFields, [...signatureFields]) ||
      receipt.signature.algorithm !== "ed25519" ||
      typeof receipt.signature.key_id !== "string" || receipt.signature.key_id.length === 0 ||
      typeof receipt.signature.value !== "string" || receipt.signature.value.length === 0) {
    errors.push("review_receipt_signature_shape_invalid");
  }
}

if (
  ledger.schema_version !== 1 ||
  ledger.kind !== "independent_review_challenge_ledger_v1" ||
  !Array.isArray(ledger.challenges) ||
  typeof ledger.state_hash !== "string" ||
  ledger.state_hash !== digest(ledger.challenges)
)
  errors.push("review_challenge_ledger_integrity_invalid");

const challenges = Array.isArray(ledger.challenges) ? ledger.challenges : [];
const challengeIds = new Set();
for (const record of challenges) {
  if (
    !record ||
    typeof record.challenge_id !== "string" ||
    challengeIds.has(record.challenge_id) ||
    !["ISSUED", "CONSUMED", "EXPIRED", "REVOKED"].includes(record.status) ||
    !["independent_readonly", "independent_breaker"].includes(record.reviewer_class) ||
    Number.isNaN(Date.parse(record.issued_at)) ||
    Number.isNaN(Date.parse(record.expires_at)) ||
    Date.parse(record.expires_at) <= Date.parse(record.issued_at) ||
    record.authority_provenance?.issuer !== "supervisor_review_lane" ||
    typeof record.authority_provenance?.key_id !== "string" ||
    record.supervisor_signature?.algorithm !== "ed25519" ||
    typeof record.supervisor_signature?.key_id !== "string" ||
    typeof record.supervisor_signature?.value !== "string"
  ) {
    errors.push("review_challenge_ledger_schema_invalid");
    break;
  }
  challengeIds.add(record.challenge_id);
  const { supervisor_signature: _supervisorSignature, ...unsignedRecord } = record;
  const supervisorPem = supervisorRegistry.schema_version === 1 && supervisorRegistry.keys && typeof supervisorRegistry.keys[record.supervisor_signature.key_id] === "string"
    ? supervisorRegistry.keys[record.supervisor_signature.key_id] : undefined;
  if (!supervisorPem || record.authority_provenance.key_id !== record.supervisor_signature.key_id) {
    errors.push("review_challenge_supervisor_key_not_authorized");
  } else {
    try {
      const valid = verify(null, Buffer.from(JSON.stringify(canonicalize(unsignedRecord)), "utf8"), createPublicKey(supervisorPem), Buffer.from(record.supervisor_signature.value, "base64url"));
      if (!valid) errors.push("review_challenge_supervisor_signature_invalid");
    } catch { errors.push("review_challenge_supervisor_signature_invalid"); }
  }
}

const challenge = challenges.find(
  (candidate) => candidate.challenge_id === receipt.challenge_id,
);
if (!challenge) errors.push("review_challenge_unknown");
else {
  if (challenge.status !== "CONSUMED") errors.push("review_challenge_not_consumed");
  if (challenge.receipt_hash !== digest(receipt)) errors.push("review_receipt_not_bound_to_consumed_challenge");
  for (const field of [
    "repository", "pr_number", "task_id", "run_id", "contract_hash",
    "base_sha", "head_sha", "builder_id", "reviewer_class",
  ]) {
    if (challenge[field] !== receipt[field]) errors.push(`review_challenge_${field}_mismatch`);
  }
  if (Date.parse(challenge.expires_at) <= Date.now()) errors.push("review_challenge_expired");
  if (
    challenge.authority_provenance?.issuer !== "supervisor_review_lane" ||
    challenge.authority_provenance?.key_id !== challenge.supervisor_signature?.key_id ||
    receipt.authority_provenance?.key_id !== challenge.supervisor_signature?.key_id
  ) errors.push("review_challenge_authority_invalid");
}

const keyId = receipt.signature?.key_id;
const pem =
  registry.schema_version === 1 && registry.keys && typeof registry.keys[keyId] === "string"
    ? registry.keys[keyId]
    : undefined;
if (!pem) errors.push("review_key_not_authorized");
if (receipt.signature?.algorithm !== "ed25519") errors.push("review_signature_algorithm_invalid");
if (typeof receipt.signature?.value !== "string") errors.push("review_signature_missing");
if (!errors.length) {
  const { signature: _signature, ...unsigned } = receipt;
  try {
    const valid = verify(
      null,
      Buffer.from(JSON.stringify(canonicalize(unsigned)), "utf8"),
      createPublicKey(pem),
      Buffer.from(receipt.signature.value, "base64url"),
    );
    if (!valid) errors.push("review_signature_invalid");
  } catch { errors.push("review_signature_invalid"); }
}
console.log(JSON.stringify({ valid: errors.length === 0, errors }));
process.exit(errors.length === 0 ? 0 : 1);
