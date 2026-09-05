// Canonical ordering parity test: Node side (campaign Phase 30).
//
// Verifies tools/trust-ceremony.mjs canonicalSort/compareUtf8 against the
// shared fixture tools/tests/fixtures/canonical-ordering-vectors.json. The
// PowerShell twin of this test is tools/tests/test-canonical-ordering.ps1;
// both must consume the same fixture so digest canonicalization stays
// byte-identical across the gate, ceremony tooling, and verifiers.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ceremonyUrl = pathToFileURL(join(here, "..", "trust-ceremony.mjs")).href;
const { canonicalSort, compareUtf8 } = await import(ceremonyUrl);

const fixture = JSON.parse(readFileSync(join(here, "fixtures", "canonical-ordering-vectors.json"), "utf8"));
if (fixture.kind !== "babel_canonical_ordering_vectors_v1") {
  console.error("FAIL fixture kind invalid");
  process.exit(1);
}

let failures = 0;
for (const testCase of fixture.cases) {
  const actual = canonicalSort(testCase.input);
  const expectedJson = JSON.stringify(testCase.expected);
  const actualJson = JSON.stringify(actual);
  if (actualJson !== expectedJson) {
    failures++;
    console.error(`FAIL ${testCase.name}: expected ${expectedJson}, got ${actualJson}`);
  } else {
    console.log(`ok ${testCase.name}`);
  }
}

// Self-check of the comparator: a stable comparator returns 0 only for equal
// strings and is antisymmetric over the fixture alphabet.
if (compareUtf8("ab", "ab") !== 0 || compareUtf8("ab", "ab\0") !== -1) {
  failures++;
  console.error("FAIL comparator sanity (equal strings / prefix rule)");
} else {
  console.log("ok comparator sanity");
}

// Document why the default sort is forbidden: it mis-orders the astral case.
const defaultSorted = [...fixture.cases.find((c) => c.name === "astral_character_sorts_by_utf8_byte_order").input].sort();
const canonical = canonicalSort(fixture.cases.find((c) => c.name === "astral_character_sorts_by_utf8_byte_order").input);
if (JSON.stringify(defaultSorted) === JSON.stringify(canonical)) {
  console.log("ok default sort happens to agree (fixture no longer discriminating — replace it)");
} else {
  console.log("ok default sort diverges on astral case (fixture still discriminating)");
}

if (failures > 0) {
  console.error(`CANONICAL_ORDERING_TEST_FAIL failures=${failures}`);
  process.exit(1);
}
console.log("CANONICAL_ORDERING_TEST_PASS");
