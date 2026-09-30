import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const source = readFileSync(
  new URL("../policy-integrity-manifest.mjs", import.meta.url),
  "utf8",
);
const paths = [
  "AGENTS.md",
  "docs/AUTONOMY_POLICY.md",
  "docs/AUTONOMY_POLICY_CHANGELOG.md",
  "docs/guides/AGENT_GIT_OPERATIONS.md",
  "scripts/agent-pr-gate.ps1",
  "scripts/agent-pr-gate-common.psm1",
  "scripts/agent-review-evidence.ps1",
  "scripts/trusted-merge-gate.ps1",
  "babel-cli/src/authority/lease.ts",
  "babel-cli/src/config/autonomyPolicy.ts",
  "babel-cli/src/agent/autonomyEnforcement.ts",
  ".agents/rules/10-independent-review-policy.md",
];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "babel-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "fixture text\n");
  }
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools/policy-integrity-manifest.mjs"), source);
  const run = (mode = "verify") => {
    const r = spawnSync(
      process.execPath,
      [join(root, "tools/policy-integrity-manifest.mjs"), mode],
      { encoding: "utf8" },
    );
    return {
      ...r,
      json: (() => {
        try {
          return JSON.parse(r.stdout);
        } catch {
          return null;
        }
      })(),
    };
  };
  assert.equal(run("generate").status, 0);
  const manifestPath = join(root, "POLICY_MANIFEST.json");
  return {
    root,
    run,
    read: () => JSON.parse(readFileSync(manifestPath, "utf8")),
    write: (m) => writeFileSync(manifestPath, JSON.stringify(m)),
    manifestPath,
  };
}
function fail(r) {
  assert.equal(r.status, 1);
  assert.equal(r.json?.status, "FAIL");
  assert.ok(Array.isArray(r.json.problems));
}
test("clean verification, schema and deterministic generation", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.read().schema_version, 2);
  assert.equal(f.read().normalization, "utf8_crlf_to_lf");
  const a = readFileSync(f.manifestPath);
  assert.equal(f.run("generate").status, 0);
  assert.deepEqual(readFileSync(f.manifestPath), a);
});
for (const [name, change] of Object.entries({
  schema: (m) => (m.schema_version = 9),
  algorithm: (m) => (m.algorithm = "bogus"),
  purpose: (m) => (m.purpose = "bogus"),
  normalization: (m) => (m.normalization = "raw"),
  bundle: (m) => (m.policy_bundle_id = "0".repeat(64)),
  bundleSyntax: (m) => (m.policy_bundle_id = "bad"),
  nullFiles: (m) => (m.files = null),
  arrayFiles: (m) => (m.files = []),
  stringFiles: (m) => (m.files = "text"),
  badHash: (m) => (m.files["AGENTS.md"] = "bad"),
  hashType: (m) => (m.files["AGENTS.md"] = 5),
  missingRegistration: (m) => delete m.files["AGENTS.md"],
  staleRegistration: (m) => (m.files["unknown.md"] = "0".repeat(64)),
}))
  test(`reject ${name}`, (t) => {
    const f = fixture(t);
    const m = f.read();
    change(m);
    f.write(m);
    fail(f.run());
  });
for (const shape of [null, [], "text", 42])
  test(`reject manifest shape ${JSON.stringify(shape)}`, (t) => {
    const f = fixture(t);
    f.write(shape);
    fail(f.run());
  });
test("malformed JSON structured failure", (t) => {
  const f = fixture(t);
  writeFileSync(f.manifestPath, "{");
  fail(f.run());
});
test("missing covered file structured failure", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "AGENTS.md"));
  fail(f.run());
  fail(f.run("generate"));
});
test("covered content drift", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "AGENTS.md"), "changed\n");
  fail(f.run());
});
test("CRLF equivalence and substantive mutation", (t) => {
  const f = fixture(t);
  const before = readFileSync(f.manifestPath);
  for (const p of [...paths, "tools/policy-integrity-manifest.mjs"])
    writeFileSync(
      join(f.root, p),
      readFileSync(join(f.root, p), "utf8").replace(/\n/g, "\r\n"),
    );
  assert.equal(f.run().status, 0);
  assert.equal(f.run("generate").status, 0);
  assert.deepEqual(readFileSync(f.manifestPath), before);
  writeFileSync(join(f.root, "AGENTS.md"), "changed\r\n");
  fail(f.run());
});
test("verifier itself covered", (t) => {
  const f = fixture(t);
  assert.ok(f.read().files["tools/policy-integrity-manifest.mjs"]);
  writeFileSync(
    join(f.root, "tools/policy-integrity-manifest.mjs"),
    source + "\n// mutation\n",
  );
  fail(f.run());
});
test("invalid UTF8 rejected for generation and verification", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
  fail(f.run());
  fail(f.run("generate"));
});
test("lone CR and final newline remain significant", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "AGENTS.md"), "fixture text\r");
  fail(f.run());
  writeFileSync(join(f.root, "AGENTS.md"), "fixture text");
  fail(f.run());
});
