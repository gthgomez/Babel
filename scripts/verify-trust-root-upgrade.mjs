// Base-rooted TrustRootUpgradeV1 authorization verifier.
//
// This script is executed from the immutable base commit by the merge gate.
// It authenticates a supervisor-signed trust-root upgrade authorization
// against the supervisor key registry carried by the base. It never receives
// candidate code, and it never derives authority from branch names, mutable
// refs, or prose claims: every binding is an exact field comparison plus an
// Ed25519 signature over the canonical unsigned payload.
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

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Canonical protected-path ordering: ordinal bytewise UTF-8 (see
// tools/tests/fixtures/canonical-ordering-vectors.json). Never the default
// Array.sort: its UTF-16 code-unit ordering mis-orders astral characters
// against U+E000..U+FFFF.
const pathEncoder = new TextEncoder();
function compareUtf8(left, right) {
  const leftBytes = pathEncoder.encode(left);
  const rightBytes = pathEncoder.encode(right);
  const shared = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < shared; index++) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] < rightBytes[index] ? -1 : 1;
  }
  if (leftBytes.length === rightBytes.length) return 0;
  return leftBytes.length < rightBytes.length ? -1 : 1;
}

function parseArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const authorizationPath = parseArg("--authorization");
const supervisorKeysPath = parseArg("--supervisor-keys");
const expected = {
  repository: parseArg("--repository"),
  pr_number: Number.parseInt(parseArg("--pr") ?? "", 10),
  base_sha: parseArg("--base-sha"),
  head_sha: parseArg("--head-sha"),
  protected_paths: JSON.parse(readFileSync(parseArg("--protected-paths-json"), "utf8")),
  protected_diff_digest: parseArg("--protected-diff-digest"),
  now_iso: parseArg("--now"),
};

const errors = [];
if (!authorizationPath || !supervisorKeysPath) {
  console.log(JSON.stringify({ valid: false, errors: ["authorization_or_supervisor_registry_missing"] }));
  process.exit(1);
}

let authorization;
let supervisorRegistry;
try { authorization = JSON.parse(readFileSync(authorizationPath, "utf8")); }
catch { errors.push("authorization_malformed"); }
try { supervisorRegistry = JSON.parse(readFileSync(supervisorKeysPath, "utf8")); }
catch { errors.push("supervisor_key_registry_malformed"); }
if (!authorization || !supervisorRegistry) {
  console.log(JSON.stringify({ valid: false, errors }));
  process.exit(1);
}

if (supervisorRegistry.schema_version !== 1 || !supervisorRegistry.keys || typeof supervisorRegistry.keys !== "object") {
  errors.push("supervisor_key_registry_schema_invalid");
}

const exactFields = {
  schema_version: { expected: 1, code: "authorization_schema_version_invalid" },
  kind: { expected: "trust_root_upgrade_authorization_v1", code: "authorization_kind_invalid" },
  intent: { expected: "trust_root_upgrade", code: "authorization_intent_invalid" },
  decision: { expected: "AUTHORIZE_TRUST_ROOT_UPGRADE", code: "authorization_decision_invalid" },
};
for (const [field, requirement] of Object.entries(exactFields)) {
  if (authorization[field] !== requirement.expected) errors.push(requirement.code);
}

if (typeof expected.repository === "string" && authorization.repository !== expected.repository) {
  errors.push("authorization_repository_mismatch");
}
if (Number.isInteger(expected.pr_number) && authorization.pr_number !== expected.pr_number) {
  errors.push("authorization_pr_mismatch");
}
const shaPattern = /^[0-9a-f]{40}$/;
for (const [field, value] of [["base_sha", expected.base_sha], ["head_sha", expected.head_sha]]) {
  if (typeof value === "string" && shaPattern.test(value) && authorization[field] !== value) {
    errors.push(`authorization_${field}_mismatch`);
  }
}
if (
  !Array.isArray(authorization.protected_paths) ||
  authorization.protected_paths.length === 0 ||
  JSON.stringify([...authorization.protected_paths].sort(compareUtf8)) !==
    JSON.stringify([...expected.protected_paths].sort(compareUtf8))
) {
  errors.push("authorization_protected_paths_mismatch");
}
if (
  typeof expected.protected_diff_digest === "string" &&
  authorization.protected_diff_digest !== expected.protected_diff_digest
) {
  errors.push("authorization_protected_diff_digest_mismatch");
}

const issuedAt = Date.parse(authorization.issued_at ?? "");
const expiresAt = Date.parse(authorization.expires_at ?? "");
const now = Number.isNaN(Date.parse(expected.now_iso ?? "")) ? Date.now() : Date.parse(expected.now_iso);
if (Number.isNaN(issuedAt)) errors.push("authorization_issued_at_invalid");
if (Number.isNaN(expiresAt)) errors.push("authorization_expires_at_invalid");
if (!Number.isNaN(issuedAt) && !Number.isNaN(expiresAt) && expiresAt <= issuedAt) {
  errors.push("authorization_expiry_precedes_issue");
}
if (!Number.isNaN(expiresAt) && expiresAt <= now) errors.push("authorization_expired");
if (!Number.isNaN(issuedAt) && issuedAt > now + 5 * 60 * 1000) errors.push("authorization_issued_in_future");

if (authorization.signature?.algorithm !== "ed25519") errors.push("authorization_signature_algorithm_invalid");
if (typeof authorization.signature?.key_id !== "string") errors.push("authorization_key_id_missing");
if (typeof authorization.signature?.value !== "string") errors.push("authorization_signature_missing");

if (!errors.length) {
  const pem = typeof supervisorRegistry.keys[authorization.signature.key_id] === "string"
    ? supervisorRegistry.keys[authorization.signature.key_id]
    : undefined;
  if (!pem) {
    errors.push("authorization_supervisor_key_not_authorized");
  } else {
    const { signature: _signature, ...unsigned } = authorization;
    try {
      const valid = verify(
        null,
        Buffer.from(canonicalJson(unsigned), "utf8"),
        createPublicKey(pem),
        Buffer.from(authorization.signature.value, "base64url"),
      );
      if (!valid) errors.push("authorization_signature_invalid");
    } catch {
      errors.push("authorization_signature_invalid");
    }
  }
}

console.log(JSON.stringify({ valid: errors.length === 0, errors }));
process.exit(errors.length === 0 ? 0 : 1);
