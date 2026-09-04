// Adversarial tests for scripts/verify-trust-root-upgrade.mjs.
// Run: node tools/tests/test-trust-root-upgrade.mjs
// Generates throwaway Ed25519 keys in-memory; no external dependency.
import { generateKeyPairSync, createHash, createPrivateKey, sign, createPublicKey } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const verifierPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "verify-trust-root-upgrade.mjs");

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const { publicKey: otherPublic, privateKey: otherPrivate } = generateKeyPairSync("ed25519");
const supervisorPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const otherPem = otherPublic.export({ type: "spki", format: "pem" }).toString();

const PROTECTED_PATHS = ["scripts/agent-pr-gate.ps1", "config/trusted-supervisor-keys.json"];
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const REPOSITORY = "gthgomez/Babel";
const PR = 138;

function protectedDiffDigest(paths) {
  const lines = paths.slice().sort().map((p) => `${p}\t${createHash("sha1").update(p).digest("hex")}`);
  return createHash("sha256").update(lines.sort().join("\n"), "utf8").digest("hex");
}
const DIGEST = protectedDiffDigest(PROTECTED_PATHS);

function signAuthorization(unsigned, key = privateKey) {
  const signature = sign(null, Buffer.from(JSON.stringify(canonicalize(unsigned)), "utf8"), key);
  return { ...unsigned, signature: { algorithm: "ed25519", key_id: "test-supervisor-v1", value: signature.toString("base64url") } };
}

function baseAuthorization() {
  return {
    schema_version: 1,
    kind: "trust_root_upgrade_authorization_v1",
    intent: "trust_root_upgrade",
    decision: "AUTHORIZE_TRUST_ROOT_UPGRADE",
    repository: REPOSITORY,
    pr_number: PR,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    protected_paths: PROTECTED_PATHS,
    protected_diff_digest: DIGEST,
    issued_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-30T00:00:00.000Z",
  };
}

const workspace = mkdtempSync(join(tmpdir(), "babel-trust-upgrade-test-"));
const registryPath = join(workspace, "supervisor-keys.json");
const pathsPath = join(workspace, "protected-paths.json");
writeFileSync(registryPath, JSON.stringify({ schema_version: 1, keys: { "test-supervisor-v1": supervisorPem } }));
writeFileSync(pathsPath, JSON.stringify(PROTECTED_PATHS));

let failures = 0;
function runCase(name, expectation, authorization, overrides = {}) {
  const authorizationPath = join(workspace, `auth-${name.replace(/[^a-z0-9]+/gi, "-")}.json`);
  writeFileSync(authorizationPath, JSON.stringify(authorization));
  const args = [
    verifierPath,
    "--authorization", authorizationPath,
    "--supervisor-keys", overrides.registry ?? registryPath,
    "--repository", overrides.repository ?? REPOSITORY,
    "--pr", String(overrides.pr ?? PR),
    "--base-sha", overrides.baseSha ?? BASE_SHA,
    "--head-sha", overrides.headSha ?? HEAD_SHA,
    "--protected-paths-json", overrides.paths ?? pathsPath,
    "--protected-diff-digest", overrides.digest ?? DIGEST,
  ];
  if (overrides.now) args.push("--now", overrides.now);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* fall through */ }
  const valid = parsed?.valid === true && result.status === 0;
  if (valid !== expectation) {
    failures++;
    console.error(`FAIL ${name}: expected valid=${expectation}, got valid=${parsed?.valid} status=${result.status} errors=${JSON.stringify(parsed?.errors)} stdout=${result.stdout} stderr=${result.stderr}`);
  } else {
    console.log(`ok ${name}`);
  }
}

runCase("valid authorization", true, signAuthorization(baseAuthorization()));
runCase("duplicate identical", true, signAuthorization(baseAuthorization()));

// Fail-closed matrix: each authorization is mutated to bind a DIFFERENT
// repository/PR/base/head than the one the verifier is asked to enforce.
const unsigned = baseAuthorization();
runCase("missing signature", false, unsigned);
runCase("forged signature", false, (() => {
  const signed = signAuthorization(unsigned);
  return { ...signed, protected_diff_digest: "c".repeat(64) };
})());
runCase("wrong base", false, signAuthorization({ ...baseAuthorization(), base_sha: "c".repeat(40) }));
runCase("stale base mismatch", false, signAuthorization(baseAuthorization()), { baseSha: "d".repeat(40) });
runCase("wrong head", false, signAuthorization({ ...baseAuthorization(), head_sha: "e".repeat(40) }));
runCase("wrong pr", false, signAuthorization({ ...baseAuthorization(), pr_number: 999 }));
runCase("wrong repository", false, signAuthorization({ ...baseAuthorization(), repository: "evil/Babel" }));
runCase("expired", false, signAuthorization(baseAuthorization()), { now: "2026-10-01T00:00:00.000Z" });
runCase("expiry precedes issue", false, signAuthorization({ ...baseAuthorization(), expires_at: "2026-08-31T00:00:00.000Z" }));
runCase("issued in future", false, signAuthorization({ ...baseAuthorization(), issued_at: "2026-09-15T00:00:00.000Z" }), { now: "2026-09-01T00:00:00.000Z" });
runCase("modified protected diff digest", false, signAuthorization({ ...baseAuthorization(), protected_diff_digest: "f".repeat(64) }));
runCase("subset protected paths", false, signAuthorization({ ...baseAuthorization(), protected_paths: ["scripts/agent-pr-gate.ps1"] }));
runCase("extra protected path", false, signAuthorization({ ...baseAuthorization(), protected_paths: [...PROTECTED_PATHS, "scripts/verify-independent-review.mjs"] }), { paths: JSON.stringify([...PROTECTED_PATHS, "scripts/verify-independent-review.mjs"]) });
runCase("wrong key id", false, signAuthorization({ ...baseAuthorization(), signature: { algorithm: "ed25519", key_id: "unknown-key", value: "AA" } }));
runCase("unregistered signer key", false, signAuthorization(unsigned, otherPrivate));
runCase("wrong algorithm", false, (() => {
  const signed = signAuthorization(unsigned);
  return { ...signed, signature: { ...signed.signature, algorithm: "rs256" } };
})());
runCase("wrong intent", false, signAuthorization({ ...baseAuthorization(), intent: "merge_everything" }));
runCase("wrong decision", false, signAuthorization({ ...baseAuthorization(), decision: "AUTHORIZE_EVERYTHING" }));
runCase("wrong kind", false, signAuthorization({ ...baseAuthorization(), kind: "trust_root_upgrade_authorization_v0" }));
runCase("schema version drift", false, signAuthorization({ ...baseAuthorization(), schema_version: 2 }));
runCase("empty protected paths", false, signAuthorization({ ...baseAuthorization(), protected_paths: [] }));

rmSync(workspace, { recursive: true, force: true });
if (failures > 0) {
  console.error(`TRUST_ROOT_UPGRADE_TEST_FAIL failures=${failures}`);
  process.exit(1);
}
console.log("TRUST_ROOT_UPGRADE_TEST_PASS");
