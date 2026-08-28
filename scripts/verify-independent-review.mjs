import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";

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

const receiptPath = parseArg("--receipt");
const keysPath = parseArg("--keys");
if (!receiptPath || !keysPath) {
  console.log(
    JSON.stringify({
      valid: false,
      errors: ["receipt_or_key_registry_path_missing"],
    }),
  );
  process.exit(1);
}

const errors = [];
let receipt;
let registry;
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
if (!receipt || !registry) {
  console.log(JSON.stringify({ valid: false, errors }));
  process.exit(1);
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
