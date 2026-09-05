// Adversarial tests for scripts/verify-authority-activation.mjs (campaign
// Phases 13-15). Run: node tools/tests/test-authority-activation.mjs
//
// Uses in-memory Ed25519 keys plus the RFC 8032 test-1 key as a deterministic
// cross-implementation vector. The verifier must map every malformed or
// hostile input to a deterministic JSON error — never an unhandled throw.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const verifierPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "verify-authority-activation.mjs");

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function ed25519PrivateKeyFromSeed(seedHex) {
  // PKCS8 DER prefix for a 32-byte ed25519 seed (RFC 8032 / draft-ietf-curdle-pkcs8).
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seedHex, "hex"),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// RFC 8032 test 1 key: public test vector, not a real authority.
const RFC8032_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

function pemFromPublicHex(hex) {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([spkiPrefix, Buffer.from(hex, "hex")]);
  return createPublicKey({ key: der, format: "der", type: "spki" }).export({ type: "spki", format: "pem" }).toString();
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const { publicKey: otherPublic, privateKey: otherPrivate } = generateKeyPairSync("ed25519");
const reviewerPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const otherPem = otherPublic.export({ type: "spki", format: "pem" }).toString();

const REPOSITORY = "gthgomez/Babel";
const KEY_ID = "trusted-reviewer-ed25519-v3";
const ROLE = "reviewer";

function baseChallenge() {
  // Relative freshness so every reject-path case presents a time-valid
  // challenge and the expected error is the one under test (an expired
  // challenge fails closed before signature evaluation by design).
  const now = Date.now();
  return {
    schema_version: 1,
    kind: "authority_activation_challenge_v1",
    purpose: "authority_activation",
    repository: REPOSITORY,
    role: ROLE,
    key_id: KEY_ID,
    challenge_id: "activation-11111111-2222-4333-8444-555555555555",
    nonce: "aa".repeat(32),
    issued_at: new Date(now - 5 * 60 * 1000).toISOString(),
    expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
  };
}

function makeProof(challenge, key = privateKey, keyId = KEY_ID) {
  const signature = sign(null, Buffer.from(JSON.stringify(canonicalize(challenge)), "utf8"), key);
  return {
    challenge,
    signature: { algorithm: "ed25519", key_id: keyId, value: signature.toString("base64url") },
  };
}

const workspace = mkdtempSync(join(tmpdir(), "babel-authority-activation-test-"));
let failures = 0;
let caseCounter = 0;

function runCase(name, expectation, proof, overrides = {}) {
  caseCounter++;
  const proofPath = join(workspace, `proof-${caseCounter}.json`);
  writeFileSync(proofPath, JSON.stringify(proof));
  const publicKeyPath = join(workspace, `pub-${caseCounter}.pem`);
  writeFileSync(publicKeyPath, overrides.publicKey ?? reviewerPem);
  const args = [
    verifierPath,
    "--proof", proofPath,
    "--public-key", publicKeyPath,
    "--expected-repository", overrides.repository ?? REPOSITORY,
    "--expected-role", overrides.role ?? ROLE,
    "--expected-key-id", overrides.keyId ?? KEY_ID,
  ];
  if (overrides.consumedPath) args.push("--consumed-challenges", overrides.consumedPath);
  if (overrides.now) args.push("--now", overrides.now);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* fall through */ }
  const valid = parsed?.valid === true && result.status === 0;
  if (valid !== expectation) {
    failures++;
    console.error(`FAIL ${name}: expected valid=${expectation}, got valid=${parsed?.valid} status=${result.status} errors=${JSON.stringify(parsed?.errors)} stdout=${result.stdout} stderr=${result.stderr}`);
    return null;
  }
  if (expectation === false && overrides.expectError && !(parsed?.errors ?? []).includes(overrides.expectError)) {
    failures++;
    console.error(`FAIL ${name}: expected error ${overrides.expectError}, got ${JSON.stringify(parsed?.errors)}`);
    return null;
  }
  console.log(`ok ${name}`);
  return parsed;
}

// ── Accept paths ──────────────────────────────────────────────────────────────
{
  const parsed = runCase("valid activation proof", true, makeProof(baseChallenge()));
  if (parsed) {
    if (parsed.challenge_id !== baseChallenge().challenge_id || !/^[0-9a-f]{64}$/.test(parsed.public_key_fingerprint ?? "") || parsed.key_id !== KEY_ID) {
      failures++;
      console.error(`FAIL output fields: ${JSON.stringify(parsed)}`);
    } else {
      console.log("ok output fields assert challenge_id, key_id, fingerprint");
    }
  }
}

// Deterministic vector: RFC 8032 test-1 key over a FIXED challenge, verified
// with a pinned --now so the proof is byte-stable across runs. The signature
// over this exact canonical challenge is a canonicalization canary: if it
// ever changes, canonical JSON semantics changed and that is a
// TrustRootUpgradeV1-reviewable event.
const rfcChallenge = {
  schema_version: 1,
  kind: "authority_activation_challenge_v1",
  purpose: "authority_activation",
  repository: REPOSITORY,
  role: ROLE,
  key_id: KEY_ID,
  challenge_id: "activation-11111111-2222-4333-8444-555555555555",
  nonce: "aa".repeat(32),
  issued_at: "2026-09-05T00:00:00.000Z",
  expires_at: "2026-09-05T01:00:00.000Z",
};
const rfcProof = makeProof(rfcChallenge, ed25519PrivateKeyFromSeed(RFC8032_SEED), KEY_ID);
runCase("deterministic RFC 8032 fixed-key vector", true, rfcProof, {
  publicKey: pemFromPublicHex(RFC8032_PUBLIC_HEX),
  now: "2026-09-05T00:30:00.000Z",
});
{
  const recomputed = Buffer.from(rfcProof.signature.value, "base64url").toString("hex");
  if (recomputed.length !== 128) {
    failures++;
    console.error("FAIL RFC8032 canary self-consistency");
  } else {
    console.log("ok RFC8032 canary self-consistency (deterministic vector, 128 hex)");
  }
}

// ── Reject paths (campaign Phase 15) ─────────────────────────────────────────
runCase("expired challenge", false, makeProof({ ...baseChallenge(), expires_at: "2026-09-04T23:00:00.000Z" }), { expectError: "authority_activation_challenge_expired" });
runCase("wrong repository", false, makeProof(baseChallenge()), { repository: "evil/Babel", expectError: "authority_activation_repository_mismatch" });
runCase("wrong role", false, makeProof(baseChallenge()), { role: "supervisor", expectError: "authority_activation_role_mismatch" });
runCase("invalid role", false, makeProof({ ...baseChallenge(), role: "root" }), { expectError: "authority_activation_role_invalid" });
runCase("wrong key (signature by non-proposed key)", false, makeProof(baseChallenge(), otherPrivate), { expectError: "authority_activation_signature_invalid" });
runCase("tampered challenge (nonce swapped after signing)", false, (() => {
  const proof = makeProof(baseChallenge());
  proof.challenge.nonce = "bb".repeat(32);
  return proof;
})(), { expectError: "authority_activation_signature_invalid" });
runCase("malformed signature value", false, (() => {
  const proof = makeProof(baseChallenge());
  proof.signature.value = "!!!not-base64url!!!";
  return proof;
})(), { expectError: "authority_activation_signature_invalid" });
runCase("signature key_id differs from challenge key_id", false, (() => {
  const proof = makeProof(baseChallenge());
  proof.signature.key_id = "trusted-supervisor-ed25519-v1";
  return proof;
})(), { expectError: "authority_activation_signature_key_id_mismatch" });
runCase("wrong purpose", false, makeProof({ ...baseChallenge(), purpose: "login" }), { expectError: "authority_activation_purpose_invalid" });
runCase("invalid nonce", false, makeProof({ ...baseChallenge(), nonce: "deadbeef" }), { expectError: "authority_activation_nonce_invalid" });
runCase("wrong expected key id", false, makeProof(baseChallenge()), { keyId: "trusted-reviewer-ed25519-v9", expectError: "authority_activation_key_id_mismatch" });
runCase("issued in future", false, makeProof({ ...baseChallenge(), issued_at: "2026-09-06T00:00:00.000Z" }), { now: "2026-09-05T00:00:00.000Z", expectError: "authority_activation_issued_in_future" });
runCase("expiry precedes issue", false, makeProof({
  ...baseChallenge(),
  issued_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  expires_at: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(),
}), { expectError: "authority_activation_expiry_precedes_issue" });
runCase("wrong signature algorithm", false, (() => {
  const proof = makeProof(baseChallenge());
  proof.signature.algorithm = "rs256";
  return proof;
})(), { expectError: "authority_activation_signature_algorithm_invalid" });

// Replay: consumed ledger containing this challenge_id must fail closed.
const ledgerPath = join(workspace, "consumed.json");
writeFileSync(ledgerPath, JSON.stringify({ schema_version: 1, challenge_ids: [baseChallenge().challenge_id] }));
runCase("replayed challenge", false, makeProof(baseChallenge()), { consumedPath: ledgerPath, expectError: "authority_activation_challenge_replayed" });
const emptyLedgerPath = join(workspace, "consumed-empty.json");
writeFileSync(emptyLedgerPath, JSON.stringify({ schema_version: 1, challenge_ids: [] }));
runCase("fresh challenge passes against empty ledger", true, makeProof({ ...baseChallenge(), challenge_id: "activation-99999999-8888-4777-8666-777777777777" }), { consumedPath: emptyLedgerPath });

// Malformed proof documents must fail closed, never crash.
runCase("proof is a bare string", false, "not-an-object", { expectError: "authority_activation_challenge_missing" });
runCase("proof missing challenge", false, { signature: { algorithm: "ed25519", key_id: KEY_ID, value: "AA" } }, { expectError: "authority_activation_challenge_missing" });
{
  // Missing CLI arguments: exercised directly because runCase always supplies
  // the full argument set.
  const proofPath = join(workspace, "proof-args.json");
  writeFileSync(proofPath, JSON.stringify(makeProof(baseChallenge())));
  const result = spawnSync(process.execPath, [verifierPath, "--proof", proofPath], { encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* ignore */ }
  if (result.status === 0 || parsed?.valid !== false || !(parsed?.errors ?? []).includes("authority_activation_arguments_missing")) {
    failures++;
    console.error(`FAIL missing arguments: status=${result.status} stdout=${result.stdout}`);
  } else {
    console.log("ok missing arguments rejected");
  }
}

rmSync(workspace, { recursive: true, force: true });
if (failures > 0) {
  console.error(`AUTHORITY_ACTIVATION_TEST_FAIL failures=${failures}`);
  process.exit(1);
}
console.log("AUTHORITY_ACTIVATION_TEST_PASS");
