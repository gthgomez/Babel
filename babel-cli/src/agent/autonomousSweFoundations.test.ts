import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Canonical } from "../acceptance/canonical.js";

import {
  buildTaskContractV1,
  freezeTaskContract,
  withAcceptanceCriteria,
  validateTaskContractV1,
  validateTaskContractV1ForCompletion,
} from "./taskContract.js";
import type {
  AcceptanceRequirementType,
  TaskContractV1,
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
  RevisionManager,
  type RevisionBoundReceipt,
} from "../evidence/revisionBoundReceipt.js";
import {
  EvidenceGraph,
  evaluateCompletionGateV1 as evaluateCompletionGateV1Raw,
} from "../evidence/evidenceGraph.js";
import { createTrustedExecutionSupervisorV1 } from "../authority/trustedExecutionSupervisor.js";
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
import { attributeFailureV1 } from "../services/failureAttribution.js";
import {
  buildReplayManifestV1,
  loadReplayManifestV1,
  parseReplayManifestV1,
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

function verifierEndpoint(endpoint_id = "verifier:test") {
  return buildAgentEndpointV1({
    endpoint_id,
    identity: endpoint_id,
    harness: "babel",
    model: "test",
    provider: "test",
    capabilities: [
      "run_tests",
      "run_build",
      "run_lint",
      "run_typecheck",
      "run_local_command",
      "inspect_external_device",
    ],
    location: "local",
    execution_domain: "isolated-verifier",
  });
}

function trustedExecutionFor(
  c: TaskContractV1,
  runId = "run:test-foundations",
  endpoint = verifierEndpoint(),
) {
  const issuer = authoritativeTestSupervisor;
  const role = c.acceptance[0]?.type === "runtime" ? "observer" : "verifier";
  if (!issuer.read.get(runId, endpoint.endpoint_id)) {
    issuer.assign({
      run_id: runId,
      task_id: c.task_id,
      contract_hash: c.contract_hash,
      role,
      endpoint,
    });
  }
  return authoritativeTestSupervisor.read;
}

const authoritativeTestSupervisor = createTrustedExecutionSupervisorV1();

function trustedExecution() {
  return trustedExecutionFor(contract());
}

function evaluateCompletionGateV1(
  input: Omit<
    Parameters<typeof evaluateCompletionGateV1Raw>[0],
    "run_id" | "trusted_execution"
  > &
    Partial<
      Pick<
        Parameters<typeof evaluateCompletionGateV1Raw>[0],
        "run_id" | "trusted_execution"
      >
    >,
) {
  return evaluateCompletionGateV1Raw({
    ...input,
    run_id: input.run_id ?? "run:test-foundations",
    trusted_execution: input.trusted_execution ?? trustedExecution(),
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
      "provenance.authority_impersonation",
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
  const journal = createTaskEventJournal("task:events", {
    run_id: "run:events",
    contract_hash: "contract:events",
  });
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
  const requirement = contract().acceptance[0]!;
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
    data: {
      status: "passed",
      exit_code: 0,
      verifier_id: requirement.verification.verifier_id,
      verifier_spec_hash: sha256Canonical(requirement.verification),
      command_hash: requirement.verification.command_hash,
    },
    parents: ["claim"],
    binding: {
      run_id: "run:test-foundations",
      task_id: "task:test-foundations",
      contract_hash: contract().contract_hash,
      repository: "repo",
      base_sha: "base-sha",
      candidate_sha: candidateSha,
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
      run_id: "run:test-foundations",
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
        run_id: "run:test-foundations",
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
      run_id: "run:test-foundations",
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

test("V1 certification requires an orchestrator-assigned producer identity", () => {
  const c = contract();
  const cases = [
    [
      "builder relabels itself",
      (graph: EvidenceGraph) => {
        graph.getNode("test")!.producer_role = "builder";
        graph.getNode("test")!.producer_identity!.role = "builder";
      },
      trustedExecutionFor(c),
    ],
    [
      "unknown endpoint",
      (graph: EvidenceGraph) => {
        graph.getNode("test")!.producer_identity!.endpoint_id =
          "verifier:unknown";
      },
      trustedExecutionFor(c),
    ],
    [
      "wrong role",
      (graph: EvidenceGraph) => {
        graph.getNode("test")!.producer_identity!.role = "observer";
        graph.getNode("test")!.producer_role = "observer";
      },
      trustedExecutionFor(c),
    ],
    [
      "wrong execution domain",
      (graph: EvidenceGraph) => {
        graph.getNode("test")!.producer_identity!.execution_domain = "host";
      },
      trustedExecutionFor(c),
    ],
  ] as const;
  for (const [name, mutate, registry] of cases) {
    const graph = evidenceGraph();
    mutate(graph);
    assert.notEqual(
      evaluateCompletionGateV1Raw({
        contract: c,
        graph,
        repository: "repo",
        candidate_sha: "candidate-a",
        run_id: "run:test-foundations",
        trusted_execution: registry,
      }).status,
      "VERIFIED",
      name,
    );
  }
  const wrongTaskRegistry = trustedExecutionFor(
    c,
    "run:test-foundations",
    verifierEndpoint(),
  );
  const wrongTaskEndpoint = verifierEndpoint();
  const otherTaskSupervisor = createTrustedExecutionSupervisorV1();
  const otherTaskRegistry = otherTaskSupervisor;
  otherTaskRegistry.assign({
    run_id: "run:test-foundations",
    task_id: "task:other",
    contract_hash: c.contract_hash,
    role: "verifier",
    endpoint: wrongTaskEndpoint,
  });
  assert.notEqual(
    evaluateCompletionGateV1Raw({
      contract: c,
      graph: evidenceGraph(),
      repository: "repo",
      candidate_sha: "candidate-a",
      run_id: "run:test-foundations",
      trusted_execution: otherTaskSupervisor.read,
    }).status,
    "VERIFIED",
  );
  assert.equal(
    evaluateCompletionGateV1Raw({
      contract: c,
      graph: evidenceGraph(),
      repository: "repo",
      candidate_sha: "candidate-a",
      run_id: "run:test-foundations",
      trusted_execution: trustedExecutionFor(c),
    }).status,
    "VERIFIED",
  );
  void wrongTaskRegistry;
});

test("frozen verifier specifications are required and hash-bound", () => {
  const c = contract();
  const wrongVerifier = evidenceGraph();
  (wrongVerifier.getNode("test")!.data as Record<string, unknown>).verifier_id =
    "verifier:wrong";
  assert.notEqual(
    evaluateCompletionGateV1Raw({
      contract: c,
      graph: wrongVerifier,
      repository: "repo",
      candidate_sha: "candidate-a",
      run_id: "run:test-foundations",
      trusted_execution: trustedExecutionFor(c),
    }).status,
    "VERIFIED",
  );
  const wrongRequirement = evidenceGraph();
  wrongRequirement.getNode("test")!.binding!.requirement_id =
    "acceptance:other";
  assert.notEqual(
    evaluateCompletionGateV1Raw({
      contract: c,
      graph: wrongRequirement,
      repository: "repo",
      candidate_sha: "candidate-a",
      run_id: "run:test-foundations",
      trusted_execution: trustedExecutionFor(c),
    }).status,
    "VERIFIED",
  );
  const staleSpec = evidenceGraph();
  (
    staleSpec.getNode("test")!.data as Record<string, unknown>
  ).verifier_spec_hash = "f".repeat(64);
  assert.notEqual(
    evaluateCompletionGateV1Raw({
      contract: c,
      graph: staleSpec,
      repository: "repo",
      candidate_sha: "candidate-a",
      run_id: "run:test-foundations",
      trusted_execution: trustedExecutionFor(c),
    }).status,
    "VERIFIED",
  );
  const tampered = {
    ...c,
    acceptance: [
      {
        ...c.acceptance[0]!,
        verification: {
          ...c.acceptance[0]!.verification,
          verifier_id: "verifier:tampered",
        },
      },
    ],
  };
  assert.notEqual(validateTaskContractV1ForCompletion(tampered).length, 0);
});

test("revision-bound receipts use their own schema and stale checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "babel-revision-receipt-"));
  try {
    const file = join(root, "verified.txt");
    await writeFile(file, "ok\n", "utf8");
    const c = contract();
    const revision = await RevisionManager.computeRevision(root, [
      "verified.txt",
    ]);
    const receipt: RevisionBoundReceipt = {
      receiptId: "receipt:1",
      command: "node verifier",
      exitCode: 0,
      boundRevision: revision,
      stale: false,
    };
    const node = (): EvidenceGraph => {
      const graph = new EvidenceGraph();
      const requirement = c.acceptance[0]!;
      graph.addNode({
        id: "receipt",
        type: "verifier_receipt",
        data: {
          ...receipt,
          verifier_id: requirement.verification.verifier_id,
          verifier_spec_hash: sha256Canonical(requirement.verification),
          command_hash: requirement.verification.command_hash,
        },
        parents: [],
        binding: {
          run_id: "run:test-foundations",
          task_id: c.task_id,
          contract_hash: c.contract_hash,
          repository: "repo",
          base_sha: c.base_sha,
          candidate_sha: "candidate-a",
          requirement_id: requirement.id,
        },
        producer_role: "verifier",
        producer_identity: {
          kind: "agent_endpoint",
          endpoint_id: "verifier:test",
          role: "verifier",
          execution_domain: "isolated-verifier",
        },
      });
      return graph;
    };
    const evaluateReceipt = (graph: EvidenceGraph) =>
      evaluateCompletionGateV1Raw({
        contract: c,
        graph,
        repository: "repo",
        project_root: root,
        candidate_sha: "candidate-a",
        run_id: "run:test-foundations",
        trusted_execution: trustedExecutionFor(c),
      });
    const validResult = evaluateReceipt(node());
    assert.equal(validResult.status, "VERIFIED", JSON.stringify(validResult));
    const failed = node();
    (failed.getNode("receipt")!.data as Record<string, unknown>).exitCode = 1;
    assert.equal(evaluateReceipt(failed).verified, false);
    const stale = node();
    (stale.getNode("receipt")!.data as Record<string, unknown>).stale = true;
    assert.equal(evaluateReceipt(stale).verified, false);
    await writeFile(file, "changed\n", "utf8");
    assert.equal(evaluateReceipt(node()).verified, false);
    const malformed = node();
    (
      malformed.getNode("receipt")!.data as Record<string, unknown>
    ).boundRevision = {};
    assert.equal(evaluateReceipt(malformed).verified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function typedContract(type: AcceptanceRequirementType): TaskContractV1 {
  const strategy = `run the ${type} verifier`;
  const verification = {
    kind: type,
    verifier_id: `verifier:${type}`,
    command_hash: sha256Canonical(strategy),
  };
  return freezeTaskContract(
    buildTaskContractV1({
      task_id: `task:${type}`,
      mode: "deep",
      task_class: "general_swe",
      user_request: `prove ${type}`,
      acceptance_criteria: [`${type} passes`],
      acceptance: [
        {
          id: "acceptance:1",
          description: `${type} passes`,
          type,
          required: true,
          verification_strategy: strategy,
          verification,
        },
      ],
      scope: { paths: ["src"] },
      base_sha: "base-sha",
    }),
  );
}

test("acceptance type matrix is explicit and fail-closed", () => {
  const cases: Array<{
    type: AcceptanceRequirementType;
    evidenceType:
      | "test_result"
      | "build_result"
      | "command_result"
      | "security_result"
      | "policy_result"
      | "runtime_observation";
  }> = [
    { type: "unit_test", evidenceType: "test_result" },
    { type: "integration_test", evidenceType: "test_result" },
    { type: "e2e", evidenceType: "test_result" },
    { type: "build", evidenceType: "build_result" },
    { type: "lint", evidenceType: "command_result" },
    { type: "typecheck", evidenceType: "command_result" },
    { type: "security", evidenceType: "security_result" },
    { type: "policy", evidenceType: "policy_result" },
    { type: "runtime", evidenceType: "runtime_observation" },
    { type: "custom", evidenceType: "command_result" },
    { type: "manual", evidenceType: "command_result" },
  ];
  for (const item of cases) {
    const c = typedContract(item.type);
    const requirement = c.acceptance[0]!;
    const runId = `run:${item.type}`;
    const trusted = trustedExecutionFor(
      c,
      runId,
      verifierEndpoint(`verifier:${item.type}`),
    );
    const makeGraph = (evidenceType: string, candidateSha = "candidate-a") => {
      const graph = new EvidenceGraph();
      const data: Record<string, unknown> = {
        status: item.type === "runtime" ? "observed" : "passed",
        passed: item.type === "runtime" ? true : undefined,
        exit_code: item.type === "runtime" ? undefined : 0,
        verifier_id: requirement.verification.verifier_id,
        verifier_spec_hash: sha256Canonical(requirement.verification),
        command_hash: requirement.verification.command_hash,
        verifier_kind: item.type,
      };
      graph.addNode({
        id: "evidence",
        type: evidenceType as never,
        data,
        parents: [],
        binding: {
          run_id: runId,
          task_id: c.task_id,
          contract_hash: c.contract_hash,
          repository: "repo",
          base_sha: c.base_sha,
          candidate_sha: candidateSha,
          requirement_id: requirement.id,
        },
        producer_role: item.type === "runtime" ? "observer" : "verifier",
        producer_identity: {
          kind: "agent_endpoint",
          endpoint_id: `verifier:${item.type}`,
          role: item.type === "runtime" ? "observer" : "verifier",
          execution_domain: "isolated-verifier",
        },
      });
      return graph;
    };
    const allowed = evaluateCompletionGateV1Raw({
      contract: c,
      graph: makeGraph(item.evidenceType),
      repository: "repo",
      candidate_sha: "candidate-a",
      run_id: runId,
      trusted_execution: trusted,
    });
    if (item.type === "manual") assert.notEqual(allowed.status, "VERIFIED");
    else assert.equal(allowed.status, "VERIFIED", item.type);

    const disallowed = makeGraph("artifact");
    assert.notEqual(
      evaluateCompletionGateV1Raw({
        contract: c,
        graph: disallowed,
        repository: "repo",
        candidate_sha: "candidate-a",
        run_id: runId,
        trusted_execution: trusted,
      }).status,
      "VERIFIED",
    );
    if (item.type !== "manual") {
      const failed = makeGraph(item.evidenceType);
      (failed.getNode("evidence")!.data as Record<string, unknown>).status =
        "failed";
      (failed.getNode("evidence")!.data as Record<string, unknown>).exit_code =
        1;
      assert.notEqual(
        evaluateCompletionGateV1Raw({
          contract: c,
          graph: failed,
          repository: "repo",
          candidate_sha: "candidate-a",
          run_id: runId,
          trusted_execution: trusted,
        }).status,
        "VERIFIED",
      );
      const malformed = makeGraph(item.evidenceType);
      malformed.getNode("evidence")!.data = {};
      assert.notEqual(
        evaluateCompletionGateV1Raw({
          contract: c,
          graph: malformed,
          repository: "repo",
          candidate_sha: "candidate-a",
          run_id: runId,
          trusted_execution: trusted,
        }).status,
        "VERIFIED",
      );
      assert.notEqual(
        evaluateCompletionGateV1Raw({
          contract: c,
          graph: makeGraph(item.evidenceType, "candidate-old"),
          repository: "repo",
          candidate_sha: "candidate-a",
          run_id: runId,
          trusted_execution: trusted,
        }).status,
        "VERIFIED",
      );
    }
  }
});

test("strict completion validation never upgrades partial or legacy-shaped contracts", () => {
  const c = contract();
  for (const field of ["authority", "scope", "provenance"] as const) {
    const partial = { ...c } as Record<string, unknown>;
    delete partial[field];
    assert.notEqual(
      validateTaskContractV1ForCompletion(partial).length,
      0,
      field,
    );
  }
  const unknownField = { ...c, unexpected_authority: true };
  assert.notEqual(validateTaskContractV1ForCompletion(unknownField).length, 0);
  assert.equal(validateTaskContractV1(c).length, 0);
});

test("Breaker is independent and read-only, and outputs structured counterexamples", () => {
  const c = contract();
  const breaker = buildBreakerContractV1({
    breaker_id: "breaker:1",
    taskContract: c,
    repository: "repo",
    candidate_sha: "candidate-a",
    run_id: "run:test-foundations",
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
  assert.throws(() => buildAgentEndpointV1({ ...endpoint, endpoint_id: "" }));
  assert.throws(() => buildAgentEndpointV1({ ...endpoint, identity: "other" }));
  assert.throws(() =>
    buildAgentEndpointV1({ ...endpoint, execution_domain: " " }),
  );
  assert.throws(() =>
    buildAgentEndpointV1({
      ...endpoint,
      capabilities: ["run_tests", "run_tests"],
    }),
  );
  assert.notEqual(
    validateAgentEndpointV1({ ...endpoint, provider: "bad provider" }).length,
    0,
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
  const repeated = attributeFailureV1({
    ...base,
    evidence: [
      {
        evidence_id: "same-observation-a",
        source: "test",
        detail: "exit 1",
        supports_category: "TOOL_FAILURE",
        producer_id: "verifier:a",
        source_domain: "ci",
        run_id: "run:1",
        observation_id: "obs:1",
      },
      {
        evidence_id: "same-observation-b",
        source: "test",
        detail: "exit 1",
        supports_category: "TOOL_FAILURE",
        producer_id: "verifier:a",
        source_domain: "ci",
        run_id: "run:1",
        observation_id: "obs:1",
      },
    ],
  });
  assert.equal(repeated.confidence, "medium");
  const corroborated = attributeFailureV1({
    ...base,
    evidence: [
      {
        evidence_id: "command",
        source: "command",
        detail: "command failed",
        supports_category: "TOOL_FAILURE",
        producer_id: "verifier:a",
        source_domain: "isolated-command",
        run_id: "run:1",
        observation_id: "obs:command",
      },
      {
        evidence_id: "capability",
        source: "environment",
        detail: "capability unavailable",
        supports_category: "TOOL_FAILURE",
        producer_id: "system:b",
        source_domain: "capability-snapshot",
        run_id: "run:2",
        observation_id: "obs:capability",
      },
    ],
  });
  assert.equal(corroborated.confidence, "high");
  const conflict = attributeFailureV1({
    ...base,
    evidence: [
      {
        evidence_id: "command",
        source: "command",
        detail: "command failed",
        supports_category: "TOOL_FAILURE",
        producer_id: "verifier:a",
        source_domain: "isolated-command",
        run_id: "run:1",
        observation_id: "obs:command",
      },
      {
        evidence_id: "environment",
        source: "environment",
        detail: "runner unavailable",
        supports_category: "ENVIRONMENT_FAILURE",
        producer_id: "system:b",
        source_domain: "capability-snapshot",
        run_id: "run:2",
        observation_id: "obs:environment",
      },
    ],
  });
  assert.equal(conflict.category, "UNKNOWN");
  assert.equal(conflict.confidence, "unknown");
});

test("replay manifests redact secrets, tolerate unsupported environment values, and telemetry preserves unknowns", async () => {
  const root = await mkdtemp(join(tmpdir(), "babel-foundations-"));
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
    const handcrafted = JSON.parse(serialized) as Record<string, any>;
    const {
      manifest_id: _manifestId,
      manifest_hash: _manifestHash,
      ...body
    } = handcrafted;
    (body.environment as Record<string, unknown>)[environmentApiKeyField] =
      fakeEnvironmentApiKey;
    const hashed = {
      ...body,
      manifest_id: "rm1:tampered",
      manifest_hash: sha256Canonical(body),
    };
    assert.equal(parseReplayManifestV1(hashed).ok, false);
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
