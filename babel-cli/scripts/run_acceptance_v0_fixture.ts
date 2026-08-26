import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildAcceptanceExperimentManifest,
  buildOfflineFixtureDetectionReport,
  coordinateDetectionCell,
  validateAcceptanceDatasetManifestV0,
  type AcceptanceDatasetManifestV0,
} from "../src/acceptance/index.js";
import { buildAcceptanceV0SpecialFixtureTrials } from "../src/acceptance/specialFixtures.js";
import { runCodingCanary } from "../src/eval/canary/runner.js";
import { CANARY_TASKS, getCanaryTask } from "../src/eval/canary/tasks.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredOption(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadDataset(path: string): AcceptanceDatasetManifestV0 {
  const dataset = JSON.parse(
    readFileSync(path, "utf8"),
  ) as AcceptanceDatasetManifestV0;
  const errors = validateAcceptanceDatasetManifestV0(dataset);
  if (errors.length > 0) {
    throw new Error(`invalid acceptance dataset: ${errors.join(", ")}`);
  }
  return dataset;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Run only the provider-free detector wiring self-test. This intentionally
 * refuses live/prevention execution; those cells require an authorized,
 * preregistered campaign runner and sealed candidate/oracle inputs.
 */
function main(): void {
  const phase = option("--phase") ?? "detection";
  const provider = option("--provider") ?? "mock";
  const datasetPath = resolve(
    process.cwd(),
    option("--dataset") ?? "../benchmarks/acceptance-v0-dataset.json",
  );
  const sourceManifestPath = resolve(
    process.cwd(),
    option("--source-manifest") ?? "../benchmarks/task-manifest.json",
  );
  if (phase !== "detection") {
    throw new Error("fixture command only supports --phase detection");
  }
  if (provider !== "mock") {
    throw new Error(
      "live execution is not implemented by the fixture command; refusing unregistered model spend",
    );
  }

  const dataset = loadDataset(datasetPath);
  const sourceManifestHash = sha256File(sourceManifestPath);
  if (dataset.sourceManifestHash !== sourceManifestHash) {
    throw new Error(
      `dataset source manifest drift: expected ${dataset.sourceManifestHash}, observed ${sourceManifestHash}`,
    );
  }
  const runnable = dataset.tasks.filter(
    (task) => task.executionStatus === "runnable",
  );
  if (runnable.length === 0)
    throw new Error("dataset has no runnable fixture tasks");
  const canaryRunnable = runnable.filter((task) =>
    CANARY_TASKS.some((candidate) => candidate.id === task.taskId),
  );
  const specialRunnable = runnable.filter(
    (task) =>
      !canaryRunnable.some((candidate) => candidate.taskId === task.taskId),
  );
  const specialTaskIds = new Set(["AA-AMB-01", "AA-BDNS-01"]);
  const unsupported = specialRunnable.filter(
    (task) => !specialTaskIds.has(task.taskId),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `runnable dataset tasks are not backed by a sealed fixture: ${unsupported.map((task) => task.taskId).join(", ")}`,
    );
  }

  const canary = runCodingCanary({
    provider: "mock",
    specs: canaryRunnable.map((task) => getCanaryTask(task.taskId)),
    trials: 1,
  });
  const requests = Object.fromEntries(
    canaryRunnable.map((task) => [
      task.taskId,
      getCanaryTask(task.taskId).prompt,
    ]),
  );
  const fixture = buildOfflineFixtureDetectionReport({
    rows: canary.trials,
    additionalTrials: buildAcceptanceV0SpecialFixtureTrials(),
    expectedTaskIds: runnable.map((task) => task.taskId),
    taskRequests: requests,
  });
  const manifest = buildAcceptanceExperimentManifest({
    phase: "detection",
    modelSnapshot: "provider-free-fixture",
    repositoryRevision: "clean-room-fixture",
    taskManifestHash: dataset.sourceManifestHash,
    taskIds: runnable.map((task) => task.taskId),
    replicates: 1,
    compilerVariant: "H0_deterministic",
    preregisteredAt: "2026-08-26T00:00:00.000Z",
  });
  const coordination = coordinateDetectionCell({
    dataset,
    manifest,
    trials: fixture.trials,
    source: fixture.source,
    experimentalEvidence: false,
  });
  if (coordination.status !== "complete") {
    throw new Error(
      `fixture coordination failed: ${coordination.readinessReasons.join(", ")}`,
    );
  }
  const output = {
    schemaVersion: 0,
    kind: "babel_acceptance_v0_fixture_report",
    experimentalEvidence: false,
    datasetId: dataset.datasetId,
    datasetHash: dataset.datasetHash,
    skippedDesignOnlyTaskIds: dataset.tasks
      .filter((task) => task.executionStatus !== "runnable")
      .map((task) => task.taskId),
    coordination: {
      status: coordination.status,
      matrixErrors: coordination.matrixErrors,
      candidateStateErrors: coordination.candidateStateErrors,
      readinessReasons: coordination.readinessReasons,
      promotionEligible: coordination.promotionEligible,
    },
    fixture,
  };
  const outputPath = option("--output");
  if (outputPath) {
    writeFileSync(
      resolve(process.cwd(), outputPath),
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
}

main();
