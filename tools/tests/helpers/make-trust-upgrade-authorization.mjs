// Test-only helper: signs a TrustRootUpgradeV1 authorization with a
// caller-provided Ed25519 private key. Never used by the merge gate; exists
// so offline integration tests can exercise the base-rooted verifier.
// Usage: node make-trust-upgrade-authorization.mjs <private-key-pem-file> <authorization-json-file>
import { readFileSync } from "node:fs";
import { createPrivateKey, sign, createHash } from "node:crypto";

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

const [keyPath, authPath] = process.argv.slice(2);
const privateKeyPem = readFileSync(keyPath, "utf8");
const unsigned = JSON.parse(readFileSync(authPath, "utf8"));
const signature = sign(null, Buffer.from(JSON.stringify(canonicalize(unsigned)), "utf8"), createPrivateKey(privateKeyPem));
const signed = { ...unsigned, signature: { algorithm: "ed25519", key_id: unsigned.signature_key_id ?? "integration-supervisor-v1", value: signature.toString("base64url") } };
process.stdout.write(JSON.stringify(signed));
