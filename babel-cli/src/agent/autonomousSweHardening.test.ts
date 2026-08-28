import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadTrustedExecutionSupervisorV1,
  isTrustedExecutionReadPort,
} from "../evidence/trustedExecutionIdentity.js";
import * as workerExecutionModule from "../evidence/trustedExecutionIdentity.js";
import {
  bootstrapTrustedExecutionSupervisorV1,
  createTrustedExecutionSupervisorV1,
} from "../authority/trustedExecutionSupervisor.js";
import { buildTaskContractV1, freezeTaskContract } from "./taskContract.js";
import {
  assertBreakerReadOnly,
  buildBreakerContractV1,
  executeBreakerLaneV1,
  executeIsolatedBreakerProcessV1,
} from "./breakerContract.js";
import { buildAgentEndpointV1 } from "./agentEndpoint.js";
import {
  createIndependentReviewAuthorityV1,
  validateReviewChallengeLedgerV1,
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

test("trusted execution uses a trusted bootstrap for authoritative restart state", () => {
  const localSupervisor = createTrustedExecutionSupervisorV1();
  assert.equal(isTrustedExecutionReadPort(localSupervisor.read), true);
  const file = tempFile("assignments");
  try {
    const supervisor = createTrustedExecutionSupervisorV1();
    const assignment = supervisor.assign({
      run_id: "run:hardening",
      task_id: "task:hardening",
      contract_hash: "contract:hardening",
      endpoint: endpoint(),
      role: "verifier",
      assigned_at: "2026-08-28T12:00:00.000Z",
    });
    supervisor.save(file);
    const untrustedLoaded = loadTrustedExecutionSupervisorV1(file, {
      run_id: "run:hardening",
      task_id: "task:hardening",
      contract_hash: "contract:hardening",
    });
    assert.equal(isTrustedExecutionReadPort(untrustedLoaded), false);
    const reloaded = bootstrapTrustedExecutionSupervisorV1(file, {
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
      () =>
        bootstrapTrustedExecutionSupervisorV1(file, { run_id: "run:other" }),
      /another run/,
    );
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.slice(0, -10), "utf8");
    assert.throws(
      () => bootstrapTrustedExecutionSupervisorV1(file),
      /cannot be loaded|schema invalid/,
    );
    writeFileSync(file, original.replace("active", "revoked"), "utf8");
    assert.throws(
      () => bootstrapTrustedExecutionSupervisorV1(file),
      /integrity invalid|hash mismatch/,
    );
  } finally {
    if (existsSync(file)) rmSync(file, { force: true });
  }
});

test("worker-facing execution module has no issuer and ordinary loading cannot mint authority", () => {
  assert.equal(
    "getAuthoritativeTrustedExecutionIssuerV1" in workerExecutionModule,
    false,
  );
  assert.equal(
    "createTrustedExecutionSupervisorV1" in workerExecutionModule,
    false,
  );
  assert.equal("TrustedExecutionRegistryV1" in workerExecutionModule, false);
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
  const ledgerFile = tempFile("review-ledger");
  const authority = createIndependentReviewAuthorityV1({
    key_id: "reviewer-test-key",
    private_key: keys.privateKey,
    ledger_path: ledgerFile,
  });
  try {
    const challenge = authority.issueChallenge({
      task_id: "task:review",
      run_id: "run:review",
      contract_hash: "contract:review",
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      builder_id: "builder:one",
      issued_at: "2026-08-28T11:00:00.000Z",
      expires_at: "2099-08-28T11:00:00.000Z",
      repository: "gthgomez/Babel",
      pr_number: 123,
      reviewer_class: "independent_readonly",
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
      repository: "gthgomez/Babel",
      pr_number: 123,
      reviewer_class: "independent_readonly",
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
  } finally {
    if (existsSync(ledgerFile)) rmSync(ledgerFile, { force: true });
  }
});

test("review challenge ledger is durable, expiring, single-use, revocable, and fail-closed", () => {
  const keys = generateKeyPairSync("ed25519");
  const ledgerFile = tempFile("review-ledger-adversarial");
  const authority = createIndependentReviewAuthorityV1({
    key_id: "reviewer-test-key",
    private_key: keys.privateKey,
    ledger_path: ledgerFile,
  });
  const base = {
    task_id: "task:review-ledger",
    run_id: "run:review-ledger",
    contract_hash: "contract:review-ledger",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    builder_id: "builder:one",
    issued_at: new Date(Date.now() - 1000).toISOString(),
    repository: "gthgomez/Babel",
    pr_number: 120,
    reviewer_class: "independent_readonly" as const,
  };
  try {
    const challenge = authority.issueChallenge({
      ...base,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const receipt = authority.issueReceipt({
      challenge,
      reviewer_id: "reviewer:one",
      reviewer_class: "independent_readonly",
      review_mode: "exact_head",
      reviewed_scope: { kind: "repository" },
      verdict: "APPROVE",
      repository: base.repository,
      pr_number: base.pr_number,
    });
    assert.equal(
      validateReviewChallengeLedgerV1(ledgerFile).challenges[0]?.status,
      "CONSUMED",
    );
    const afterRestart = createIndependentReviewAuthorityV1({
      key_id: "reviewer-test-key",
      private_key: keys.privateKey,
      ledger_path: ledgerFile,
    });
    assert.equal(
      afterRestart.getChallenge(challenge.challenge_id)?.status,
      "CONSUMED",
    );
    assert.throws(
      () =>
        afterRestart.issueReceipt({
          challenge,
          reviewer_id: "reviewer:two",
          reviewer_class: "independent_readonly",
          review_mode: "exact_head",
          reviewed_scope: { kind: "repository" },
          verdict: "APPROVE",
          repository: base.repository,
          pr_number: base.pr_number,
        }),
      /unknown or already consumed/,
    );
    assert.throws(
      () =>
        afterRestart.issueReceipt({
          challenge: { ...challenge, head_sha: "c".repeat(40) },
          reviewer_id: "reviewer:two",
          reviewer_class: "independent_readonly",
          review_mode: "exact_head",
          reviewed_scope: { kind: "repository" },
          verdict: "APPROVE",
          repository: base.repository,
          pr_number: base.pr_number,
        }),
      /tampered|unknown or already consumed/,
    );
    void receipt;
    const expired = afterRestart.issueChallenge({
      ...base,
      run_id: "run:expired",
      expires_at: new Date(Date.now() - 1).toISOString(),
    });
    assert.throws(
      () =>
        afterRestart.issueReceipt({
          challenge: expired,
          reviewer_id: "reviewer:one",
          reviewer_class: "independent_readonly",
          review_mode: "exact_head",
          reviewed_scope: { kind: "repository" },
          verdict: "APPROVE",
          repository: base.repository,
          pr_number: base.pr_number,
        }),
      /expired/,
    );
    const revoked = afterRestart.issueChallenge({
      ...base,
      run_id: "run:revoked",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    afterRestart.revokeChallenge(revoked.challenge_id);
    assert.throws(
      () =>
        afterRestart.issueReceipt({
          challenge: revoked,
          reviewer_id: "reviewer:one",
          reviewer_class: "independent_readonly",
          review_mode: "exact_head",
          reviewed_scope: { kind: "repository" },
          verdict: "APPROVE",
          repository: base.repository,
          pr_number: base.pr_number,
        }),
      /unknown or already consumed/,
    );
    const raw = readFileSync(ledgerFile, "utf8");
    writeFileSync(
      ledgerFile,
      raw.replace("reviewer-test-key", "attacker-key"),
      "utf8",
    );
    assert.throws(
      () => validateReviewChallengeLedgerV1(ledgerFile),
      /state hash mismatch/,
    );
  } finally {
    if (existsSync(ledgerFile)) rmSync(ledgerFile, { force: true });
  }
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

test("isolated Breaker process rejects writes and mismatched structured output", async () => {
  const taskContract = freezeTaskContract(
    buildTaskContractV1({
      task_id: "task:breaker-process",
      mode: "deep",
      task_class: "general_swe",
      user_request: "Run an isolated breaker.",
      goal: "Run an isolated breaker.",
      acceptance_criteria: ["the breaker runs"],
      risk: "high",
      base_sha: "a".repeat(40),
      scope: { paths: ["babel-cli/src"] },
    }),
  );
  const contract = buildBreakerContractV1({
    breaker_id: "breaker:process",
    taskContract,
    repository: "gthgomez/Babel",
    candidate_sha: "b".repeat(40),
    run_id: "run:breaker-process",
  });
  const report = {
    schema_version: 1,
    breaker_id: contract.breaker_id,
    task_id: contract.task_id,
    run_id: contract.run_id,
    contract_hash: contract.contract_hash,
    candidate_sha: contract.candidate_sha,
    status: "PASS",
    findings: [],
  };
  const good = await executeIsolatedBreakerProcessV1({
    contract,
    project_root: join(process.cwd(), "src", "agent"),
    executable: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(JSON.stringify(report))})`,
    ],
  });
  assert.equal(good.status, "PASS");
  const writes = await executeIsolatedBreakerProcessV1({
    contract,
    project_root: join(process.cwd(), "src", "agent"),
    executable: process.execPath,
    args: [
      "-e",
      `require("node:fs").writeFileSync("breaker-write.txt", "nope"); process.stdout.write(${JSON.stringify(JSON.stringify(report))})`,
    ],
  });
  assert.equal(writes.status, "UNKNOWN");
  const wrong = { ...report, candidate_sha: "c".repeat(40) };
  const mismatched = await executeIsolatedBreakerProcessV1({
    contract,
    project_root: join(process.cwd(), "src", "agent"),
    executable: process.execPath,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(JSON.stringify(wrong))})`,
    ],
  });
  assert.equal(mismatched.status, "UNKNOWN");
});
