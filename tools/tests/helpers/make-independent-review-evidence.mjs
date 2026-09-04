// Test-only helper: produces a fully signed independent review receipt and
// supervisor-signed challenge ledger exactly as the production issuer and
// supervisor lanes would. Never used by the merge gate; exists so offline
// integration tests can exercise the CERTIFIED review tier end to end.
//
// Usage:
//   node make-independent-review-evidence.mjs <spec-json> <receipt-out> <ledger-out>
//
// Spec JSON: {
//   unsignedReceipt: <receipt object without signature; artifact_hash already set>,
//   reviewerPrivateKeyPem: <string>, reviewerKeyId: <string>,
//   supervisorPrivateKeyPem: <string>, supervisorKeyId: <string>,
//   challenge: { challenge_id, task_id, run_id, contract_hash, issued_at, expires_at }
// }
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function digestOf(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function signValue(value, privateKeyPem) {
  return sign(null, Buffer.from(JSON.stringify(canonicalize(value)), "utf8"), createPrivateKey(privateKeyPem)).toString("base64url");
}

const [specPath, receiptOut, ledgerOut] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const receipt = {
  ...spec.unsignedReceipt,
  signature: { algorithm: "ed25519", key_id: spec.reviewerKeyId, value: signValue(spec.unsignedReceipt, spec.reviewerPrivateKeyPem) },
};

const challenge = {
  challenge_id: spec.challenge.challenge_id,
  status: "CONSUMED",
  receipt_hash: digestOf(receipt),
  repository: receipt.repository,
  pr_number: receipt.pr_number,
  task_id: spec.challenge.task_id,
  run_id: spec.challenge.run_id,
  contract_hash: spec.challenge.contract_hash,
  base_sha: receipt.base_sha,
  head_sha: receipt.head_sha,
  builder_id: receipt.builder_id,
  reviewer_class: receipt.reviewer_class,
  issued_at: spec.challenge.issued_at,
  expires_at: spec.challenge.expires_at,
  authority_provenance: { issuer: "supervisor_review_lane", key_id: spec.supervisorKeyId },
};
challenge.supervisor_signature = { algorithm: "ed25519", key_id: spec.supervisorKeyId, value: signValue(challenge, spec.supervisorPrivateKeyPem) };

const challenges = [challenge];
const ledger = {
  schema_version: 1,
  kind: "independent_review_challenge_ledger_v1",
  challenges,
  state_hash: digestOf(challenges),
};

writeFileSync(receiptOut, JSON.stringify(receipt));
writeFileSync(ledgerOut, JSON.stringify(ledger));
process.stdout.write("REVIEW_EVIDENCE_SIGNED");
