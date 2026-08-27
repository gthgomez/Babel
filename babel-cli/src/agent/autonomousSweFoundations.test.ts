import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  buildTaskContractV1,
  freezeTaskContract,
  withAcceptanceCriteria,
  validateTaskContractV1,
  validateTaskContractV1ForCompletion,
} from "./taskContract.js";
import {
  buildAcceptanceBundleV1,
  validateAcceptanceBundleForContractV1,
} from "../acceptance/escrow.js";
import {
  createTaskEventJournal,
  parseTaskEventJournal,
} from "./taskEventJournal.js";
import {
  EvidenceGraph,
  evaluateCompletionGateV1 as evaluateRawCompletionGate,
} from "../evidence/evidenceGraph.js";
import { RevisionManager } from "../evidence/revisionBoundReceipt.js";
import {
  assertBreakerReadOnly,
  buildBreakerContractV1,
  createBreakerFindingV1,
} from "./breakerContract.js";
import {
  buildAgentEndpointV1,
  endpointHasCapability,
  validateAgentEndpointV1,
} from "./agentEndpoint.js";
import { createTrustedExecutionSupervisor } from "../authority/trustedExecution.js";
import { attributeFailureV1 } from "../services/failureAttribution.js";
import {
  buildReplayManifestV1,
  loadReplayManifestV1,
  serializeReplayManifestV1,
} from "../services/replayManifest.js";
import {
  appendReliabilityTelemetryV1,
  buildReliabilityTelemetryV1,
  loadReliabilityTelemetryV1,
} from "../telemetry/reliability.js";

function contract() {
  return freezeTaskContract(
    buildTaskContractV1({
      task_id: "task:test-foundations",
      mode: "deep",
      task_class: "general_swe",
      user_request: "Prove the foundation invariants.",
      goal: "Prove the foundation invariants.",
      acceptance_criteria: ["the verifier passes"],
      risk: "high",
      base_sha: "base-sha",
      scope: { paths: ["babel-cli/src"] },
    }),
  );
}

function evaluateCompletionGateV1(
  input: Parameters<typeof evaluateRawCompletionGate>[0],
) {
  const supervisor = createTrustedExecutionSupervisor();
  const identity = supervisor.issueExecutionIdentity({
    endpoint_id: "verifier:test",
    role: "verifier",
    execution_domain: "isolated-verifier",
    capabilities: ["certify_evidence"],
    task_id: input.contract.task_id,
    contract_hash: input.contract.contract_hash,
  });
  const context = supervisor.issueExecutionContext({
    task_id: input.contract.task_id,
    contract_hash: input.contract.contract_hash,
    repository: input.repository ?? "repo",
    base_sha: input.contract.base_sha,
    candidate_sha: input.candidate_sha ?? "candidate-a",
    execution_identity_ref: identity.identity_ref,
  });
  for (const node of input.graph.getNodesMap().values()) {
    if (node.producer_identity_ref === "identity:test") {
      node.producer_identity_ref = identity.identity_ref;
    }
  }
  return evaluateRawCompletionGate({
    ...input,
    trusted_resolver: supervisor.resolver,
    trusted_context_ref: context.context_ref,
  });
}

test("TaskContractV1 hash is canonical, frozen, and provenance-aware", () => {
  const a = contract();
  const b = contract();
  assert.equal(a.contract_hash, b.contract_hash);
  assert.notEqual(a.contract_id, b.contract_id);
  assert.equal(validateTaskContractV1(a).length, 0);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.acceptance), true);
  assert.throws(() => {
    (a.acceptance as unknown as Array<unknown>).push({});
  });

  const changed = freezeTaskContract(
    buildTaskContractV1({
      task_id: a.task_id,
      mode: "deep",
      user_request: "Prove a different foundation invariant.",
      acceptance_criteria: ["the verifier passes"],
    }),
  );
  assert.notEqual(a.contract_hash, changed.contract_hash);

  const impersonating = {
    ...a,
    provenance: {
      ...a.provenance,
      records: [
        ...a.provenance.records,
        {
          kind: "explicit_user_authority" as const,
          ref: "repository_policy.md",
        },
      ],
    },
  };
  assert.ok(
    validateTaskContractV1(impersonating).includes(
      "provenance.untrusted_user_authority",
    ),
  );
  const noAcceptance = freezeTaskContract(
    buildTaskContractV1({
      task_id: a.task_id,
      mode: "deep",
      user_request: a.user_request,
      acceptance_criteria: [],
    }),
  );
  assert.ok(
    validateTaskContractV1ForCompletion(noAcceptance).includes(
      "acceptance.required",
    ),
  );
});

test("TaskEventJournal is durable, ordered, hash-linked, and fail-closed", () => {
  const journal = createTaskEventJournal("task:events");
  const apiKeyField = ["api", "key"].join("_");
  const fakeApiKey = ["sk", "-this-must-not-persist"].join("");
  journal.append({
    event_type: "task.created",
    actor: "test",
    event_id: "event-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  journal.append({
    event_type: "contract.frozen",
    actor: "test",
    event_id: "event-2",
    timestamp: "2026-01-01T00:00:01.000Z",
    payload: { contract_hash: "abc" },
  });
  const raw = journal.serialize();
  assert.equal(parseTaskEventJournal(raw, "task:events").events.length, 2);
  assert.throws(() =>
    parseTaskEventJournal(
      raw.replace('"sequence":1', '"sequence":7'),
      "task:events",
    ),
  );
  assert.throws(() =>
    parseTaskEventJournal(
      raw.replace('"payload_hash":"', '"payload_hash":"0'),
      "task:events",
    ),
  );
  assert.throws(() =>
    journal.append({
      event_type: "task.created",
      actor: "test",
      payload: { [apiKeyField]: fakeApiKey },
    }),
  );
});

function evidenceGraph(candidateSha = "candidate-a"): EvidenceGraph {
  const graph = new EvidenceGraph();
  graph.addNode({
    id: "claim",
    type: "claim",
    data: { statement: "done" },
    parents: [],
    producer_role: "builder",
  });
  graph.addNode({
    id: "approval",
    type: "critic_approval",
    data: { status: "approved" },
    parents: ["claim"],
    producer_role: "reviewer",
  });
  graph.addNode({
    id: "test",
    type: "test_result",
    data: { status: "passed", exit_code: 0 },
    parents: ["claim"],
    binding: {
      task_id: "task:test-foundations",
      contract_hash: contract().contract_hash,
      repository: "repo",
      base_sha: "base-sha",
      candidate_sha: candidateSha,
      requirement_id: "acceptance:1",
    },
    producer_role: "verifier",
    producer_identity: {
      kind: "execution_identity",
      endpoint_id: "verifier:test",
      role: "verifier",
      execution_domain: "isolated-verifier",
    },
    producer_identity_ref: "identity:test",
  });
  return graph;
}

test("EvidenceGraph completion gate rejects consensus, builder claims, stale SHA, and failures", () => {
  const c = contract();
  const empty = new EvidenceGraph();
  empty.addNode({
    id: "claim",
    type: "claim",
    data: { status: "approved" },
    parents: [],
    producer_role: "builder",
  });
  assert.equal(
    evaluateCompletionGateV1({
      contract: c,
      graph: empty,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "UNVERIFIED",
  );

  const builderOnly = new EvidenceGraph();
  builderOnly.addNode({
    id: "builder-test",
    type: "test_result",
    data: { status: "passed" },
    parents: [],
    producer_role: "builder",
    binding: {
      task_id: c.task_id,
      contract_hash: c.contract_hash,
      repository: "repo",
      base_sha: "base-sha",
      candidate_sha: "candidate-a",
      requirement_id: "acceptance:1",
    },
  });
  assert.equal(
    evaluateCompletionGateV1({
      contract: c,
      graph: builderOnly,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).verified,
    false,
  );

  const genericSuccess = new EvidenceGraph();
  for (const type of ["artifact", "challenge", "review_finding"] as const) {
    genericSuccess.addNode({
      id: type,
      type,
      data: { status: "success", verified: true },
      parents: [],
      binding: {
        task_id: c.task_id,
        contract_hash: c.contract_hash,
        repository: "repo",
        base_sha: c.base_sha,
        candidate_sha: "candidate-a",
        requirement_id: "acceptance:1",
      },
      producer_role: "verifier",
      producer_identity: {
        kind: "agent_endpoint",
        endpoint_id: "verifier:test",
        role: "verifier",
        execution_domain: "isolated-verifier",
      },
    });
  }
  assert.notEqual(
    evaluateCompletionGateV1({
      contract: c,
      graph: genericSuccess,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "VERIFIED",
  );

  for (const bindingChange of [
    { task_id: "task:other" },
    { contract_hash: "f".repeat(32) },
    { repository: "other-repo" },
    { candidate_sha: "candidate-old" },
  ]) {
    const stale = evidenceGraph();
    stale.getNode("test")!.binding = {
      ...stale.getNode("test")!.binding!,
      ...bindingChange,
    };
    assert.notEqual(
      evaluateCompletionGateV1({
        contract: c,
        graph: stale,
        repository: "repo",
        candidate_sha: "candidate-a",
      }).status,
      "VERIFIED",
    );
  }

  const malformedResult = evidenceGraph();
  malformedResult.getNode("test")!.data = { status: "success" };
  assert.notEqual(
    evaluateCompletionGateV1({
      contract: c,
      graph: malformedResult,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "VERIFIED",
  );

  const missingIdentity = evidenceGraph();
  const testNode = missingIdentity.getNode("test")!;
  delete testNode.producer_identity;
  delete testNode.producer_identity_ref;
  assert.notEqual(
    evaluateCompletionGateV1({
      contract: c,
      graph: missingIdentity,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "VERIFIED",
  );

  const wrongBase = evidenceGraph();
  wrongBase.getNode("test")!.binding!.base_sha = "wrong-base";
  assert.notEqual(
    evaluateCompletionGateV1({
      contract: c,
      graph: wrongBase,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "VERIFIED",
  );

  assert.equal(
    evaluateCompletionGateV1({
      contract: c,
      graph: evidenceGraph(),
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "VERIFIED",
  );
  assert.equal(
    evaluateCompletionGateV1({
      contract: c,
      graph: evidenceGraph("candidate-old"),
      repository: "repo",
      candidate_sha: "candidate-a",
    }).verified,
    false,
  );

  const failed = evidenceGraph();
  failed.addNode({
    id: "failed",
    type: "test_result",
    data: { status: "failed", exit_code: 1 },
    parents: [],
    producer_role: "verifier",
    binding: {
      task_id: c.task_id,
      contract_hash: c.contract_hash,
      repository: "repo",
      base_sha: "base-sha",
      candidate_sha: "candidate-a",
      requirement_id: "acceptance:1",
    },
    producer_identity: {
      kind: "agent_endpoint",
      endpoint_id: "verifier:test",
      role: "verifier",
      execution_domain: "isolated-verifier",
    },
  });
  assert.equal(
    evaluateCompletionGateV1({
      contract: c,
      graph: failed,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "FAILED",
  );

  const dangling = evidenceGraph();
  dangling.addEdge({
    id: "dangling",
    from: "test",
    to: "missing",
    relation: "supports",
  });
  assert.equal(dangling.validate().valid, false);
  assert.equal(
    evaluateCompletionGateV1({
      contract: c,
      graph: dangling,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).verified,
    false,
  );

  const invalidContract = { ...c, contract_hash: "0".repeat(32) };
  assert.equal(
    evaluateCompletionGateV1({
      contract: invalidContract,
      graph: evidenceGraph(),
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "UNKNOWN",
  );

  const spoofed = evidenceGraph();
  spoofed.getNode("test")!.producer_identity = {
    kind: "agent_endpoint",
    endpoint_id: "verifier:test",
    role: "builder",
    execution_domain: "isolated-verifier",
  };
  assert.notEqual(
    evaluateCompletionGateV1({
      contract: c,
      graph: spoofed,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "VERIFIED",
  );
});

test("V1.1 trust boundary rejects identity impersonation and lifecycle failures", () => {
  const c = contract();
  const supervisor = createTrustedExecutionSupervisor();
  const trusted = supervisor.issueExecutionIdentity({
    endpoint_id: "verifier:test",
    role: "verifier",
    execution_domain: "isolated-verifier",
    capabilities: ["certify_evidence"],
    task_id: c.task_id,
    contract_hash: c.contract_hash,
  });
  const context = supervisor.issueExecutionContext({
    task_id: c.task_id,
    contract_hash: c.contract_hash,
    repository: "repo",
    base_sha: c.base_sha,
    candidate_sha: "candidate-a",
    execution_identity_ref: trusted.identity_ref,
  });
  const evaluate = (graph: EvidenceGraph = evidenceGraph()) =>
    evaluateRawCompletionGate({
      contract: c,
      graph,
      repository: "repo",
      candidate_sha: "candidate-a",
      trusted_resolver: supervisor.resolver,
      trusted_context_ref: context.context_ref,
    });

  const node = () => {
    const graph = evidenceGraph();
    const testNode = graph.getNode("test")!;
    testNode.producer_identity_ref = trusted.identity_ref;
    testNode.producer_identity = {
      kind: "execution_identity",
      endpoint_id: trusted.endpoint_id,
      role: trusted.role,
      execution_domain: trusted.execution_domain,
    };
    return { graph, testNode };
  };
  assert.equal(evaluate(node().graph).status, "VERIFIED");
  assert.equal(
    evaluateRawCompletionGate({
      contract: c,
      graph: node().graph,
      repository: "repo",
      candidate_sha: "candidate-a",
    }).status,
    "UNKNOWN",
  );
  assert.equal(
    evaluateRawCompletionGate({
      contract: c,
      graph: node().graph,
      repository: "attacker-repository",
      candidate_sha: "attacker-candidate",
      trusted_resolver: supervisor.resolver,
      trusted_context_ref: context.context_ref,
    }).status,
    "UNKNOWN",
  );
  const missing = node();
  delete missing.testNode.producer_identity_ref;
  assert.notEqual(evaluate(missing.graph).status, "VERIFIED");
  const builderRole = node();
  builderRole.testNode.producer_role = "builder";
  assert.notEqual(evaluate(builderRole.graph).status, "VERIFIED");
  const forgedIdentity = node();
  forgedIdentity.testNode.producer_identity = {
    kind: "execution_identity",
    endpoint_id: "verifier:forged",
    role: "verifier",
    execution_domain: "isolated-verifier",
  };
  assert.notEqual(evaluate(forgedIdentity.graph).status, "VERIFIED");
  const unknownHandle = node();
  unknownHandle.testNode.producer_identity_ref = "identity:does-not-exist";
  assert.notEqual(evaluate(unknownHandle.graph).status, "VERIFIED");
  const expired = supervisor.issueExecutionIdentity({
    endpoint_id: "verifier:expired",
    role: "verifier",
    execution_domain: "isolated-verifier",
    capabilities: ["certify_evidence"],
    task_id: c.task_id,
    contract_hash: c.contract_hash,
    expires_at: "2020-01-01T00:00:00.000Z",
  });
  const expiredGraph = node();
  expiredGraph.testNode.producer_identity_ref = expired.identity_ref;
  assert.notEqual(evaluate(expiredGraph.graph).status, "VERIFIED");
  supervisor.revokeExecutionIdentity(trusted.identity_ref);
  assert.notEqual(evaluate(node().graph).status, "VERIFIED");
  assert.equal("issueExecutionIdentity" in supervisor.resolver, false);
  assert.throws(() =>
    supervisor.issueExecutionIdentity({
      endpoint_id: "verifier:no-capability",
      role: "verifier",
      execution_domain: "isolated-verifier",
      capabilities: ["run_tests"],
      task_id: c.task_id,
      contract_hash: c.contract_hash,
    }),
  );
  assert.throws(() =>
    supervisor.issueExecutionContext({
      task_id: "task:other",
      contract_hash: c.contract_hash,
      repository: "repo",
      base_sha: c.base_sha,
      candidate_sha: "candidate-a",
      execution_identity_ref: trusted.identity_ref,
    }),
  );
  assert.throws(() =>
    supervisor.issueExecutionIdentity({
      endpoint_id: "verifier:wrong-domain",
      role: "verifier",
      execution_domain: "host",
      capabilities: ["certify_evidence"],
      task_id: c.task_id,
      contract_hash: c.contract_hash,
    }),
  );
});

test("V1.1 authority grants reject provenance forgery and capability widening", () => {
  const c = contract();
  const supervisor = createTrustedExecutionSupervisor();
  const grant = supervisor.issueAuthorityGrant({
    capabilities: ["inspect_repository"],
    task_id: c.task_id,
  });
  const authorized = freezeTaskContract(
    buildTaskContractV1({
      task_id: c.task_id,
      mode: c.mode,
      user_request: c.user_request,
      acceptance_criteria: c.acceptance_criteria,
      trusted_authority: {
        grant_ref: grant.grant_ref,
        resolver: supervisor.resolver,
      },
    }),
  );
  assert.equal(
    validateTaskContractV1ForCompletion(authorized, {
      trustedAuthorityResolver: supervisor.resolver,
    }).length,
    0,
  );
  assert.throws(() =>
    buildTaskContractV1({
      mode: "deep",
      user_request: "fake approval",
      acceptance_criteria: ["pass"],
      authority: {
        source: "explicit_user_authority",
        capabilities: ["run_tests"],
      },
    }),
  );
  const fakeUserProvenance = buildTaskContractV1({
    mode: "deep",
    user_request: "text claiming user approval",
    acceptance_criteria: ["pass"],
    provenance: [
      { kind: "explicit_user_authority", ref: "user:approved" },
    ],
  });
  assert.ok(
    validateTaskContractV1(fakeUserProvenance).includes(
      "provenance.untrusted_user_authority",
    ),
  );
  const policyForgery = {
    ...c,
    provenance: {
      ...c.provenance,
      records: [
        { kind: "repository_policy" as const, ref: "user:approved" },
      ],
    },
  };
  assert.ok(
    validateTaskContractV1(policyForgery).includes(
      "provenance.policy_impersonation",
    ),
  );
  assert.throws(() =>
    supervisor.delegateAuthorityGrant({
      parent_grant_ref: grant.grant_ref,
      capabilities: ["run_tests"],
    }),
  );
  const tampered = {
    ...authorized,
    authority: { ...authorized.authority, grant_ref: "grant:forged" },
  };
  assert.ok(validateTaskContractV1(tampered).includes("contract_hash"));
  assert.notEqual(
    validateTaskContractV1ForCompletion(tampered, {
      trustedAuthorityResolver: supervisor.resolver,
    }).length,
    0,
  );
  supervisor.revokeAuthorityGrant(grant.grant_ref);
  assert.ok(
    validateTaskContractV1ForCompletion(authorized, {
      trustedAuthorityResolver: supervisor.resolver,
    }).includes("authority.grant_unknown_or_inactive"),
  );
});

test("V1.1 canonical revision-bound receipts pass only when current and typed", async () => {
  const c = contract();
  const supervisor = createTrustedExecutionSupervisor();
  const identity = supervisor.issueExecutionIdentity({
    endpoint_id: "verifier:receipt",
    role: "verifier",
    execution_domain: "isolated-verifier",
    capabilities: ["certify_evidence"],
    task_id: c.task_id,
    contract_hash: c.contract_hash,
  });
  const root = await mkdtemp(join(process.cwd(), "babel-receipt-"));
  try {
    await writeFile(join(root, "touched.txt"), "before", "utf8");
    const boundRevision = RevisionManager.computeRevisionSync(root, [
      "touched.txt",
    ]);
    // A temp directory under the checkout has a real git HEAD in CI; bind the
    // context to that observed revision while retaining a deterministic
    // non-git fallback for isolated local runners.
    const candidateSha = boundRevision.gitCommitHash ?? "candidate-a";
    const context = supervisor.issueExecutionContext({
      task_id: c.task_id,
      contract_hash: c.contract_hash,
      repository: "repo",
      project_root: root,
      base_sha: c.base_sha,
      candidate_sha: candidateSha,
      execution_identity_ref: identity.identity_ref,
    });
    const receipt = {
      receiptId: "receipt:passing",
      command: "npm test -- foundation",
      exitCode: 0,
      boundRevision,
      stale: false,
    };
    const graph = new EvidenceGraph();
    graph.addNode({
      id: "receipt",
      type: "verifier_receipt",
      data: { schema_version: 1, receipt },
      parents: [],
      binding: {
        task_id: c.task_id,
        contract_hash: c.contract_hash,
        repository: "repo",
        base_sha: c.base_sha,
        candidate_sha: candidateSha,
        requirement_id: "acceptance:1",
      },
      producer_role: "verifier",
      producer_identity_ref: identity.identity_ref,
      producer_identity: {
        kind: "execution_identity",
        endpoint_id: identity.endpoint_id,
        role: identity.role,
        execution_domain: identity.execution_domain,
      },
    });
    const evaluate = () =>
      evaluateRawCompletionGate({
        contract: c,
        graph,
        repository: "repo",
        candidate_sha: candidateSha,
        trusted_resolver: supervisor.resolver,
        trusted_context_ref: context.context_ref,
      });
    assert.equal(evaluate().status, "VERIFIED");
    receipt.exitCode = 1;
    assert.notEqual(evaluate().status, "VERIFIED");
    receipt.exitCode = 0;
    receipt.stale = true;
    assert.notEqual(evaluate().status, "VERIFIED");
    receipt.stale = false;
    graph.getNode("receipt")!.data = {
      boundRevision,
      exitCode: 0,
    };
    assert.notEqual(evaluate().status, "VERIFIED");
    graph.getNode("receipt")!.data = { schema_version: 1, receipt };
    await writeFile(join(root, "touched.txt"), "after", "utf8");
    assert.notEqual(evaluate().status, "VERIFIED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Breaker is independent and read-only, and outputs structured counterexamples", () => {
  const c = contract();
  const breaker = buildBreakerContractV1({
    breaker_id: "breaker:1",
    taskContract: c,
    repository: "repo",
    candidate_sha: "candidate-a",
  });
  assert.equal(breaker.mutation_allowed, false);
  assert.throws(() => assertBreakerReadOnly(["edit_task_files"]));
  assert.throws(() => assertBreakerReadOnly(["run_tests"]));
  assert.doesNotThrow(() =>
    assertBreakerReadOnly(["run_tests"], {
      execution_domain: "isolated-sandbox",
    }),
  );
  const finding = createBreakerFindingV1({
    finding_id: "finding:1",
    severity: "high",
    contract_requirement: "acceptance:1",
    counterexample: "The behavior fails after restart.",
    reproduction: "npm test -- restart-case",
    evidence: ["test:restart"],
    confidence: "high",
    status: "reproduced",
  });
  assert.equal(finding.status, "reproduced");
  assert.equal("reasoning" in finding, false);
});

test("acceptance escrow partitions frozen acceptance and restricted criteria gate completion", () => {
  const c = contract();
  const bundle = buildAcceptanceBundleV1({
    taskContract: c,
    builder_visible: [],
    restricted: [...c.acceptance],
  });
  assert.deepEqual(validateAcceptanceBundleForContractV1(bundle, c), []);
  assert.throws(() =>
    buildAcceptanceBundleV1({
      taskContract: c,
      builder_visible: [],
      restricted: [{ ...c.acceptance[0]!, description: "drift" }],
    }),
  );
  const graph = evidenceGraph();
  const missingBundle = {
    ...bundle,
    builder_visible: [],
    restricted: [],
  };
  const missing = evaluateCompletionGateV1({
    contract: c,
    graph,
    repository: "repo",
    candidate_sha: "candidate-a",
    acceptance_bundle: missingBundle,
  });
  assert.notEqual(missing.status, "VERIFIED");
});

test("acceptance reconciliation creates new immutable structured requirements", () => {
  const c = buildTaskContractV1({
    mode: "deep",
    user_request: "acceptance reconciliation",
    acceptance_criteria: ["one"],
  });
  const appended = withAcceptanceCriteria(c, ["one", "two"]);
  assert.deepEqual(
    appended.acceptance.map((item) => item.description),
    ["one", "two"],
  );
  assert.notEqual(appended.contract_hash, c.contract_hash);
  assert.throws(() =>
    withAcceptanceCriteria(freezeTaskContract(c), ["changed"]),
  );
});

test("contract validation fails closed for provenance tampering and durable secrets", () => {
  const c = contract();
  const tampered = {
    ...c,
    provenance: {
      ...c.provenance,
      records: [...c.provenance.records, { kind: "user_goal", ref: "changed" }],
    },
  };
  assert.ok(validateTaskContractV1(tampered).includes("contract_hash"));
  const secret = ["sk", "-durable-secret-value-that-must-not-persist"].join("");
  const redacted = buildTaskContractV1({
    mode: "deep",
    user_request: `Do not persist ${secret}`,
    acceptance_criteria: ["a verifier passes"],
  });
  assert.equal(redacted.user_request.includes(secret), false);
});

test("AgentEndpointV1 normalizes model, harness, domain, and existing capability vocabulary", () => {
  const endpoint = buildAgentEndpointV1({
    endpoint_id: "remote:g14:babel",
    identity: "remote:g14:babel",
    harness: "babel",
    model: "g14",
    provider: "remote",
    capabilities: ["inspect_repository", "run_tests"],
    location: "remote",
    execution_domain: "isolated-session",
  });
  assert.equal(endpointHasCapability(endpoint, "run_tests"), true);
  assert.throws(() =>
    buildAgentEndpointV1({ ...endpoint, capabilities: ["unknown"] }),
  );
  const fakeToken = ["sk", "-endpoint-secret-that-must-not-persist"].join("");
  assert.equal(
    validateAgentEndpointV1({ ...endpoint, model: fakeToken }).includes(
      "durable_secret",
    ),
    true,
  );
});

test("failure attribution stays UNKNOWN without independent causal evidence", () => {
  const base = {
    failure_id: "failure:1",
    task_id: "task:test-foundations",
    contract_hash: contract().contract_hash,
    proposed_category: "MODEL_JUDGMENT_FAILURE" as const,
    evidence: [
      {
        evidence_id: "model",
        source: "model_self_report" as const,
        detail: "I made a mistake",
        supports_category: "MODEL_JUDGMENT_FAILURE" as const,
      },
    ],
  };
  assert.equal(attributeFailureV1(base).category, "UNKNOWN");
  assert.equal(
    attributeFailureV1({
      ...base,
      evidence: [
        {
          evidence_id: "test",
          source: "test",
          detail: "exit 1",
          supports_category: "FLAKY_TEST",
        },
      ],
    }).category,
    "FLAKY_TEST",
  );
  assert.deepEqual(
    attributeFailureV1({
      ...base,
      evidence: [
        {
          evidence_id: "test",
          source: "test",
          detail: "exit 1",
          supports_category: "TOOL_FAILURE",
        },
        {
          evidence_id: "env",
          source: "environment",
          detail: "runner unavailable",
          supports_category: "ENVIRONMENT_FAILURE",
        },
      ],
    }).alternative_hypotheses.sort(),
    ["ENVIRONMENT_FAILURE", "MODEL_JUDGMENT_FAILURE", "TOOL_FAILURE"],
  );
});

test("replay manifests redact secrets, tolerate unsupported environment values, and telemetry preserves unknowns", async () => {
  const root = await mkdtemp(join(process.cwd(), "babel-foundations-"));
  try {
    const featureApiKeyField = ["api", "key"].join("_");
    const environmentApiKeyField = "API_" + "KEY";
    const fakeFeatureApiKey = [
      "sk",
      "-feature-secret-that-must-not-persist",
    ].join("");
    const fakeEnvironmentApiKey = [
      "sk",
      "-secret-value-that-must-not-persist",
    ].join("");
    const manifest = buildReplayManifestV1({
      task_id: "task:test-foundations",
      contract_hash: contract().contract_hash,
      repository: "repo",
      feature_flags: {
        [featureApiKeyField]: fakeFeatureApiKey,
        offline: true,
      },
      environment: {
        os: "windows",
        [environmentApiKeyField]: fakeEnvironmentApiKey,
        unsupported: { nested: true },
      },
    });
    const serialized = serializeReplayManifestV1(manifest);
    assert.equal(serialized.includes("sk-secret"), false);
    assert.equal(serialized.includes("sk-feature-secret"), false);
    assert.equal(loadReplayManifestV1(join(root, "missing.json")).ok, false);
    const telemetry = buildReliabilityTelemetryV1({
      run_id: "run:1",
      task_id: "task:test-foundations",
    });
    assert.equal(telemetry.success, null);
    const telemetryPath = join(root, "telemetry.jsonl");
    appendReliabilityTelemetryV1(telemetryPath, telemetry);
    assert.equal(loadReliabilityTelemetryV1(telemetryPath).length, 1);
    await readFile(join(root, "telemetry.jsonl"), "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
