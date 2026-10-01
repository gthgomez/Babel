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
  ".agents/rules/10-independent-review-policy.md",
  ".github/workflows/public-pr-metadata.yml",
  ".github/workflows/trusted-control-plane.yml",
  ".github/workflows/typecheck.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "babel-cli/src/agent/autonomyEnforcement.ts",
  "babel-cli/src/authority/actionRequest.ts",
  "babel-cli/src/authority/authority.test.ts",
  "babel-cli/src/authority/authorityMapping.test.ts",
  "babel-cli/src/authority/capabilities.ts",
  "babel-cli/src/authority/ciRepair.ts",
  "babel-cli/src/authority/commandDecoder.ts",
  "babel-cli/src/authority/commandSpec.test.ts",
  "babel-cli/src/authority/commandSpec.ts",
  "babel-cli/src/authority/convergence-integrity.regression-gate.test.ts",
  "babel-cli/src/authority/convergence-parser.regression-gate.test.ts",
  "babel-cli/src/authority/gitCommand.ts",
  "babel-cli/src/authority/governanceReconcile.ts",
  "babel-cli/src/authority/governanceRestore.test.ts",
  "babel-cli/src/authority/governanceSubprocess.test.ts",
  "babel-cli/src/authority/integrity.ts",
  "babel-cli/src/authority/lease.ts",
  "babel-cli/src/authority/leaseTime.ts",
  "babel-cli/src/authority/patchTargets.test.ts",
  "babel-cli/src/authority/patchTargets.ts",
  "babel-cli/src/authority/pdp.ts",
  "babel-cli/src/authority/privilegedTargetBinding.test.ts",
  "babel-cli/src/authority/reasonCodes.ts",
  "babel-cli/src/authority/remoteClarification.test.ts",
  "babel-cli/src/authority/scriptPrivilegeEscape.test.ts",
  "babel-cli/src/authority/sessionContext.test.ts",
  "babel-cli/src/authority/sessionContext.ts",
  "babel-cli/src/authority/sessionLifecycle.test.ts",
  "babel-cli/src/authority/targetBinding.ts",
  "babel-cli/src/authority/taskClarity.test.ts",
  "babel-cli/src/authority/taskClarity.ts",
  "babel-cli/src/authority/trustedExecutionPort.architecture.test.ts",
  "babel-cli/src/authority/trustedExecutionPort.ts",
  "babel-cli/src/authority/trustedExecutionSupervisor.ts",
  "babel-cli/src/authority/unprivilegedChildEnv.ts",
  "babel-cli/src/authority/wire.ts",
  "babel-cli/src/config/autonomyPolicy.test.ts",
  "babel-cli/src/config/autonomyPolicy.ts",
  "babel-cli/src/services/babelChatReview.test.ts",
  "babel-cli/src/services/babelChatReview.ts",
  "babel-cli/src/services/babelChatReviewParity.test.ts",
  "babel-cli/src/services/babelReviewObserver.test.ts",
  "babel-cli/src/services/babelReviewObserver.ts",
  "babel-cli/src/services/babelReviewQueue.test.ts",
  "babel-cli/src/services/babelReviewQueue.ts",
  "babel-cli/src/services/babelReviewSnapshot.test.ts",
  "babel-cli/src/services/babelReviewSnapshot.ts",
  "babel-cli/src/services/candidateCollector.test.ts",
  "babel-cli/src/services/candidateCollector.ts",
  "babel-cli/src/services/candidateCollectorCli.ts",
  "babel-cli/src/services/codexHarnessReview.test.ts",
  "babel-cli/src/services/codexHarnessReview.ts",
  "babel-cli/src/services/controllerMediatedHarnessReview.test.ts",
  "babel-cli/src/services/controllerMediatedHarnessReview.ts",
  "babel-cli/src/services/harnessReviewProtocol.test.ts",
  "babel-cli/src/services/harnessReviewProtocol.ts",
  "babel-cli/src/services/hostReviewController.test.ts",
  "babel-cli/src/services/hostReviewController.ts",
  "babel-cli/src/services/hostReviewV3Publication.test.ts",
  "babel-cli/src/services/hostReviewV3Publication.ts",
  "babel-cli/src/services/hostReviewWorker.test.ts",
  "babel-cli/src/services/hostReviewWorker.ts",
  "babel-cli/src/services/independentReviewBroker.test.ts",
  "babel-cli/src/services/independentReviewBroker.ts",
  "babel-cli/src/services/independentReviewController.test.ts",
  "babel-cli/src/services/independentReviewController.ts",
  "babel-cli/src/services/independentReviewEvidenceV3.test.ts",
  "babel-cli/src/services/independentReviewEvidenceV3.ts",
  "babel-cli/src/services/independentReviewPolicy.test.ts",
  "babel-cli/src/services/independentReviewPolicy.ts",
  "babel-cli/src/services/independentReviewProvider.test.ts",
  "babel-cli/src/services/independentReviewProvider.ts",
  "babel-cli/src/services/mergeReadinessBroker.test.ts",
  "babel-cli/src/services/mergeReadinessBroker.ts",
  "babel-cli/src/services/openCodeHarnessReview.test.ts",
  "babel-cli/src/services/openCodeHarnessReview.ts",
  "babel-cli/src/services/orchestratorReviewAdapter.test.ts",
  "babel-cli/src/services/orchestratorReviewAdapter.ts",
  "babel-cli/src/services/reviewControlPlaneParity.test.ts",
  "babel-cli/src/services/reviewCoverage.test.ts",
  "babel-cli/src/services/reviewCoverage.ts",
  "babel-cli/src/services/reviewCustody.test.ts",
  "babel-cli/src/services/reviewIndependence.test.ts",
  "babel-cli/src/services/reviewIndependence.ts",
  "babel-cli/src/services/reviewOrchestrator.test.ts",
  "babel-cli/src/services/reviewOrchestrator.ts",
  "babel-cli/src/services/reviewPolicy.test.ts",
  "babel-cli/src/services/reviewPolicy.ts",
  "babel-cli/src/services/reviewProcessContainment.test.ts",
  "babel-cli/src/services/reviewProcessContainment.ts",
  "babel-cli/src/services/reviewProvenance.ts",
  "babel-cli/src/services/reviewServiceTransport.test.ts",
  "babel-cli/src/services/reviewServiceTransport.ts",
  "babel-cli/src/services/reviewSupervisor.test.ts",
  "babel-cli/src/services/reviewSupervisor.ts",
  "babel-cli/src/services/reviewTrustedAuthority.ts",
  "babel-cli/src/services/structuredFinding.test.ts",
  "babel-cli/src/services/structuredFinding.ts",
  "babel-cli/src/services/trustedReviewInstallation.test.ts",
  "babel-cli/src/services/trustedReviewInstallation.ts",
  "config/review-risk-policy.json",
  "docs/AUTONOMY_POLICY.md",
  "docs/AUTONOMY_POLICY_CHANGELOG.md",
  "docs/BABEL_PR_REVIEW.md",
  "docs/architecture/MERGE_CONTROL_PLANE_V1.md",
  "docs/guides/AGENT_GIT_OPERATIONS.md",
  "scripts/agent-git-common.psm1",
  "scripts/agent-pr-gate-common.psm1",
  "scripts/agent-pr-gate.ps1",
  "scripts/agent-pr-merge.ps1",
  "scripts/agent-review-evidence.ps1",
  "scripts/materialize-independent-review-receipt.ps1",
  "scripts/trusted-merge-gate.ps1",
  "scripts/verify-independent-review.mjs",
  "scripts/verify-trust-root-upgrade.mjs",
  "tools/agent-host-review.ps1",
  "tools/babel-pr-orchestrate-opencode.mts",
  "tools/babel-pr-orchestrate.mts",
  "tools/host-review-worker.mts"
];
function fixture(t, verifierSource = source) {
  const root = mkdtempSync(join(tmpdir(), "babel-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "fixture text\n");
  }
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools/policy-integrity-manifest.mjs"), verifierSource);
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
for (const checkoutEnding of ["LF", "CRLF"])
test(`CRLF equivalence and substantive mutation from ${checkoutEnding} checkout`, (t) => {
  const checkoutSource = source.replace(/\r\n/g, "\n");
  const f = fixture(t, checkoutEnding === "CRLF" ? checkoutSource.replace(/\n/g, "\r\n") : checkoutSource);
  const before = readFileSync(f.manifestPath);
  for (const p of [...paths, "tools/policy-integrity-manifest.mjs"])
    writeFileSync(
      join(f.root, p),
      readFileSync(join(f.root, p), "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
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
