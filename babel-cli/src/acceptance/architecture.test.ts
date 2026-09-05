import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAcceptanceInputSnapshot,
  compileAcceptance,
  planOracles,
  synthesizePatchBlindOracleCandidates,
} from "./index.js";
import {
  buildTaskContractV1,
  freezeTaskContract,
} from "../agent/taskContract.js";

const acceptanceDirectory = dirname(fileURLToPath(import.meta.url));

test("patch-blind compiler and oracle planner have no runtime implementation imports", () => {
  const forbiddenImports = [
    'from "../agent/',
    'from "../diagnostics/',
    'from "../executor/',
    'from "../interactive/',
    'from "../pipeline',
    'from "../runners/',
    'from "../services/',
  ];
  for (const module of ["compiler.ts", "oraclePlanner.ts"]) {
    const source = readFileSync(join(acceptanceDirectory, module), "utf8");
    for (const forbidden of forbiddenImports)
      assert.equal(
        source.includes(forbidden),
        false,
        `${module} must not import ${forbidden}; use an explicit snapshot-only seam`,
      );
  }
});

test("counterexample oracle synthesis is frozen to the pre-implementation snapshot", () => {
  const taskContract = freezeTaskContract(
    buildTaskContractV1({
      mode: "deep",
      user_request:
        "Preserve idempotency and reject unauthorized requests during migration.",
      acceptance_criteria: [
        "The migration must preserve idempotency.",
        "Unauthorized requests must be rejected.",
      ],
      risk: "high",
      source: "acceptance.architecture.test",
    }),
  );
  const snapshot = buildAcceptanceInputSnapshot({ taskContract });
  const contract = compileAcceptance(snapshot);
  const candidates = synthesizePatchBlindOracleCandidates(snapshot, contract);
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((candidate) => candidate.synthesisFamily),
    ["concurrency", "security_policy"],
  );
  assert.ok(candidates.every((candidate) => candidate.createdBeforePatch));
  assert.ok(candidates.every((candidate) => candidate.command === undefined));
  const plan = planOracles(contract, {
    snapshot,
    synthesizeCounterexamples: true,
  });
  assert.ok(plan.steps.every((step) => step.createdBeforePatch));
  assert.ok(plan.steps.every((step) => step.synthesisFamily));
  assert.equal(plan.planner.patchBlind, true);
});
