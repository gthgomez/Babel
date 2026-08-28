import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createTrustedExecutionSupervisorV1,
  loadTrustedExecutionSupervisorV1,
  getAuthoritativeTrustedExecutionReadPortV1,
  isTrustedExecutionReadPort,
  TrustedExecutionRegistryV1,
} from "../evidence/trustedExecutionIdentity.js";
import { buildTaskContractV1, freezeTaskContract } from "./taskContract.js";
import {
  assertBreakerReadOnly,
  buildBreakerContractV1,
  executeBreakerLaneV1,
} from "./breakerContract.js";
import { buildAgentEndpointV1 } from "./agentEndpoint.js";
import {
  createIndependentReviewAuthorityV1,
  validateIndependentReviewReceiptV1,
} from "../evidence/independentReview.js";
import {
  RevisionManager,
  validateRevisionBoundReceipt,
} from "../evidence/revisionBoundReceipt.js";
import {
  createExecutionLifecycleV1,
  loadExecutionLifecycleV1,
} from "./executionLifecycle.js";

function endpoint() {
  return buildAgentEndpointV1({
    endpoint_id: "verifier:hardening",
    identity: "verifier:hardening",
    harness: "babel",
    model: "test",
    provider: "test",
    capabilities: ["run_tests", "run_build", "run_local_command"],
    location: "local",
    execution_domain: "isolated-verifier",
  });
}

function tempFile(name: string): string {
  return join(process.cwd(), `.autonomous-swe-${name}-${process.pid}.json`);
}

test("trusted execution rejects arbitrary construction and survives an integrity-checked restart", () => {
  assert.throws(() => new TrustedExecutionRegistryV1(), /supervisor-only/);
  const localSupervisor = createTrustedExecutionSupervisorV1();
  assert.equal(isTrustedExecutionReadPort(localSupervisor.read), false);
  assert.equal(
    isTrustedExecutionReadPort(getAuthoritativeTrustedExecutionReadPortV1()),
    true,
  );
  const file = tempFile("assignments");
  try {
    const supervisor = createTrustedExecutionSupervisorV1();
    const assignment = supervisor.issuer.assign({
      run_id: "run:hardening",
      task_id: "task:hardening",
      contract_hash: "contract:hardening",
      endpoint: endpoint(),
      role: "verifier",
      assigned_at: "2026-08-28T12:00:00.000Z",
    });
    supervisor.issuer.save(file);
    const reloaded = loadTrustedExecutionSupervisorV1(file, {
      run_id: "run:hardening",
      task_id: "task:hardening",
      contract_hash: "contract:hardening",
    });
    assert.equal(
      reloaded.read.authorize({
        run_id: "run:hardening",
        task_id: "task:hardening",
        contract_hash: "contract:hardening",
        endpoint_id: assignment.endpoint_id,
        role: "verifier",
        execution_domain: "isolated-verifier",
        required_capability: "run_tests",
      }).authorized,
      true,
    );
    assert.throws(
      () => loadTrustedExecutionSupervisorV1(file, { run_id: "run:other" }),
      /another run/,
    );
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.slice(0, -10), "utf8");
    assert.throws(
      () => loadTrustedExecutionSupervisorV1(file),
      /cannot be loaded|schema invalid/,
    );
    writeFileSync(file, original.replace("active", "revoked"), "utf8");
    assert.throws(
      () => loadTrustedExecutionSupervisorV1(file),
      /integrity invalid|hash mismatch/,
    );
  } finally {
    if (existsSync(file)) rmSync(file, { force: true });
  }
});

test("revision evidence rejects empty or unsafe scopes and distinguishes explicit repository scope", () => {
  assert.throws(
    () => RevisionManager.computeRevisionSync(process.cwd(), []),
    /must not be empty/,
  );
  assert.throws(
    () => RevisionManager.computeRevisionSync(process.cwd(), ["../outside"]),
    /traverses/,
  );
  assert.throws(
    () =>
      RevisionManager.computeRevisionSync(process.cwd(), [
        "src/agentEndpoint.ts",
        "src\\agentEndpoint.ts",
      ]),
    /duplicate/,
  );
  const repositoryRevision = RevisionManager.computeRevisionSync(
    process.cwd(),
    [],
    { scope_kind: "repository", git_binding: "optional" },
  );
  assert.deepEqual(repositoryRevision.scope, { kind: "repository" });
  assert.equal(
    validateRevisionBoundReceipt({
      receiptId: "receipt:empty",
      command: "verifier",
      exitCode: 0,
      boundRevision: {
        ...repositoryRevision,
        scope: { kind: "files", paths: [] },
      },
      stale: false,
    }).some((error) => error.startsWith("boundRevision.scope")),
    true,
  );
});

test("independent review requires supervisor challenge, semantic bindings, and an asymmetric signature", () => {
  const keys = generateKeyPairSync("ed25519");
  const authority = createIndependentReviewAuthorityV1({
    key_id: "reviewer-test-key",
    private_key: keys.privateKey,
  });
  const challenge = authority.issueChallenge({
    task_id: "task:review",
    run_id: "run:review",
    contract_hash: "contract:review",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    builder_id: "builder:one",
    issued_at: "2026-08-28T11:00:00.000Z",
    expires_at: "2099-08-28T11:00:00.000Z",
  });
  const receipt = authority.issueReceipt({
    challenge,
    reviewer_id: "reviewer:one",
    reviewer_class: "independent_readonly",
    review_mode: "exact_head",
    reviewed_at: "2026-08-28T12:00:00.000Z",
    reviewed_scope: { kind: "files", paths: ["src/agentEndpoint.ts"] },
    verdict: "APPROVE",
    repository: "gthgomez/Babel",
    pr_number: 123,
  });
  const expected = {
    repository: "gthgomez/Babel",
    pr_number: 123,
    task_id: "task:review",
    run_id: "run:review",
    contract_hash: "contract:review",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    builder_id: "builder:one",
    now: Date.parse("2026-08-28T12:00:00.000Z"),
  };
  assert.deepEqual(
    validateIndependentReviewReceiptV1(
      receipt,
      new Map([["reviewer-test-key", keys.publicKey]]),
      expected,
    ),
    [],
  );
  const builderChallenge = authority.issueChallenge({
    task_id: "task:review",
    run_id: "run:review",
    contract_hash: "contract:review",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    builder_id: "builder:one",
    issued_at: "2026-08-28T11:00:00.000Z",
    expires_at: "2099-08-28T11:00:00.000Z",
  });
  assert.throws(
    () =>
      authority.issueReceipt({
        ...receipt,
        challenge: builderChallenge,
        reviewer_id: "builder:one",
      } as never),
    /independent/,
  );
  assert.throws(
    () =>
      authority.issueReceipt({
        challenge,
        reviewer_id: "reviewer:two",
        reviewer_class: "independent_readonly",
        review_mode: "exact_head",
        reviewed_scope: { kind: "repository" },
        verdict: "APPROVE",
        repository: "gthgomez/Babel",
      }),
    /unknown or already consumed/,
  );
  const altered = { ...receipt, head_sha: "c".repeat(40) };
  assert.notDeepEqual(
    validateIndependentReviewReceiptV1(
      altered,
      new Map([["reviewer-test-key", keys.publicKey]]),
      expected,
    ),
    [],
  );
  assert.notDeepEqual(
    validateIndependentReviewReceiptV1(
      { ...receipt, signature: undefined },
      new Map(),
      expected,
    ),
    [],
  );
});

test("lifecycle transitions are legal-only and durable state is fail-closed", () => {
  const file = tempFile("lifecycle");
  try {
    const lifecycle = createExecutionLifecycleV1({
      task_id: "task:lifecycle",
      run_id: "run:lifecycle",
      contract_hash: "contract:lifecycle",
      assignment_id: "assignment:lifecycle",
    });
    assert.throws(
      () => lifecycle.transition("COMPLETED"),
      /Illegal lifecycle transition/,
    );
    lifecycle.transition("ASSIGNED", "2026-08-28T12:00:00.000Z");
    lifecycle.transition("RUNNING", "2026-08-28T12:00:01.000Z");
    lifecycle.save(file);
    const loaded = loadExecutionLifecycleV1(file, {
      task_id: "task:lifecycle",
      run_id: "run:lifecycle",
      contract_hash: "contract:lifecycle",
    });
    assert.equal(loaded.snapshot.state, "RUNNING");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.replace('"revision":2', '"revision":99'), "utf8");
    assert.throws(
      () => loadExecutionLifecycleV1(file),
      /tampered|hash mismatch/,
    );
  } finally {
    if (existsSync(file)) rmSync(file, { force: true });
  }
});

test("Breaker execution is read-only, independently scoped, and fail-closed", async () => {
  const taskContract = freezeTaskContract(
    buildTaskContractV1({
      task_id: "task:breaker",
      mode: "deep",
      task_class: "general_swe",
      user_request: "Challenge completion.",
      goal: "Challenge completion.",
      acceptance_criteria: ["the challenge runs"],
      risk: "high",
      base_sha: "a".repeat(40),
      scope: { paths: ["babel-cli/src"] },
    }),
  );
  const contract = buildBreakerContractV1({
    breaker_id: "breaker:hardening",
    taskContract,
    repository: "gthgomez/Babel",
    candidate_sha: "b".repeat(40),
    run_id: "run:breaker-hardening",
  });
  const widenedReport = await executeBreakerLaneV1({
    contract: { ...contract, capabilities: ["write_repository"] } as never,
    inspect: async () => [],
  });
  assert.equal(widenedReport.status, "UNKNOWN");
  assert.throws(
    () =>
      assertBreakerReadOnly(["write_repository"], {
        execution_domain: "isolated-sandbox",
      }),
    /widening rejected/,
  );
  const report = await executeBreakerLaneV1({
    contract,
    inspect: async (context) => {
      assert.equal(context.mutation_allowed, false);
      assert.equal(context.credential_access, false);
      return [
        {
          finding_id: "finding:breaker",
          severity: "high",
          contract_requirement: "acceptance:breaker",
          counterexample: "completion cannot be established",
          reproduction: "read-only reproduction",
          evidence: [],
          confidence: "high",
          status: "open",
        },
      ];
    },
  });
  assert.equal(report.status, "FINDINGS");
  assert.equal(report.task_id, "task:breaker");
  assert.equal(report.run_id, "run:breaker-hardening");
});
