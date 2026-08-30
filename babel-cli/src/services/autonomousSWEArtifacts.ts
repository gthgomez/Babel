import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildAcceptanceBundleV1,
  serializeAcceptanceBundleV1,
} from "../acceptance/escrow.js";
import {
  buildTaskContractV1,
  freezeTaskContract,
  type TaskRisk,
} from "../agent/taskContract.js";
import {
  createTaskEventJournal,
  TASK_EVENTS_FILENAME,
} from "../agent/taskEventJournal.js";
import {
  EvidenceGraph,
  serializeEvidenceGraphV1,
} from "../evidence/evidenceGraph.js";
import {
  buildReplayManifestV1,
  serializeReplayManifestV1,
} from "./replayManifest.js";
import {
  appendReliabilityTelemetryV1,
  buildReliabilityTelemetryV1,
  RELIABILITY_TELEMETRY_FILENAME,
} from "../telemetry/reliability.js";
import { redactEvidenceValue } from "../utils/redaction.js";

export interface AutonomousSWEArtifactPathsV1 {
  directory: string;
  task_contract: string;
  acceptance_bundle: string;
  task_events: string;
  evidence_graph: string;
  replay_manifest: string;
  reliability_telemetry: string;
}

export interface AutonomousSWEArtifactResultV1 {
  task_id: string;
  contract_hash: string;
  mutation_subagents_enabled: false;
  paths: AutonomousSWEArtifactPathsV1;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(
    path,
    `${JSON.stringify(redactEvidenceValue(value), null, 2)}\n`,
    "utf8",
  );
}

/**
 * Emit the minimum control-plane artifacts for the existing read-only Full
 * proof lane. This is additive and does not execute or enable mutating workers.
 */
export function writeAutonomousSWEArtifactsV1(input: {
  runDir: string;
  task: string;
  run_id: string;
  project_root?: string | null;
  base_sha?: string | null;
  candidate_sha?: string | null;
  risk?: TaskRisk;
  model?: string | null;
  harness?: string | null;
  tool_profile?: string | null;
}): AutonomousSWEArtifactResultV1 {
  const directory = join(input.runDir, "autonomous-swe-v1");
  mkdirSync(directory, { recursive: true });
  const taskContract = freezeTaskContract(
    buildTaskContractV1({
      task_id: `task:${input.run_id}`,
      mode: "deep",
      user_request: input.task,
      goal: input.task,
      task_class: "general_swe",
      acceptance_criteria: [input.task],
      required_behaviors: [input.task],
      non_goals: [
        "Do not enable autonomous mutating multi-worker orchestration.",
      ],
      scope: { paths: [input.project_root ?? "<unspecified-project>"] },
      risk: input.risk ?? "high",
      authority: {
        capabilities: ["inspect_repository", "search_repository", "run_tests"],
        source: "derived_policy",
      },
      base_sha: input.base_sha ?? null,
      source: "babel-full.read-only-proof-lane",
    }),
  );
  const acceptanceBundle = buildAcceptanceBundleV1({ taskContract });
  const journal = createTaskEventJournal(taskContract.task_id, {
    run_id: input.run_id,
    contract_hash: taskContract.contract_hash,
  });
  const timestamp = taskContract.created_at;
  journal.append({
    event_type: "task.created",
    actor: "babel-full",
    timestamp,
    payload: { run_id: input.run_id },
  });
  journal.append({
    event_type: "contract.created",
    actor: "babel-full",
    timestamp,
    payload: { contract_hash: taskContract.contract_hash },
  });
  journal.append({
    event_type: "contract.frozen",
    actor: "babel-full",
    timestamp,
    payload: { contract_hash: taskContract.contract_hash },
  });
  journal.append({
    event_type: "plan.created",
    actor: "babel-full",
    timestamp,
    payload: { mutation_subagents_enabled: false },
  });

  const graph = new EvidenceGraph();
  for (const requirement of taskContract.acceptance) {
    graph.addNode({
      id: `requirement:${requirement.id}`,
      type: "contract_requirement",
      data: { description: requirement.description },
      parents: [],
      binding: {
        run_id: input.run_id,
        task_id: taskContract.task_id,
        contract_hash: taskContract.contract_hash,
        repository: input.project_root ?? "<unspecified-project>",
        base_sha: taskContract.base_sha,
        candidate_sha: input.candidate_sha ?? "<not-yet-executed>",
        requirement_id: requirement.id,
      },
      producer_role: "system",
    });
  }

  const replayManifest = buildReplayManifestV1({
    task_id: taskContract.task_id,
    contract_hash: taskContract.contract_hash,
    repository: input.project_root ?? "<unspecified-project>",
    base_sha: taskContract.base_sha,
    candidate_sha: input.candidate_sha ?? null,
    model: input.model ?? null,
    harness: input.harness ?? "babel-full",
    tool_profile: input.tool_profile ?? "read-only-proof",
    verification_commands: [],
    verification_result: null,
    environment: { execution_mode: "read_only_proof" },
    created_at: timestamp,
  });
  const telemetry = buildReliabilityTelemetryV1({
    run_id: input.run_id,
    task_id: taskContract.task_id,
    task_class: taskContract.task_class,
    risk: taskContract.risk,
    model: input.model ?? null,
    harness: input.harness ?? "babel-full",
    tool_profile: input.tool_profile ?? "read-only-proof",
  });

  const paths: AutonomousSWEArtifactPathsV1 = {
    directory,
    task_contract: join(directory, "task-contract.json"),
    acceptance_bundle: join(directory, "acceptance-bundle.json"),
    task_events: join(directory, TASK_EVENTS_FILENAME),
    evidence_graph: join(directory, "evidence-graph.json"),
    replay_manifest: join(directory, "replay-manifest.json"),
    reliability_telemetry: join(directory, RELIABILITY_TELEMETRY_FILENAME),
  };
  writeJson(paths.task_contract, taskContract);
  writeFileSync(
    paths.acceptance_bundle,
    serializeAcceptanceBundleV1(acceptanceBundle),
    "utf8",
  );
  journal.save(paths.task_events);
  writeFileSync(
    paths.evidence_graph,
    serializeEvidenceGraphV1({
      graph,
      task_id: taskContract.task_id,
      contract_hash: taskContract.contract_hash,
    }),
    "utf8",
  );
  writeFileSync(
    paths.replay_manifest,
    serializeReplayManifestV1(replayManifest),
    "utf8",
  );
  appendReliabilityTelemetryV1(paths.reliability_telemetry, telemetry);
  return {
    task_id: taskContract.task_id,
    contract_hash: taskContract.contract_hash,
    mutation_subagents_enabled: false,
    paths,
  };
}
