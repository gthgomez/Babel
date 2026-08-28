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
  for (const key of Object.keys(value).sort())
    result[key] = canonicalize(value[key]);
  return result;
}

function parseArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

const receiptPath = parseArg("--receipt");
const keysPath = parseArg("--keys");
const ledgerPath = parseArg("--ledger");
if (!receiptPath || !keysPath || !ledgerPath) {
  console.log(
    JSON.stringify({
      valid: false,
      errors: ["receipt_key_registry_or_ledger_path_missing"],
    }),
  );
  process.exit(1);
}

const errors = [];
let receipt;
let registry;
let ledger;
try {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
} catch {
  errors.push("receipt_malformed");
}
try {
  registry = JSON.parse(readFileSync(keysPath, "utf8"));
} catch {
  errors.push("review_key_registry_malformed");
}
try {
  ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch {
  errors.push("review_challenge_ledger_malformed");
}
if (!receipt || !registry || !ledger) {
  console.log(JSON.stringify({ valid: false, errors }));
  process.exit(1);
}

if (
  ledger.schema_version !== 1 ||
  ledger.kind !== "independent_review_challenge_ledger_v1" ||
  !Array.isArray(ledger.challenges) ||
  typeof ledger.state_hash !== "string" ||
  ledger.state_hash !== digest(ledger.challenges)
)
  errors.push("review_challenge_ledger_integrity_invalid");

const challengeIds = new Set();
for (const record of ledger.challenges) {
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
    typeof record.authority_provenance?.key_id !== "string"
  ) {
    errors.push("review_challenge_ledger_schema_invalid");
    break;
  }
  challengeIds.add(record.challenge_id);
}

const challenge = ledger.challenges.find(
  (candidate) => candidate.challenge_id === receipt.challenge_id,
);
if (!challenge) errors.push("review_challenge_unknown");
else {
  if (challenge.status !== "CONSUMED")
    errors.push("review_challenge_not_consumed");
  if (challenge.receipt_hash !== digest(receipt))
    errors.push("review_receipt_not_bound_to_consumed_challenge");
  for (const field of [
    "repository",
    "pr_number",
    "task_id",
    "run_id",
    "contract_hash",
    "base_sha",
    "head_sha",
    "builder_id",
    "reviewer_class",
  ]) {
    if (challenge[field] !== receipt[field])
      errors.push(`review_challenge_${field}_mismatch`);
  }
  if (Date.parse(challenge.expires_at) <= Date.now())
    errors.push("review_challenge_expired");
  if (
    challenge.authority_provenance?.issuer !== "supervisor_review_lane" ||
    challenge.authority_provenance?.key_id !== receipt.signature?.key_id
  )
    errors.push("review_challenge_authority_invalid");
}

const keyId = receipt.signature?.key_id;
const pem =
  registry.schema_version === 1 &&
  registry.keys &&
  typeof registry.keys[keyId] === "string"
    ? registry.keys[keyId]
    : undefined;
if (!pem) errors.push("review_key_not_authorized");
if (receipt.signature?.algorithm !== "ed25519")
  errors.push("review_signature_algorithm_invalid");
if (typeof receipt.signature?.value !== "string")
  errors.push("review_signature_missing");
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
  } catch {
    errors.push("review_signature_invalid");
  }
}
console.log(JSON.stringify({ valid: errors.length === 0, errors }));
process.exit(errors.length === 0 ? 0 : 1);
