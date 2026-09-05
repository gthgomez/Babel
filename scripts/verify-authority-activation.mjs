#!/usr/bin/env node
// Base-rooted authority activation (proof-of-possession) verifier.
//
// Invariant: a committed public key is not proof that a usable private
// authority exists. Before any reviewer/supervisor public key may be treated
// as an activated authority, the holder of the proposed PRIVATE key must sign
// a structured activation challenge; this verifier validates that proof
// against the proposed public key. The private key is never exposed to the
// repository: the holder signs out of band and submits only the signed proof.
//
// The signature is always over the canonical JSON of the embedded challenge
// document (purpose=authority_activation). Arbitrary bytes can never be
// signed into an activation proof: every binding field is exact.
//
// Challenge binding (all exact field comparisons):
//   repository, role, key_id, challenge_id, nonce, issued_at, expires_at,
//   purpose = "authority_activation".
//
// Replay prevention: a consumed-challenges ledger (a JSON object with a
// "challenge_ids" array, or a bare JSON array) may be supplied; a challenge_id
// already present is rejected. Operators append accepted challenge_ids to the
// ledger after each successful activation.
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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function parseArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptionalJson(path, errorCode, errors) {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    errors.push(errorCode);
    return undefined;
  }
}

const proofPath = parseArg("--proof");
const publicKeyPath = parseArg("--public-key");
const expectedRepository = parseArg("--expected-repository");
const expectedRole = parseArg("--expected-role");
const expectedKeyId = parseArg("--expected-key-id");
const consumedPath = parseArg("--consumed-challenges");
const nowArg = parseArg("--now");

const errors = [];
if (!proofPath || !publicKeyPath || !expectedRepository || !expectedRole || !expectedKeyId) {
  console.log(
    JSON.stringify({
      valid: false,
      errors: ["authority_activation_arguments_missing"],
      required_arguments: [
        "--proof",
        "--public-key",
        "--expected-repository",
        "--expected-role",
        "--expected-key-id",
      ],
    }),
  );
  process.exit(1);
}

let proof;
let publicPem;
let consumedLedger;
try { proof = JSON.parse(readFileSync(proofPath, "utf8")); }
catch { errors.push("authority_activation_proof_malformed"); }
try { publicPem = readFileSync(publicKeyPath, "utf8"); }
catch { errors.push("authority_activation_public_key_unreadable"); }
consumedLedger = readOptionalJson(consumedPath, "authority_activation_consumed_ledger_malformed", errors);

if (!proof || !publicPem) {
  console.log(JSON.stringify({ valid: false, errors }));
  process.exit(1);
}

const ALLOWED_ROLES = ["reviewer", "supervisor"];
const challenge = proof.challenge;
if (!challenge || typeof challenge !== "object" || Array.isArray(challenge)) {
  errors.push("authority_activation_challenge_missing");
} else {
  if (challenge.schema_version !== 1) errors.push("authority_activation_schema_version_invalid");
  if (challenge.kind !== "authority_activation_challenge_v1") errors.push("authority_activation_kind_invalid");
  if (challenge.purpose !== "authority_activation") errors.push("authority_activation_purpose_invalid");
  if (challenge.repository !== expectedRepository) errors.push("authority_activation_repository_mismatch");
  if (!ALLOWED_ROLES.includes(challenge.role)) errors.push("authority_activation_role_invalid");
  else if (challenge.role !== expectedRole) errors.push("authority_activation_role_mismatch");
  if (typeof challenge.key_id !== "string" || challenge.key_id.length === 0) {
    errors.push("authority_activation_key_id_missing");
  } else if (challenge.key_id !== expectedKeyId) {
    errors.push("authority_activation_key_id_mismatch");
  }
  if (typeof challenge.challenge_id !== "string" || challenge.challenge_id.length < 8) {
    errors.push("authority_activation_challenge_id_invalid");
  }
  if (typeof challenge.nonce !== "string" || !/^[0-9a-f]{64}$/.test(challenge.nonce)) {
    errors.push("authority_activation_nonce_invalid");
  }
  const issuedAt = Date.parse(challenge.issued_at ?? "");
  const expiresAt = Date.parse(challenge.expires_at ?? "");
  const now = Number.isNaN(Date.parse(nowArg ?? "")) ? Date.now() : Date.parse(nowArg);
  if (Number.isNaN(issuedAt)) errors.push("authority_activation_issued_at_invalid");
  if (Number.isNaN(expiresAt)) errors.push("authority_activation_expires_at_invalid");
  if (!Number.isNaN(issuedAt) && !Number.isNaN(expiresAt) && expiresAt <= issuedAt) {
    errors.push("authority_activation_expiry_precedes_issue");
  }
  if (!Number.isNaN(expiresAt) && expiresAt <= now) errors.push("authority_activation_challenge_expired");
  if (!Number.isNaN(issuedAt) && issuedAt > now + 5 * 60 * 1000) errors.push("authority_activation_issued_in_future");
}

if (proof.signature?.algorithm !== "ed25519") errors.push("authority_activation_signature_algorithm_invalid");
if (typeof proof.signature?.key_id !== "string") errors.push("authority_activation_signature_key_id_missing");
else if (challenge && proof.signature.key_id !== challenge.key_id) {
  errors.push("authority_activation_signature_key_id_mismatch");
}
if (typeof proof.signature?.value !== "string") errors.push("authority_activation_signature_missing");

// Replay detection: the consumed ledger lists challenge_ids already used for a
// successful activation; a repeated challenge can never re-activate.
if (consumedLedger !== undefined && challenge?.challenge_id !== undefined) {
  const consumedIds = Array.isArray(consumedLedger)
    ? consumedLedger
    : consumedLedger?.challenge_ids;
  if (Array.isArray(consumedIds) && consumedIds.includes(challenge.challenge_id)) {
    errors.push("authority_activation_challenge_replayed");
  }
}

let fingerprint = null;
if (!errors.length) {
  try {
    const publicKey = createPublicKey(publicPem);
    fingerprint = createHash("sha256").update(publicPem, "utf8").digest("hex");
    // The signature covers the canonical challenge document itself — not a
    // wrapper, not arbitrary bytes — so the signed statement is exactly the
    // bound activation challenge.
    const message = Buffer.from(canonicalJson(proof.challenge), "utf8");
    const signature = Buffer.from(proof.signature.value, "base64url");
    const valid = verify(null, message, publicKey, signature);
    if (!valid) errors.push("authority_activation_signature_invalid");
  } catch {
    errors.push("authority_activation_signature_invalid");
  }
}

console.log(
  JSON.stringify({
    valid: errors.length === 0,
    errors,
    key_id: challenge?.key_id ?? null,
    challenge_id: challenge?.challenge_id ?? null,
    public_key_fingerprint: fingerprint,
  }),
);
process.exit(errors.length === 0 ? 0 : 1);
