import { sha256Canonical, omitKeys } from "./canonical.js";
import { deepFreeze } from "./freeze.js";
import {
  A7B_DETECTION_GATE_POLICY_V0,
  type DetectionPromotionGatePolicyV0,
} from "./experiment.js";

export const ACCEPTANCE_DATASET_SCHEMA_VERSION = 0 as const;

export const ACCEPTANCE_DATASET_CATEGORIES = [
  "governance_false_completion",
  "user_visible_false_completion",
  "regression",
  "ambiguity",
  "evidence_insufficiency",
  "bdns_contradiction",
] as const;

export type AcceptanceDatasetCategoryV0 =
  (typeof ACCEPTANCE_DATASET_CATEGORIES)[number];

export type AcceptanceDatasetExecutionStatusV0 =
  | "runnable"
  | "design_only"
  | "excluded";

/** One preregistered task identity; ground truth remains in the oracle ref. */
export interface AcceptanceDatasetTaskV0 {
  taskId: string;
  category: AcceptanceDatasetCategoryV0;
  sourceRef: string;
  requestRef: string;
  candidateSetRef: string;
  hiddenOracleRef: string;
  groundTruthRef: string;
  executionStatus: AcceptanceDatasetExecutionStatusV0;
}

export interface AcceptanceDatasetManifestV0 {
  schemaVersion: typeof ACCEPTANCE_DATASET_SCHEMA_VERSION;
  kind: "babel_acceptance_v0_dataset";
  datasetId: string;
  datasetHash: string;
  sourceManifestHash: string;
  tasks: AcceptanceDatasetTaskV0[];
  requiredCategories: AcceptanceDatasetCategoryV0[];
  promotionGatePolicy: DetectionPromotionGatePolicyV0;
  frozen: true;
}

export interface BuildAcceptanceDatasetManifestInputV0 {
  sourceManifestHash: string;
  tasks: readonly AcceptanceDatasetTaskV0[];
  promotionGatePolicy?: DetectionPromotionGatePolicyV0;
}

export interface AcceptanceDatasetReadinessV0 {
  ready: boolean;
  runnableTaskIds: string[];
  designOnlyTaskIds: string[];
  excludedTaskIds: string[];
  reasons: string[];
}

function validateTaskShape(
  tasks: readonly AcceptanceDatasetTaskV0[],
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== "object") {
      errors.push("invalid_task");
      continue;
    }
    const taskId = typeof task.taskId === "string" ? task.taskId : "";
    if (!taskId.trim() || ids.has(taskId)) {
      errors.push(`duplicate_or_empty_task:${taskId}`);
    }
    ids.add(taskId);
    if (
      !ACCEPTANCE_DATASET_CATEGORIES.includes(
        task.category as AcceptanceDatasetCategoryV0,
      )
    )
      errors.push(`${taskId}:category`);
    if (!["runnable", "design_only", "excluded"].includes(task.executionStatus))
      errors.push(`${taskId}:executionStatus`);
    for (const [field, value] of Object.entries(task)) {
      if (field === "category" || field === "executionStatus") continue;
      if (typeof value !== "string" || !value.trim()) {
        errors.push(`${taskId}:${field}`);
      }
    }
  }
  const categories = new Set(tasks.map((task) => task.category));
  for (const category of ACCEPTANCE_DATASET_CATEGORIES) {
    if (!categories.has(category)) errors.push(`missing_category:${category}`);
  }
  return errors;
}

/** Build the immutable preregistration record; it never runs a task. */
export function buildAcceptanceDatasetManifest(
  input: BuildAcceptanceDatasetManifestInputV0,
): AcceptanceDatasetManifestV0 {
  if (!/^[0-9a-f]{64}$/i.test(input.sourceManifestHash)) {
    throw new Error("sourceManifestHash must be a SHA-256 digest");
  }
  const errors = validateTaskShape(input.tasks);
  if (errors.length > 0) throw new Error(errors.join(", "));
  const draft = {
    schemaVersion: ACCEPTANCE_DATASET_SCHEMA_VERSION,
    kind: "babel_acceptance_v0_dataset" as const,
    datasetId: "ad0:pending",
    datasetHash: "0".repeat(64),
    sourceManifestHash: input.sourceManifestHash.toLowerCase(),
    tasks: input.tasks.map((task) => ({ ...task })),
    requiredCategories: [...ACCEPTANCE_DATASET_CATEGORIES],
    promotionGatePolicy: {
      ...(input.promotionGatePolicy ?? A7B_DETECTION_GATE_POLICY_V0),
    },
    frozen: true as const,
  };
  const datasetHash = sha256Canonical(
    omitKeys(draft, ["datasetId", "datasetHash", "frozen"]),
  );
  return deepFreeze({
    ...draft,
    datasetId: `ad0:${datasetHash.slice(0, 16)}:preregistered`,
    datasetHash,
  });
}

export function validateAcceptanceDatasetManifestV0(
  value: AcceptanceDatasetManifestV0,
): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== ACCEPTANCE_DATASET_SCHEMA_VERSION)
    errors.push("schemaVersion");
  if (value.kind !== "babel_acceptance_v0_dataset") errors.push("kind");
  if (value.frozen !== true) errors.push("frozen");
  if (!/^[0-9a-f]{64}$/i.test(value.sourceManifestHash))
    errors.push("sourceManifestHash");
  const policy = value.promotionGatePolicy;
  if (
    !policy ||
    !Number.isInteger(policy.minimumTrialsPerArm) ||
    policy.minimumTrialsPerArm < 1 ||
    !Number.isFinite(policy.minimumFalseAcceptReduction) ||
    policy.minimumFalseAcceptReduction < 0 ||
    policy.minimumFalseAcceptReduction > 1 ||
    !Number.isFinite(policy.minimumFalseAcceptReductionVsFrontier) ||
    policy.minimumFalseAcceptReductionVsFrontier < 0 ||
    policy.minimumFalseAcceptReductionVsFrontier > 1 ||
    !Number.isFinite(policy.maximumFalseRejectRate) ||
    policy.maximumFalseRejectRate < 0 ||
    policy.maximumFalseRejectRate > 1 ||
    !Number.isFinite(policy.maximumEscalationRate) ||
    policy.maximumEscalationRate < 0 ||
    policy.maximumEscalationRate > 1 ||
    typeof policy.requireCompleteCoverage !== "boolean"
  )
    errors.push("promotionGatePolicy");
  const taskErrors = validateTaskShape(value.tasks);
  errors.push(...taskErrors);
  const expected = sha256Canonical(
    omitKeys(value as unknown as Record<string, unknown>, [
      "datasetId",
      "datasetHash",
      "frozen",
    ]),
  );
  if (value.datasetHash !== expected) errors.push("datasetHash");
  if (!value.datasetId.startsWith(`ad0:${value.datasetHash.slice(0, 16)}:`))
    errors.push("datasetId");
  if (
    JSON.stringify(value.requiredCategories) !==
    JSON.stringify(ACCEPTANCE_DATASET_CATEGORIES)
  )
    errors.push("requiredCategories");
  return errors;
}

/**
 * Confirm that a frozen dataset can support a confirmatory cell. Design-only
 * and excluded tasks are reported explicitly so a runner cannot silently
 * shrink the preregistered population.
 */
export function assessAcceptanceDatasetReadiness(
  dataset: AcceptanceDatasetManifestV0,
): AcceptanceDatasetReadinessV0 {
  const validationErrors = validateAcceptanceDatasetManifestV0(dataset);
  const runnableTaskIds = dataset.tasks
    .filter((task) => task.executionStatus === "runnable")
    .map((task) => task.taskId);
  const designOnlyTaskIds = dataset.tasks
    .filter((task) => task.executionStatus === "design_only")
    .map((task) => task.taskId);
  const excludedTaskIds = dataset.tasks
    .filter((task) => task.executionStatus === "excluded")
    .map((task) => task.taskId);
  const reasons = validationErrors.map((error) => `invalid_dataset:${error}`);
  if (runnableTaskIds.length === 0) reasons.push("no_runnable_tasks");
  if (designOnlyTaskIds.length > 0)
    reasons.push(`design_only_tasks:${designOnlyTaskIds.join(",")}`);
  if (excludedTaskIds.length > 0)
    reasons.push(`excluded_tasks:${excludedTaskIds.join(",")}`);
  return {
    ready: reasons.length === 0,
    runnableTaskIds,
    designOnlyTaskIds,
    excludedTaskIds,
    reasons,
  };
}

/**
 * Compact first-cell preregistration. Existing canary references and the two
 * sealed special fixtures are runnable; the fixture runner remains explicitly
 * non-experimental and cannot promote its output.
 */
export const ACCEPTANCE_V0_PREREGISTERED_TASKS: readonly AcceptanceDatasetTaskV0[] =
  [
    {
      taskId: "C08",
      category: "governance_false_completion",
      sourceRef: "src/eval/canary/tasks.ts#C08",
      requestRef: "src/eval/canary/tasks.ts#C08.prompt",
      candidateSetRef: "src/eval/canary/tasks.ts#C08.files",
      hiddenOracleRef: "src/eval/canary/tasks.ts#C08.oracle_test",
      groundTruthRef: "src/eval/canary/validity.ts#verifyCanaryTaskValidity",
      executionStatus: "runnable",
    },
    {
      taskId: "C10",
      category: "user_visible_false_completion",
      sourceRef: "src/eval/canary/tasks.ts#C10",
      requestRef: "src/eval/canary/tasks.ts#C10.prompt",
      candidateSetRef: "src/eval/canary/tasks.ts#C10.inadequate",
      hiddenOracleRef: "src/eval/canary/tasks.ts#C10.oracle_test",
      groundTruthRef: "src/eval/canary/validity.ts#verifyCanaryTaskValidity",
      executionStatus: "runnable",
    },
    {
      taskId: "C11",
      category: "user_visible_false_completion",
      sourceRef: "src/eval/canary/tasks.ts#C11",
      requestRef: "src/eval/canary/tasks.ts#C11.prompt",
      candidateSetRef: "src/eval/canary/tasks.ts#C11.inadequate",
      hiddenOracleRef: "src/eval/canary/tasks.ts#C11.oracle_test",
      groundTruthRef: "src/eval/canary/validity.ts#verifyCanaryTaskValidity",
      executionStatus: "runnable",
    },
    {
      taskId: "C12",
      category: "user_visible_false_completion",
      sourceRef: "src/eval/canary/tasks.ts#C12",
      requestRef: "src/eval/canary/tasks.ts#C12.prompt",
      candidateSetRef: "src/eval/canary/tasks.ts#C12.inadequate",
      hiddenOracleRef: "src/eval/canary/tasks.ts#C12.oracle_test",
      groundTruthRef: "src/eval/canary/validity.ts#verifyCanaryTaskValidity",
      executionStatus: "runnable",
    },
    {
      taskId: "C13",
      category: "user_visible_false_completion",
      sourceRef: "src/eval/canary/tasks.ts#C13",
      requestRef: "src/eval/canary/tasks.ts#C13.prompt",
      candidateSetRef: "src/eval/canary/tasks.ts#C13.inadequate",
      hiddenOracleRef: "src/eval/canary/tasks.ts#C13.oracle_test",
      groundTruthRef: "src/eval/canary/validity.ts#verifyCanaryTaskValidity",
      executionStatus: "runnable",
    },
    {
      taskId: "C07",
      category: "regression",
      sourceRef: "src/eval/canary/tasks.ts#C07",
      requestRef: "src/eval/canary/tasks.ts#C07.prompt",
      candidateSetRef: "src/eval/canary/tasks.ts#C07.files",
      hiddenOracleRef: "src/eval/canary/tasks.ts#C07.oracle_test",
      groundTruthRef: "src/eval/canary/validity.ts#verifyCanaryTaskValidity",
      executionStatus: "runnable",
    },
    {
      taskId: "C09",
      category: "evidence_insufficiency",
      sourceRef: "src/eval/canary/tasks.ts#C09",
      requestRef: "src/eval/canary/tasks.ts#C09.prompt",
      candidateSetRef: "src/eval/canary/tasks.ts#C09.files",
      hiddenOracleRef: "src/eval/canary/tasks.ts#C09.oracle_test",
      groundTruthRef: "src/eval/canary/validity.ts#verifyCanaryTaskValidity",
      executionStatus: "runnable",
    },
    {
      taskId: "AA-AMB-01",
      category: "ambiguity",
      sourceRef: "src/acceptance/specialFixtures.ts#AA-AMB-01",
      requestRef: "src/acceptance/specialFixtures.ts#AMBIGUOUS_FIXTURE_REQUEST",
      candidateSetRef: "src/acceptance/specialFixtures.ts#ambiguous-policy.js",
      hiddenOracleRef: "sealed-human-resolution:AA-AMB-01",
      groundTruthRef: "sealed-ground-truth:AA-AMB-01:reject",
      executionStatus: "runnable",
    },
    {
      taskId: "AA-BDNS-01",
      category: "bdns_contradiction",
      sourceRef: "src/diagnostics/bdns/diagnostics.ts#reconcileProcessOutcome",
      requestRef: "src/acceptance/specialFixtures.ts#BDNS_FIXTURE_REQUEST",
      candidateSetRef: "src/acceptance/specialFixtures.ts#validator.js",
      hiddenOracleRef: "sealed-bdns-contradiction:PROCESS_OUTCOME_MISMATCH",
      groundTruthRef: "sealed-ground-truth:AA-BDNS-01:reject",
      executionStatus: "runnable",
    },
  ];

export function buildAcceptanceV0PreregisteredDataset(
  sourceManifestHash: string,
): AcceptanceDatasetManifestV0 {
  return buildAcceptanceDatasetManifest({
    sourceManifestHash,
    tasks: ACCEPTANCE_V0_PREREGISTERED_TASKS,
  });
}
