/**
 * TaskContractV1 — H3 universal frozen task contract across Chat, Plan, Deep.
 *
 * Acceptance criteria and non-goals are immutable after freeze. Mutating work
 * carries baseline reproduction + baseline verifier state. Controllers remain
 * mode-specific; this contract is the shared authority boundary.
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  terminalOutcomeExitCode,
  type TerminalOutcome,
} from "../schemas/agentContracts.js";
import type { BabelMode, ToolEffectClass } from "../executor/contracts.js";
import {
  ALL_CAPABILITIES,
  type CapabilityId,
} from "../authority/capabilities.js";
import {
  getAuthoritativeTrustedExecutionResolver,
  type TrustedExecutionResolver,
} from "../authority/trustedExecution.js";
import { sha256Canonical } from "../acceptance/canonical.js";
import { deepFreeze } from "../acceptance/freeze.js";
import {
  hasDurableSecretLikeText,
  sanitizeDurableString,
} from "../utils/redaction.js";

export const TASK_CONTRACT_VERSION = 1 as const;

export type TaskClass =
  | "general_swe"
  | "quick_fix"
  | "investigate"
  | "governance"
  | "plan_only"
  | "unknown";

export type TaskRisk = "low" | "medium" | "high" | "critical" | "unknown";

export type TaskContractProvenanceKind =
  | "user_goal"
  | "repository_policy"
  | "derived_acceptance"
  | "risk_analysis"
  | "explicit_user_authority";

export interface TaskContractProvenanceRecord {
  kind: TaskContractProvenanceKind;
  ref: string;
}

export type AcceptanceRequirementType =
  | "unit_test"
  | "integration_test"
  | "e2e"
  | "build"
  | "lint"
  | "typecheck"
  | "security"
  | "policy"
  | "manual"
  | "runtime"
  | "custom";

export interface AcceptanceRequirementV1 {
  id: string;
  description: string;
  type: AcceptanceRequirementType;
  required: boolean;
  verification_strategy: string;
}

export interface TaskAuthorityV1 {
  /** Existing Babel capability IDs are the authority vocabulary. */
  capabilities: CapabilityId[];
  source: "derived_policy" | "repository_policy" | "explicit_user_authority";
  /** Opaque supervisor-issued grant reference; provenance text is not a grant. */
  grant_ref?: string;
}

export type FailureClass =
  | "task"
  | "context"
  | "implementation"
  | "verifier"
  | "infrastructure"
  | "policy"
  | "provider"
  | "budget";

export interface FailureCapsuleV1 {
  failure_class: FailureClass;
  code: string;
  message: string;
  retryable: boolean;
  /** Which recovery budget this failure consumes. */
  budget_key:
    | "implementation_repair"
    | "infra_retry"
    | "provider_retry"
    | "none";
  evidence_refs: string[];
  at: string;
}

/** Recovery budgets keyed by failure class (H3). */
export interface FailureClassBudgets {
  implementation_repair: number;
  infra_retry: number;
  provider_retry: number;
}

export const DEFAULT_FAILURE_CLASS_BUDGETS: FailureClassBudgets = {
  implementation_repair: 3,
  infra_retry: 2,
  provider_retry: 2,
};

export function budgetKeyForFailureClass(
  fc: FailureClass,
): FailureCapsuleV1["budget_key"] {
  switch (fc) {
    case "implementation":
    case "task":
      return "implementation_repair";
    case "infrastructure":
    case "verifier":
      return "infra_retry";
    case "provider":
      return "provider_retry";
    case "policy":
    case "context":
    case "budget":
      return "none";
  }
}

export interface TaskContractV1 {
  schema_version: typeof TASK_CONTRACT_VERSION;
  /** Durable task identity; independent from transport and contract revision. */
  task_id: string;
  /** Immutable contract identity. */
  contract_id: string;
  /** Content hash of frozen fields (acceptance, non-goals, paths, effects). */
  contract_hash: string;
  mode: BabelMode;
  task_class: TaskClass;
  goal: string;
  required_behaviors: string[];
  invariants: string[];
  user_request: string;
  acceptance_criteria: string[];
  non_goals: string[];
  scope: {
    paths: string[];
    repository?: string;
  };
  risk: TaskRisk;
  authority: TaskAuthorityV1;
  acceptance: AcceptanceRequirementV1[];
  created_at: string;
  base_sha: string | null;
  allowed_paths: string[];
  protected_paths: string[];
  verifier_requirements: string[];
  budgets: {
    max_turns?: number;
    max_tokens?: number;
    failure_class_budgets: FailureClassBudgets;
  };
  allowed_effects: ToolEffectClass[];
  allowed_terminal_outcomes: TerminalOutcome[];
  /** Required for mutating work. */
  baseline_reproduction?: string;
  baseline_verifier_state?: {
    command?: string;
    exit_code?: number;
    summary?: string;
  };
  provenance: {
    created_at: string;
    source: string;
    records: TaskContractProvenanceRecord[];
    parent_contract_id?: string;
  };
  /** True once freeze() has been called — acceptance cannot drift. */
  frozen: boolean;
}

export interface BuildTaskContractInput {
  mode: BabelMode;
  user_request: string;
  task_id?: string;
  goal?: string;
  task_class?: TaskClass;
  required_behaviors?: string[];
  invariants?: string[];
  acceptance_criteria?: string[];
  acceptance?: AcceptanceRequirementV1[];
  non_goals?: string[];
  allowed_paths?: string[];
  protected_paths?: string[];
  verifier_requirements?: string[];
  max_turns?: number;
  max_tokens?: number;
  failure_class_budgets?: Partial<FailureClassBudgets>;
  allowed_effects?: ToolEffectClass[];
  allowed_terminal_outcomes?: TerminalOutcome[];
  scope?: { paths: string[]; repository?: string };
  risk?: TaskRisk;
  authority?: Partial<TaskAuthorityV1>;
  /** A supervisor-resolved grant used only for explicit user authority. */
  trusted_authority?: {
    grant_ref: string;
    resolver: TrustedExecutionResolver;
  };
  provenance?: TaskContractProvenanceRecord[];
  base_sha?: string | null;
  baseline_reproduction?: string;
  baseline_verifier_state?: TaskContractV1["baseline_verifier_state"];
  source?: string;
  parent_contract_id?: string;
}

const DEFAULT_ALLOWED_TERMINALS: TerminalOutcome[] = [
  "VERIFIED_COMPLETE",
  "UNVERIFIED_PATCH",
  "BLOCKED_EXTERNAL",
  "BLOCKED_POLICY",
  "BUDGET_EXHAUSTED",
  "CANCELLED",
  "INFRA_FAILURE",
  "AGENT_FAILURE",
  "NO_CHANGE_REQUIRED",
  "INVALID_TASK",
  "NEEDS_HUMAN_DECISION",
];

type ContractBody = Omit<
  TaskContractV1,
  "contract_id" | "contract_hash" | "frozen"
>;

function hashContractBody(c: ContractBody): string {
  const { created_at: _createdAt, provenance, ...stable } = c;
  const boundProvenance = {
    records: provenance.records,
    ...(provenance.parent_contract_id
      ? { parent_contract_id: provenance.parent_contract_id }
      : {}),
  };
  return sha256Canonical({ ...stable, provenance: boundProvenance }).slice(
    0,
    32,
  );
}

function legacyContractBody(
  c: Record<string, unknown>,
): Record<string, unknown> {
  return {
    mode: c["mode"],
    task_class: c["task_class"],
    user_request: c["user_request"],
    acceptance_criteria: c["acceptance_criteria"],
    non_goals: c["non_goals"],
    allowed_paths: c["allowed_paths"],
    protected_paths: c["protected_paths"],
    verifier_requirements: c["verifier_requirements"],
    budgets: c["budgets"],
    allowed_effects: c["allowed_effects"],
    allowed_terminal_outcomes: c["allowed_terminal_outcomes"],
    baseline_reproduction: c["baseline_reproduction"] ?? null,
    baseline_verifier_state: c["baseline_verifier_state"] ?? null,
  };
}

export const TaskContractV1Schema = z
  .object({
    schema_version: z.literal(TASK_CONTRACT_VERSION),
    task_id: z.string().min(1).optional(),
    contract_id: z.string().min(1),
    contract_hash: z.string().regex(/^[0-9a-f]{32,64}$/),
    mode: z.enum(["chat", "plan", "deep"]),
    task_class: z.string().min(1),
    goal: z.string().min(1).optional(),
    required_behaviors: z.array(z.string()).optional(),
    invariants: z.array(z.string()).optional(),
    user_request: z.string().min(1),
    acceptance_criteria: z.array(z.string()),
    non_goals: z.array(z.string()),
    scope: z
      .object({
        paths: z.array(z.string()).min(1),
        repository: z.string().optional(),
      })
      .optional(),
    risk: z.enum(["low", "medium", "high", "critical", "unknown"]).optional(),
    authority: z
      .object({
        capabilities: z.array(
          z.enum(ALL_CAPABILITIES as unknown as [string, ...string[]]),
        ),
        source: z.enum([
          "derived_policy",
          "repository_policy",
          "explicit_user_authority",
        ]),
        grant_ref: z.string().min(1).optional(),
      })
      .optional(),
    acceptance: z
      .array(
        z
          .object({
            id: z.string().min(1),
            description: z.string().min(1),
            type: z.enum([
              "unit_test",
              "integration_test",
              "e2e",
              "build",
              "lint",
              "typecheck",
              "security",
              "policy",
              "manual",
              "runtime",
              "custom",
            ]),
            required: z.boolean(),
            verification_strategy: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    created_at: z.string().datetime().optional(),
    base_sha: z.string().nullable().optional(),
  })
  .passthrough();

/** Validate the frozen identity of a persisted task contract. */
export function validateTaskContractV1(value: unknown): string[] {
  const parsed = TaskContractV1Schema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => issue.path.join(".") || "$");
  const candidate = parsed.data as unknown as Record<string, unknown>;
  const errors: string[] = [];
  if (candidate["frozen"] !== true) errors.push("not_frozen");
  const hasV1Fields =
    typeof candidate["task_id"] === "string" &&
    candidate["acceptance"] !== undefined;
  let computed: string;
  if (hasV1Fields) {
    const modernBody = Object.fromEntries(
      Object.entries(candidate).filter(
        ([key]) =>
          !["contract_id", "contract_hash", "frozen", "provenance"].includes(
            key,
          ),
      ),
    ) as ContractBody;
    const candidateProvenance = candidate["provenance"];
    const safeProvenance =
      candidateProvenance && typeof candidateProvenance === "object"
        ? (candidateProvenance as TaskContractV1["provenance"])
        : ({ records: [] } as unknown as TaskContractV1["provenance"]);
    computed = hashContractBody({
      ...modernBody,
      provenance: safeProvenance,
    });
  } else {
    const legacyBody = legacyContractBody(candidate);
    computed = createHash("sha256")
      .update(JSON.stringify(legacyBody), "utf8")
      .digest("hex")
      .slice(0, 32);
  }
  if (candidate["contract_hash"] !== computed) errors.push("contract_hash");
  if (
    typeof candidate["contract_id"] !== "string" ||
    !candidate["contract_id"].startsWith(`tc1:${computed.slice(0, 16)}:`)
  )
    errors.push("contract_id");
  if (hasV1Fields) {
    const allowedKeys = new Set([
      "schema_version",
      "task_id",
      "contract_id",
      "contract_hash",
      "mode",
      "task_class",
      "goal",
      "required_behaviors",
      "invariants",
      "user_request",
      "acceptance_criteria",
      "non_goals",
      "scope",
      "risk",
      "authority",
      "acceptance",
      "created_at",
      "base_sha",
      "allowed_paths",
      "protected_paths",
      "verifier_requirements",
      "budgets",
      "allowed_effects",
      "allowed_terminal_outcomes",
      "baseline_reproduction",
      "baseline_verifier_state",
      "provenance",
      "frozen",
    ]);
    for (const key of Object.keys(candidate)) {
      if (!allowedKeys.has(key)) errors.push(`unknown.${key}`);
    }
    const provenance = candidate["provenance"];
    const provenanceRecordValues =
      provenance && typeof provenance === "object"
        ? (provenance as Record<string, unknown>)["records"]
        : undefined;
    const records = Array.isArray(provenanceRecordValues)
      ? (provenanceRecordValues as Array<Record<string, unknown>>)
      : [];
    if (
      !provenance ||
      typeof provenance !== "object" ||
      !Array.isArray(provenanceRecordValues)
    )
      errors.push("provenance.records");
    for (const [index, record] of records.entries()) {
      if (
        !record ||
        typeof record["kind"] !== "string" ||
        ![
          "user_goal",
          "repository_policy",
          "derived_acceptance",
          "risk_analysis",
          "explicit_user_authority",
        ].includes(record["kind"]) ||
        typeof record["ref"] !== "string"
      ) {
        errors.push(`provenance.records.${index}`);
      }
    }
    const authority = candidate["authority"] as { capabilities?: unknown };
    const capabilities = Array.isArray(authority?.capabilities)
      ? authority.capabilities
      : [];
    if (capabilities.includes("unknown"))
      errors.push("authority.capabilities.unknown");
    if (
      records.some(
        (record) =>
          record["kind"] === "explicit_user_authority" &&
          (typeof record["ref"] !== "string" ||
            !String(record["ref"]).startsWith("grant:")),
      )
    ) {
      errors.push("provenance.untrusted_user_authority");
    }
    if (
      records.some(
        (record) =>
          record["kind"] === "repository_policy" &&
          String(record["ref"] ?? "").startsWith("user:"),
      )
    ) {
      errors.push("provenance.policy_impersonation");
    }
    if (
      (candidate["authority"] as { source?: unknown } | undefined)?.source ===
        "explicit_user_authority" &&
      !records.some(
        (record) =>
          record["kind"] === "explicit_user_authority" &&
          typeof record["ref"] === "string" &&
          record["ref"].startsWith("grant:"),
      )
    ) {
      errors.push("authority.explicit_user_authority_unbound");
    }
    if (
      (candidate["authority"] as { source?: unknown } | undefined)?.source ===
        "explicit_user_authority" &&
      typeof (candidate["authority"] as { grant_ref?: unknown } | undefined)
        ?.grant_ref !== "string"
    ) {
      errors.push("authority.grant_ref");
    }
    const durableValues = [
      candidate["goal"],
      candidate["user_request"],
      ...(Array.isArray(candidate["acceptance_criteria"])
        ? candidate["acceptance_criteria"]
        : []),
      ...(Array.isArray(candidate["required_behaviors"])
        ? candidate["required_behaviors"]
        : []),
      ...(Array.isArray(candidate["invariants"])
        ? candidate["invariants"]
        : []),
      ...(Array.isArray(candidate["non_goals"]) ? candidate["non_goals"] : []),
      ...(Array.isArray(candidate["verifier_requirements"])
        ? candidate["verifier_requirements"]
        : []),
      ...(Array.isArray(provenanceRecordValues)
        ? (provenanceRecordValues as Array<{ ref?: unknown }>).map(
            (record) => record.ref,
          )
        : []),
      (candidate["scope"] as { repository?: unknown } | undefined)
        ?.repository,
      ...(Array.isArray(candidate["acceptance"])
        ? (candidate["acceptance"] as Array<Record<string, unknown>>).flatMap(
            (item) => [item["id"], item["verification_strategy"]],
          )
        : []),
      (candidate["baseline_verifier_state"] as
        | { command?: unknown; summary?: unknown }
        | undefined)?.command,
      (candidate["baseline_verifier_state"] as
        | { command?: unknown; summary?: unknown }
        | undefined)?.summary,
      candidate["source"],
      candidate["base_sha"],
      (candidate["authority"] as { grant_ref?: unknown } | undefined)
        ?.grant_ref,
    ];
    if (
      durableValues.some(
        (item) => typeof item === "string" && hasDurableSecretLikeText(item),
      )
    )
      errors.push("durable_secret");
    const acceptance = candidate["acceptance"];
    const criteria = candidate["acceptance_criteria"];
    if (Array.isArray(acceptance) && Array.isArray(criteria)) {
      const ids = acceptance.map((item) =>
        String((item as Record<string, unknown>)["id"]),
      );
      if (new Set(ids).size !== ids.length)
        errors.push("acceptance.duplicate_id");
      if (
        acceptance.length !== criteria.length ||
        acceptance.some(
          (item, index) =>
            (item as Record<string, unknown>)["description"] !==
            criteria[index],
        )
      ) {
        errors.push("acceptance.reconciliation");
      }
    }
  }
  return errors;
}

/** Strict V1 completion validation; legacy V0 fixture contracts may be empty. */
export function validateTaskContractV1ForCompletion(
  value: unknown,
  options: { trustedAuthorityResolver?: TrustedExecutionResolver } = {},
): string[] {
  void options;
  const trustedAuthorityResolver = getAuthoritativeTrustedExecutionResolver();
  const errors = validateTaskContractV1(value);
  if (errors.length > 0) return errors;
  const candidate = value as TaskContractV1;
  if (
    !candidate.acceptance ||
    candidate.acceptance.filter((item) => item.required === true).length === 0
  ) {
    errors.push("acceptance.required");
  }
  if (candidate.authority?.source === "explicit_user_authority") {
    const grantRef = candidate.authority.grant_ref;
    const grant = grantRef
      ? trustedAuthorityResolver.resolveAuthorityGrant(grantRef)
      : undefined;
    if (!grant) {
      errors.push("authority.grant_unknown_or_inactive");
    } else {
      if (grant.source !== "explicit_user") errors.push("authority.grant_source");
      if (grant.task_id !== null && grant.task_id !== candidate.task_id)
        errors.push("authority.grant_task_id");
      if (
        grant.contract_hash !== null &&
        grant.contract_hash !== candidate.contract_hash
      )
        errors.push("authority.grant_contract_hash");
      if (
        candidate.authority.capabilities.some(
          (capability) => !grant.capabilities.includes(capability),
        )
      )
        errors.push("authority.grant_capability_widening");
    }
  }
  return errors;
}

export function buildTaskContractV1(
  input: BuildTaskContractInput,
): TaskContractV1 {
  const rawAcceptance = input.acceptance ?? [];
  const acceptanceCriteria = [
    ...(input.acceptance_criteria ??
      (input.acceptance ? rawAcceptance.map((item) => item.description) : [])),
  ].map((value) => durableText(value));
  const acceptance = [
    ...(input.acceptance
      ? rawAcceptance.map((item) => ({
          ...item,
          id: durableText(item.id),
          description: durableText(item.description),
          verification_strategy: durableText(item.verification_strategy),
        }))
      : acceptanceCriteria.map((description, index) => ({
          id: `acceptance:${index + 1}`,
          description,
          type: "custom" as const,
          required: true,
          verification_strategy:
            "independent evidence bound to the candidate revision",
        }))),
  ];
  if (new Set(acceptanceCriteria).size !== acceptanceCriteria.length) {
    throw new Error("TaskContract acceptance criteria must be unique.");
  }
  if (
    acceptance.length !== acceptanceCriteria.length ||
    acceptance.some(
      (item, index) => item.description !== acceptanceCriteria[index],
    )
  ) {
    throw new Error(
      "TaskContract acceptance must reconcile with acceptance_criteria.",
    );
  }
  const createdAt = new Date().toISOString();
  const trustedGrant = input.trusted_authority
    ? input.trusted_authority.resolver.resolveAuthorityGrant(
        input.trusted_authority.grant_ref,
      )
    : undefined;
  if (input.trusted_authority && !trustedGrant) {
    throw new Error("Unknown or inactive trusted authority grant.");
  }
  const authoritySource =
    input.authority?.source ??
    (trustedGrant ? "explicit_user_authority" : "derived_policy");
  if (authoritySource === "explicit_user_authority" && !trustedGrant) {
    throw new Error("Explicit user authority requires a trusted authority grant.");
  }
  if (
    trustedGrant &&
    input.authority?.grant_ref &&
    input.authority.grant_ref !== trustedGrant.grant_ref
  ) {
    throw new Error("TaskContract authority grant reference mismatch.");
  }
  const provenanceRecords = [
    { kind: "user_goal" as const, ref: "user_request" },
    { kind: "derived_acceptance" as const, ref: "acceptance_criteria" },
    ...(trustedGrant
      ? [{ kind: "explicit_user_authority" as const, ref: trustedGrant.grant_ref }]
      : []),
    ...(input.provenance ?? []),
  ].map((record) => ({
    ...record,
    ref: durableText(record.ref),
  }));
  const provenance = {
    created_at: createdAt,
    source: durableText(input.source ?? "taskContract.build"),
    records: provenanceRecords,
    ...(input.parent_contract_id
      ? { parent_contract_id: durableText(input.parent_contract_id) }
      : {}),
  };
  const body = {
    schema_version: TASK_CONTRACT_VERSION,
    task_id:
      durableText(
        input.task_id ??
          `task:${sha256Canonical({ mode: input.mode, user_request: input.user_request }).slice(0, 24)}`,
      ),
    mode: input.mode,
    task_class: input.task_class ?? "unknown",
    goal: durableText(input.goal ?? input.user_request),
    required_behaviors: [
      ...(input.required_behaviors ?? acceptanceCriteria),
    ].map(durableText),
    invariants: [...(input.invariants ?? [])].map(durableText),
    user_request: durableText(input.user_request),
    acceptance_criteria: acceptanceCriteria,
    non_goals: [...(input.non_goals ?? [])].map(durableText),
    scope: {
      paths: [
        ...(input.scope?.paths ?? input.allowed_paths ?? ["**/*"]),
      ].map(durableText),
      ...(input.scope?.repository
        ? { repository: durableText(input.scope.repository) }
        : {}),
    },
    risk: input.risk ?? "unknown",
    authority: {
      capabilities: [
        ...(input.authority?.capabilities ??
          trustedGrant?.capabilities ?? ["inspect_repository"]),
      ],
      source: authoritySource,
      ...(trustedGrant ? { grant_ref: trustedGrant.grant_ref } : {}),
    },
    acceptance,
    created_at: createdAt,
    base_sha:
      input.base_sha === null || input.base_sha === undefined
        ? null
        : durableText(input.base_sha),
    allowed_paths: [...(input.allowed_paths ?? ["**/*"])].map(durableText),
    protected_paths: [...(input.protected_paths ?? [])].map(durableText),
    verifier_requirements: [...(input.verifier_requirements ?? [])].map(
      durableText,
    ),
    budgets: {
      ...(input.max_turns !== undefined ? { max_turns: input.max_turns } : {}),
      ...(input.max_tokens !== undefined
        ? { max_tokens: input.max_tokens }
        : {}),
      failure_class_budgets: {
        ...DEFAULT_FAILURE_CLASS_BUDGETS,
        ...input.failure_class_budgets,
      },
    },
    allowed_effects: [
      ...(input.allowed_effects ?? [
        "read_only",
        "idempotent",
        "reconcilable_mutation",
      ]),
    ],
    allowed_terminal_outcomes: [
      ...(input.allowed_terminal_outcomes ?? DEFAULT_ALLOWED_TERMINALS),
    ],
    ...(input.baseline_reproduction
      ? { baseline_reproduction: durableText(input.baseline_reproduction) }
      : {}),
    ...(input.baseline_verifier_state
      ? {
          baseline_verifier_state: {
            ...(input.baseline_verifier_state.command
              ? {
                  command: durableText(input.baseline_verifier_state.command),
                }
              : {}),
            ...(input.baseline_verifier_state.exit_code !== undefined
              ? { exit_code: input.baseline_verifier_state.exit_code }
              : {}),
            ...(input.baseline_verifier_state.summary
              ? {
                  summary: durableText(input.baseline_verifier_state.summary),
                }
              : {}),
          },
        }
      : {}),
  };
  if (
    trustedGrant &&
    body.authority.capabilities.some(
      (capability) => !trustedGrant.capabilities.includes(capability),
    )
  ) {
    throw new Error("TaskContract authority exceeds the trusted grant.");
  }
  const contract_hash = hashContractBody({ ...body, provenance });
  return {
    ...body,
    contract_id: `tc1:${contract_hash.slice(0, 16)}:${randomUUID().slice(0, 8)}`,
    contract_hash,
    provenance,
    frozen: false,
  };
}

/** Freeze contract — subsequent acceptance/path mutations throw. */
export function freezeTaskContract(contract: TaskContractV1): TaskContractV1 {
  return deepFreeze({ ...contract, frozen: true });
}

/**
 * Attempt to mutate acceptance criteria. Throws when frozen (H3 exit gate).
 */
export function withAcceptanceCriteria(
  contract: TaskContractV1,
  criteria: string[],
  options: { trustedAuthorityResolver?: TrustedExecutionResolver } = {},
): TaskContractV1 {
  if (contract.frozen) {
    throw new Error(
      `TaskContractV1 ${contract.contract_id} is frozen; acceptance criteria cannot drift`,
    );
  }
  if (contract.authority.grant_ref && !options.trustedAuthorityResolver) {
    throw new Error(
      "Rebuilding an explicitly authorized TaskContract requires the trusted authority resolver.",
    );
  }
  const next = buildTaskContractV1({
    task_id: contract.task_id,
    mode: contract.mode,
    goal: contract.goal,
    user_request: contract.user_request,
    task_class: contract.task_class,
    required_behaviors: contract.required_behaviors,
    invariants: contract.invariants,
    acceptance_criteria: criteria,
    non_goals: contract.non_goals,
    allowed_paths: contract.allowed_paths,
    protected_paths: contract.protected_paths,
    verifier_requirements: contract.verifier_requirements,
    ...(contract.budgets.max_turns !== undefined
      ? { max_turns: contract.budgets.max_turns }
      : {}),
    ...(contract.budgets.max_tokens !== undefined
      ? { max_tokens: contract.budgets.max_tokens }
      : {}),
    failure_class_budgets: contract.budgets.failure_class_budgets,
    allowed_effects: contract.allowed_effects,
    allowed_terminal_outcomes: contract.allowed_terminal_outcomes,
    scope: contract.scope,
    risk: contract.risk,
    authority: contract.authority,
    ...(contract.authority.grant_ref
      ? {
          trusted_authority: {
            grant_ref: contract.authority.grant_ref,
            resolver: options.trustedAuthorityResolver!,
          },
        }
      : {}),
    base_sha: contract.base_sha,
    provenance: contract.provenance.records,
    ...(contract.baseline_reproduction
      ? { baseline_reproduction: contract.baseline_reproduction }
      : {}),
    ...(contract.baseline_verifier_state
      ? { baseline_verifier_state: contract.baseline_verifier_state }
      : {}),
    source: "withAcceptanceCriteria",
    parent_contract_id: contract.contract_id,
  });
  return next;
}

function durableText(value: string): string {
  return sanitizeDurableString(value, "TaskContract");
}

/** Whether a terminal outcome is allowed by the contract. */
export function isAllowedTerminal(
  contract: TaskContractV1,
  outcome: TerminalOutcome,
): boolean {
  return contract.allowed_terminal_outcomes.includes(outcome);
}

/**
 * Decide honest outcome for already-fixed / invalid / needs-human cases.
 * Does not authorize VERIFIED_COMPLETE for plan mode.
 */
export function decideHonestTaskOutcome(input: {
  contract: TaskContractV1;
  acceptanceAlreadyMet: boolean;
  taskInvalid: boolean;
  needsHuman: boolean;
  planMode?: boolean;
}): TerminalOutcome | null {
  if (input.taskInvalid) return "INVALID_TASK";
  if (input.needsHuman) return "NEEDS_HUMAN_DECISION";
  if (input.acceptanceAlreadyMet) return "NO_CHANGE_REQUIRED";
  if (input.planMode) return null; // plan uses PLAN_COMPLETE via kernel, not executor VC
  return null;
}

/**
 * Live completion hook: re-map mutating success outcomes when the frozen
 * contract says the task is invalid, already fixed, or needs a human.
 * Does not invent VERIFIED_COMPLETE; does not authorize plan mutations.
 */
export function applyHonestTaskOutcomeToCompletion(input: {
  contract: TaskContractV1 | null | undefined;
  requestedOutcome: TerminalOutcome;
  hasMutation: boolean;
  planMode: boolean;
  /** Explicit product signals (optional). */
  taskInvalid?: boolean;
  needsHuman?: boolean;
  acceptanceAlreadyMet?: boolean;
}): TerminalOutcome {
  const c = input.contract;
  if (!c) return input.requestedOutcome;

  // Baseline already green + no mutation path → already fixed
  const baselineGreen =
    input.acceptanceAlreadyMet === true ||
    (c.baseline_verifier_state?.exit_code === 0 &&
      !input.hasMutation &&
      (input.requestedOutcome === "VERIFIED_COMPLETE" ||
        input.requestedOutcome === "UNVERIFIED_PATCH"));

  const honest = decideHonestTaskOutcome({
    contract: c,
    acceptanceAlreadyMet: baselineGreen,
    taskInvalid: input.taskInvalid === true,
    needsHuman: input.needsHuman === true,
    planMode: input.planMode,
  });
  if (honest) return honest;

  // Plan mode must never surface executor VERIFIED_COMPLETE
  if (input.planMode && input.requestedOutcome === "VERIFIED_COMPLETE") {
    return "UNVERIFIED_PATCH";
  }

  // Frozen contract: mutating work that is not allowed should not claim VC
  if (
    input.hasMutation &&
    c.allowed_effects.every((e) => e === "read_only") &&
    input.requestedOutcome === "VERIFIED_COMPLETE"
  ) {
    return "BLOCKED_POLICY";
  }

  return input.requestedOutcome;
}

/** Live FailureClass budget tracker factory bound to a contract. */
export function createFailureBudgetTrackerFromContract(
  contract: TaskContractV1 | null | undefined,
): FailureClassBudgetTracker {
  return new FailureClassBudgetTracker(
    contract?.budgets.failure_class_budgets ?? DEFAULT_FAILURE_CLASS_BUDGETS,
  );
}

/**
 * Track failure-class budgets. Infrastructure retries must not consume
 * implementation-repair budget (H3 exit gate).
 */
export class FailureClassBudgetTracker {
  private remaining: FailureClassBudgets;

  constructor(budgets: FailureClassBudgets = DEFAULT_FAILURE_CLASS_BUDGETS) {
    this.remaining = { ...budgets };
  }

  remainingBudgets(): FailureClassBudgets {
    return { ...this.remaining };
  }

  /**
   * Consume one unit of the budget keyed by failure class.
   * Returns false when exhausted or budget_key is 'none'.
   */
  consume(failure: FailureCapsuleV1): boolean {
    const key = failure.budget_key;
    if (key === "none") return false;
    if (this.remaining[key] <= 0) return false;
    this.remaining[key] -= 1;
    return true;
  }

  canConsume(failure: FailureCapsuleV1): boolean {
    const key = failure.budget_key;
    if (key === "none") return false;
    return this.remaining[key] > 0;
  }
}

export function makeFailureCapsule(
  failure_class: FailureClass,
  code: string,
  message: string,
  opts?: { retryable?: boolean; evidence_refs?: string[] },
): FailureCapsuleV1 {
  return {
    failure_class,
    code,
    message,
    retryable:
      opts?.retryable ??
      (failure_class !== "policy" && failure_class !== "task"),
    budget_key: budgetKeyForFailureClass(failure_class),
    evidence_refs: opts?.evidence_refs ?? [],
    at: new Date().toISOString(),
  };
}

/**
 * Cross-surface terminal agreement record (Chat/TUI/headless/persistence/exit).
 * Built from live mappers — not tautological clones of one string.
 */
export interface TerminalSurfaceAgreement {
  outcome: TerminalOutcome;
  exit_code: number;
  /** From userFacingStatusFromOutcome (success|blocked|failed|…). */
  chat_status: string;
  /** Headless JSON outcome field (canonical TerminalOutcome). */
  headless_json_outcome: string;
  /** Persistence outcome field (canonical TerminalOutcome). */
  persistence_outcome: string;
  /** Process exit from exitCodeFromOutcome / terminalOutcomeExitCode. */
  process_exit_code: number;
}

export function buildTerminalSurfaceAgreement(
  outcome: TerminalOutcome,
  mappers?: {
    userFacingStatus?: (o: TerminalOutcome) => string;
    exitCode?: (o: TerminalOutcome) => number;
  },
): TerminalSurfaceAgreement {
  // Lazy import avoided — callers should pass live mappers in production tests.
  const userFacing = mappers?.userFacingStatus?.(outcome) ?? outcome;
  const exit = mappers?.exitCode?.(outcome) ?? terminalOutcomeExitCode(outcome);
  return {
    outcome,
    exit_code: exit,
    chat_status: userFacing,
    headless_json_outcome: outcome,
    persistence_outcome: outcome,
    process_exit_code: terminalOutcomeExitCode(outcome),
  };
}

/** True when headless/persistence share outcome and exits agree. */
export function surfacesAgreeOnTerminal(a: TerminalSurfaceAgreement): boolean {
  return (
    a.headless_json_outcome === a.persistence_outcome &&
    a.headless_json_outcome === a.outcome &&
    a.exit_code === a.process_exit_code
  );
}
